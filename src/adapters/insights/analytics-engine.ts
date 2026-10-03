/**
 * Page and confirm views on Workers Analytics Engine.
 *
 * Writes go through the `INSIGHTS` binding (`[[analytics_engine_datasets]]`
 * in wrangler.toml) and cost nothing per request. Reads go through the
 * Analytics Engine SQL API, which needs the account id and an API token
 * with Account Analytics Read — optional, because a self-hoster may not
 * want to mint one; without it `query` returns null and the Insights page
 * shows the bookings half with a note on how to get the views.
 *
 * Column layout (one row per view):
 *   blob1 kind · blob2 eventTypeId · blob3 ownerUserId · blob4 ownerTeamId
 *   blob5 referer host · blob6 utm_source · blob7 utm_medium · blob8 utm_campaign
 *   blob9 embed ('1' | '0') · double1 1 · index1 eventTypeId
 */

import type { InsightEvent, InsightKind, InsightsViews } from '../../core/domain/insights.js'
import type { InsightsPort } from '../../ports.js'

export interface AnalyticsEngineInsightsOptions {
  dataset?: AnalyticsEngineDataset
  datasetName: string
  accountId?: string
  apiToken?: string
  fetch?: typeof globalThis.fetch
}

const SQL_API = 'https://api.cloudflare.com/client/v4/accounts'

/** AE's SQL dialect has no parameters; the ids are ours (`et_…`), but quoted defensively all the same. */
function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

export function createAnalyticsEngineInsights(opts: AnalyticsEngineInsightsOptions): InsightsPort {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const canRead = Boolean(opts.accountId && opts.apiToken)

  async function sql<T>(query: string): Promise<T[] | null> {
    const res = await fetchImpl(`${SQL_API}/${encodeURIComponent(opts.accountId!)}/analytics_engine/sql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiToken}`, 'content-type': 'text/plain' },
      body: query,
    })
    if (!res.ok) {
      console.error(`[punctual] insights query failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
      return null
    }
    const body = (await res.json()) as { data?: T[] }
    return body.data ?? []
  }

  return {
    enabled: opts.dataset !== undefined,
    canRead,
    record(event: InsightEvent) {
      if (!opts.dataset) return
      try {
        opts.dataset.writeDataPoint({
          blobs: [event.kind, event.eventTypeId, event.ownerUserId ?? '', event.ownerTeamId ?? '', event.referer, event.utmSource, event.utmMedium, event.utmCampaign, event.embed ? '1' : '0'],
          doubles: [1],
          indexes: [event.eventTypeId],
        })
      } catch (err) {
        // Never let a metric take a page down.
        console.error('[punctual] insights write failed', err)
      }
    },
    async query(eventTypeIds, period) {
      if (!canRead || eventTypeIds.length === 0) return null
      const ids = eventTypeIds.map(sqlString).join(',')
      const since = `toDateTime(${Math.floor((period.until - period.days * 86_400_000) / 1000)})`
      const until = `toDateTime(${Math.floor(period.until / 1000)})`
      const table = opts.datasetName
      const daily = await sql<{ kind: string; event_type_id: string; day: string; n: string | number }>(
        `SELECT blob1 AS kind, blob2 AS event_type_id, toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, SUM(_sample_interval) AS n
         FROM ${table}
         WHERE timestamp >= ${since} AND timestamp < ${until} AND index1 IN (${ids})
         GROUP BY kind, event_type_id, day`,
      )
      if (daily === null) return null
      const sources = await sql<{ source: string; n: string | number }>(
        `SELECT if(blob6 != '', concat('utm:', blob6), blob5) AS source, SUM(_sample_interval) AS n
         FROM ${table}
         WHERE timestamp >= ${since} AND timestamp < ${until} AND index1 IN (${ids}) AND blob1 = 'page_view' AND (blob5 != '' OR blob6 != '')
         GROUP BY source ORDER BY n DESC LIMIT 12`,
      )
      const views: InsightsViews = {
        daily: daily
          .filter((r) => r.kind === 'page_view' || r.kind === 'confirm_view')
          .map((r) => ({ eventTypeId: r.event_type_id, day: String(r.day).slice(0, 10), kind: r.kind as InsightKind, count: Number(r.n) })),
        sources: (sources ?? []).map((r) => ({ source: r.source, count: Number(r.n) })),
      }
      return views
    },
  }
}
