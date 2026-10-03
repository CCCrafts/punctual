/**
 * The booking funnel, as a host sees it: how many people reached a booking
 * page, how many went on to pick a time, how many booked, cancelled or
 * moved — per event type, per day, and by where the visitors came from.
 *
 * Two sources, deliberately: the bookings themselves are rows in D1 and
 * are always there; page and confirm views are a stream, written to
 * Workers Analytics Engine when the deployment has the binding and read
 * back through its SQL API when it has a token. Without either, the page
 * still shows the bookings half and says how to get the rest.
 */

import type { EventType } from './types.js'

export type InsightKind = 'page_view' | 'confirm_view'

/** One view, as recorded at the edge. Everything in it is already known to the request. */
export interface InsightEvent {
  kind: InsightKind
  eventTypeId: string
  ownerUserId: string | null
  ownerTeamId: string | null
  /** The referring site's host, '' when none or when it is this deployment. */
  referer: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  embed: boolean
}

/** View counts, read back for a set of event types over a period. */
export interface InsightsViews {
  /** Per event type, per UTC day (YYYY-MM-DD), per kind. */
  daily: Array<{ eventTypeId: string; day: string; kind: InsightKind; count: number }>
  /** Page views by source — a referer host, or `utm:<source>` — over the period. */
  sources: Array<{ source: string; count: number }>
}

/** Booking counts from D1, per event type, per UTC day. */
export interface BookingDayStats {
  eventTypeId: string
  day: string
  booked: number
  cancelled: number
  rescheduled: number
}

export interface InsightsPeriod {
  days: 7 | 30 | 90
  /** Exclusive end, epoch ms — "now". */
  until: number
}

export const INSIGHT_PERIODS: ReadonlyArray<InsightsPeriod['days']> = [7, 30, 90]

export function periodFrom(raw: string | undefined, until: number): InsightsPeriod {
  const n = Number(raw)
  const days = (INSIGHT_PERIODS as readonly number[]).includes(n) ? (n as InsightsPeriod['days']) : 30
  return { days, until }
}

export function periodStart(p: InsightsPeriod): number {
  return p.until - p.days * 86_400_000
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Crawlers, previews and scripts are not visitors. A loose match on the
 * agent string is enough for a funnel — Facebook's preview fetcher alone
 * was nine tenths of one homepage's "traffic" — and a false positive costs
 * one uncounted view, not a booking.
 */
const BOT_AGENT = /bot|crawl|spider|slurp|preview|externalhit|fetch|scan|monitor|headless|python|curl|wget|httpclient|java\/|go-http|okhttp|axios|node-fetch|lighthouse|pingdom|uptime|facebookexternalhit|whatsapp|telegrambot|discordbot|slackbot|linkedinbot|twitterbot|applebot|bingbot|googlebot|yandex|baiduspider|duckduckbot|petalbot|semrush|ahrefs|mj12|dotbot|gptbot|claudebot|ccbot|bytespider|perplexity|anthropic|openai/i

export function isLikelyBot(userAgent: string | null | undefined): boolean {
  if (!userAgent || userAgent.trim() === '') return true
  return BOT_AGENT.test(userAgent)
}

/** The referring site's host, lowercased, without `www.`; '' for none, garbage, or this deployment itself. */
export function refererHost(referer: string | null | undefined, baseUrl: string): string {
  if (!referer) return ''
  try {
    const host = new URL(referer).hostname.toLowerCase().replace(/^www\./, '')
    const own = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, '')
    return host === own || host === '' ? '' : host
  } catch {
    return ''
  }
}

function clean(value: string | null | undefined, max = 80): string {
  return (value ?? '').trim().slice(0, max)
}

export function insightEventFor(
  kind: InsightKind,
  eventType: Pick<EventType, 'id' | 'ownerUserId' | 'ownerTeamId'>,
  request: { referer: string | null; url: URL; embed: boolean },
  baseUrl: string,
): InsightEvent {
  const q = request.url.searchParams
  return {
    kind,
    eventTypeId: eventType.id,
    ownerUserId: eventType.ownerUserId,
    ownerTeamId: eventType.ownerTeamId,
    referer: refererHost(request.referer, baseUrl),
    utmSource: clean(q.get('utm_source')),
    utmMedium: clean(q.get('utm_medium')),
    utmCampaign: clean(q.get('utm_campaign')),
    embed: request.embed,
  }
}

// ---------------------------------------------------------------------------
// Aggregation for the page
// ---------------------------------------------------------------------------

export interface InsightsRow {
  eventType: EventType
  ownerName: string
  views: number
  confirms: number
  booked: number
  cancelled: number
  rescheduled: number
  /** booked / views, 0..1; null when there were no views to divide by. */
  conversion: number | null
}

export interface InsightsDay {
  day: string
  views: number
  booked: number
}

export interface InsightsReport {
  period: InsightsPeriod
  /** False when views could not be read: no binding, no token, or the read failed. */
  hasViews: boolean
  totals: Omit<InsightsRow, 'eventType' | 'ownerName'>
  rows: InsightsRow[]
  days: InsightsDay[]
  sources: Array<{ source: string; count: number }>
}

export function buildInsightsReport(input: {
  period: InsightsPeriod
  eventTypes: Array<{ eventType: EventType; ownerName: string }>
  bookings: BookingDayStats[]
  views: InsightsViews | null
}): InsightsReport {
  const { period } = input
  const start = periodStart(period)
  const dayKeys: string[] = []
  for (let t = start; t < period.until; t += 86_400_000) dayKeys.push(utcDay(t))
  const dayIndex = new Map(dayKeys.map((d, i) => [d, i]))
  const days: InsightsDay[] = dayKeys.map((day) => ({ day, views: 0, booked: 0 }))

  const perType = new Map<string, InsightsRow>()
  for (const { eventType, ownerName } of input.eventTypes) {
    perType.set(eventType.id, { eventType, ownerName, views: 0, confirms: 0, booked: 0, cancelled: 0, rescheduled: 0, conversion: null })
  }
  for (const b of input.bookings) {
    const row = perType.get(b.eventTypeId)
    if (!row) continue
    row.booked += b.booked
    row.cancelled += b.cancelled
    row.rescheduled += b.rescheduled
    const i = dayIndex.get(b.day)
    if (i !== undefined) days[i]!.booked += b.booked
  }
  for (const v of input.views?.daily ?? []) {
    const row = perType.get(v.eventTypeId)
    if (!row) continue
    if (v.kind === 'page_view') {
      row.views += v.count
      const i = dayIndex.get(v.day)
      if (i !== undefined) days[i]!.views += v.count
    } else {
      row.confirms += v.count
    }
  }
  const rows = [...perType.values()].map((r) => ({ ...r, conversion: r.views > 0 ? Math.min(1, r.booked / r.views) : null }))
  rows.sort((a, b) => b.booked - a.booked || b.views - a.views || a.eventType.title.localeCompare(b.eventType.title))
  const sum = (k: 'views' | 'confirms' | 'booked' | 'cancelled' | 'rescheduled') => rows.reduce((n, r) => n + r[k], 0)
  const views = sum('views')
  const booked = sum('booked')
  return {
    period,
    hasViews: input.views !== null,
    totals: { views, confirms: sum('confirms'), booked, cancelled: sum('cancelled'), rescheduled: sum('rescheduled'), conversion: views > 0 ? Math.min(1, booked / views) : null },
    rows,
    days,
    sources: [...(input.views?.sources ?? [])].sort((a, b) => b.count - a.count).slice(0, 12),
  }
}
