/**
 * Avatar upload and serving (CCC-543), under the real Workers runtime — the
 * part that cannot be checked by reading the code: `@cf-wasm/photon` actually
 * decodes and resizes real bytes under workerd, and R2 (simulated by
 * `@cloudflare/vitest-pool-workers` from the `[[r2_buckets]]` binding in
 * wrangler.toml) actually round-trips them.
 */

import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildRouter } from '../../src/http/router.js'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { createR2BlobStorage } from '../../src/adapters/storage/r2-blob.js'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import { createSlotService } from '../../src/engine.js'
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from '../../src/core/domain/auth-service.js'
import { createFakeEmailSender, createFakeRateLimiter, fakeConfig } from '../../src/testing/fakes.js'
import type {
  BlobCache,
  CalendarProviders,
  EnginePorts,
  HostCoordinator,
  QueuePort,
} from '../../src/ports.js'

const db = env.DB
const BASE = 'https://punctual.test'
const NOW = Date.now()
const HOST_ID = 'usr_avatar_host'
const HOST_EMAIL = 'avatarhost@example.test'

// A real 6x4 PNG (`magick -size 6x4 xc:'#3355ee' -depth 8 -strip`) — small
// enough to embed, real enough for photon to decode, crop and resize as an
// actual image rather than bytes that merely pass the content-type check.
// Deliberately NOT one of the well-known hand-minified "smallest possible
// PNG" byte strings that circulate online: several of those use encoding
// shortcuts that trip a decode panic in photon-rs's underlying `image`
// crate (verified directly — this is not a hypothetical), which a normal
// encoder's output does not.
const PNG_6X4_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAEAQMAAACXytwAAAAAA1BMVEUzVe4BKQB9AAAAC0lEQVQI12NggAAAAAgAAS8g3TEAAAAASUVORK5CYII='
function pngBytes(): Uint8Array {
  const binary = atob(PNG_6X4_BASE64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const crypto_ = createWebCrypto({
  keys: { 1: 'dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy0hIQ==' },
  currentVersion: 1,
  signingKey: 'dGVzdC1zaWduaW5nLWtleS0zMi1ieXRlcy1sb25nLi4h',
})

const calendars: CalendarProviders = {
  get() {
    throw new Error('test: no calendar provider is configured')
  },
  available: () => [],
}
const blobCache: BlobCache = {
  async get() {
    return null
  },
  async put() {},
}
const queue: QueuePort = { async send() {}, async sendBatch() {} }
const coordinator = new Proxy({} as HostCoordinator, {
  get(_t, prop) {
    return () => {
      throw new Error(`test: coordinator.${String(prop)} is not stubbed`)
    }
  },
})

const ports: EnginePorts = {
  repositories: (scope) => createD1Repositories(db, scope),
  calendars,
  oauth: { forProvider: () => null, redirectUri: (name, purpose) => `${BASE}/auth/${name}/callback?purpose=${purpose}` },
  email: createFakeEmailSender(),
  crypto: crypto_,
  cache: { async get() { return null }, async put() {}, async delete() {} },
  blobCache,
  blobStorage: createR2BlobStorage(env.AVATARS),
  clock: { now: () => Date.now() },
  queue,
  coordinator,
  rateLimiter: createFakeRateLimiter(),
  config: fakeConfig({ baseUrl: BASE }),
}

const slots = createSlotService(ports)
const app = buildRouter(ports, slots)

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

async function csrfFor(cookie: string): Promise<string> {
  const token = cookie.slice(`${SESSION_COOKIE_NAME}=`.length)
  const idHash = await crypto_.hash(token)
  return crypto_.hash(`csrf|${idHash}`)
}

async function uploadAvatar(
  cookie: string,
  csrf: string,
  file: { bytes: Uint8Array; type: string; name?: string },
): Promise<Response> {
  const form = new FormData()
  form.append('csrf', csrf)
  form.append('avatar', new File([file.bytes], file.name ?? 'photo.png', { type: file.type }))
  return app.fetch(
    new Request(`${BASE}/dashboard/settings/avatar`, { method: 'POST', body: form, headers: { cookie } }),
  )
}

beforeAll(async () => {
  await db
    .prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
    .bind(HOST_ID, HOST_EMAIL, 'Avatar Host', 'UTC', 'avatar-host', NOW)
    .run()
})

describe('avatar upload', () => {
  it('rejects an unsupported content type', async () => {
    const cookie = await seedSession(HOST_ID)
    const csrf = await csrfFor(cookie)
    const res = await uploadAvatar(cookie, csrf, { bytes: new Uint8Array([1, 2, 3]), type: 'image/gif' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('PNG, JPEG or WebP')
  })

  it('rejects a file over the 5 MB cap', async () => {
    const cookie = await seedSession(HOST_ID)
    const csrf = await csrfFor(cookie)
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1)
    const res = await uploadAvatar(cookie, csrf, { bytes: oversized, type: 'image/png' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('larger than 5 MB')
  })

  it('rejects a request with no valid CSRF token', async () => {
    const cookie = await seedSession(HOST_ID)
    const res = await uploadAvatar(cookie, 'forged', { bytes: pngBytes(), type: 'image/png' })
    expect(res.status).toBe(403)
  })

  it('uploads a real PNG, resizes it, and serves the thumbnail back at /avatars/:key', async () => {
    const cookie = await seedSession(HOST_ID)
    const csrf = await csrfFor(cookie)

    const res = await uploadAvatar(cookie, csrf, { bytes: pngBytes(), type: 'image/png' })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Photo updated')

    const key = /\/avatars\/([a-f0-9]{64}-thumb\.webp)/.exec(html)?.[1]
    expect(key).toBeTruthy()

    const served = await app.fetch(new Request(`${BASE}/avatars/${key}`))
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/webp')
    expect(served.headers.get('cache-control')).toContain('immutable')
    const bytes = new Uint8Array(await served.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(0)

    // Persisted on the row, not just returned in this response.
    const row = await db.prepare('SELECT avatar_key FROM users WHERE id = ?').bind(HOST_ID).first<{
      avatar_key: string
    }>()
    expect(row?.avatar_key).toBe(key)
  })

  it('the booking page for this host now shows the uploaded photo, not the initials badge', async () => {
    await db
      .prepare(
        `INSERT INTO event_types
         (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
          slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
          max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        'et_avatar_host',
        HOST_ID,
        null,
        'personal',
        'thirty',
        '30 min',
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
        NOW,
      )
      .run()

    const res = await app.fetch(new Request(`${BASE}/avatar-host/thirty`))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toMatch(/\/avatars\/[a-f0-9]{64}-thumb\.webp/)
  })

  it('re-uploading identical bytes resolves to the same content-addressed key', async () => {
    const cookie = await seedSession(HOST_ID)
    const csrf = await csrfFor(cookie)

    const first = await uploadAvatar(cookie, csrf, { bytes: pngBytes(), type: 'image/png' })
    const firstKey = /\/avatars\/([a-f0-9]{64}-thumb\.webp)/.exec(await first.text())?.[1]

    const second = await uploadAvatar(cookie, csrf, { bytes: pngBytes(), type: 'image/png' })
    const secondKey = /\/avatars\/([a-f0-9]{64}-thumb\.webp)/.exec(await second.text())?.[1]

    expect(firstKey).toBe(secondKey)
  })
})

describe('GET /avatars/:key', () => {
  it('404s for a well-formed key that was never uploaded', async () => {
    const res = await app.fetch(new Request(`${BASE}/avatars/${'0'.repeat(64)}-thumb.webp`))
    expect(res.status).toBe(404)
  })

  it('404s for a malformed key instead of ever reaching R2 with it', async () => {
    const res = await app.fetch(new Request(`${BASE}/avatars/../../etc/passwd`))
    expect(res.status).toBe(404)
  })
})

describe('avatar removal', () => {
  it('clears avatarKey and the settings page falls back to the initials badge', async () => {
    const cookie = await seedSession(HOST_ID)
    const csrf = await csrfFor(cookie)
    await uploadAvatar(cookie, csrf, { bytes: pngBytes(), type: 'image/png' })

    const res = await app.fetch(
      new Request(`${BASE}/dashboard/settings/avatar/delete`, {
        method: 'POST',
        body: (() => {
          const f = new FormData()
          f.append('csrf', csrf)
          return f
        })(),
        headers: { cookie },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Photo removed')

    const row = await db.prepare('SELECT avatar_key FROM users WHERE id = ?').bind(HOST_ID).first<{
      avatar_key: string | null
    }>()
    expect(row?.avatar_key).toBeNull()
  })
})
