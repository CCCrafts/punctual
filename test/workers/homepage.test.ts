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
const HOST_ID = 'usr_home_host'
const HOST_EMAIL = 'homehost@example.test'

// A real 6x4 PNG (`magick -size 6x4 xc:'#3355ee' -depth 8 -strip`) — small
// enough to embed, real enough for photon to decode, crop and resize as an
// actual image rather than bytes that merely pass the content-type check.
// Deliberately NOT one of the well-known hand-minified "smallest possible
// PNG" byte strings that circulate online: several of those use encoding
// shortcuts that trip a decode panic in photon-rs's underlying `image`
// crate (verified directly — this is not a hypothetical), which a normal
// encoder's output does not.



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
    .bind(HOST_ID, HOST_EMAIL, 'Home Host', 'UTC', 'home-host', NOW)
    .run()
})



async function postForm(path: string, cookie: string, body: Record<string, string>): Promise<Response> {
  const form = new FormData()
  for (const [k, v] of Object.entries(body)) form.append(k, v)
  return app.fetch(new Request(`${BASE}${path}`, { method: 'POST', body: form, headers: { cookie } }))
}



/**
 * `/` is the Punctual landing by default; an instance can make it an index
 * of its own booking links instead (issue #8). The admin picks from every
 * active event type on the instance; a crafted id, or one that went
 * inactive, never becomes a link.
 */
describe('the instance homepage', () => {
  const ADMIN = 'usr_home_admin'
  const MEMBER = 'usr_home_member'
  const ET = 'et_home_intro'
  const ET_TEAM = 'et_home_team'
  const ET_OFF = 'et_home_off'

  beforeAll(async () => {
    const insertUser = 'INSERT INTO users (id,email,name,tz,slug,role,created_at) VALUES (?,?,?,?,?,?,?)'
    const insertEt = `INSERT INTO event_types (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
    await db.batch([
      db.prepare(insertUser).bind(ADMIN, 'home-admin@example.test', 'Ada Admin', 'UTC', 'ada', 'admin', NOW),
      db.prepare(insertUser).bind(MEMBER, 'home-member@example.test', 'Max Member', 'UTC', 'max', 'member', NOW),
      db.prepare('INSERT INTO teams (id,name,slug,created_at) VALUES (?,?,?,?)').bind('team_home', 'Support Crew', 'support-crew', NOW),
      db.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind('team_home', ADMIN, 'admin', 1),
      db.prepare(insertEt).bind(ET, ADMIN, null, 'personal', 'intro', 'Intro call', 'A short chat.', 30, 1, NOW),
      db.prepare(insertEt).bind(ET_TEAM, null, 'team_home', 'round_robin', 'support', 'Support call', '', 15, 1, NOW),
      db.prepare(insertEt).bind(ET_OFF, ADMIN, null, 'personal', 'old', 'Old thing', '', 30, 0, NOW),
    ])
  })

  it('is the landing until an admin says otherwise', async () => {
    const html = await (await app.fetch(new Request(`${BASE}/`))).text()
    expect(html).toContain('Calendly')
    expect(html).not.toContain('class="pu-home-list"')
  })

  it('an admin picks the index; a member cannot; the page lists the picked links under their owners', async () => {
    const member = await seedSession(MEMBER)
    const refused = await postForm('/dashboard/admin/homepage', member, { csrf: await csrfFor(member), home_mode: 'index' })
    expect(refused.status).not.toBe(200)

    const cookie = await seedSession(ADMIN)
    const csrf = await csrfFor(cookie)
    const admin = await (await app.fetch(new Request(`${BASE}/dashboard/admin`, { headers: { cookie } }))).text()
    // The picker offers active event types only, each with the link it would make.
    expect(admin).toContain(`value="${ET}"`)
    expect(admin).toContain('<code>/support-crew/support</code>')
    expect(admin).not.toContain(`value="${ET_OFF}"`)

    const form = new FormData()
    form.append('csrf', csrf)
    form.append('home_mode', 'index')
    form.append('title', 'Acme Support')
    // As a browser sends a textarea: CRLF line breaks, which must not count double against the limit.
    form.append('intro', `Pick a time.\r\n\r\n${'x'.repeat(1970)}\r\nWe answer fast.`)
    form.append('event_types', ET_TEAM)
    form.append('event_types', ET)
    form.append('event_types', ET_OFF)
    form.append('event_types', 'et_forged')
    const saved = await app.fetch(new Request(`${BASE}/dashboard/admin/homepage`, { method: 'POST', body: form, headers: { cookie } }))
    expect(saved.status).toBe(200)
    expect(await saved.text()).toContain('/ now shows this instance')
    const stored = await db.prepare("SELECT value FROM instance_settings WHERE key = 'home_event_types'").first<{ value: string }>()
    expect(JSON.parse(stored!.value)).toEqual([ET_TEAM, ET])

    const html = await (await app.fetch(new Request(`${BASE}/`))).text()
    expect(html).toContain('<title>Acme Support</title>')
    expect(html).toContain('<link rel="canonical" href="https://punctual.test/">')
    expect(html).toContain('<p>Pick a time.</p>')
    expect((await db.prepare("SELECT value FROM instance_settings WHERE key = 'home_intro'").first<{ value: string }>())!.value).not.toContain('\r')
    expect(html.indexOf('href="/support-crew/support"')).toBeLessThan(html.indexOf('href="/ada/intro"'))
    expect(html).toContain('15 min · Support Crew')
    expect(html).toContain('30 min · Ada Admin')
    expect(html).not.toContain('/ada/old')
    expect(html).not.toContain('Calendly')

    // Back to the landing.
    expect((await postForm('/dashboard/admin/homepage', cookie, { csrf, home_mode: 'landing' })).status).toBe(200)
    expect(await (await app.fetch(new Request(`${BASE}/`))).text()).toContain('Calendly')
  })
})
