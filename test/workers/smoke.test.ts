import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { clampMonth } from '../../src/http/router.js'

/**
 * `/health` must SAY when the deployment is silently degraded.
 *
 * Added after a live instance spent a week with no email provider key,
 * logging every confirmation instead of sending it, across nine real
 * bookings. Nothing was externally observable: the page rendered, bookings
 * committed, calendars synced, `/health` said `ok: true`. This suite's env
 * sets no RESEND/BREVO key, so it resolves to the console sender — the exact
 * degraded state, which makes this the natural place to assert the signal.
 */
describe('/health surfaces silent degradation', () => {
  it('reports the resolved email mode and warns when nothing is being delivered', async () => {
    const { default: worker } = await import('../../src/index.js')
    const res = await worker.fetch(
      new Request('https://punctual.sh/health'),
      env,
      createExecutionContext(),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; emailDelivery: string; warnings: string[] }

    // `ok` stays pure liveness — the Worker IS up. Flipping it for a
    // deliberately mail-less dev instance would train operators to ignore it.
    expect(body.ok).toBe(true)
    expect(body.emailDelivery).toBe('console')
    // Machine-checkable: a monitor can alert on a non-empty `warnings`.
    expect(body.warnings.length).toBeGreaterThan(0)
    expect(body.warnings.join(' ')).toContain('email_not_configured')
  })

  it('never leaks the provider key itself, only the mode', async () => {
    const { default: worker } = await import('../../src/index.js')
    const res = await worker.fetch(
      new Request('https://punctual.sh/health'),
      env,
      createExecutionContext(),
    )
    const raw = await res.text()
    // /health is unauthenticated. Provider NAMES are not secrets; keys are.
    expect(raw).not.toMatch(/xkeysib-|re_[A-Za-z0-9]/)
  })
})

/**
 * Proves the Workers-project harness itself works: real runtime, real D1,
 * real migrations. If this fails, every other Workers test is meaningless.
 */
describe('workers harness', () => {
  it('has the schema applied', async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>()
    const names = (rows.results ?? []).map((r) => r.name)
    expect(names).toContain('slot_locks')
    expect(names).toContain('bookings')
    expect(names).toContain('slot_holds')
  })

  /**
   * The batch-rollback regression test, now permanent.
   *
   * The anti-double-booking invariant rests on batch() rolling back the WHOLE
   * batch when one statement violates a constraint. Verified on production D1
   * on 2026-08-14; kept here so a platform change cannot silently take it away.
   */
  it('D1 batch() rolls back entirely on a constraint violation', async () => {
    const lock = (h: string, b: number, id: string) =>
      env.DB.prepare(
        'INSERT INTO slot_locks (host_user_id,bucket_start,booking_id) VALUES (?,?,?)',
      ).bind(h, b, id)

    await env.DB.prepare('DELETE FROM slot_locks').run()

    await expect(
      env.DB.batch([
        lock('hostA', 1000, 'bk1'),
        lock('hostA', 1005, 'bk1'),
        lock('hostA', 1010, 'bk1'),
        lock('hostA', 1010, 'bk2'), // duplicate PK — must abort everything
      ]),
    ).rejects.toThrow()

    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks').first<{ n: number }>()
    expect(after?.n).toBe(0)
  })

  /**
   * The real race from ADR-0002: booking B overlaps A at one bucket and must
   * leave nothing behind at its own non-conflicting buckets. A partial commit
   * here would block real slots with locks from a booking that never existed.
   */
  it('a losing booking leaves no ghost locks', async () => {
    const lock = (h: string, b: number, id: string) =>
      env.DB.prepare(
        'INSERT INTO slot_locks (host_user_id,bucket_start,booking_id) VALUES (?,?,?)',
      ).bind(h, b, id)

    await env.DB.prepare('DELETE FROM slot_locks').run()
    await env.DB.batch([lock('hostB', 1000, 'A'), lock('hostB', 1005, 'A'), lock('hostB', 1010, 'A')])

    await expect(
      env.DB.batch([lock('hostB', 1010, 'B'), lock('hostB', 1015, 'B'), lock('hostB', 1020, 'B')]),
    ).rejects.toThrow()

    const ghosts = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = 'B'",
    ).first<{ n: number }>()
    expect(ghosts?.n).toBe(0)

    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks').first<{ n: number }>()
    expect(total?.n).toBe(3)
  })

  /** Holds are advisory: two holds may cover the same bucket, a lock may not. */
  it('slot_holds allows overlapping holds but slot_locks does not', async () => {
    await env.DB.prepare('DELETE FROM slot_holds').run()
    const hold = (h: string, b: number, id: string) =>
      env.DB.prepare(
        'INSERT INTO slot_holds (host_user_id,bucket_start,hold_id,event_type_id,expires_at,created_at) VALUES (?,?,?,?,?,?)',
      ).bind(h, b, id, 'et1', Date.now() + 300_000, Date.now())

    await env.DB.batch([hold('hostC', 3000, 'h1'), hold('hostC', 3000, 'h2')])
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_holds').first<{ n: number }>()
    expect(n?.n).toBe(2)
  })
})

/**
 * A day the calendar advertises must actually show times.
 *
 * The bug this guards: slots are computed for ONE month and the day view
 * filters that set, while the calendar's day links carried only `?date=`. So
 * picking any day outside the current month silently produced "No times
 * available" — the calendar offering days it then refused to serve.
 */
describe('month resolution follows the selected date', () => {
  it('derives the month from ?date= when ?month= is absent', async () => {
    const { default: worker } = await import('../../src/index.js')
    // A date two months out: with the bug, this resolved against the CURRENT
    // month and returned nothing.
    const next = new Date(Date.now() + 62 * 86_400_000)
    const date = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-15`

    const res = await worker.fetch(
      new Request(`https://punctual.sh/nobody/nothing?date=${date}`),
      env,
      createExecutionContext(),
    )
    // The host does not exist, so 404 — but the point is that resolving the
    // month from the date must not throw before we get there.
    expect(res.status).toBe(404)
  })
})

/**
 * CCC-588: the floor clampMonth snaps back to is the earlier of the two
 * parties' current months, not just the host's — so a guest whose own
 * "today" falls a calendar month behind the host's (a date-line split: host
 * already on Sep 1, guest still on Aug 31) never has their default "today"
 * clamped onto a month grid with no cell for it. The ceiling stays anchored
 * purely to the host's month regardless — maxHorizonDays is a host-local
 * scheduling constraint, not something a guest's timezone should stretch or
 * shrink. `clampMonth` is pure (no clock/IO), so this calls it directly
 * rather than needing to straddle a real month boundary in an HTTP test.
 */
describe('clampMonth floor is the earlier of host and guest current months (CCC-588)', () => {
  it('does not clamp the guest-local month forward to a HOST month that has already ticked over', () => {
    // Host already on 2026-09-01 (Kiritimati, UTC+14); guest still on
    // 2026-08-31 (Los Angeles, UTC-7). The floor the caller computes and
    // passes in is the earlier of the two: 2026-08.
    expect(clampMonth('2026-08', '2026-08', '2026-09', 60)).toBe('2026-08')
  })

  it('still clamps forward to the floor when the requested month is genuinely before BOTH parties', () => {
    expect(clampMonth('2026-06', '2026-08', '2026-09', 60)).toBe('2026-08')
  })

  it('the ceiling stays anchored to the HOST month, not the (possibly earlier) floor', () => {
    // A 60-day horizon from the host's Sep anchor reaches into December; if
    // the ceiling were computed from the earlier Aug floor instead, this
    // would wrongly clamp back to November.
    expect(clampMonth('2026-12', '2026-08', '2026-09', 60)).toBe('2026-12')
  })
})

/**
 * A fresh visit to the booking page — no `?date=` at all — must show TODAY's
 * times immediately rather than the generic "Pick a day to see available
 * times" prompt, even though today genuinely has open slots and the
 * calendar itself already marks it as bookable. Every link the page renders
 * carries `?date=`, so a bare load is the ONLY way to reach the unset state.
 */
describe('a fresh page load shows today, not "pick a day"', () => {
  // A suite-level hook, not a seed inside the first `it` (caught by review):
  // storage persists across tests in a file, so the other two tests here
  // passed only because test 1 happened to run first and left the fixture
  // behind. Filtering to one of them with `-t` (or `.only`, or a reorder)
  // skipped that body and 404ed. `beforeAll` rather than `beforeEach`
  // because the rows persist — re-inserting per test hits users.slug's
  // unique index.
  beforeAll(async () => {
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)').bind(
        'u_fresh_load',
        'fresh@example.com',
        'Fresh Host',
        'UTC',
        'fresh-host',
        now,
      ),
      // The whole day, every day — the test must not be flaky depending on
      // what hour it happens to run.
      env.DB.prepare(
        'INSERT INTO schedules (id,user_id,name,is_default,timezone,weekly_json,overrides_json,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(
        'sch_fresh_load',
        'u_fresh_load',
        'Working hours',
        1,
        'UTC',
        JSON.stringify(Array(7).fill([{ startMinute: 0, endMinute: 24 * 60 }])),
        '[]',
        now,
      ),
      env.DB.prepare(
        `INSERT INTO event_types
         (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
          slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
          max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        'et_fresh_load',
        'u_fresh_load',
        null,
        'personal',
        'fresh-intro',
        'Fresh intro call',
        '',
        30,
        null,
        0,
        0,
        0,
        60,
        null,
        'google_meet',
        null,
        '[]',
        1,
        now,
      ),
    ])
  })

  it('defaults the day view to the guest\'s today', async () => {
    const { default: worker } = await import('../../src/index.js')
    const res = await worker.fetch(
      new Request('https://punctual.sh/fresh-host/fresh-intro'),
      env,
      createExecutionContext(),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('Pick a day to see available times')
    // Asserts on the rendered date HEADER, not a slot anchor (caught by
    // review): the 24-hour schedule guarantees slots exist somewhere in the
    // day, but its LAST 30-minute slot starts at 23:30 UTC — a run between
    // 23:30 and 24:00 UTC would find zero remaining slots for "today" and
    // legitimately render "No times available on this day.", which is a
    // correct response to a real edge case, not a bug in the defaulting
    // this test is actually about. `slotList` renders this exact date
    // header in BOTH the has-slots and empty-day branches (booking.ts:423
    // and :454), so it proves the day view defaulted to today regardless of
    // what time the suite happens to run.
    const today = new Date().toISOString().slice(0, 10)
    const [y, m, d] = today.split('-').map(Number)
    const todayHeader = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y!, m! - 1, d!)))
    expect(body).toContain(`<h2>${todayHeader}</h2>`)
  })

  /**
   * Caught by review: defaulting `selectedDate` whenever `?date=` was absent
   * also fired on the Previous/Next month links, which carry `?month=`
   * alone. That re-applied THIS month's "today" as the selected date against
   * a DIFFERENT month's slot set — every month-navigation click rendered a
   * bogus "No times available on this day" instead of just the calendar.
   */
  it('does not carry a stale selected date into month-only navigation', async () => {
    const { default: worker } = await import('../../src/index.js')
    const next = new Date(Date.now() + 32 * 86_400_000)
    const nextMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`

    const res = await worker.fetch(
      new Request(`https://punctual.sh/fresh-host/fresh-intro?month=${nextMonth}&tz=UTC`),
      env,
      createExecutionContext(),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Pick a day to see available times')
    expect(body).not.toContain('No times available on this day')
  })

  /**
   * Caught by review: the day panel must never describe a month the calendar
   * beside it isn't showing — its slots would be unreachable from the
   * visible grid. `clampMonth` can move the calendar off the selected day's
   * own month, and the review's trigger was a date-line split (host already
   * on Sep 1, guest still on Aug 31, so the HOST-local `currentMonth` clamps
   * the GUEST-local default forward). A past `?date=` reaches the identical
   * clamp branch (`month < currentMonth`) without needing to pin the clock
   * or straddle a month boundary.
   */
  it('drops a selected date the month clamp moved the calendar away from', async () => {
    const { default: worker } = await import('../../src/index.js')
    const res = await worker.fetch(
      new Request('https://punctual.sh/fresh-host/fresh-intro?date=2020-01-15&tz=UTC'),
      env,
      createExecutionContext(),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    // Asserts on the day panel's own `<h2>` heading, not a bare "January 15"
    // (caught by review): every calendar cell carries the same human date in
    // its aria-label, so during the first half of any January the CURRENT
    // month's grid legitimately contains that string and a bare
    // `not.toContain` would fail deterministically for two weeks a year.
    expect(body).not.toContain('<h2>Wednesday, January 15</h2>')
    expect(body).toContain('Pick a day to see available times')
  })
})

/**
 * A team-owned event type's public booking page must resolve.
 *
 * The bug: `bookingPageContext` INNER JOINed `event_types` to `users` on
 * `owner_user_id` alone. A round_robin/collective event type has that column
 * NULL (it's owned via `owner_team_id` instead), so the join produced no row
 * and the page 404ed for every team event type — invisible in every other
 * test because they all call `prepareBooking`/`createWithLocks` directly,
 * never through this HTTP route.
 */
describe('a team-owned event type has a working public booking page', () => {
  it('resolves by the team slug instead of 404ing', async () => {
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)').bind(
        'u_team_member',
        'member@example.com',
        'Team Member',
        'UTC',
        'team-member',
        now,
      ),
      env.DB.prepare('INSERT INTO teams (id,name,slug,created_at) VALUES (?,?,?,?)').bind(
        't_sales',
        'Sales',
        'sales-team',
        now,
      ),
      env.DB.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind(
        't_sales',
        'u_team_member',
        'admin',
        1,
      ),
      env.DB.prepare(
        `INSERT INTO event_types
         (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
          slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
          max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        'et_team_intro',
        null,
        't_sales',
        'round_robin',
        'team-intro',
        'Team intro call',
        '',
        30,
        null,
        0,
        0,
        0,
        60,
        null,
        'google_meet',
        null,
        '[]',
        1,
        now,
      ),
    ])

    const { default: worker } = await import('../../src/index.js')
    const res = await worker.fetch(
      new Request('https://punctual.sh/sales-team/team-intro'),
      env,
      createExecutionContext(),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Team intro call')

    // The page must link to itself and its own confirm step under the TEAM
    // slug, not the representative member's personal slug — `bookingPath`
    // used to derive every link from `host.slug`, which `bookingPageContext`
    // resolves to a member's slug for display purposes on a team-owned event
    // type. Every link on the page 404ed the moment a guest clicked it.
    expect(body).toContain('/sales-team/team-intro')
    expect(body).not.toContain('/team-member/team-intro')
  })
})

/**
 * The public booking page is an unauthenticated, D1-reading GET with no
 * limit at all before this change — month-walking is clamped to the event
 * type's horizon, but the page render itself is still a free hammer target.
 * Mirrors the POST confirm route's existing `booking:ip` abuse limit
 * (ADR-0006 §3), against the real DO-backed token bucket rather than a fake,
 * because the algorithm (continuous refill, not a fixed window) is the thing
 * worth trusting here.
 */
describe('the public booking page rate-limits by IP', () => {
  it('allows generous GET traffic, then 429s a hammering IP', async () => {
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)').bind(
        'u_rl_host',
        'rl-host@example.com',
        'RL Host',
        'UTC',
        'rl-host',
        now,
      ),
      env.DB.prepare(
        `INSERT INTO event_types
         (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
          slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
          max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        'et_rl_intro',
        'u_rl_host',
        null,
        'personal',
        'rl-intro',
        'RL intro call',
        '',
        30,
        null,
        0,
        0,
        0,
        60,
        null,
        'google_meet',
        null,
        '[]',
        1,
        now,
      ),
    ])

    const { default: worker } = await import('../../src/index.js')
    // A distinct IP per test run so this suite is order-independent and can
    // never inherit tokens spent by another test hitting the same bucket.
    const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`
    const fetchPage = () =>
      worker.fetch(
        new Request('https://punctual.sh/rl-host/rl-intro', {
          headers: { 'cf-connecting-ip': ip },
        }),
        env,
        createExecutionContext(),
      )

    // Spend the full bucket (120 tokens) — every one must succeed.
    const spendStart = Date.now()
    for (let i = 0; i < 120; i++) {
      const res = await fetchPage()
      expect(res.status).toBe(200)
    }
    const spendElapsedMs = Date.now() - spendStart

    // The rate limiter refills continuously against real wall-clock time
    // (src/do/rate-limiter.ts: 120 tokens / 60s = 1 token per 500ms), not a
    // mockable clock — so the 120-request spend loop above is itself real
    // elapsed time a slow CI host can bank WHOLE extra tokens against, not
    // just a fractional one. A fixed small retry count (previously 5) is not
    // proportional to that: a runner slow enough to take several seconds for
    // the spend loop can bank a dozen or more tokens, and a fixed retry
    // undercounts them — which is exactly what re-flaked this test on CI.
    // Drain however many the measured spend elapsed time could actually have
    // refilled, plus a margin for the drain loop's own (much shorter)
    // elapsed time, rather than guessing a constant.
    const REFILL_PER_MS = 120 / 60_000
    const drainBudget = Math.ceil(spendElapsedMs * REFILL_PER_MS) + 10
    let denied: Response | undefined
    for (let attempt = 0; attempt < drainBudget && denied?.status !== 429; attempt++) {
      denied = await fetchPage()
    }
    expect(denied?.status).toBe(429)
    const retryAfter = Number(denied?.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(60)
    // 120+ sequential real fetches (D1 + a DO-backed rate limiter + full
    // page render each) blew the default 5s test timeout on GitHub's shared
    // CI runners, well before the retry loop even mattered — this machine
    // runs the whole file in ~250ms, but that is not a bound CI honors. The
    // drain loop above can add a proportional number of further requests on
    // a slow runner, so the budget scales with it too.
  }, 60_000)
})
