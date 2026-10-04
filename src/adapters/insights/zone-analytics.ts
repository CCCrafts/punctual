/**
 * The instance's traffic as Cloudflare's edge saw it — for the Admin page.
 *
 * Reads the zone's `httpRequestsAdaptiveGroups` through the GraphQL
 * Analytics API: requests per day, the most-fetched paths, countries and
 * user agents, over the last fourteen days, for browsers only
 * (`requestSource: eyeball`) on this deployment's host. Needs the zone id
 * and a token with Zone Analytics Read; both optional, and the section
 * says what is missing when they are. Cached for ten minutes, so an admin
 * reloading the page does not spend GraphQL quota. Free zones lack the
 * referer and ASN fields, so neither is asked for.
 */

import type { Cache } from '../../ports.js'

export interface ZoneTraffic {
  since: string
  until: string
  total: number
  days: Array<{ day: string; requests: number }>
  paths: Array<{ path: string; requests: number }>
  countries: Array<{ country: string; requests: number }>
  agents: Array<{ agent: string; requests: number }>
}

export interface ZoneAnalyticsOptions {
  zoneId?: string
  apiToken?: string
  /** The host to count — the deployment's own, from BASE_URL. */
  host: string
  cache?: Cache
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export interface ZoneAnalyticsPort {
  configured: boolean
  /** Null when not configured or when the API refused; the reason is logged, not shown. */
  traffic(): Promise<ZoneTraffic | null>
}

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql'
const DAYS = 14
const TTL_SECONDS = 600

export function createZoneAnalytics(opts: ZoneAnalyticsOptions): ZoneAnalyticsPort {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const now = opts.now ?? (() => Date.now())
  const configured = Boolean(opts.zoneId && opts.apiToken)
  const cacheKey = `zone-traffic:v1:${opts.zoneId ?? ''}:${opts.host}`
  return {
    configured,
    async traffic() {
      if (!configured) return null
      const cached = await opts.cache?.get<ZoneTraffic>(cacheKey).catch(() => null)
      if (cached) return cached
      const untilMs = now()
      const sinceMs = untilMs - DAYS * 86_400_000
      const since = new Date(sinceMs).toISOString()
      const until = new Date(untilMs).toISOString()
      const host = JSON.stringify(opts.host)
      const base = `datetime_geq:$since, datetime_leq:$until, requestSource:"eyeball", clientRequestHTTPHost:${host}`
      const query = `query($zone:String!,$since:Time!,$until:Time!){ viewer { zones(filter:{zoneTag:$zone}) {
        days: httpRequestsAdaptiveGroups(limit:20, filter:{${base}}, orderBy:[date_ASC]) { count dimensions { date } }
        paths: httpRequestsAdaptiveGroups(limit:12, filter:{${base}, edgeResponseStatus:200}, orderBy:[count_DESC]) { count dimensions { clientRequestPath } }
        countries: httpRequestsAdaptiveGroups(limit:8, filter:{${base}}, orderBy:[count_DESC]) { count dimensions { clientCountryName } }
        agents: httpRequestsAdaptiveGroups(limit:6, filter:{${base}}, orderBy:[count_DESC]) { count dimensions { userAgent } }
      } } }`
      let body: unknown
      try {
        const res = await fetchImpl(GRAPHQL, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables: { zone: opts.zoneId, since, until } }),
        })
        if (!res.ok) {
          console.error(`[punctual] zone analytics: HTTP ${res.status}`)
          return null
        }
        body = await res.json()
      } catch (err) {
        console.error('[punctual] zone analytics request failed', err)
        return null
      }
      const r = body as { errors?: Array<{ message: string }>; data?: { viewer?: { zones?: Array<Record<string, Array<{ count: number; dimensions: Record<string, string> }>>> } } }
      if (r.errors?.length) {
        console.error(`[punctual] zone analytics: ${r.errors.map((e) => e.message).join('; ').slice(0, 300)}`)
        return null
      }
      const z = r.data?.viewer?.zones?.[0]
      if (!z) return null
      const days = (z['days'] ?? []).map((g) => ({ day: g.dimensions['date']!, requests: g.count }))
      const traffic: ZoneTraffic = {
        since: since.slice(0, 10),
        until: until.slice(0, 10),
        total: days.reduce((n, d) => n + d.requests, 0),
        days,
        paths: (z['paths'] ?? []).map((g) => ({ path: g.dimensions['clientRequestPath']!, requests: g.count })),
        countries: (z['countries'] ?? []).map((g) => ({ country: g.dimensions['clientCountryName']!, requests: g.count })),
        agents: (z['agents'] ?? []).map((g) => ({ agent: g.dimensions['userAgent']!, requests: g.count })),
      }
      await opts.cache?.put(cacheKey, traffic, TTL_SECONDS).catch(() => {})
      return traffic
    },
  }
}
