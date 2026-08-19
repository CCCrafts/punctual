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
