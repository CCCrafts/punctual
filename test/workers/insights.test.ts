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
import { createFakeEmailSender, createFakeInsights, createFakeRateLimiter, fakeConfig } from '../../src/testing/fakes.js'
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
const HOST_ID = 'usr_ins_host'
const HOST_EMAIL = 'inshost@example.test'

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
const insights = createFakeInsights()
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
  insights,
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



beforeAll(async () => {
  await db
    .prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)')
    .bind(HOST_ID, HOST_EMAIL, 'Ins Host', 'UTC', 'ins-host', NOW)
    .run()
})






const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
const DAY = 86_400_000

/**
 * The funnel: views recorded at the edge for people, not crawlers;
 * bookings counted from D1 by the day they were made or cancelled; one
 * page that joins them per event type, with the whole instance for an
 * admin.
 */
describe('insights', () => {
  const ADMIN = 'usr_ins_admin'
  const ET = 'et_ins_intro'
  const ET_TEAM = 'et_ins_team'
  const ET_OTHER = 'et_ins_other'

  beforeAll(async () => {
    const insertUser = 'INSERT INTO users (id,email,name,tz,slug,role,created_at) VALUES (?,?,?,?,?,?,?)'
    const insertEt = `INSERT INTO event_types (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
    const insertBooking = `INSERT INTO bookings (id,event_type_id,host_user_id,host_user_ids_json,guest_name,guest_email,guest_timezone,start_utc,end_utc,local_date,status,manage_token_hash,reschedule_of,cancelled_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    const t = NOW - 2 * DAY
    await db.batch([
      db.prepare(insertUser).bind(ADMIN, 'ins-admin@example.test', 'Ins Admin', 'UTC', 'ins-admin', 'admin', NOW),
      db.prepare('INSERT INTO teams (id,name,slug,created_at) VALUES (?,?,?,?)').bind('team_ins', 'Ins Crew', 'ins-crew', NOW),
      db.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind('team_ins', HOST_ID, 'member', 1),
      db.prepare(insertEt).bind(ET, HOST_ID, null, 'personal', 'intro', 'Intro call', '', 30, 1, NOW),
      db.prepare(insertEt).bind(ET_TEAM, null, 'team_ins', 'round_robin', 'crew', 'Crew call', '', 30, 1, NOW),
      db.prepare(insertEt).bind(ET_OTHER, ADMIN, null, 'personal', 'admin-only', 'Admin only', '', 30, 1, NOW),
      // Two bookings two days ago, one of them cancelled yesterday; one reschedule replacement yesterday; one far outside the period.
      db.prepare(insertBooking).bind('bk_ins_1', ET, HOST_ID, '[]', 'A', 'a@x.test', 'UTC', t + DAY, t + DAY + 1800000, '', 'confirmed', 'h1', null, null, t),
      db.prepare(insertBooking).bind('bk_ins_2', ET, HOST_ID, '[]', 'B', 'b@x.test', 'UTC', t + DAY, t + DAY + 1800000, '', 'cancelled', 'h2', null, NOW - DAY, t),
      db.prepare(insertBooking).bind('bk_ins_3', ET, HOST_ID, '[]', 'A', 'a@x.test', 'UTC', t + 2 * DAY, t + 2 * DAY + 1800000, '', 'confirmed', 'h3', 'bk_ins_1', null, NOW - DAY),
      db.prepare(insertBooking).bind('bk_ins_4', ET_TEAM, HOST_ID, '[]', 'C', 'c@x.test', 'UTC', t + DAY, t + DAY + 1800000, '', 'confirmed', 'h4', null, null, NOW - DAY),
      db.prepare(insertBooking).bind('bk_ins_old', ET, HOST_ID, '[]', 'Z', 'z@x.test', 'UTC', t, t + 1800000, '', 'confirmed', 'h5', null, null, NOW - 200 * DAY),
      db.prepare(insertBooking).bind('bk_ins_other', ET_OTHER, ADMIN, '[]', 'Q', 'q@x.test', 'UTC', t + DAY, t + DAY + 1800000, '', 'confirmed', 'h6', null, null, NOW - DAY),
    ])
  })

  it('records a view for a person, not for a crawler, with the referer and utm source', async () => {
    insights.reset()
    const page = (ua: string, extra = '') =>
      app.fetch(new Request(`${BASE}/ins-host/intro${extra}`, { headers: { 'user-agent': ua, referer: 'https://www.linkedin.com/feed/' } }))
    expect((await page(BROWSER, '?utm_source=newsletter')).status).toBe(200)
    expect((await page('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)')).status).toBe(200)
    expect((await page('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).status).toBe(200)
    const confirm = await app.fetch(new Request(`${BASE}/ins-host/intro/confirm?start=${NOW + 7 * DAY}&tz=UTC&embed=1`, { headers: { 'user-agent': BROWSER } }))
    expect(confirm.status).toBe(200)
    // Moving around the calendar is the same visit, not new arrivals (caught by review).
    expect((await app.fetch(new Request(`${BASE}/ins-host/intro?date=2030-01-15`, { headers: { 'user-agent': BROWSER, referer: `${BASE}/ins-host/intro` } }))).status).toBe(200)
    expect((await app.fetch(new Request(`${BASE}/ins-host/intro?month=2030-02`, { headers: { 'user-agent': BROWSER } }))).status).toBe(200)
    expect((await app.fetch(new Request(`${BASE}/ins-host/intro`, { headers: { 'user-agent': BROWSER, referer: `${BASE}/` } }))).status).toBe(200)
    expect(insights.recorded).toEqual([
      { kind: 'page_view', eventTypeId: ET, ownerUserId: HOST_ID, ownerTeamId: null, referer: 'linkedin.com', utmSource: 'newsletter', utmMedium: '', utmCampaign: '', embed: false },
      { kind: 'confirm_view', eventTypeId: ET, ownerUserId: HOST_ID, ownerTeamId: null, referer: '', utmSource: '', utmMedium: '', utmCampaign: '', embed: true },
    ])
  })

  it("shows a host's funnel: their own and their teams' event types, bookings from D1, views joined in", async () => {
    insights.reset()
    insights.at = NOW - DAY
    for (let i = 0; i < 20; i++) insights.record({ kind: 'page_view', eventTypeId: ET, ownerUserId: HOST_ID, ownerTeamId: null, referer: i < 5 ? 'linkedin.com' : '', utmSource: '', utmMedium: '', utmCampaign: '', embed: false })
    for (let i = 0; i < 4; i++) insights.record({ kind: 'confirm_view', eventTypeId: ET, ownerUserId: HOST_ID, ownerTeamId: null, referer: '', utmSource: '', utmMedium: '', utmCampaign: '', embed: false })
    insights.record({ kind: 'page_view', eventTypeId: ET_OTHER, ownerUserId: ADMIN, ownerTeamId: null, referer: '', utmSource: '', utmMedium: '', utmCampaign: '', embed: false })
    insights.at = null

    const cookie = await seedSession(HOST_ID)
    const res = await app.fetch(new Request(`${BASE}/dashboard/insights?days=7`, { headers: { cookie } }))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<h1>Insights</h1>')
    expect(html).toContain('aria-current="page">7 days</a>')
    // Intro: 20 views, 4 picked a time, 1 booked (the cancelled one still counts as booked that day), 1 rescheduled, 1 cancelled; 2 bookings → 10% conversion.
    expect(html).toMatch(/<td>Intro call<\/td>\s*<td class="pu-num">20<\/td><td class="pu-num">4<\/td>\s*<td class="pu-num"><strong>2<\/strong><\/td>\s*<td class="pu-num">10%<\/td>\s*<td class="pu-num">1<\/td>\s*<td class="pu-num">1<\/td>/)
    // The team's event type is in, named after the team; the admin's own is not; the 200-day-old booking is not.
    expect(html).toContain('Crew call <span class="pu-muted">— Ins Crew</span>')
    expect(html).not.toContain('Admin only')
    expect(html).toContain('<span class="pu-ins-kpi-value">3</span><span class="pu-ins-kpi-label">Booked</span>')
    expect(html).toContain('<td>linkedin.com</td><td class="pu-num">5</td>')
    expect(html).toContain('<svg viewBox=')
    // A member sees no instance switch.
    expect(html).not.toContain('whole instance')
  })

  it('an admin can widen to the whole instance; without a readable view store the page stands on bookings', async () => {
    const cookie = await seedSession(ADMIN)
    const mine = await (await app.fetch(new Request(`${BASE}/dashboard/insights`, { headers: { cookie } }))).text()
    expect(mine).toContain('Admin only')
    expect(mine).not.toContain('Intro call')
    expect(mine).toContain('whole instance')
    const all = await (await app.fetch(new Request(`${BASE}/dashboard/insights?scope=instance&days=30`, { headers: { cookie } }))).text()
    expect(all).toContain('Intro call <span class="pu-muted">— Ins Host</span>')
    expect(all).toContain('Crew call <span class="pu-muted">— Ins Crew</span>')
    expect(all).toContain('Admin only')

    insights.readable = false
    try {
      const noViews = await (await app.fetch(new Request(`${BASE}/dashboard/insights?scope=instance`, { headers: { cookie } }))).text()
      expect(noViews).toContain('cannot be read back yet')
      expect(noViews).toContain('INSIGHTS_API_TOKEN')
      expect(noViews).not.toContain('Conversion')
      expect(noViews).toContain('<span class="pu-ins-kpi-value">4</span><span class="pu-ins-kpi-label">Booked</span>')
    } finally {
      insights.readable = true
    }
  })
})
