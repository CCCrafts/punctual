/**
 * The authenticated surface, under the real Workers runtime (ADR-0003 §5).
 *
 * These properties are the ones that cannot be checked by reading the code:
 * they depend on real cookies, real SHA-256, real HMAC and real D1 rows.
 * Everything asserted here fails open if it regresses — an enumeration oracle,
 * a missing redirect or an accepted forged token all still return a page.
 */

import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildDashboardRoutes } from '../../src/http/dashboard-routes.js'
import { buildRouter } from '../../src/http/router.js'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import { issueManageToken } from '../../src/core/domain/auth-flows.js'
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
  RequestScope,
} from '../../src/ports.js'

const db = env.DB

const BASE = 'http://localhost'
const NOW = Date.now()
const HOST_ID = 'usr_host'
const HOST_EMAIL = 'host@example.test'
const EVENT_ID = 'evt_1'
const BOOKING_ID = 'bkg_1'

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

const email = createFakeEmailSender()
const rateLimiter = createFakeRateLimiter()

/**
 * Only the ports these routes actually touch are real. Anything else throws
 * rather than returning a plausible empty value — a stub that quietly succeeds
 * turns a routing bug into a passing test.
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

const blobStorage = createFakeBlobStorage()

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
  email,
  crypto: crypto_,
  cache,
  blobCache,
  blobStorage,
  clock: { now: () => Date.now() },
  queue,
  coordinator,
  rateLimiter,
  config: fakeConfig({ baseUrl: BASE }),
}

const slots: SlotService = {
  async forEventType() {
    return []
  },
}

const app = buildDashboardRoutes(ports, slots)

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

// The schema arrives from `test/workers/setup.ts`, which applies the real
// migrations to this file's isolated D1 before anything below runs.
beforeAll(async () => {
  await db
    .prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
    .bind(HOST_ID, HOST_EMAIL, 'Test Host', 'UTC', 'test-host', NOW)
    .run()

  await db
    .prepare(
      `INSERT INTO event_types
       (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
        slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
        max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(EVENT_ID, HOST_ID, null, 'personal', 'intro', 'Intro call', '', 30, null, 0, 0, 0, 60, null,
      'google_meet', null, '[]', 1, NOW)
    .run()
})

// ---------------------------------------------------------------------------

describe('session gate', () => {
  it('sends an unauthenticated visitor to /login', async () => {
    const res = await get('/dashboard')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('lets a valid session through to the dashboard', async () => {
    const cookie = await seedSession(HOST_ID)
    const res = await get('/dashboard', cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Event types')
    expect(html).toContain('Intro call')
  })

  it('rejects a cookie that matches no session row', async () => {
    const res = await get('/dashboard', `${SESSION_COOKIE_NAME}=${crypto_.randomToken(32)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })
})

describe('magic link request', () => {
  /**
   * The enumeration property (ADR-0005 §3). Byte equality, not "both are 200":
   * a difference of one word in the copy is exactly the oracle this defends
   * against, and only comparing the whole body catches it.
   */
  it('answers identically for a known and an unknown address', async () => {
    const known = await post('/login', { email: HOST_EMAIL })
    const unknown = await post('/login', { email: 'nobody-at-all@example.test' })

    expect(known.status).toBe(unknown.status)
    expect(known.status).toBe(200)
    expect(await known.text()).toBe(await unknown.text())
  })

  it('sends a link for both, so the response is not the only thing that matches', async () => {
    // Both addresses receive mail: a magic link is sign-in and sign-up at once,
    // so there is no existence branch behind the identical response either.
    const recipients = email.sent.map((m) => m.to)
    expect(recipients).toContain(HOST_EMAIL)
    expect(recipients).toContain('nobody-at-all@example.test')
  })
})

describe('CSRF', () => {
  it('refuses a dashboard POST with no token', async () => {
    const cookie = await seedSession(HOST_ID)
    const res = await post('/dashboard/api-keys', { name: 'Forged' }, cookie)
    expect(res.status).toBe(403)
    const keys = await db.prepare('SELECT COUNT(*) AS n FROM api_keys').first<{ n: number }>()
    expect(keys?.n).toBe(0)
  })

  it('refuses a token belonging to a different session', async () => {
    const cookie = await seedSession(HOST_ID)
    const otherCookie = await seedSession(HOST_ID)
    const otherPage = await get('/dashboard/api-keys', otherCookie)
    const stolen = /name="csrf" value="([^"]+)"/.exec(await otherPage.text())?.[1] ?? ''
    expect(stolen).not.toBe('')

    const res = await post('/dashboard/api-keys', { name: 'Forged', csrf: stolen }, cookie)
    expect(res.status).toBe(403)
  })

  it('accepts the token minted for this session', async () => {
    const cookie = await seedSession(HOST_ID)
    const page = await get('/dashboard/api-keys', cookie)
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''

    const res = await post('/dashboard/api-keys', { name: 'Laptop', csrf }, cookie)
    expect(res.status).toBe(200)
    // The raw key is shown exactly once, at creation (ADR-0005 §7).
    const html = await res.text()
    expect(html).toContain('pk_')
    expect(html).toContain('only time it will be shown')
  })
})

describe('guest manage page', () => {
  async function seedBooking(purpose: 'cancel' | 'reschedule'): Promise<string> {
    const start = NOW + 86_400_000
    const issued = await issueManageToken({ crypto: crypto_ }, { id: BOOKING_ID, startUtc: start }, purpose)
    await db.prepare('DELETE FROM bookings WHERE id = ?').bind(BOOKING_ID).run()
    await db
      .prepare(
        `INSERT INTO bookings
         (id,event_type_id,host_user_id,host_user_ids_json,guest_name,guest_email,guest_timezone,
          start_utc,end_utc,local_date,status,answers_json,external_event_ids_json,reschedule_of,
          rescheduled_to,manage_token_hash,cancelled_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(BOOKING_ID, EVENT_ID, HOST_ID, JSON.stringify([HOST_ID]), 'Guest Person', 'guest@example.test',
        'UTC', start, start + 1_800_000, '2026-08-15', 'confirmed', '{}', '{}', null, null,
        issued.tokenHash, null, NOW)
      .run()
    return issued.token
  }

  it('opens for a valid token', async () => {
    const token = await seedBooking('cancel')
    const res = await get(`/booking/${BOOKING_ID}?token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Intro call')
    expect(html).toContain('Cancel this booking')
  })

  it('refuses a token with a tampered signature', async () => {
    const token = await seedBooking('cancel')
    // Flip the last character of the HMAC. Everything else — booking id,
    // purpose, expiry, nonce — is untouched and still names a real row.
    const last = token.slice(-1)
    const forged = `${token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`

    const res = await get(`/booking/${BOOKING_ID}?token=${encodeURIComponent(forged)}`)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('This link is not valid')
  })

  it('refuses a missing token', async () => {
    await seedBooking('cancel')
    const res = await get(`/booking/${BOOKING_ID}`)
    expect(res.status).toBe(400)
  })

  it('refuses a valid token presented for a different booking', async () => {
    const token = await seedBooking('cancel')
    const res = await get(`/booking/bkg_other?token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(400)
  })

  it('refuses to cancel with a reschedule token', async () => {
    // The purpose is inside the signature (ADR-0005 §4), so this is a
    // deliberate refusal rather than a signature accident.
    const token = await seedBooking('reschedule')
    const res = await post(`/booking/${BOOKING_ID}/cancel`, { token })
    expect(res.status).toBe(400)
    const row = await db.prepare('SELECT status FROM bookings WHERE id = ?').bind(BOOKING_ID).first<{ status: string }>()
    expect(row?.status).toBe('confirmed')
  })

  it('cancels with a cancel token and releases the slot locks', async () => {
    const token = await seedBooking('cancel')
    await db
      .prepare('INSERT INTO slot_locks (host_user_id,bucket_start,booking_id) VALUES (?,?,?)')
      .bind(HOST_ID, NOW + 86_400_000, BOOKING_ID)
      .run()

    const res = await post(`/booking/${BOOKING_ID}/cancel`, { token })
    expect(res.status).toBe(200)

    const row = await db.prepare('SELECT status FROM bookings WHERE id = ?').bind(BOOKING_ID).first<{ status: string }>()
    expect(row?.status).toBe('cancelled')
    const locks = await db
      .prepare('SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = ?')
      .bind(BOOKING_ID)
      .first<{ n: number }>()
    expect(locks?.n).toBe(0)
  })
})

describe('connections save', () => {
  const CONNECTION_ID = 'cal_1'

  /** Every call the connections repo receives, in order — the spy this suite is built around. */
  const repoCalls: string[] = []

  const spyPorts: EnginePorts = {
    ...ports,
    repositories: (scope: RequestScope) => {
      const repos = createD1Repositories(db, scope)
      return {
        ...repos,
        connections: {
          ...repos.connections,
          async delete(id) {
            repoCalls.push('delete')
            return repos.connections.delete(id)
          },
          async create(conn) {
            repoCalls.push('create')
            return repos.connections.create(conn)
          },
          async updateCalendars(id, patch) {
            repoCalls.push('updateCalendars')
            return repos.connections.updateCalendars(id, patch)
          },
        },
      }
    },
  }

  const spyApp = buildDashboardRoutes(spyPorts, slots)

  async function getSpy(path: string, cookie: string): Promise<Response> {
    return spyApp.fetch(new Request(`${BASE}${path}`, { headers: { cookie } }))
  }

  async function postSpy(path: string, body: Record<string, string>, cookie: string): Promise<Response> {
    const form = new FormData()
    for (const [k, v] of Object.entries(body)) form.append(k, v)
    return spyApp.fetch(new Request(`${BASE}${path}`, { method: 'POST', body: form, headers: { cookie } }))
  }

  async function seedConnection(): Promise<void> {
    await db.prepare('DELETE FROM calendar_connections WHERE id = ?').bind(CONNECTION_ID).run()
    await db
      .prepare(
        `INSERT INTO calendar_connections
         (id,user_id,provider,provider_account_email,encrypted_tokens,key_version,
          calendar_ids_read_json,calendar_id_write,sync_status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(CONNECTION_ID, HOST_ID, 'google', HOST_EMAIL, 'cipher-original', 3, '[]', null, 'ok', NOW)
      .run()
  }

  it('persists a new calendar selection through updateCalendars, never delete+create', async () => {
    await seedConnection()
    repoCalls.length = 0
    const cookie = await seedSession(HOST_ID)

    const page = await getSpy('/dashboard/connections', cookie)
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''

    const res = await postSpy(
      `/dashboard/connections/${CONNECTION_ID}`,
      { read: 'cal_work', write: 'cal_work', csrf },
      cookie,
    )
    expect(res.status).toBe(302)

    // The save went through `updateCalendars` and nothing else touched the row.
    expect(repoCalls).toEqual(['updateCalendars'])

    const row = await db
      .prepare('SELECT * FROM calendar_connections WHERE id = ?')
      .bind(CONNECTION_ID)
      .first<Record<string, unknown>>()
    expect(row).toBeTruthy()
    expect(JSON.parse(String(row?.['calendar_ids_read_json']))).toEqual(['cal_work'])
    expect(row?.['calendar_id_write']).toBe('cal_work')

    // Nothing but the calendar selection changed — proof the row was rewritten
    // in place rather than replaced, so key-rotation continuity survives.
    expect(row?.['id']).toBe(CONNECTION_ID)
    expect(row?.['encrypted_tokens']).toBe('cipher-original')
    expect(row?.['key_version']).toBe(3)
    expect(row?.['provider_account_email']).toBe(HOST_EMAIL)
    expect(row?.['sync_status']).toBe('ok')
    expect(row?.['created_at']).toBe(NOW)
  })
})

describe('settings — change slug', () => {
  const SLUG_HOST_ID = 'usr_slug_host'
  const SLUG_EVENT_ID = 'evt_slug_host'
  const TAKEN_HOST_ID = 'usr_taken_slug'
  const OLD_SLUG = 'sluggy-old'
  const TAKEN_SLUG = 'already-taken'
  const TAKEN_TEAM_ID = 'team_taken_slug'
  const TAKEN_TEAM_SLUG = 'taken-by-team'

  // The public booking page lives in the top-level router, not the dashboard
  // sub-app — proving a slug change actually moves the live page (not just the
  // DB row) needs the real `/:userSlug/:eventSlug` route, which only
  // `buildRouter` mounts. Same `ports`/`slots` as every other test in this
  // file, so it shares the fake rate limiter and the real D1 behind them.
  const publicApp = buildRouter(ports, slots)
  async function getPublic(path: string): Promise<Response> {
    return publicApp.fetch(new Request(`${BASE}${path}`))
  }

  beforeAll(async () => {
    await db
      .prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
      .bind(SLUG_HOST_ID, 'sluggy@example.test', 'Sluggy Host', 'UTC', OLD_SLUG, NOW)
      .run()
    await db
      .prepare(
        `INSERT INTO event_types
         (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
          slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
          max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(SLUG_EVENT_ID, SLUG_HOST_ID, null, 'personal', 'chat', 'Chat with Sluggy', '', 30, null, 0, 0, 0,
        60, null, 'google_meet', null, '[]', 1, NOW)
      .run()
    await db
      .prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
      .bind(TAKEN_HOST_ID, 'taken@example.test', 'Taken Host', 'UTC', TAKEN_SLUG, NOW)
      .run()
    await db
      .prepare('INSERT INTO teams (id,name,slug,created_at) VALUES (?,?,?,?)')
      .bind(TAKEN_TEAM_ID, 'Taken Team', TAKEN_TEAM_SLUG, NOW)
      .run()
  })

  /** Every test starts from the same known row, so order never matters. */
  async function resetSlugHost(): Promise<void> {
    await db.prepare('UPDATE users SET slug = ? WHERE id = ?').bind(OLD_SLUG, SLUG_HOST_ID).run()
  }

  async function settingsCsrf(cookie: string): Promise<string> {
    const page = await get('/dashboard/settings', cookie)
    return /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''
  }

  it('shows the current slug', async () => {
    await resetSlugHost()
    const cookie = await seedSession(SLUG_HOST_ID)
    const res = await get('/dashboard/settings', cookie)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(OLD_SLUG)
  })

  it('changes to a valid new slug and persists it', async () => {
    await resetSlugHost()
    const cookie = await seedSession(SLUG_HOST_ID)
    const csrf = await settingsCsrf(cookie)

    const res = await post('/dashboard/settings', { slug: 'sluggy-new', csrf }, cookie)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Slug updated')

    const row = await db
      .prepare('SELECT slug FROM users WHERE id = ?')
      .bind(SLUG_HOST_ID)
      .first<{ slug: string }>()
    expect(row?.slug).toBe('sluggy-new')
  })

  it('rejects a slug already taken by another user, leaving the row unchanged', async () => {
    await resetSlugHost()
    const cookie = await seedSession(SLUG_HOST_ID)
    const csrf = await settingsCsrf(cookie)

    const res = await post('/dashboard/settings', { slug: TAKEN_SLUG, csrf }, cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('already taken')

    const row = await db
      .prepare('SELECT slug FROM users WHERE id = ?')
      .bind(SLUG_HOST_ID)
      .first<{ slug: string }>()
    expect(row?.slug).toBe(OLD_SLUG)
  })

  // `bookingPageContext` resolves a public booking page by matching the
  // owner slug against EITHER users OR teams (`u.slug = ? OR t.slug = ?`), so
  // a user slug colliding with an existing TEAM's slug would make
  // `/that-slug/<event>` ambiguous between the two.
  it('rejects a slug already taken by a team', async () => {
    await resetSlugHost()
    const cookie = await seedSession(SLUG_HOST_ID)
    const csrf = await settingsCsrf(cookie)

    const res = await post('/dashboard/settings', { slug: TAKEN_TEAM_SLUG, csrf }, cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('already taken')

    const row = await db
      .prepare('SELECT slug FROM users WHERE id = ?')
      .bind(SLUG_HOST_ID)
      .first<{ slug: string }>()
    expect(row?.slug).toBe(OLD_SLUG)
  })

  // The form's read-then-write check (bySlug) cannot close a race between two
  // concurrent saves of the same new slug — `UserRepository.update`'s own
  // return value is the real guard. Exercised directly at the repository
  // layer, where the race is deterministic to set up: seed a second row
  // already sitting on the slug the "concurrent" write targets, so the
  // second `update` call hits the same UNIQUE constraint a true race would.
  it('UserRepository.update reports false on a slug collision, rather than throwing', async () => {
    await resetSlugHost()
    const repos = ports.repositories({ consistency: 'bookmark' })
    const ok = await repos.users.update(SLUG_HOST_ID, { slug: TAKEN_SLUG })
    expect(ok).toBe(false)

    const row = await db
      .prepare('SELECT slug FROM users WHERE id = ?')
      .bind(SLUG_HOST_ID)
      .first<{ slug: string }>()
    expect(row?.slug).toBe(OLD_SLUG)
  })

  it('rejects a reserved word', async () => {
    await resetSlugHost()
    const cookie = await seedSession(SLUG_HOST_ID)
    const csrf = await settingsCsrf(cookie)

    const res = await post('/dashboard/settings', { slug: 'dashboard', csrf }, cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('reserved')

    const row = await db
      .prepare('SELECT slug FROM users WHERE id = ?')
      .bind(SLUG_HOST_ID)
      .first<{ slug: string }>()
    expect(row?.slug).toBe(OLD_SLUG)
  })

  it.each([
    ['uppercase', 'SluggyNew'],
    ['spaces', 'sluggy new'],
    ['symbols', 'sluggy_new!'],
  ])('rejects a malformed slug (%s)', async (_label, bad) => {
    await resetSlugHost()
    const cookie = await seedSession(SLUG_HOST_ID)
    const csrf = await settingsCsrf(cookie)

    const res = await post('/dashboard/settings', { slug: bad, csrf }, cookie)
    expect(res.status).toBe(400)

    const row = await db
      .prepare('SELECT slug FROM users WHERE id = ?')
      .bind(SLUG_HOST_ID)
      .first<{ slug: string }>()
    expect(row?.slug).toBe(OLD_SLUG)
  })

  it('moves the live booking page: the old slug 404s, the new one resolves', async () => {
    await resetSlugHost()
    const cookie = await seedSession(SLUG_HOST_ID)
    const csrf = await settingsCsrf(cookie)

    const before = await getPublic(`/${OLD_SLUG}/chat`)
    expect(before.status).toBe(200)
    expect(await before.text()).toContain('Chat with Sluggy')

    const res = await post('/dashboard/settings', { slug: 'sluggy-new', csrf }, cookie)
    expect(res.status).toBe(200)

    const stale = await getPublic(`/${OLD_SLUG}/chat`)
    expect(stale.status).toBe(404)

    const fresh = await getPublic('/sluggy-new/chat')
    expect(fresh.status).toBe(200)
    expect(await fresh.text()).toContain('Chat with Sluggy')
  })
})

describe('availability — named schedules (CCC-581)', () => {
  const AVAIL_HOST_ID = 'usr_avail_dash_host'
  const DEFAULT_SCHEDULE_ID = 'sch_avail_dash_default'
  const AVAIL_EVENT_ID = 'evt_avail_dash'

  beforeAll(async () => {
    await db
      .prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
      .bind(AVAIL_HOST_ID, 'avail-dash@example.test', 'Avail Host', 'UTC', 'avail-dash-host', NOW)
      .run()
    await db
      .prepare(
        `INSERT INTO schedules (id,user_id,name,is_default,timezone,weekly_json,overrides_json,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(DEFAULT_SCHEDULE_ID, AVAIL_HOST_ID, 'Working hours', 1, 'UTC', '[[],[],[],[],[],[],[]]', '[]', NOW)
      .run()
    await db
      .prepare(
        `INSERT INTO event_types
         (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
          slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
          max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(AVAIL_EVENT_ID, AVAIL_HOST_ID, null, 'personal', 'avail-chat', 'Avail chat', '', 30, null, 0, 0, 0,
        60, null, 'google_meet', null, '[]', 1, NOW)
      .run()
  })

  async function availCsrf(cookie: string): Promise<string> {
    const page = await get('/dashboard/availability', cookie)
    return /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''
  }

  it('lists the default schedule', async () => {
    const cookie = await seedSession(AVAIL_HOST_ID)
    const res = await get('/dashboard/availability', cookie)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Working hours')
    expect(text).toContain('Default')
  })

  it('creates a new schedule as a copy of the default and redirects to its edit page', async () => {
    const cookie = await seedSession(AVAIL_HOST_ID)
    const csrf = await availCsrf(cookie)

    const res = await post('/dashboard/availability/new', { name: 'Evenings', csrf }, cookie)
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toMatch(/^\/dashboard\/availability\/sch_/)

    const edit = await app.fetch(new Request(`${BASE}${location}`, { headers: { cookie } }))
    expect(edit.status).toBe(200)
    expect(await edit.text()).toContain('Evenings')
  })

  it('rejects an empty name', async () => {
    const cookie = await seedSession(AVAIL_HOST_ID)
    const csrf = await availCsrf(cookie)
    const res = await post('/dashboard/availability/new', { name: '', csrf }, cookie)
    expect(res.status).toBe(400)
  })

  it('saves weekly hours and overrides for a specific schedule', async () => {
    const cookie = await seedSession(AVAIL_HOST_ID)
    const csrf = await availCsrf(cookie)

    const weekday = (day: number) => ({
      [`day-${day}-enabled`]: 'on',
      [`day-${day}-start-0`]: '09:00',
      [`day-${day}-end-0`]: '17:00',
    })
    const res = await post(
      `/dashboard/availability/${DEFAULT_SCHEDULE_ID}`,
      {
        name: 'Working hours',
        timezone: 'UTC',
        ...weekday(1),
        ...weekday(2),
        ...weekday(3),
        ...weekday(4),
        ...weekday(5),
        overrides: '',
        csrf,
      },
      cookie,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Schedule saved')

    const row = await db
      .prepare('SELECT weekly_json FROM schedules WHERE id = ?')
      .bind(DEFAULT_SCHEDULE_ID)
      .first<{ weekly_json: string }>()
    expect(JSON.parse(row!.weekly_json)[1]).toEqual([{ startMinute: 540, endMinute: 1020 }])
  })

  it('"+ Add range" appends an empty row without saving, and preserves the typed timezone and overrides', async () => {
    const cookie = await seedSession(AVAIL_HOST_ID)
    const csrf = await availCsrf(cookie)

    const res = await post(
      `/dashboard/availability/${DEFAULT_SCHEDULE_ID}`,
      {
        name: 'Working hours',
        timezone: 'America/New_York',
        'day-1-enabled': 'on',
        'day-1-start-0': '09:00',
        'day-1-end-0': '17:00',
        overrides: '2026-12-24',
        'add-range': '1',
        csrf,
      },
      cookie,
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    // The typed timezone/overrides survive the re-render...
    expect(text).toContain('value="America/New_York"')
    expect(text).toContain('2026-12-24')
    // ...a second, empty range row was appended to Monday...
    expect(text).toContain('name="day-1-start-1" value=""')

    // ...and nothing was actually saved to D1.
    const row = await db
      .prepare('SELECT timezone, weekly_json, overrides_json FROM schedules WHERE id = ?')
      .bind(DEFAULT_SCHEDULE_ID)
      .first<{ timezone: string; weekly_json: string; overrides_json: string }>()
    expect(row?.timezone).toBe('UTC')
    expect(JSON.parse(row!.weekly_json)[1]).toEqual([{ startMinute: 540, endMinute: 1020 }])
    expect(row?.overrides_json).toBe('[]')
  })

  it('rejects a save with no new-format weekly fields at all rather than silently blanking the schedule', async () => {
    const cookie = await seedSession(AVAIL_HOST_ID)
    const csrf = await availCsrf(cookie)

    // Mimics a stale tab still holding the OLD single-text-field form,
    // submitted after the editor was redesigned.
    const res = await post(
      `/dashboard/availability/${DEFAULT_SCHEDULE_ID}`,
      { name: 'Working hours', timezone: 'UTC', 'day-1': '09:00-17:00', overrides: '', csrf },
      cookie,
    )
    expect(res.status).toBe(409)

    const row = await db
      .prepare('SELECT weekly_json FROM schedules WHERE id = ?')
      .bind(DEFAULT_SCHEDULE_ID)
      .first<{ weekly_json: string }>()
    expect(JSON.parse(row!.weekly_json)[1]).toEqual([{ startMinute: 540, endMinute: 1020 }])
  })

  it('duplicates a schedule, sets a new default, then refuses to delete the new default', async () => {
    const cookie = await seedSession(AVAIL_HOST_ID)
    let csrf = await availCsrf(cookie)

    const dup = await post(`/dashboard/availability/${DEFAULT_SCHEDULE_ID}/duplicate`, { csrf }, cookie)
    expect(dup.status).toBe(200)
    expect(await dup.text()).toContain('Schedule duplicated')

    const row = await db
      .prepare("SELECT id FROM schedules WHERE user_id = ? AND name = 'Working hours copy'")
      .bind(AVAIL_HOST_ID)
      .first<{ id: string }>()
    expect(row).toBeTruthy()
    const copyId = row!.id

    csrf = await availCsrf(cookie)
    const setDefault = await post(`/dashboard/availability/${copyId}/set-default`, { csrf }, cookie)
    expect(setDefault.status).toBe(200)
    expect(await setDefault.text()).toContain('is now your default')

    const defaults = await db
      .prepare('SELECT id FROM schedules WHERE user_id = ? AND is_default = 1')
      .bind(AVAIL_HOST_ID)
      .first<{ id: string }>()
    expect(defaults?.id).toBe(copyId)

    csrf = await availCsrf(cookie)
    const deleteDefault = await post(`/dashboard/availability/${copyId}/delete`, { csrf }, cookie)
    expect(deleteDefault.status).toBe(400)
    expect(await deleteDefault.text()).toContain('Cannot delete your default schedule')
  })

  it('truncates a duplicated schedule\'s generated name to the same 120-char limit the form enforces', async () => {
    // Caught by review: an untruncated "${name} copy" on an already-120-char
    // name inserted a 125-char row that then failed the SAME 120-char check
    // on its very next save.
    const cookie = await seedSession(AVAIL_HOST_ID)
    let csrf = await availCsrf(cookie)

    const longName = 'x'.repeat(120)
    const create = await post('/dashboard/availability/new', { name: longName, csrf }, cookie)
    expect(create.status).toBe(302)
    const longId = (create.headers.get('location') ?? '').split('/').pop()!

    csrf = await availCsrf(cookie)
    const dup = await post(`/dashboard/availability/${longId}/duplicate`, { csrf }, cookie)
    expect(dup.status).toBe(200)

    const row = await db
      .prepare('SELECT id, name FROM schedules WHERE user_id = ? AND id != ? ORDER BY updated_at DESC LIMIT 1')
      .bind(AVAIL_HOST_ID, longId)
      .first<{ id: string; name: string }>()
    expect(row!.name.length).toBeLessThanOrEqual(120)

    // The truncated name must itself still round-trip through a save. Every
    // day gets its (blank) `day-N-start-0` field, same as the real form
    // always renders — omitting all of them looks like a stale pre-redesign
    // submission, which the route now rejects rather than silently saving.
    const blankDay = (day: number) => ({ [`day-${day}-start-0`]: '', [`day-${day}-end-0`]: '' })
    csrf = await availCsrf(cookie)
    const save = await post(
      `/dashboard/availability/${row!.id}`,
      {
        name: row!.name,
        timezone: 'UTC',
        ...blankDay(0),
        ...blankDay(1),
        ...blankDay(2),
        ...blankDay(3),
        ...blankDay(4),
        ...blankDay(5),
        ...blankDay(6),
        overrides: '',
        csrf,
      },
      cookie,
    )
    expect(save.status).toBe(200)
  })

  it('refuses to delete a schedule an event type still uses, then allows it once unassigned', async () => {
    const cookie = await seedSession(AVAIL_HOST_ID)
    let csrf = await availCsrf(cookie)

    const create = await post('/dashboard/availability/new', { name: 'In use', csrf }, cookie)
    const scheduleId = (create.headers.get('location') ?? '').split('/').pop()!

    await db.prepare('UPDATE event_types SET schedule_id = ? WHERE id = ?').bind(scheduleId, AVAIL_EVENT_ID).run()

    csrf = await availCsrf(cookie)
    const blocked = await post(`/dashboard/availability/${scheduleId}/delete`, { csrf }, cookie)
    expect(blocked.status).toBe(400)
    expect(await blocked.text()).toContain('an event type is still using')

    await db.prepare('UPDATE event_types SET schedule_id = NULL WHERE id = ?').bind(AVAIL_EVENT_ID).run()

    csrf = await availCsrf(cookie)
    const allowed = await post(`/dashboard/availability/${scheduleId}/delete`, { csrf }, cookie)
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain('Schedule deleted')
  })

  it('offers the schedule on the event type editor once more than the default exists', async () => {
    const cookie = await seedSession(AVAIL_HOST_ID)
    const res = await get(`/dashboard/event-types/${AVAIL_EVENT_ID}`, cookie)
    expect(res.status).toBe(200)
    // At least one non-default schedule survives the previous tests in this
    // block (set-default swapped the default; "In use" was deleted again) —
    // the select must be present either way, and named schedules listed.
    expect(await res.text()).toContain('Availability schedule')
  })
})

describe('settings — profile (name and company)', () => {
  const PROFILE_HOST_ID = 'usr_profile_host'

  beforeAll(async () => {
    await db
      .prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
      .bind(PROFILE_HOST_ID, 'profile@example.test', 'Original Name', 'UTC', 'profile-host', NOW)
      .run()
  })

  async function resetProfileHost(): Promise<void> {
    await db
      .prepare('UPDATE users SET name = ?, company = NULL, job_title = NULL WHERE id = ?')
      .bind('Original Name', PROFILE_HOST_ID)
      .run()
  }

  async function settingsCsrf(cookie: string): Promise<string> {
    const page = await get('/dashboard/settings', cookie)
    return /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''
  }

  it('saves a new name, position and company', async () => {
    await resetProfileHost()
    const cookie = await seedSession(PROFILE_HOST_ID)
    const csrf = await settingsCsrf(cookie)

    const res = await post(
      '/dashboard/settings/profile',
      { name: 'New Name', job_title: 'CEO', company: 'Acme Inc', csrf },
      cookie,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Profile updated')

    const row = await db
      .prepare('SELECT name, job_title, company FROM users WHERE id = ?')
      .bind(PROFILE_HOST_ID)
      .first<{ name: string; job_title: string | null; company: string | null }>()
    expect(row?.name).toBe('New Name')
    expect(row?.job_title).toBe('CEO')
    expect(row?.company).toBe('Acme Inc')
  })

  it('an empty company clears the field rather than storing an empty string', async () => {
    await resetProfileHost()
    const cookie = await seedSession(PROFILE_HOST_ID)
    let csrf = await settingsCsrf(cookie)
    await post('/dashboard/settings/profile', { name: 'New Name', company: 'Acme Inc', csrf }, cookie)

    csrf = await settingsCsrf(cookie)
    await post('/dashboard/settings/profile', { name: 'New Name', company: '', csrf }, cookie)

    const row = await db
      .prepare('SELECT company FROM users WHERE id = ?')
      .bind(PROFILE_HOST_ID)
      .first<{ company: string | null }>()
    expect(row?.company).toBeNull()
  })

  it('saves a company link, and rejects a non-http scheme that could reach a public href', async () => {
    await resetProfileHost()
    const cookie = await seedSession(PROFILE_HOST_ID)
    let csrf = await settingsCsrf(cookie)

    const ok = await post(
      '/dashboard/settings/profile',
      { name: 'New Name', company: 'Acme', company_url: 'https://acme.example', csrf },
      cookie,
    )
    expect(ok.status).toBe(200)
    const row = await db
      .prepare('SELECT company_url FROM users WHERE id = ?')
      .bind(PROFILE_HOST_ID)
      .first<{ company_url: string | null }>()
    expect(row?.company_url).toBe('https://acme.example')

    csrf = await settingsCsrf(cookie)
    const bad = await post(
      '/dashboard/settings/profile',
      { name: 'New Name', company: 'Acme', company_url: 'javascript:alert(1)', csrf },
      cookie,
    )
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('starting with https://')
  })

  it('rejects an empty name, leaving the row unchanged', async () => {
    await resetProfileHost()
    const cookie = await seedSession(PROFILE_HOST_ID)
    const csrf = await settingsCsrf(cookie)

    const res = await post('/dashboard/settings/profile', { name: '  ', company: '', csrf }, cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Name is required')

    const row = await db
      .prepare('SELECT name FROM users WHERE id = ?')
      .bind(PROFILE_HOST_ID)
      .first<{ name: string }>()
    expect(row?.name).toBe('Original Name')
  })

  it('rejects a request with no valid CSRF token', async () => {
    await resetProfileHost()
    const cookie = await seedSession(PROFILE_HOST_ID)
    const res = await post(
      '/dashboard/settings/profile',
      { name: 'Forged Name', company: '', csrf: 'forged' },
      cookie,
    )
    expect(res.status).toBe(403)
  })
})

describe('signup policy', () => {
  const closedPorts: EnginePorts = {
    ...ports,
    config: fakeConfig({ baseUrl: BASE, signupPolicy: { mode: 'closed' } }),
  }
  const closedApp = buildDashboardRoutes(closedPorts, slots)

  async function closedPost(path: string, body: Record<string, string>): Promise<Response> {
    const form = new FormData()
    for (const [k, v] of Object.entries(body)) form.append(k, v)
    return closedApp.fetch(new Request(`${BASE}${path}`, { method: 'POST', body: form }))
  }

  async function seedLink(emailAddr: string): Promise<string> {
    const token = crypto_.randomToken(32)
    await createD1Repositories(db, { consistency: 'bookmark' }).sessions.createMagicLink({
      tokenHash: await crypto_.hash(token),
      email: emailAddr,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    })
    return token
  }

  it('a closed instance answers identically for known and unknown addresses — and mails BOTH, so there is no timing branch either', async () => {
    // The request path must be byte- and work-identical regardless of policy:
    // an earlier version suppressed the stranger's email here, and the skipped
    // D1 insert + awaited provider send was a measurable existence oracle.
    // The stranger's link simply dead-ends at the consume gate below.
    const known = await closedPost('/login', { email: HOST_EMAIL })
    const unknown = await closedPost('/login', { email: 'stranger-closed@example.test' })
    expect(known.status).toBe(200)
    expect(await known.text()).toBe(await unknown.text())

    const recipients = email.sent.map((m) => m.to)
    expect(recipients).toContain(HOST_EMAIL)
    expect(recipients).toContain('stranger-closed@example.test')
  })

  it('the consume gate refuses to CREATE a user on a closed instance, with a distinct message', async () => {
    // A link seeded directly (as if policy changed between send and click, or
    // a crafted OAuth identity redemption) — the create branch must still
    // refuse; the request-time check is UX, this is the security boundary.
    const token = await seedLink('brand-new-closed@example.test')
    const res = await closedApp.fetch(new Request(`${BASE}/auth/callback?token=${encodeURIComponent(token)}`))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Sign-ups are closed')

    const row = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind('brand-new-closed@example.test')
      .first()
    expect(row).toBeNull()
  })

  it('an existing user still signs in on a closed instance', async () => {
    const token = await seedLink(HOST_EMAIL)
    const res = await closedApp.fetch(new Request(`${BASE}/auth/callback?token=${encodeURIComponent(token)}`))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/dashboard')
  })

  it('an allowlist admits a matching domain and refuses everyone else', async () => {
    const allowPorts: EnginePorts = {
      ...ports,
      config: fakeConfig({
        baseUrl: BASE,
        signupPolicy: { mode: 'allowlist', entries: ['@allowed.test'] },
      }),
    }
    const allowApp = buildDashboardRoutes(allowPorts, slots)

    const inToken = await seedLink('newhire@allowed.test')
    const ok = await allowApp.fetch(new Request(`${BASE}/auth/callback?token=${encodeURIComponent(inToken)}`))
    expect(ok.status).toBe(302)

    const outToken = await seedLink('stranger@elsewhere.test')
    const no = await allowApp.fetch(new Request(`${BASE}/auth/callback?token=${encodeURIComponent(outToken)}`))
    expect(no.status).toBe(400)
    expect(await no.text()).toContain('Sign-ups are closed')
  })
})

describe('admin — instance administration', () => {
  const ADMIN_ID = 'usr_admin'
  const ADMIN_EMAIL = 'admin@example.test'

  beforeAll(async () => {
    await db
      .prepare("INSERT INTO users (id,email,name,tz,slug,role,created_at) VALUES (?,?,?,?,?,'admin',?)")
      .bind(ADMIN_ID, ADMIN_EMAIL, 'The Admin', 'UTC', 'the-admin', NOW)
      .run()
  })

  async function adminCsrf(cookie: string): Promise<string> {
    const page = await get('/dashboard/admin', cookie)
    return /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''
  }

  async function seedLink(emailAddr: string): Promise<string> {
    const token = crypto_.randomToken(32)
    await createD1Repositories(db, { consistency: 'bookmark' }).sessions.createMagicLink({
      tokenHash: await crypto_.hash(token),
      email: emailAddr,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    })
    return token
  }

  it('a member who guesses the URL is redirected to their own dashboard, and never sees the nav link', async () => {
    const cookie = await seedSession(HOST_ID)
    const res = await get('/dashboard/admin', cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/dashboard')

    const home = await get('/dashboard', cookie)
    expect(await home.text()).not.toContain('href="/dashboard/admin"')
  })

  it('an admin sees the users list and the nav link', async () => {
    const cookie = await seedSession(ADMIN_ID)
    const res = await get('/dashboard/admin', cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('href="/dashboard/admin"')
    expect(html).toContain(ADMIN_EMAIL)
    expect(html).toContain(HOST_EMAIL)
  })

  it('closing sign-ups from the UI drives the real consume gate, and reopening lifts it', async () => {
    const cookie = await seedSession(ADMIN_ID)
    let csrf = await adminCsrf(cookie)

    const closed = await post('/dashboard/admin/signups', { mode: 'closed', csrf }, cookie)
    expect(closed.status).toBe(200)
    expect(await closed.text()).toContain('Sign-up policy saved')

    const refused = await app.fetch(
      new Request(`${BASE}/auth/callback?token=${encodeURIComponent(await seedLink('ui-closed@example.test'))}`),
    )
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain('Sign-ups are closed')

    csrf = await adminCsrf(cookie)
    await post('/dashboard/admin/signups', { mode: 'open', csrf }, cookie)
    const admitted = await app.fetch(
      new Request(`${BASE}/auth/callback?token=${encodeURIComponent(await seedLink('ui-open@example.test'))}`),
    )
    expect(admitted.status).toBe(302)
  })

  it('an allowlist saved from the UI must not be empty', async () => {
    const cookie = await seedSession(ADMIN_ID)
    const csrf = await adminCsrf(cookie)
    const res = await post('/dashboard/admin/signups', { mode: 'allowlist', allowlist: ' , ', csrf }, cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('at least one email or @domain')
  })

  it('promotes a member, and refuses to demote the last admin', async () => {
    const cookie = await seedSession(ADMIN_ID)
    let csrf = await adminCsrf(cookie)

    // The only admin demoting themselves must be refused outright.
    const refused = await post(`/dashboard/admin/users/${ADMIN_ID}/role`, { role: 'member', csrf }, cookie)
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain('Cannot remove the last admin')

    csrf = await adminCsrf(cookie)
    const promoted = await post(`/dashboard/admin/users/${HOST_ID}/role`, { role: 'admin', csrf }, cookie)
    expect(promoted.status).toBe(200)
    const row = await db.prepare('SELECT role FROM users WHERE id = ?').bind(HOST_ID).first<{ role: string }>()
    expect(row?.role).toBe('admin')

    // Two admins now — demoting one is allowed again. Restore the fixture.
    csrf = await adminCsrf(cookie)
    const demoted = await post(`/dashboard/admin/users/${HOST_ID}/role`, { role: 'member', csrf }, cookie)
    expect(demoted.status).toBe(200)
  })

  it('demoteAdmin is a single guarded statement: refuses the last admin, demotes one of two', async () => {
    // The guard and the write are one SQL statement — the property that makes
    // two concurrent demotions unable to race past a separate count and
    // leave zero admins. Exercised at the repository, where the atomicity
    // actually lives.
    const repos = createD1Repositories(db, { consistency: 'bookmark' })

    expect(await repos.users.demoteAdmin(ADMIN_ID)).toBe(false) // sole admin
    expect(await repos.users.demoteAdmin(HOST_ID)).toBe(false) // not an admin at all

    await db.prepare("UPDATE users SET role='admin' WHERE id = ?").bind(HOST_ID).run()
    expect(await repos.users.demoteAdmin(HOST_ID)).toBe(true) // one of two
    const row = await db.prepare('SELECT role FROM users WHERE id = ?').bind(HOST_ID).first<{ role: string }>()
    expect(row?.role).toBe('member')
  })

  it('an env-pinned policy renders read-only and ignores the form', async () => {
    const pinnedPorts: EnginePorts = {
      ...ports,
      config: fakeConfig({ baseUrl: BASE, signupPolicy: { mode: 'closed' } }),
    }
    const pinnedApp = buildDashboardRoutes(pinnedPorts, slots)
    const cookie = await seedSession(ADMIN_ID)

    const page = await pinnedApp.fetch(new Request(`${BASE}/dashboard/admin`, { headers: { cookie } }))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Pinned to')
    expect(html).not.toContain('name="mode"')
  })
})
