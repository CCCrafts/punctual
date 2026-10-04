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
import { notifyWebhooks } from '../../src/adapters/notify.js'
import { handleOne } from '../../src/adapters/queue/consumer.js'
import type { Booking } from '../../src/core/domain/types.js'
import type {
  QueueMessage,
  BlobCache,
  CalendarProviders,
  EnginePorts,
  HostCoordinator,
  QueuePort,
} from '../../src/ports.js'

const db = env.DB
const BASE = 'https://punctual.test'
const NOW = Date.now()
const HOST_ID = 'usr_ch_host'
const HOST_EMAIL = 'chhost@example.test'

// A real 6x4 PNG (`magick -size 6x4 xc:'#3355ee' -depth 8 -strip`) — small
// enough to embed, real enough for photon to decode, crop and resize as an
// actual image rather than bytes that merely pass the content-type check.
// Deliberately NOT one of the well-known hand-minified "smallest possible
// PNG" byte strings that circulate online: several of those use encoding
// shortcuts that trip a decode panic in photon-rs's underlying `image`
// crate (verified directly — this is not a hypothetical), which a normal
// encoder's output does not.



/** Deterministic 32-byte keys — the channel secret is really encrypted here, unlike the harness this was copied from. */
function keyMaterial(seed: number): string {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) & 0xff
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}
const crypto_ = createWebCrypto({ keys: { 1: keyMaterial(1) }, currentVersion: 1, signingKey: keyMaterial(9) })

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
const queued: QueueMessage[] = []
const queue: QueuePort = { async send(m) { queued.push(m) }, async sendBatch(ms) { queued.push(...ms) } }
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
    .bind(HOST_ID, HOST_EMAIL, 'Chan Host', 'UTC', 'chan-host', NOW)
    .run()
})



async function postForm(path: string, cookie: string, body: Record<string, string>): Promise<Response> {
  const form = new FormData()
  for (const [k, v] of Object.entries(body)) form.append(k, v)
  return app.fetch(new Request(`${BASE}${path}`, { method: 'POST', body: form, headers: { cookie } }))
}



const SLACK = 'https://hooks.slack.com/services/T0ABC/B0DEF/xyz123'
const TG_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0'

/** Capture outbound posts: the engine's chat delivery and the test button go through global fetch. */
function captureFetch(status = 200) {
  const calls: Array<{ url: string; body: unknown }> = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(status === 200 ? 'ok' : 'no_service', { status })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

/**
 * A host's and a team's Slack / Telegram channels: added from the
 * dashboard (secret stored encrypted, shown as a masked label), fanned out
 * on a booking event through the queue, delivered by the consumer, tested
 * with one button.
 */
describe('notification channels', () => {
  const ADMIN = 'usr_ch_admin'
  const OTHER = 'usr_ch_other'
  const TEAM = 'team_ch'
  const ET = 'et_ch_team'
  const BOOKING = 'bk_ch_1'

  beforeAll(async () => {
    const insertUser = 'INSERT INTO users (id,email,name,tz,slug,role,created_at) VALUES (?,?,?,?,?,?,?)'
    await db.batch([
      db.prepare(insertUser).bind(ADMIN, 'ch-admin@example.test', 'Ch Admin', 'Europe/Kyiv', 'ch-admin', 'member', NOW),
      db.prepare(insertUser).bind(OTHER, 'ch-other@example.test', 'Ch Other', 'UTC', 'ch-other', 'member', NOW),
      db.prepare('INSERT INTO teams (id,name,slug,created_at) VALUES (?,?,?,?)').bind(TEAM, 'Chan Crew', 'chan-crew', NOW),
      db.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind(TEAM, ADMIN, 'admin', 1),
      db.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind(TEAM, HOST_ID, 'member', 1),
      db.prepare(`INSERT INTO event_types (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(ET, null, TEAM, 'collective', 'crew', 'Crew call', '', 30, 1, NOW),
      db.prepare(`INSERT INTO bookings (id,event_type_id,host_user_id,host_user_ids_json,guest_name,guest_email,guest_timezone,start_utc,end_utc,local_date,status,manage_token_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(BOOKING, ET, HOST_ID, JSON.stringify([HOST_ID, ADMIN]), 'Ada Lovelace', 'ada@example.test', 'UTC', NOW + 86_400_000, NOW + 86_400_000 + 1_800_000, '', 'confirmed', 'h', NOW),
    ])
  })

  it('a host adds a Slack channel from Settings; the URL is stored encrypted and shown masked; bad input is refused', async () => {
    const cookie = await seedSession(HOST_ID)
    const csrf = await csrfFor(cookie)
    const bad = await postForm('/dashboard/notifications', cookie, { csrf, kind: 'slack', webhook_url: 'https://evil.example/hook', events: 'booking.created' })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('A Slack incoming webhook URL looks like')
    const none = await postForm('/dashboard/notifications', cookie, { csrf, kind: 'slack', webhook_url: SLACK })
    expect(none.status).toBe(400)
    expect(await none.text()).toContain('Tick at least one event')

    const form = new FormData()
    form.append('csrf', csrf); form.append('kind', 'slack'); form.append('webhook_url', SLACK)
    form.append('events', 'booking.created'); form.append('events', 'booking.cancelled')
    const ok = await app.fetch(new Request(`${BASE}/dashboard/notifications`, { method: 'POST', body: form, headers: { cookie } }))
    expect(ok.status).toBe(200)
    const html = await ok.text()
    expect(html).toContain('Slack · …/T0ABC/B0DEF')
    expect(html).toContain('New booking, Cancelled')
    expect(html).not.toContain('xyz123')
    const row = await db.prepare('SELECT * FROM notification_channels WHERE owner_kind = ? AND owner_id = ?').bind('user', HOST_ID).first<Record<string, string>>()
    expect(row!.kind).toBe('slack')
    expect(row!.config_enc).not.toContain('hooks.slack.com')
    expect(JSON.parse(row!.events_json!)).toEqual(['booking.created', 'booking.cancelled'])
  })

  it("a team admin adds a Telegram channel on the team's card; a member cannot", async () => {
    const member = await seedSession(HOST_ID)
    expect((await postForm(`/dashboard/teams/${TEAM}/notifications`, member, { csrf: await csrfFor(member), kind: 'telegram', bot_token: TG_TOKEN, chat_id: '-100123', events: 'booking.created' })).status).toBe(404)
    const cookie = await seedSession(ADMIN)
    const csrf = await csrfFor(cookie)
    const ok = await postForm(`/dashboard/teams/${TEAM}/notifications`, cookie, { csrf, kind: 'telegram', bot_token: TG_TOKEN, chat_id: '-100123', events: 'booking.created' })
    expect(ok.status).toBe(200)
    const html = await ok.text()
    expect(html).toContain('Telegram · -100123 via bot 123456789')
    expect(html).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0')
  })

  it('a booking event fans out to the host\'s and the team\'s channels once each, and the consumer posts the message', async () => {
    queued.length = 0
    const booking = (await createD1Repositories(db, { consistency: 'bookmark' }).bookings.byId(BOOKING)) as Booking
    const eventType = (await createD1Repositories(db, { consistency: 'bookmark' }).eventTypes.byId(ET))!
    await notifyWebhooks(ports, 'booking.created', booking, eventType)
    const chats = queued.filter((m) => m.kind === 'chat') as Array<Extract<QueueMessage, { kind: 'chat' }>>
    expect(chats).toHaveLength(2)
    expect(new Set(chats.map((m) => m.event))).toEqual(new Set(['booking.created']))

    const { calls, restore } = captureFetch()
    try {
      for (const m of chats) await handleOne(m, ports)
    } finally {
      restore()
    }
    const slack = calls.find((c) => c.url === SLACK)!
    const tg = calls.find((c) => c.url.startsWith('https://api.telegram.org/bot'))!
    expect(slack).toBeTruthy()
    expect(tg.url).toBe(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`)
    const text = (slack.body as { text: string }).text
    expect(text).toContain('*New booking: Crew call*')
    expect(text).toContain('Ada Lovelace <ada@example.test>')
    expect(text).toContain('With Chan Host and Ch Admin')
    // The host's own channel reads the time in the host's zone (UTC); the team's in its first member's.
    expect(text).toContain('(UTC)')
    expect((tg.body as { text: string }).text).toContain('Open booking')
    expect((tg.body as { chat_id: string }).chat_id).toBe('-100123')

    // A cancellation reaches only the channel that asked for it.
    queued.length = 0
    await notifyWebhooks(ports, 'booking.cancelled', booking, eventType)
    expect(queued.filter((m) => m.kind === 'chat')).toHaveLength(1)
  })

  it('a failed post throws so the queue retries', async () => {
    queued.length = 0
    const repos = createD1Repositories(db, { consistency: 'bookmark' })
    await notifyWebhooks(ports, 'booking.created', (await repos.bookings.byId(BOOKING))!, (await repos.eventTypes.byId(ET))!)
    const msg = queued.find((m) => m.kind === 'chat')!
    const { restore } = captureFetch(500)
    try {
      await expect(handleOne(msg!, ports)).rejects.toThrow(/chat notification to .* failed: Slack answered 500|Telegram answered 500/)
    } finally {
      restore()
    }
  })

  it('"Send a test" posts now and reports the outcome; a stranger cannot reach the channel; delete removes it', async () => {
    const row = await db.prepare('SELECT id FROM notification_channels WHERE owner_kind = ? AND owner_id = ?').bind('user', HOST_ID).first<{ id: string }>()
    const cookie = await seedSession(HOST_ID)
    const csrf = await csrfFor(cookie)
    const { calls, restore } = captureFetch()
    try {
      const res = await postForm(`/dashboard/notifications/${row!.id}/test`, cookie, { csrf })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('Test sent to Slack · …/T0ABC/B0DEF')
      expect(calls).toHaveLength(1)
      expect((calls[0]!.body as { text: string }).text).toContain('Test from Punctual')
    } finally {
      restore()
    }
    const { restore: restore2 } = captureFetch(404)
    try {
      const failed = await postForm(`/dashboard/notifications/${row!.id}/test`, cookie, { csrf })
      expect(failed.status).toBe(400)
      expect(await failed.text()).toContain('Could not post to Slack')
    } finally {
      restore2()
    }
    const other = await seedSession(OTHER)
    expect((await postForm(`/dashboard/notifications/${row!.id}/test`, other, { csrf: await csrfFor(other) })).status).toBe(404)
    expect((await postForm(`/dashboard/notifications/${row!.id}/delete`, other, { csrf: await csrfFor(other) })).status).toBe(404)
    const gone = await postForm(`/dashboard/notifications/${row!.id}/delete`, cookie, { csrf })
    expect(gone.status).toBe(302)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM notification_channels WHERE id = ?').bind(row!.id).first<{ n: number }>()).toEqual({ n: 0 })
  })
})
