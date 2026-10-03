import { describe, expect, it } from 'vitest'
import type { EventType } from '../../src/core/domain/types.js'
import { buildInsightsReport, insightEventFor, isLikelyBot, periodFrom, periodStart, refererHost, utcDay } from '../../src/core/domain/insights.js'
import { createAnalyticsEngineInsights } from '../../src/adapters/insights/analytics-engine.js'

function eventType(patch: Partial<EventType>): EventType {
  return {
    id: 'et_1', ownerUserId: 'u_1', ownerTeamId: null, schedulingType: 'personal', slug: 'intro', title: 'Intro call', description: '',
    durationMinutes: 30, slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 60, maxHorizonDays: 60,
    maxPerDay: null, locationType: 'google_meet', locationValue: null, questions: [], active: true, createdAt: 0, scheduleId: null, ...patch,
  }
}

describe('who counts as a visitor', () => {
  it('leaves crawlers, previews and scripts out, and an empty agent too', () => {
    for (const ua of [
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)',
      'curl/8.4.0', 'python-requests/2.31', 'Hello from Palo Alto Networks, find out more about our scans', '',
    ]) expect(isLikelyBot(ua), ua).toBe(true)
    expect(isLikelyBot(null)).toBe(true)
    for (const ua of [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    ]) expect(isLikelyBot(ua), ua).toBe(false)
  })

  it('names the referring site, never this deployment, never garbage', () => {
    expect(refererHost('https://www.linkedin.com/feed/', 'https://punctual.sh')).toBe('linkedin.com')
    expect(refererHost('https://t.co/abc', 'https://punctual.sh')).toBe('t.co')
    expect(refererHost('https://punctual.sh/serge', 'https://punctual.sh')).toBe('')
    expect(refererHost('https://www.punctual.sh/', 'https://punctual.sh')).toBe('')
    expect(refererHost('not a url', 'https://punctual.sh')).toBe('')
    expect(refererHost(null, 'https://punctual.sh')).toBe('')
  })

  it('builds an event from the request: utm fields trimmed and capped, embed noted', () => {
    const e = insightEventFor('page_view', eventType({}), { referer: 'https://news.ycombinator.com/item?id=1', url: new URL(`https://punctual.sh/serge/intro?utm_source=  newsletter &utm_medium=email&utm_campaign=${'x'.repeat(200)}`), embed: true }, 'https://punctual.sh')
    expect(e).toEqual({ kind: 'page_view', eventTypeId: 'et_1', ownerUserId: 'u_1', ownerTeamId: null, referer: 'news.ycombinator.com', utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'x'.repeat(80), embed: true })
  })
})

describe('the period', () => {
  it('is 7, 30 or 90 days ending now, 30 by default', () => {
    const now = Date.UTC(2026, 9, 3, 12)
    expect(periodFrom('7', now)).toEqual({ days: 7, until: now })
    expect(periodFrom('90', now).days).toBe(90)
    for (const bad of ['', undefined, '14', 'abc']) expect(periodFrom(bad, now).days).toBe(30)
    expect(utcDay(periodStart({ days: 7, until: now }))).toBe('2026-09-26')
  })
})

describe('the report', () => {
  const now = Date.UTC(2026, 9, 3, 12)
  const types = [
    { eventType: eventType({ id: 'et_1', title: 'Intro' }), ownerName: 'Grace' },
    { eventType: eventType({ id: 'et_2', title: 'Support', ownerUserId: null, ownerTeamId: 't_1' }), ownerName: 'Support Crew' },
  ]
  const bookings = [
    { eventTypeId: 'et_1', day: '2026-10-01', booked: 3, cancelled: 1, rescheduled: 0 },
    { eventTypeId: 'et_1', day: '2026-10-02', booked: 2, cancelled: 0, rescheduled: 1 },
    { eventTypeId: 'et_2', day: '2026-10-02', booked: 1, cancelled: 0, rescheduled: 0 },
    { eventTypeId: 'et_gone', day: '2026-10-02', booked: 9, cancelled: 0, rescheduled: 0 },
  ]
  const views = {
    daily: [
      { eventTypeId: 'et_1', day: '2026-10-01', kind: 'page_view' as const, count: 40 },
      { eventTypeId: 'et_1', day: '2026-10-01', kind: 'confirm_view' as const, count: 10 },
      { eventTypeId: 'et_1', day: '2026-10-02', kind: 'page_view' as const, count: 10 },
      { eventTypeId: 'et_2', day: '2026-10-02', kind: 'page_view' as const, count: 5 },
    ],
    sources: [{ source: 'linkedin.com', count: 7 }, { source: 'utm:newsletter', count: 12 }],
  }

  it('joins bookings and views per event type and per day, with conversion and sources sorted', () => {
    const r = buildInsightsReport({ period: { days: 7, until: now }, eventTypes: types, bookings, views })
    expect(r.hasViews).toBe(true)
    expect(r.totals).toEqual({ views: 55, confirms: 10, booked: 6, cancelled: 1, rescheduled: 1, conversion: 6 / 55 })
    expect(r.rows.map((x) => [x.eventType.id, x.views, x.confirms, x.booked, x.conversion])).toEqual([
      ['et_1', 50, 10, 5, 0.1],
      ['et_2', 5, 0, 1, 0.2],
    ])
    expect(r.days).toHaveLength(7)
    expect(r.days.map((d) => d.day)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'])
    expect(r.days[5]).toEqual({ day: '2026-10-01', views: 40, booked: 3 })
    expect(r.days[6]).toEqual({ day: '2026-10-02', views: 15, booked: 3 })
    expect(r.sources.map((s) => s.source)).toEqual(['utm:newsletter', 'linkedin.com'])
  })

  it('stands on bookings alone when views cannot be read, and never divides by zero', () => {
    const r = buildInsightsReport({ period: { days: 30, until: now }, eventTypes: types, bookings, views: null })
    expect(r.hasViews).toBe(false)
    expect(r.totals.conversion).toBeNull()
    expect(r.rows[0]!.conversion).toBeNull()
    expect(r.totals.booked).toBe(6)
    expect(r.sources).toEqual([])
  })
})

describe('the Analytics Engine adapter', () => {
  const dataset = { points: [] as unknown[], writeDataPoint(p: unknown) { this.points.push(p) } }

  it('writes one row per view in the documented column order', () => {
    const port = createAnalyticsEngineInsights({ dataset: dataset as never, datasetName: 'punctual_insights' })
    expect(port.enabled).toBe(true)
    expect(port.canRead).toBe(false)
    port.record({ kind: 'page_view', eventTypeId: 'et_1', ownerUserId: 'u_1', ownerTeamId: null, referer: 'linkedin.com', utmSource: 'nl', utmMedium: '', utmCampaign: '', embed: false })
    expect(dataset.points).toEqual([{ blobs: ['page_view', 'et_1', 'u_1', '', 'linkedin.com', 'nl', '', '', '0'], doubles: [1], indexes: ['et_1'] }])
  })

  it('reads back through the SQL API with the account and token, scoped to the event types and period', async () => {
    const calls: Array<{ url: string; auth: string; body: string }> = []
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>)['authorization']), body: String(init?.body) })
      const body = calls.length === 1
        ? { data: [{ kind: 'page_view', event_type_id: 'et_1', day: '2026-10-01 00:00:00', n: '40' }, { kind: 'confirm_view', event_type_id: 'et_1', day: '2026-10-01 00:00:00', n: 10 }, { kind: 'junk', event_type_id: 'et_1', day: '2026-10-01 00:00:00', n: 1 }] }
        : { data: [{ source: 'utm:newsletter', n: '12' }] }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof globalThis.fetch
    const port = createAnalyticsEngineInsights({ datasetName: 'punctual_insights', accountId: 'acc_1', apiToken: 'tok', fetch: fetchImpl })
    expect(port.enabled).toBe(false)
    expect(port.canRead).toBe(true)
    const now = Date.UTC(2026, 9, 3, 12)
    const views = await port.query(["et_1", "et_o'neil"], { days: 7, until: now })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc_1/analytics_engine/sql')
    expect(calls[0]!.auth).toBe('Bearer tok')
    expect(calls[0]!.body).toContain("index1 IN ('et_1','et_o\\'neil')")
    expect(calls[0]!.body).toContain(`toDateTime(${Math.floor((now - 7 * 86_400_000) / 1000)})`)
    expect(calls[0]!.body).toContain('FROM punctual_insights')
    expect(views).toEqual({
      daily: [
        { eventTypeId: 'et_1', day: '2026-10-01', kind: 'page_view', count: 40 },
        { eventTypeId: 'et_1', day: '2026-10-01', kind: 'confirm_view', count: 10 },
      ],
      sources: [{ source: 'utm:newsletter', count: 12 }],
    })
  })

  it('returns null — bookings-only — without a token, and on an API failure', async () => {
    const noToken = createAnalyticsEngineInsights({ datasetName: 'x' })
    expect(await noToken.query(['et_1'], { days: 7, until: Date.now() })).toBeNull()
    const failing = createAnalyticsEngineInsights({ datasetName: 'x', accountId: 'a', apiToken: 't', fetch: (async () => new Response('nope', { status: 500 })) as typeof globalThis.fetch })
    expect(await failing.query(['et_1'], { days: 7, until: Date.now() })).toBeNull()
  })
})
