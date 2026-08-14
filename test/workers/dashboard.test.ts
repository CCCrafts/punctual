/// <reference types="@cloudflare/vitest-pool-workers/types" />
/// <reference types="vite/client" />

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
import schemaSql from '../../migrations/0001_initial.sql?raw'

import { buildDashboardRoutes } from '../../src/http/dashboard-routes.js'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import { issueManageToken } from '../../src/core/domain/auth-flows.js'
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from '../../src/core/domain/auth-service.js'
import {
  createFakeEmailSender,
  createFakeRateLimiter,
  fakeConfig,
} from '../../src/testing/fakes.js'
import type { SlotService } from '../../src/engine.js'
import type {
  Cache as CachePort,
  CalendarProviders,
  EnginePorts,
  HostCoordinator,
  QueuePort,
} from '../../src/ports.js'

const db = (env as unknown as { DB: D1Database }).DB

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
  email,
  crypto: crypto_,
  cache,
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

function get(path: string, cookie?: string): Promise<Response> {
  return app.fetch(new Request(`${BASE}${path}`, cookie ? { headers: { cookie } } : {}))
}

function post(path: string, body: Record<string, string>, cookie?: string): Promise<Response> {
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

/**
 * D1's `exec` treats each line as a statement, which a multi-line CREATE TABLE
 * is not — so the migration is split on statement boundaries instead.
 */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
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

beforeAll(async () => {
  await db.batch(statements(schemaSql).map((sql) => db.prepare(sql)))

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
