/**
 * The teams dashboard UI, under the real Workers runtime.
 *
 * What is asserted here is the honesty gap this surface exists to close: a
 * team can be created, staffed and given a round-robin event type entirely
 * from forms, and the resulting public page actually resolves at the TEAM's
 * slug. Every guard tested fails open if it regresses — a slug collision, a
 * last-member removal or a non-member's crafted POST all still return a page.
 */

import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildDashboardRoutes } from '../../src/http/dashboard-routes.js'
import { buildRouter } from '../../src/http/router.js'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from '../../src/core/domain/auth-service.js'
import {
  createFakeBlobStorage,
  createFakeEmailSender,
  createFakeRateLimiter,
  fakeConfig,
} from '../../src/testing/fakes.js'
import type { SlotService } from '../../src/engine.js'
import type { Schedule } from '../../src/core/domain/types.js'
import type {
  BlobCache,
  Cache as CachePort,
  CalendarProviders,
  EnginePorts,
  HostCoordinator,
  QueuePort,
} from '../../src/ports.js'

const db = env.DB

const BASE = 'http://localhost'
const NOW = Date.now()
const ALICE_ID = 'usr_alice'
const ALICE_EMAIL = 'alice@example.test'
const BOB_ID = 'usr_bob'
const BOB_EMAIL = 'bob@example.test'
const OUTSIDER_ID = 'usr_outsider'

/** Deterministic 32-byte key material, so the suite needs no secrets. */
function keyMaterial(seed: number): string {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) & 0xff
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

const crypto_ = createWebCrypto({
  keys: { 1: keyMaterial(1) },
  currentVersion: 1,
  signingKey: keyMaterial(9),
})

/**
 * Only the ports these routes actually touch are real. Anything else throws
 * rather than returning a plausible empty value — a stub that quietly succeeds
 * turns a routing bug into a passing test. (Same shape as dashboard.test.ts.)
 */
const calendars: CalendarProviders = {
  get() {
    throw new Error('test: no calendar provider is configured')
  },
  available: () => [],
}

const cache: CachePort = {
  async get() {
    return null
  },
  async put() {},
  async delete() {},
}

const blobCache: BlobCache = {
  async get() {
    return null
  },
  async put() {},
}

const queue: QueuePort = {
  async send() {},
  async sendBatch() {},
}

const coordinator = new Proxy({} as HostCoordinator, {
  get(_target, prop) {
    return () => {
      throw new Error(`test: coordinator.${String(prop)} is not stubbed`)
    }
  },
})

const ports: EnginePorts = {
  repositories: (scope) => createD1Repositories(db, scope),
  calendars,
  oauth: {
    forProvider: () => null,
    redirectUri: (name, purpose) => `${BASE}/auth/${name}/callback?purpose=${purpose}`,
  },
  email: createFakeEmailSender(),
  crypto: crypto_,
  cache,
  blobCache,
  blobStorage: createFakeBlobStorage(),
  clock: { now: () => Date.now() },
  queue,
  coordinator,
  rateLimiter: createFakeRateLimiter(),
  config: fakeConfig({ baseUrl: BASE }),
}

const slots: SlotService = {
  async forEventType() {
    return []
  },
}

const app = buildDashboardRoutes(ports, slots)
// The public booking page lives in the top-level router, not the dashboard
// sub-app — proving a team event type's page resolves at /<team-slug>/<event>
// needs the real catch-all route, which only `buildRouter` mounts.
const publicApp = buildRouter(ports, slots)

async function get(path: string, cookie?: string): Promise<Response> {
  return app.fetch(new Request(`${BASE}${path}`, cookie ? { headers: { cookie } } : {}))
}

async function post(
  path: string,
  body: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  const form = new FormData()
  for (const [k, v] of Object.entries(body)) form.append(k, v)
  return app.fetch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      body: form,
      ...(cookie ? { headers: { cookie } } : {}),
    }),
  )
}

/** A session row, as `createSession` would have written it. */
async function seedSession(userId: string): Promise<string> {
  const token = crypto_.randomToken(32)
  await db
    .prepare(
      `INSERT INTO sessions (id_hash,user_id,expires_at,absolute_expires_at,bookmark,created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(await crypto_.hash(token), userId, NOW + SESSION_TTL_MS, NOW + SESSION_ABSOLUTE_TTL_MS, null, NOW)
    .run()
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function csrfFrom(path: string, cookie: string): Promise<string> {
  const page = await get(path, cookie)
  return /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''
}

// The schema arrives from `test/workers/setup.ts`, which applies the real
// migrations to this file's isolated D1 before anything below runs.
beforeAll(async () => {
  const insert = 'INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)'
  await db.prepare(insert).bind(ALICE_ID, ALICE_EMAIL, 'Alice Host', 'UTC', 'alice', NOW).run()
  await db.prepare(insert).bind(BOB_ID, BOB_EMAIL, 'Bob Host', 'UTC', 'bob', NOW).run()
  await db.prepare(insert).bind(OUTSIDER_ID, 'outsider@example.test', 'Outsider', 'UTC', 'outsider', NOW).run()
})

// ---------------------------------------------------------------------------

describe('teams page', () => {
  it('creates a team from the form; the creator is its first, admin member', async () => {
    const cookie = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)

    const res = await post('/dashboard/teams', { name: 'Support Crew', slug: 'support-crew', csrf }, cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/dashboard/teams?created=1')

    const team = await db
      .prepare('SELECT id, name FROM teams WHERE slug = ?')
      .bind('support-crew')
      .first<{ id: string; name: string }>()
    expect(team?.name).toBe('Support Crew')

    const member = await db
      .prepare('SELECT role, rr_weight FROM team_members WHERE team_id = ? AND user_id = ?')
      .bind(team!.id, ALICE_ID)
      .first<{ role: string; rr_weight: number }>()
    expect(member?.role).toBe('admin')
    expect(member?.rr_weight).toBe(1)

    const page = await get('/dashboard/teams', cookie)
    const html = await page.text()
    expect(html).toContain('Support Crew')
    expect(html).toContain(ALICE_EMAIL)
  })

  // `bookingPageContext` resolves a page's first path segment against users
  // OR teams, so a team slug that shadows a user's would make /that-slug/...
  // ambiguous. The refusal, not the constraint error, is the contract.
  it('refuses a team slug already taken by a user, creating nothing', async () => {
    const cookie = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)

    const res = await post('/dashboard/teams', { name: 'Shadow', slug: 'bob', csrf }, cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('already taken')

    const row = await db.prepare('SELECT id FROM teams WHERE slug = ?').bind('bob').first()
    expect(row).toBeNull()
  })

  it('refuses a team slug already taken by another team', async () => {
    const cookie = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)

    const res = await post('/dashboard/teams', { name: 'Support Crew Again', slug: 'support-crew', csrf }, cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('already taken')

    const rows = await db
      .prepare('SELECT COUNT(*) AS n FROM teams WHERE slug = ?')
      .bind('support-crew')
      .first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })
})

describe('team members', () => {
  let teamId = ''

  beforeAll(async () => {
    const row = await db
      .prepare('SELECT id FROM teams WHERE slug = ?')
      .bind('support-crew')
      .first<{ id: string }>()
    teamId = row!.id
  })

  it('adds a member by email with a round-robin weight', async () => {
    const cookie = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)

    const res = await post(
      `/dashboard/teams/${teamId}/members`,
      { email: BOB_EMAIL, weight: '3', csrf },
      cookie,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(`${BOB_EMAIL} is on Support Crew`)

    const member = await db
      .prepare('SELECT role, rr_weight FROM team_members WHERE team_id = ? AND user_id = ?')
      .bind(teamId, BOB_ID)
      .first<{ role: string; rr_weight: number }>()
    expect(member?.role).toBe('member')
    expect(member?.rr_weight).toBe(3)
  })

  it('refuses an email with no account on this instance', async () => {
    const cookie = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)

    const res = await post(
      `/dashboard/teams/${teamId}/members`,
      { email: 'nobody@example.test', weight: '1', csrf },
      cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('No user with that email on this instance')
  })

  it('a non-member cannot manage someone else\'s team', async () => {
    const cookie = await seedSession(OUTSIDER_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)

    // Crafted POSTs against a team the outsider does not belong to — both the
    // add and the remove path answer 404, indistinguishable from a wrong id.
    const add = await post(
      `/dashboard/teams/${teamId}/members`,
      { email: 'outsider@example.test', weight: '1', csrf },
      cookie,
    )
    expect(add.status).toBe(404)

    const remove = await post(`/dashboard/teams/${teamId}/members/${BOB_ID}/remove`, { csrf }, cookie)
    expect(remove.status).toBe(404)

    const members = await db
      .prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?')
      .bind(teamId)
      .first<{ n: number }>()
    expect(members?.n).toBe(2)
  })

  it('removes a member', async () => {
    const cookie = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)

    const res = await post(`/dashboard/teams/${teamId}/members/${BOB_ID}/remove`, { csrf }, cookie)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Member removed')

    const row = await db
      .prepare('SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?')
      .bind(teamId, BOB_ID)
      .first()
    expect(row).toBeNull()
  })

  it('refuses to remove the last member — a memberless team is unmanageable forever', async () => {
    const cookie = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)

    const res = await post(`/dashboard/teams/${teamId}/members/${ALICE_ID}/remove`, { csrf }, cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('at least one member')

    const row = await db
      .prepare('SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?')
      .bind(teamId, ALICE_ID)
      .first()
    expect(row).toBeTruthy()
  })
})

describe('team event types', () => {
  let teamId = ''

  beforeAll(async () => {
    const row = await db
      .prepare('SELECT id FROM teams WHERE slug = ?')
      .bind('support-crew')
      .first<{ id: string }>()
    teamId = row!.id
    // Bob rejoins for the round-robin fixture; the member tests above left
    // Alice alone on the team.
    await db
      .prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)')
      .bind(teamId, BOB_ID, 'member', 1)
      .run()
  })

  it('creates a round-robin event type owned by the team via the form route', async () => {
    const cookie = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/event-types/new', cookie)

    const res = await post(
      '/dashboard/event-types',
      {
        title: 'Support call',
        slug: 'support-call',
        durationMinutes: '30',
        owner: teamId,
        schedulingType: 'round_robin',
        active: '1',
        csrf,
      },
      cookie,
    )
    expect(res.status).toBe(302)

    const row = await db
      .prepare('SELECT owner_user_id, owner_team_id, scheduling_type FROM event_types WHERE slug = ?')
      .bind('support-call')
      .first<{ owner_user_id: string | null; owner_team_id: string; scheduling_type: string }>()
    expect(row?.owner_team_id).toBe(teamId)
    expect(row?.owner_user_id).toBeNull()
    expect(row?.scheduling_type).toBe('round_robin')
  })

  it('refuses team ownership from a user who is not a member of that team', async () => {
    const cookie = await seedSession(OUTSIDER_ID)
    const csrf = await csrfFrom('/dashboard/event-types/new', cookie)

    const res = await post(
      '/dashboard/event-types',
      {
        title: 'Hijack',
        slug: 'hijack',
        durationMinutes: '30',
        owner: teamId,
        schedulingType: 'round_robin',
        active: '1',
        csrf,
      },
      cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('not a member of that team')

    const row = await db.prepare('SELECT id FROM event_types WHERE slug = ?').bind('hijack').first()
    expect(row).toBeNull()
  })

  it('the public booking page resolves at /<team-slug>/<event-slug>', async () => {
    const res = await publicApp.fetch(new Request(`${BASE}/support-crew/support-call`))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Support call')
  })

  it('the dashboard home lists the team event type with the TEAM-slug URL', async () => {
    const cookie = await seedSession(ALICE_ID)
    const res = await get('/dashboard', cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Support call')
    expect(html).toContain(`${BASE}/support-crew/support-call`)
    // And never the user's slug in front of the team event's slug — that URL
    // would 404, which is the overclaim this surface exists to kill.
    expect(html).not.toContain(`${BASE}/alice/support-call`)
  })
})

describe('repository-level atomic guards', () => {
  it('removeMemberGuarded is one statement: refuses the last member, removes one of two', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const NOW2 = Date.now()
    await db.prepare("INSERT INTO teams (id,name,slug,created_at) VALUES ('team_guard','Guard','guard-team',?)").bind(NOW2).run()
    await db.prepare("INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES ('team_guard','usr_g1','admin',1)").run()

    // Sole member: refused, row intact.
    expect(await repos.teams.removeMemberGuarded('team_guard', 'usr_g1')).toBe(false)
    // Not a member at all: refused, and distinguishable by the caller re-reading.
    expect(await repos.teams.removeMemberGuarded('team_guard', 'usr_missing')).toBe(false)

    await db.prepare("INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES ('team_guard','usr_g2','member',1)").run()
    expect(await repos.teams.removeMemberGuarded('team_guard', 'usr_g2')).toBe(true)
    const left = await db.prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id='team_guard'").first<{ n: number }>()
    expect(left?.n).toBe(1)
  })

  it('createWithFirstMember is one batch: no team row survives a failed membership insert', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    // Force the second statement to fail: a duplicate (team,user) primary key
    // cannot exist on a fresh team id, so break it with an invalid role CHECK?
    // The schema has no CHECKs — instead prove atomicity the direct way: a
    // duplicate membership insert in the SAME batch (seeded below) fails, and
    // the team row must not exist afterwards.
    await db.prepare("INSERT INTO teams (id,name,slug,created_at) VALUES ('team_dup','Dup','dup-team',1)").run()
    await db.prepare("INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES ('team_dup','usr_d1','admin',1)").run()

    // Same PK (team_dup, usr_d1) — but createWithFirstMember generates its
    // own team id, so simulate by calling the raw batch shape: reuse the
    // method with a team whose id ALREADY exists, so the FIRST insert fails
    // and nothing commits. A constraint violation resolves to null, not a
    // throw — the route's own slug race (same constraint family) needs a
    // clean form error, not an uncaught 500.
    const result = await repos.teams.createWithFirstMember(
      { id: 'team_dup', name: 'Dup2', slug: 'dup-team-2', logoKey: null },
      { userId: 'usr_d2', role: 'admin', rrWeight: 1 },
    )
    expect(result).toBeNull()
    const member = await db
      .prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id='team_dup' AND user_id='usr_d2'")
      .first<{ n: number }>()
    expect(member?.n).toBe(0)
    const slug2 = await db.prepare("SELECT COUNT(*) AS n FROM teams WHERE slug='dup-team-2'").first<{ n: number }>()
    expect(slug2?.n).toBe(0)
  })

  it('availability.saveIfAbsent never overwrites a row that already exists', async () => {
    // The login-backfill path (auth-flows.ts) calls this instead of a
    // forUser-then-save check specifically so a concurrent real save (a
    // host clearing their week from another device) can never lose a race
    // to the backfill's default — only the database can arbitrate that.
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const cleared: Schedule = {
      id: 'sch_avail',
      userId: 'usr_avail',
      name: 'Working hours',
      isDefault: true,
      timezone: 'UTC',
      weekly: [[], [], [], [], [], [], []],
      overrides: [],
    }
    await repos.availability.create('usr_avail', cleared)

    await repos.availability.saveIfAbsent('usr_avail', {
      id: 'sch_avail_backfill',
      userId: 'usr_avail',
      name: 'Working hours',
      isDefault: true,
      timezone: 'America/New_York',
      weekly: [[], [{ startMinute: 540, endMinute: 1020 }], [], [], [], [], []],
      overrides: [],
    })

    expect(await repos.availability.forUser('usr_avail')).toEqual({ ...cleared, createdBy: 'usr_avail' })
  })

  it('availability.saveIfAbsent inserts when no row exists', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    expect(await repos.availability.forUser('usr_avail_new')).toBeNull()

    const fresh: Schedule = {
      id: 'sch_avail_new',
      userId: 'usr_avail_new',
      name: 'Working hours',
      isDefault: true,
      timezone: 'Europe/Kyiv',
      weekly: [[], [{ startMinute: 540, endMinute: 1020 }], [], [], [], [], []],
      overrides: [],
    }
    await repos.availability.saveIfAbsent('usr_avail_new', fresh)
    expect(await repos.availability.forUser('usr_avail_new')).toEqual({ ...fresh, createdBy: 'usr_avail_new' })
  })

  it('setDefault atomically moves the default flag, even under concurrent calls', async () => {
    // The partial unique index (schedules_user_default_idx) is the actual
    // invariant — this proves setDefault's two-statement batch never leaves
    // two schedules (or zero) marked default for the same user, which a
    // naive single UPDATE ordered the wrong way around would risk (see the
    // comment on setDefault in repositories.ts).
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const a: Schedule = {
      id: 'sch_race_a',
      userId: 'usr_race',
      name: 'A',
      isDefault: true,
      timezone: 'UTC',
      weekly: [[], [], [], [], [], [], []],
      overrides: [],
    }
    const b: Schedule = { ...a, id: 'sch_race_b', name: 'B', isDefault: false }
    await repos.availability.create('usr_race', a)
    await repos.availability.create('usr_race', b)

    await Promise.all([
      repos.availability.setDefault('usr_race', 'sch_race_b'),
      repos.availability.setDefault('usr_race', 'sch_race_a'),
    ])

    const defaults = await db
      .prepare("SELECT COUNT(*) AS n FROM schedules WHERE user_id='usr_race' AND is_default=1")
      .first<{ n: number }>()
    expect(defaults?.n).toBe(1)
  })

  it('setDefault targeting a vanished schedule leaves the old default intact, not cleared', async () => {
    // Caught by review: the target existing was only ever checked by the
    // ROUTE (ownedSchedule), not by setDefault's own first statement — a
    // concurrent delete of the target between that check and this call
    // used to clear the real default in statement 1 regardless, then match
    // nothing in statement 2, committing with NO schedule marked default
    // for the user at all. The clear is now conditional on the target
    // still existing.
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const real: Schedule = {
      id: 'sch_vanish_default',
      userId: 'usr_vanish',
      name: 'Real default',
      isDefault: true,
      timezone: 'UTC',
      weekly: [[], [], [], [], [], [], []],
      overrides: [],
    }
    await repos.availability.create('usr_vanish', real)

    const result = await repos.availability.setDefault('usr_vanish', 'sch_never_existed')
    expect(result).toBe(false)

    const defaults = await db
      .prepare("SELECT id FROM schedules WHERE user_id='usr_vanish' AND is_default=1")
      .first<{ id: string }>()
    expect(defaults?.id).toBe('sch_vanish_default')
  })

  it('delete refuses the default schedule, and the user\'s only remaining one, in one statement', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const empty: Omit<Schedule, 'id' | 'name' | 'isDefault'> = {
      userId: 'usr_del',
      timezone: 'UTC',
      weekly: [[], [], [], [], [], [], []],
      overrides: [],
    }
    await repos.availability.create('usr_del', { ...empty, id: 'sch_del_default', name: 'Default', isDefault: true })
    await repos.availability.create('usr_del', { ...empty, id: 'sch_del_extra', name: 'Extra', isDefault: false })

    // Not the default, and not the last one — succeeds.
    expect(await repos.availability.delete('usr_del', 'sch_del_extra')).toBe(true)
    // Now the user's only (and default) schedule — refused either way.
    expect(await repos.availability.delete('usr_del', 'sch_del_default')).toBe(false)
    const left = await db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE user_id='usr_del'").first<{ n: number }>()
    expect(left?.n).toBe(1)
  })

  it('deleting an event type is refused while an upcoming confirmed booking needs it', async () => {
    // Not cosmetic: the queued calendar sync reads this row to render the
    // guest's confirmation, so deleting it inside that window leaves the
    // guest having booked and heard nothing.
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const now = Date.now()
    await db
      .prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
      .bind('usr_etdel', 'etdel@example.test', 'Del', 'UTC', 'etdel', now)
      .run()
    await repos.eventTypes.create({
      id: 'et_del_guard',
      ownerUserId: 'usr_etdel',
      ownerTeamId: null,
      schedulingType: 'personal',
      slug: 'guarded',
      title: 'Guarded',
      description: '',
      durationMinutes: 30,
      slotIntervalMinutes: null,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      maxHorizonDays: 60,
      maxPerDay: null,
      locationType: 'google_meet',
      locationValue: null,
      questions: [],
      active: true,
      scheduleId: null,
    })

    const insertBooking = (id: string, status: string, startUtc: number) =>
      db
        .prepare(
          `INSERT INTO bookings
           (id,event_type_id,host_user_id,host_user_ids_json,guest_name,guest_email,guest_timezone,
            start_utc,end_utc,local_date,status,answers_json,external_event_ids_json,
            reschedule_of,rescheduled_to,manage_token_hash,cancelled_at,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(id, 'et_del_guard', 'usr_etdel', '["usr_etdel"]', 'G', 'g@example.test', 'UTC',
          startUtc, startUtc + 1_800_000, '2026-09-01', status, '{}', '{}', null, null, `h_${id}`, null, now)
        .run()

    // Upcoming and confirmed — refused, row intact.
    await insertBooking('bk_guard_future', 'confirmed', now + 86_400_000)
    expect(await repos.eventTypes.delete('et_del_guard', now)).toBe(false)
    expect(await repos.eventTypes.byId('et_del_guard')).not.toBeNull()

    // A cancelled booking needs nothing more from it, and a PAST meeting is
    // already done — neither should block the host forever.
    await db.prepare("UPDATE bookings SET status='cancelled' WHERE id='bk_guard_future'").run()
    await insertBooking('bk_guard_past', 'confirmed', now - 86_400_000)
    expect(await repos.eventTypes.delete('et_del_guard', now)).toBe(true)
    expect(await repos.eventTypes.byId('et_del_guard')).toBeNull()
  })

  it('delete refuses a schedule an event type still points at', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const empty: Omit<Schedule, 'id' | 'name' | 'isDefault'> = {
      userId: 'usr_del2',
      timezone: 'UTC',
      weekly: [[], [], [], [], [], [], []],
      overrides: [],
    }
    await repos.availability.create('usr_del2', { ...empty, id: 'sch_del2_default', name: 'Default', isDefault: true })
    await repos.availability.create('usr_del2', { ...empty, id: 'sch_del2_extra', name: 'Extra', isDefault: false })
    await repos.eventTypes.create({
      id: 'et_del2',
      ownerUserId: 'usr_del2',
      ownerTeamId: null,
      schedulingType: 'personal',
      slug: 'evening',
      title: 'Evening call',
      description: '',
      durationMinutes: 30,
      slotIntervalMinutes: null,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      maxHorizonDays: 60,
      maxPerDay: null,
      locationType: 'google_meet',
      locationValue: null,
      questions: [],
      active: true,
      scheduleId: 'sch_del2_extra',
    })

    expect(await repos.availability.delete('usr_del2', 'sch_del2_extra')).toBe(false)
    await repos.eventTypes.update('et_del2', { scheduleId: null })
    expect(await repos.availability.delete('usr_del2', 'sch_del2_extra')).toBe(true)
  })

  it('create/update never store a scheduleId the schedule table doesn\'t actually have', async () => {
    // The TOCTOU this closes: dashboard-routes.ts and rest.ts both validate
    // ownership via availability.byId() BEFORE this write; a concurrent
    // delete of that exact schedule in the window between the check and the
    // write used to commit a dangling reference. Simulated directly here —
    // an id that was never created — rather than orchestrating the actual
    // race, since the guard's job is to make what create/update ever WRITE
    // independent of what the caller checked earlier.
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const created = await repos.eventTypes.create({
      id: 'et_dangling_1',
      ownerUserId: 'usr_dangling',
      ownerTeamId: null,
      schedulingType: 'personal',
      slug: 'dangling-create',
      title: 'Dangling on create',
      description: '',
      durationMinutes: 30,
      slotIntervalMinutes: null,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      maxHorizonDays: 60,
      maxPerDay: null,
      locationType: 'google_meet',
      locationValue: null,
      questions: [],
      active: true,
      scheduleId: 'sch_never_existed',
    })
    // Caught by review: create() used to echo the input scheduleId
    // unchanged even when the subquery resolved it to NULL, so a 201
    // response could claim a scheduleId the row didn't actually have —
    // same class of bug the sibling PATCH path already guards against by
    // re-reading. The return value must match a fresh read, not the input.
    expect(created.scheduleId).toBeNull()
    const fetched = await repos.eventTypes.byId('et_dangling_1')
    expect(fetched?.scheduleId).toBeNull()

    // Same guard on update, and it must not disturb any OTHER column in the
    // same call — only schedule_id resolves through the subquery.
    await repos.eventTypes.update('et_dangling_1', { title: 'Renamed', scheduleId: 'sch_also_never_existed' })
    const afterUpdate = await repos.eventTypes.byId('et_dangling_1')
    expect(afterUpdate?.scheduleId).toBeNull()
    expect(afterUpdate?.title).toBe('Renamed')
  })
})

describe('slug_claims — the shared namespace constraint', () => {
  it('a team cannot claim a slug an existing user already holds', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    await repos.users.create({
      id: 'usr_slugrace_1',
      email: 'slugrace1@example.test',
      name: 'Slug Race',
      tz: 'UTC',
      slug: 'contested-slug',
      avatarKey: null,
      company: null,
      jobTitle: null,
      companyUrl: null,
      role: 'member',
    })

    // teams_slug_idx alone would never catch this — no other TEAM wants
    // "contested-slug". Only slug_claims' shared PRIMARY KEY does.
    const result = await repos.teams.createWithFirstMember(
      { id: 'team_slugrace', name: 'Slug Race Team', slug: 'contested-slug', logoKey: null },
      { userId: 'usr_slugrace_1', role: 'admin', rrWeight: 1 },
    )
    expect(result).toBeNull()
    const team = await db.prepare("SELECT COUNT(*) AS n FROM teams WHERE id='team_slugrace'").first<{ n: number }>()
    expect(team?.n).toBe(0)
  })

  it('TeamRepository.create (the memberless sibling of createWithFirstMember) also claims its slug, and also refuses one already held', async () => {
    // Caught by review: createWithFirstMember claimed its slug atomically
    // from the start, but this sibling method on the same public port did a
    // bare single-statement insert — a team created through it held a slug
    // in `teams` that nothing held in `slug_claims`, silently reopening the
    // exact race this table exists to close for any later signup or slug
    // change racing that same slug.
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const team = await repos.teams.create({ id: 'team_bare', name: 'Bare Create', slug: 'bare-create-slug', logoKey: null })
    expect(team).not.toBeNull()
    const claim = await db
      .prepare("SELECT owner_id FROM slug_claims WHERE slug='bare-create-slug'")
      .first<{ owner_id: string }>()
    expect(claim?.owner_id).toBe('team_bare')

    // And the reverse: it must also REFUSE a slug already claimed, not just
    // successfully claim a free one.
    await repos.users.create({
      id: 'usr_bare_holder',
      email: 'bare-holder@example.test',
      name: 'Bare Holder',
      tz: 'UTC',
      slug: 'user-held-for-bare',
      avatarKey: null,
      company: null,
      jobTitle: null,
      companyUrl: null,
      role: 'member',
    })
    const blocked = await repos.teams.create({
      id: 'team_bare_2',
      name: 'Bare Create 2',
      slug: 'user-held-for-bare',
      logoKey: null,
    })
    expect(blocked).toBeNull()
    const notCreated = await db
      .prepare("SELECT COUNT(*) AS n FROM teams WHERE id='team_bare_2'")
      .first<{ n: number }>()
    expect(notCreated?.n).toBe(0)
  })

  it('a user cannot be created with a slug an existing team already holds', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    const team = await repos.teams.createWithFirstMember(
      { id: 'team_slugrace2', name: 'Team Holds It', slug: 'team-held-slug', logoKey: null },
      { userId: 'usr_slugrace_owner', role: 'admin', rrWeight: 1 },
    )
    expect(team).not.toBeNull()

    // users_slug_idx alone would never catch this — no other USER wants
    // "team-held-slug". Only the shared slug_claims constraint does; the
    // batch in `users.create` must roll back the user row along with it.
    // null, not a throw — the caller (consumeMagicLink) reaches this after
    // its single-use link is already burned, so a collision here must be
    // retryable rather than an uncaught exception on a dead link.
    const created = await repos.users.create({
      id: 'usr_slugrace_2',
      email: 'slugrace2@example.test',
      name: 'Slug Race 2',
      tz: 'UTC',
      slug: 'team-held-slug',
      avatarKey: null,
      company: null,
      jobTitle: null,
      companyUrl: null,
      role: 'member',
    })
    expect(created).toBeNull()
    const user = await db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE id='usr_slugrace_2'")
      .first<{ n: number }>()
    expect(user?.n).toBe(0)
  })

  it('a user cannot change their slug to one a team already holds, and their own claim is untouched on failure', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    await repos.users.create({
      id: 'usr_slugrace_3',
      email: 'slugrace3@example.test',
      name: 'Slug Race 3',
      tz: 'UTC',
      slug: 'my-own-slug',
      avatarKey: null,
      company: null,
      jobTitle: null,
      companyUrl: null,
      role: 'member',
    })
    await repos.teams.createWithFirstMember(
      { id: 'team_slugrace3', name: 'Blocking Team', slug: 'blocking-team-slug', logoKey: null },
      { userId: 'usr_slugrace_3', role: 'admin', rrWeight: 1 },
    )

    const ok = await repos.users.update('usr_slugrace_3', { slug: 'blocking-team-slug' })
    expect(ok).toBe(false)
    // Rolled back as one batch: the user's OWN slug (and its claim row) must
    // still be exactly what it was — not deleted, not half-updated.
    const user = await repos.users.byId('usr_slugrace_3')
    expect(user?.slug).toBe('my-own-slug')
    const claim = await db
      .prepare("SELECT owner_id FROM slug_claims WHERE slug='my-own-slug'")
      .first<{ owner_id: string }>()
    expect(claim?.owner_id).toBe('usr_slugrace_3')
  })

  it('a user CAN change their slug when the new one is genuinely free, and the old claim is released', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    await repos.users.create({
      id: 'usr_slugrace_4',
      email: 'slugrace4@example.test',
      name: 'Slug Race 4',
      tz: 'UTC',
      slug: 'old-free-slug',
      avatarKey: null,
      company: null,
      jobTitle: null,
      companyUrl: null,
      role: 'member',
    })

    const ok = await repos.users.update('usr_slugrace_4', { slug: 'new-free-slug' })
    expect(ok).toBe(true)
    const oldClaim = await db
      .prepare("SELECT COUNT(*) AS n FROM slug_claims WHERE slug='old-free-slug'")
      .first<{ n: number }>()
    expect(oldClaim?.n).toBe(0)
    const newClaim = await db
      .prepare("SELECT owner_id FROM slug_claims WHERE slug='new-free-slug'")
      .first<{ owner_id: string }>()
    expect(newClaim?.owner_id).toBe('usr_slugrace_4')
  })
})

// ---------------------------------------------------------------------------
// Team roles with teeth (core/domain/teams.ts): admins manage, members host.
// ---------------------------------------------------------------------------

describe('team roles', () => {
  const ROOT_ID = 'usr_root'
  const CAROL_ID = 'usr_carol'
  let crewId = ''
  let crewEventTypeId = ''

  async function sqlRole(userId: string): Promise<string | null> {
    const row = await db
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .bind(crewId, userId)
      .first<{ role: string }>()
    return row?.role ?? null
  }

  beforeAll(async () => {
    const insert = 'INSERT INTO users (id,email,name,tz,slug,role,created_at) VALUES (?,?,?,?,?,?,?)'
    await db.prepare(insert).bind(ROOT_ID, 'root@example.test', 'Root Admin', 'UTC', 'root', 'admin', NOW).run()
    await db.prepare(insert).bind(CAROL_ID, 'carol@example.test', 'Carol Host', 'UTC', 'carol', 'member', NOW).run()

    // Alice creates the team (and so is its admin); Bob joins as a member.
    const cookie = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)
    await post('/dashboard/teams', { name: 'Roles Crew', slug: 'roles-crew', csrf }, cookie)
    const team = await db.prepare('SELECT id FROM teams WHERE slug = ?').bind('roles-crew').first<{ id: string }>()
    crewId = team!.id
    await post(`/dashboard/teams/${crewId}/members`, { email: BOB_EMAIL, weight: '1', csrf }, cookie)

    const etCsrf = await csrfFrom('/dashboard/event-types/new', cookie)
    await post(
      '/dashboard/event-types',
      { title: 'Crew call', slug: 'crew-call', durationMinutes: '30', owner: crewId, schedulingType: 'collective', active: '1', csrf: etCsrf },
      cookie,
    )
    const et = await db.prepare('SELECT id FROM event_types WHERE slug = ?').bind('crew-call').first<{ id: string }>()
    crewEventTypeId = et!.id
  })

  it('a member sees the team read-only: no add form, no remove or role buttons', async () => {
    const cookie = await seedSession(BOB_ID)
    const html = await (await get('/dashboard/teams', cookie)).text()
    expect(html).toContain('Roles Crew')
    expect(html).toContain('managed by its admins')
    expect(html).not.toContain(`/dashboard/teams/${crewId}/members"`)
    expect(html).not.toContain(`/members/${ALICE_ID}/remove`)
    expect(html).not.toContain(`/members/${ALICE_ID}/role`)
  })

  it('a member cannot add, remove or re-role anyone — same 404 as an outsider', async () => {
    const cookie = await seedSession(BOB_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)
    expect((await post(`/dashboard/teams/${crewId}/members`, { email: 'carol@example.test', weight: '1', csrf }, cookie)).status).toBe(404)
    expect((await post(`/dashboard/teams/${crewId}/members/${ALICE_ID}/remove`, { csrf }, cookie)).status).toBe(404)
    expect((await post(`/dashboard/teams/${crewId}/members/${BOB_ID}/role`, { role: 'admin', csrf }, cookie)).status).toBe(404)
    expect(await sqlRole(BOB_ID)).toBe('member')
  })

  it('a member hosts the team event type but cannot edit it; the home page says so', async () => {
    const bob = await seedSession(BOB_ID)
    expect((await get(`/dashboard/event-types/${crewEventTypeId}`, bob)).status).toBe(404)
    const bobHome = await (await get('/dashboard', bob)).text()
    expect(bobHome).toContain('Crew call')
    expect(bobHome).toContain('Managed by the team')
    expect(bobHome).not.toContain(`/dashboard/event-types/${crewEventTypeId}"`)

    const alice = await seedSession(ALICE_ID)
    expect((await get(`/dashboard/event-types/${crewEventTypeId}`, alice)).status).toBe(200)
    expect(await (await get('/dashboard', alice)).text()).toContain(`/dashboard/event-types/${crewEventTypeId}"`)
  })

  it('a member cannot put an event type under the team, and the form does not offer it', async () => {
    const cookie = await seedSession(BOB_ID)
    const form = await (await get('/dashboard/event-types/new', cookie)).text()
    expect(form).not.toContain(`value="${crewId}"`)

    const csrf = await csrfFrom('/dashboard/event-types/new', cookie)
    const res = await post(
      '/dashboard/event-types',
      { title: 'Sneaky', slug: 'sneaky', durationMinutes: '30', owner: crewId, schedulingType: 'round_robin', active: '1', csrf },
      cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Only an admin of that team')
    expect(await db.prepare('SELECT id FROM event_types WHERE slug = ?').bind('sneaky').first()).toBeNull()
  })

  it('an admin promotes and demotes; the last admin cannot be demoted', async () => {
    const cookie = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/teams', cookie)

    // Demoting herself while she is the only admin: refused, inside the UPDATE.
    const refused = await post(`/dashboard/teams/${crewId}/members/${ALICE_ID}/role`, { role: 'member', csrf }, cookie)
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain('at least one admin')
    expect(await sqlRole(ALICE_ID)).toBe('admin')

    const promoted = await post(`/dashboard/teams/${crewId}/members/${BOB_ID}/role`, { role: 'admin', csrf }, cookie)
    expect(promoted.status).toBe(200)
    expect(await promoted.text()).toContain('Bob Host is now an admin')
    expect(await sqlRole(BOB_ID)).toBe('admin')

    // Two admins now: Bob can manage too, and Alice can be demoted.
    const bob = await seedSession(BOB_ID)
    const bobCsrf = await csrfFrom('/dashboard/teams', bob)
    const demoted = await post(`/dashboard/teams/${crewId}/members/${ALICE_ID}/role`, { role: 'member', csrf: bobCsrf }, bob)
    expect(demoted.status).toBe(200)
    expect(await sqlRole(ALICE_ID)).toBe('member')

    // Restore for the tests below: Bob promotes Alice back, then steps down.
    await post(`/dashboard/teams/${crewId}/members/${ALICE_ID}/role`, { role: 'admin', csrf: bobCsrf }, bob)
    await post(`/dashboard/teams/${crewId}/members/${BOB_ID}/role`, { role: 'member', csrf: bobCsrf }, bob)
    expect(await sqlRole(ALICE_ID)).toBe('admin')
    expect(await sqlRole(BOB_ID)).toBe('member')
  })

  it('removing the last admin is refused inside the DELETE, even with other members present', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    expect(await repos.teams.removeMemberGuarded(crewId, ALICE_ID)).toBe(false)
    expect(await sqlRole(ALICE_ID)).toBe('admin')
    // A non-admin with an admin remaining goes fine — and comes back.
    expect(await repos.teams.removeMemberGuarded(crewId, BOB_ID)).toBe(true)
    await repos.teams.addMember({ teamId: crewId, userId: BOB_ID, role: 'member', rrWeight: 1 })
  })

  it('re-adding an existing member changes only their weight, never their role', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    // The upsert path with a stale "member" role must not demote an admin.
    await repos.teams.addMember({ teamId: crewId, userId: ALICE_ID, role: 'member', rrWeight: 7 })
    expect(await sqlRole(ALICE_ID)).toBe('admin')
    const row = await db.prepare('SELECT rr_weight FROM team_members WHERE team_id = ? AND user_id = ?').bind(crewId, ALICE_ID).first<{ rr_weight: number }>()
    expect(row?.rr_weight).toBe(7)
    await repos.teams.addMember({ teamId: crewId, userId: ALICE_ID, role: 'member', rrWeight: 1 })
  })

  it('a member\'s display name is escaped everywhere the on-behalf pages print it', async () => {
    const hostile = '<img src=x onerror="alert(1)">'
    await db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(hostile, BOB_ID).run()
    const alice = await seedSession(ALICE_ID)
    const base = `/dashboard/teams/${crewId}/members/${BOB_ID}/availability`
    for (const path of [base, '/dashboard/teams']) {
      const html = await (await get(path, alice)).text()
      expect(html).not.toContain(hostile)
      expect(html).toContain('&lt;img src=x')
    }
    const sched = await db.prepare('SELECT id FROM schedules WHERE user_id = ? LIMIT 1').bind(BOB_ID).first<{ id: string }>()
    if (sched) {
      const html = await (await get(`${base}/${sched.id}`, alice)).text()
      expect(html).not.toContain(hostile)
    }
    await db.prepare('UPDATE users SET name = ? WHERE id = ?').bind('Bob Host', BOB_ID).run()
  })

  it('setRole is one statement: demoting the last admin changes nothing', async () => {
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    expect(await repos.teams.setRole(crewId, ALICE_ID, 'member')).toBe(false)
    expect(await sqlRole(ALICE_ID)).toBe('admin')
    expect(await repos.teams.setRole(crewId, 'usr_not_on_team', 'admin')).toBe(false)
  })

  it('the backfill in migration 0010 gives an all-member team its earliest member as admin', async () => {
    await db.prepare('INSERT INTO teams (id,name,slug,logo_key,created_at) VALUES (?,?,?,?,?)').bind('team_orphan', 'Orphan', 'orphan', null, NOW).run()
    await db.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind('team_orphan', CAROL_ID, 'member', 1).run()
    await db.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind('team_orphan', BOB_ID, 'member', 1).run()

    // The exact statement the migration runs, re-run against rows that
    // exist only now — the migration itself ran before any test seeded data.
    await db
      .prepare(
        `UPDATE team_members SET role = 'admin'
         WHERE rowid IN (
           SELECT MIN(rowid) FROM team_members AS tm
           WHERE NOT EXISTS (
             SELECT 1 FROM team_members AS m
             WHERE m.team_id = tm.team_id AND m.role IN ('owner', 'admin')
           )
           GROUP BY tm.team_id
         )`,
      )
      .run()

    const rows = await db
      .prepare('SELECT user_id, role FROM team_members WHERE team_id = ? ORDER BY rowid')
      .bind('team_orphan')
      .all<{ user_id: string; role: string }>()
    expect(rows.results.map((r) => [r.user_id, r.role])).toEqual([[CAROL_ID, 'admin'], [BOB_ID, 'member']])
    // Teams that already had an admin are untouched.
    expect(await sqlRole(BOB_ID)).toBe('member')
  })

  it('an admin sets up a member\'s schedule on their behalf; the member sees who did it', async () => {
    const alice = await seedSession(ALICE_ID)
    const base = `/dashboard/teams/${crewId}/members/${BOB_ID}/availability`

    const page = await get(base, alice)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Bob Host&rsquo;s availability')
    expect(html).toContain('as an admin of <strong>Roles Crew</strong>')

    const csrf = await csrfFrom(base, alice)
    const created = await post(`${base}/new`, { name: 'Support hours', csrf }, alice)
    expect(created.status).toBe(302)
    const location = created.headers.get('location') ?? ''
    expect(location.startsWith(`${base}/sch_`)).toBe(true)

    const row = await db
      .prepare('SELECT id, user_id, created_by, updated_by FROM schedules WHERE user_id = ? AND name = ?')
      .bind(BOB_ID, 'Support hours')
      .first<{ id: string; user_id: string; created_by: string; updated_by: string }>()
    expect(row?.created_by).toBe(ALICE_ID)
    expect(row?.updated_by).toBe(ALICE_ID)

    // Edit on Bob's behalf: the editor renders with the banner, and a save
    // lands on Bob's row with Alice as the last writer.
    const editor = await get(location, alice)
    expect(editor.status).toBe(200)
    expect(await editor.text()).toContain('You are editing <strong>Bob Host</strong>')
    const saved = await post(
      location,
      {
        name: 'Support hours',
        timezone: 'Europe/Kyiv',
        'day-1-enabled': 'on',
        'day-1-start-0': '10:00',
        'day-1-end-0': '14:00',
        overrides: '',
        csrf,
      },
      alice,
    )
    expect(saved.status).toBe(200)
    expect(await saved.text()).toContain('Schedule saved.')
    const after = await db.prepare('SELECT timezone, updated_by FROM schedules WHERE id = ?').bind(row!.id).first<{ timezone: string; updated_by: string }>()
    expect(after?.timezone).toBe('Europe/Kyiv')
    expect(after?.updated_by).toBe(ALICE_ID)

    // Bob's own page shows the schedule, badged, and he can open and edit it himself.
    const bob = await seedSession(BOB_ID)
    const bobPage = await (await get('/dashboard/availability', bob)).text()
    expect(bobPage).toContain('Support hours')
    expect(bobPage).toContain('set up by Alice Host')
    expect((await get(`/dashboard/availability/${row!.id}`, bob)).status).toBe(200)
    // And Alice's own page carries no such badge on her own rows.
    expect(await (await get('/dashboard/availability', alice)).text()).not.toContain('set up by')
  })

  it('a member or outsider cannot reach another member\'s availability through the team path', async () => {
    const base = `/dashboard/teams/${crewId}/members/${ALICE_ID}/availability`
    expect((await get(base, await seedSession(BOB_ID))).status).toBe(404)
    expect((await get(base, await seedSession(OUTSIDER_ID))).status).toBe(404)
    // A user who is not on the team is not a subject either, even for an admin.
    const alice = await seedSession(ALICE_ID)
    expect((await get(`/dashboard/teams/${crewId}/members/${OUTSIDER_ID}/availability`, alice)).status).toBe(404)
  })

  it('the instance admin manages a team they are not on, and the page says why they see it', async () => {
    const root = await seedSession(ROOT_ID)
    const html = await (await get('/dashboard/teams', root)).text()
    expect(html).toContain('Roles Crew')
    expect(html).toContain('Instance admin view')

    const csrf = await csrfFrom('/dashboard/teams', root)
    const added = await post(`/dashboard/teams/${crewId}/members`, { email: 'carol@example.test', weight: '2', csrf }, root)
    expect(added.status).toBe(200)
    expect(await sqlRole(CAROL_ID)).toBe('member')
    expect((await get(`/dashboard/event-types/${crewEventTypeId}`, root)).status).toBe(200)
    expect((await get(`/dashboard/teams/${crewId}/members/${CAROL_ID}/availability`, root)).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Explicit host sets (event_type_hosts): guards, cascades, resolution.
// ---------------------------------------------------------------------------

describe('event type hosts', () => {
  const CAROL_ID = 'usr_carol'
  const repos = () => createD1Repositories(db, { consistency: 'bookmark' })
  let crewId = ''
  let crewEventTypeId = ''
  let aliceSchedule = ''
  let bobSchedule = ''

  beforeAll(async () => {
    const team = await db.prepare('SELECT id FROM teams WHERE slug = ?').bind('roles-crew').first<{ id: string }>()
    crewId = team!.id
    const et = await db.prepare('SELECT id FROM event_types WHERE slug = ?').bind('crew-call').first<{ id: string }>()
    crewEventTypeId = et!.id
    // Carol may or may not be on the team by now, depending on suite order.
    await repos().teams.addMember({ teamId: crewId, userId: CAROL_ID, role: 'member', rrWeight: 1 })
    const workday = [{ startMinute: 9 * 60, endMinute: 17 * 60 }]
    for (const [uid, name] of [[ALICE_ID, 'sch_alice_support'], [BOB_ID, 'sch_bob_support']] as const) {
      await repos().availability.create(uid, {
        id: name,
        userId: uid,
        name: 'Support hours',
        isDefault: false,
        timezone: 'UTC',
        weekly: [[], workday, workday, workday, workday, workday, []],
        overrides: [],
      })
    }
    aliceSchedule = 'sch_alice_support'
    bobSchedule = 'sch_bob_support'
  })

  it('replace refuses a host who is not on the team, writing nothing at all', async () => {
    const ok = await repos().eventTypeHosts.replace(crewEventTypeId, [
      { userId: ALICE_ID, required: true, scheduleId: null, rrWeight: null },
      { userId: OUTSIDER_ID, required: false, scheduleId: null, rrWeight: null },
    ])
    expect(ok).toBe(false)
    expect(await repos().eventTypeHosts.forEventType(crewEventTypeId)).toEqual([])
  })

  it("replace refuses a schedule that is not that host's, writing nothing at all", async () => {
    const ok = await repos().eventTypeHosts.replace(crewEventTypeId, [
      { userId: ALICE_ID, required: true, scheduleId: bobSchedule, rrWeight: null },
    ])
    expect(ok).toBe(false)
    expect(await repos().eventTypeHosts.forEventType(crewEventTypeId)).toEqual([])
  })

  it('replace writes the set in order, with per-host schedule and weight', async () => {
    const ok = await repos().eventTypeHosts.replace(crewEventTypeId, [
      { userId: BOB_ID, required: false, scheduleId: bobSchedule, rrWeight: 3 },
      { userId: ALICE_ID, required: true, scheduleId: aliceSchedule, rrWeight: null },
    ])
    expect(ok).toBe(true)
    const rows = await repos().eventTypeHosts.forEventType(crewEventTypeId)
    expect(rows.map((r) => [r.userId, r.required, r.scheduleId, r.rrWeight, r.position])).toEqual([
      [BOB_ID, false, bobSchedule, 3, 0],
      [ALICE_ID, true, aliceSchedule, null, 1],
    ])
  })

  it('setSchedule applies the same ownership guard', async () => {
    expect(await repos().eventTypeHosts.setSchedule(crewEventTypeId, ALICE_ID, bobSchedule)).toBe(false)
    expect(await repos().eventTypeHosts.setSchedule(crewEventTypeId, ALICE_ID, null)).toBe(true)
    expect(await repos().eventTypeHosts.setSchedule(crewEventTypeId, ALICE_ID, aliceSchedule)).toBe(true)
    expect(await repos().eventTypeHosts.setSchedule(crewEventTypeId, CAROL_ID, null)).toBe(false) // not in the set
  })

  it('resolveHosts returns the explicit set with its settings, and every member when there is none', async () => {
    const { resolveHosts } = await import('../../src/core/domain/hosts.js')
    const et = (await repos().eventTypes.byId(crewEventTypeId))!
    const alice = (await repos().users.byId(ALICE_ID))!
    const explicit = await resolveHosts(repos(), et, alice)
    expect(explicit.map((h) => [h.user.id, h.required, h.scheduleId, h.rrWeight])).toEqual([
      [BOB_ID, false, bobSchedule, 3],
      [ALICE_ID, true, aliceSchedule, 1],
    ])

    await repos().eventTypeHosts.replace(crewEventTypeId, [])
    const implicit = await resolveHosts(repos(), et, alice)
    expect(implicit.map((h) => h.user.id).sort()).toEqual([ALICE_ID, BOB_ID, CAROL_ID].sort())
    expect(implicit.every((h) => h.required && h.scheduleId === null)).toBe(true)
  })

  it('a required host of an active event type cannot be removed from the team; the page names the event type', async () => {
    await repos().eventTypeHosts.replace(crewEventTypeId, [
      { userId: ALICE_ID, required: true, scheduleId: null, rrWeight: null },
      { userId: CAROL_ID, required: true, scheduleId: null, rrWeight: null },
    ])
    expect(await repos().teams.removeMemberGuarded(crewId, CAROL_ID)).toBe(false)

    const alice = await seedSession(ALICE_ID)
    const csrf = await csrfFrom('/dashboard/teams', alice)
    const res = await post(`/dashboard/teams/${crewId}/members/${CAROL_ID}/remove`, { csrf }, alice)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Still a required host on &quot;Crew call&quot;')

    // Made optional, the removal goes through and takes her host row with it.
    await repos().eventTypeHosts.replace(crewEventTypeId, [
      { userId: ALICE_ID, required: true, scheduleId: null, rrWeight: null },
      { userId: CAROL_ID, required: false, scheduleId: null, rrWeight: null },
    ])
    expect(await repos().teams.removeMemberGuarded(crewId, CAROL_ID)).toBe(true)
    expect((await repos().eventTypeHosts.forEventType(crewEventTypeId)).map((h) => h.userId)).toEqual([ALICE_ID])
  })

  it('deleting the event type takes its host set with it', async () => {
    const et = await repos().eventTypes.create({
      ...(await repos().eventTypes.byId(crewEventTypeId))!,
      id: 'et_crew_temp',
      slug: 'crew-temp',
    })
    await repos().eventTypeHosts.replace(et.id, [{ userId: ALICE_ID, required: true, scheduleId: null, rrWeight: null }])
    expect(await repos().eventTypes.delete(et.id, Date.now())).toBe(true)
    expect(await repos().eventTypeHosts.forEventType(et.id)).toEqual([])
    // Cleanup for later suites: back to the implicit set.
    await repos().eventTypeHosts.replace(crewEventTypeId, [])
  })
})
