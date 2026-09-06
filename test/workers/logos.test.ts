/**
 * Logos for event types and teams, and team editing and serving, under the real Workers runtime — the
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


beforeAll(async () => {
  await db
    .prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
    .bind(HOST_ID, HOST_EMAIL, 'Avatar Host', 'UTC', 'avatar-host', NOW)
    .run()
})


async function multipart(path: string, cookie: string, csrf: string, field: string, bytes: Uint8Array, type = 'image/png'): Promise<Response> {
  const form = new FormData()
  form.append('csrf', csrf)
  form.append(field, new File([bytes], 'logo.png', { type }))
  return app.fetch(new Request(`${BASE}${path}`, { method: 'POST', body: form, headers: { cookie } }))
}

async function postForm(path: string, cookie: string, body: Record<string, string>): Promise<Response> {
  const form = new FormData()
  for (const [k, v] of Object.entries(body)) form.append(k, v)
  return app.fetch(new Request(`${BASE}${path}`, { method: 'POST', body: form, headers: { cookie } }))
}

const L_ALICE = 'usr_logo_alice'
const L_BOB = 'usr_logo_bob'
const L_TEAM = 'team_logo'
const L_ET = 'et_logo_team'
const L_PERSONAL = 'et_logo_personal'

beforeAll(async () => {
  const now = Date.now()
  const insertUser = 'INSERT INTO users (id,email,name,tz,slug,role,created_at) VALUES (?,?,?,?,?,?,?)'
  await db.batch([
    db.prepare(insertUser).bind(L_ALICE, 'logo-alice@example.test', 'Alice Logo', 'UTC', 'logo-alice', 'member', now),
    db.prepare(insertUser).bind(L_BOB, 'logo-bob@example.test', 'Bob Logo', 'UTC', 'logo-bob', 'member', now),
    db.prepare('INSERT INTO slug_claims (slug,kind,owner_id,created_at) VALUES (?,?,?,?)').bind('logo-alice', 'user', L_ALICE, now),
    db.prepare('INSERT INTO slug_claims (slug,kind,owner_id,created_at) VALUES (?,?,?,?)').bind('logo-bob', 'user', L_BOB, now),
    db.prepare('INSERT INTO teams (id,name,slug,logo_key,created_at) VALUES (?,?,?,?,?)').bind(L_TEAM, 'Logo Crew', 'logo-crew', null, now),
    db.prepare('INSERT INTO slug_claims (slug,kind,owner_id,created_at) VALUES (?,?,?,?)').bind('logo-crew', 'team', L_TEAM, now),
    db.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind(L_TEAM, L_ALICE, 'admin', 1),
    db.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind(L_TEAM, L_BOB, 'member', 1),
    db.prepare(
      `INSERT INTO event_types (id,owner_user_id,owner_team_id,scheduling_type,slug,title,duration_minutes,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(L_ET, null, L_TEAM, 'collective', 'crew-call', 'Crew call', 30, now),
    db.prepare(
      `INSERT INTO event_types (id,owner_user_id,owner_team_id,scheduling_type,slug,title,duration_minutes,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(L_PERSONAL, L_ALICE, null, 'personal', 'intro', 'Intro', 30, now),
  ])
})

describe('event type logo', () => {
  it('uploads a logo from the edit form; the booking page is headed by it; remove clears it', async () => {
    const cookie = await seedSession(L_ALICE)
    const csrf = await csrfFor(cookie)
    const res = await multipart(`/dashboard/event-types/${L_ET}/logo`, cookie, csrf, 'logo', pngBytes())
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Logo updated.')
    const row = await db.prepare('SELECT logo_key FROM event_types WHERE id = ?').bind(L_ET).first<{ logo_key: string | null }>()
    expect(row?.logo_key).toMatch(/-thumb\.webp$/)
    expect(html).toContain(`/avatars/${row!.logo_key}`)
    expect(html).toContain('Replace logo')

    // The public page shows the event's own logo, not the team's initial.
    const page = await app.fetch(new Request(`${BASE}/logo-crew/crew-call`))
    const pageHtml = await page.text()
    expect(pageHtml).toContain(`/avatars/${row!.logo_key}`)
    // Served for real, as a WebP thumbnail.
    const img = await app.fetch(new Request(`${BASE}/avatars/${row!.logo_key}`))
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/webp')

    const removed = await postForm(`/dashboard/event-types/${L_ET}/logo/delete`, cookie, { csrf })
    expect(removed.status).toBe(200)
    expect(await removed.text()).toContain('Logo removed.')
    const after = await db.prepare('SELECT logo_key FROM event_types WHERE id = ?').bind(L_ET).first<{ logo_key: string | null }>()
    expect(after?.logo_key).toBeNull()
  })

  it('rejects a bad file with the same rules as the profile photo, and a non-admin cannot upload at all', async () => {
    const cookie = await seedSession(L_ALICE)
    const csrf = await csrfFor(cookie)
    const bad = await multipart(`/dashboard/event-types/${L_ET}/logo`, cookie, csrf, 'logo', new Uint8Array([1, 2, 3]), 'text/plain')
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('PNG, JPEG or WebP images only')

    const bob = await seedSession(L_BOB)
    const bobCsrf = await csrfFor(bob)
    expect((await multipart(`/dashboard/event-types/${L_ET}/logo`, bob, bobCsrf, 'logo', pngBytes())).status).toBe(404)
  })

  it('the create form has no logo panel; a personal event type gets one on edit', async () => {
    const cookie = await seedSession(L_ALICE)
    const fresh = await app.fetch(new Request(`${BASE}/dashboard/event-types/new`, { headers: { cookie } }))
    expect(await fresh.text()).not.toContain('Upload logo')
    const edit = await app.fetch(new Request(`${BASE}/dashboard/event-types/${L_PERSONAL}`, { headers: { cookie } }))
    expect(await edit.text()).toContain('Upload logo')
  })
})

describe('team editing', () => {
  it('an admin uploads and removes the team logo; a member sees no settings', async () => {
    const cookie = await seedSession(L_ALICE)
    const csrf = await csrfFor(cookie)
    const res = await multipart(`/dashboard/teams/${L_TEAM}/logo`, cookie, csrf, 'logo', pngBytes())
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('logo updated.')
    const row = await db.prepare('SELECT logo_key FROM teams WHERE id = ?').bind(L_TEAM).first<{ logo_key: string | null }>()
    expect(row?.logo_key).toMatch(/-thumb\.webp$/)
    // The team page is headed by it.
    const page = await app.fetch(new Request(`${BASE}/logo-crew/crew-call`))
    expect(await page.text()).toContain(`/avatars/${row!.logo_key}`)

    const bob = await seedSession(L_BOB)
    const bobPage = await app.fetch(new Request(`${BASE}/dashboard/teams`, { headers: { cookie: bob } }))
    expect(await bobPage.text()).not.toContain('Team settings')
    expect((await multipart(`/dashboard/teams/${L_TEAM}/logo`, bob, await csrfFor(bob), 'logo', pngBytes())).status).toBe(404)

    const removed = await postForm(`/dashboard/teams/${L_TEAM}/logo/delete`, cookie, { csrf })
    expect(removed.status).toBe(200)
    expect((await db.prepare('SELECT logo_key FROM teams WHERE id = ?').bind(L_TEAM).first<{ logo_key: string | null }>())?.logo_key).toBeNull()
  })

  it('renames and re-slugs a team; the claim moves; the old address stops resolving', async () => {
    const cookie = await seedSession(L_ALICE)
    const csrf = await csrfFor(cookie)
    const res = await postForm(`/dashboard/teams/${L_TEAM}`, cookie, { csrf, name: 'Logo Crew Ltd', slug: 'logo-crew-ltd' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Its booking links now start with /logo-crew-ltd')
    const team = await db.prepare('SELECT name, slug FROM teams WHERE id = ?').bind(L_TEAM).first<{ name: string; slug: string }>()
    expect(team).toEqual({ name: 'Logo Crew Ltd', slug: 'logo-crew-ltd' })
    const claim = await db.prepare("SELECT slug FROM slug_claims WHERE kind = 'team' AND owner_id = ?").bind(L_TEAM).first<{ slug: string }>()
    expect(claim?.slug).toBe('logo-crew-ltd')
    expect((await app.fetch(new Request(`${BASE}/logo-crew-ltd/crew-call`))).status).toBe(200)
    expect((await app.fetch(new Request(`${BASE}/logo-crew/crew-call`))).status).toBe(404)
  })

  it("refuses a slug a user holds, naming them, and a reserved one; a member cannot edit", async () => {
    const cookie = await seedSession(L_ALICE)
    const csrf = await csrfFor(cookie)
    const taken = await postForm(`/dashboard/teams/${L_TEAM}`, cookie, { csrf, name: 'Logo Crew Ltd', slug: 'logo-bob' })
    expect(taken.status).toBe(400)
    expect(await taken.text()).toContain('That slug is already taken by Bob Logo')
    const reserved = await postForm(`/dashboard/teams/${L_TEAM}`, cookie, { csrf, name: 'Logo Crew Ltd', slug: 'api' })
    expect(reserved.status).toBe(400)
    expect(await reserved.text()).toContain('reserved')
    expect((await db.prepare('SELECT slug FROM teams WHERE id = ?').bind(L_TEAM).first<{ slug: string }>())?.slug).toBe('logo-crew-ltd')

    const bob = await seedSession(L_BOB)
    expect((await postForm(`/dashboard/teams/${L_TEAM}`, bob, { csrf: await csrfFor(bob), name: 'X', slug: 'x' })).status).toBe(404)
  })
})
