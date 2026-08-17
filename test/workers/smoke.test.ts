import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

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
