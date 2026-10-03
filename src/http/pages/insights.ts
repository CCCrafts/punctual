/**
 * Insights: the booking funnel for the signed-in host — or, for an admin,
 * the whole instance. Numbers first, then one small chart, then the table
 * and the sources. No client script: the chart is inline SVG.
 */

import type { DashboardChrome } from './dashboard.js'
import type { InsightsReport, InsightsRow } from '../../core/domain/insights.js'
import { INSIGHT_PERIODS } from '../../core/domain/insights.js'
import { escapeHtml } from './booking.js'

export interface InsightsPageData extends DashboardChrome {
  report: InsightsReport
  /** 'mine' or, for an admin, 'instance'. */
  scope: 'mine' | 'instance'
  /** Views are being recorded (binding present) — decides which hint to show when they cannot be read. */
  viewsEnabled: boolean
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`
}

function n(v: number): string {
  return v.toLocaleString('en-US')
}

/** Views as light bars, bookings as dark bars on the same day; the taller series sets the scale. */
function chart(report: InsightsReport): string {
  const days = report.days
  if (days.length === 0) return ''
  const max = Math.max(1, ...days.map((d) => Math.max(d.views, d.booked)))
  const W = 720
  const H = 120
  const pad = 2
  const bw = (W - pad * (days.length - 1)) / days.length
  const bars = days
    .map((d, i) => {
      const x = i * (bw + pad)
      const vh = (d.views / max) * (H - 4)
      const bh = (d.booked / max) * (H - 4)
      return (
        `<g><title>${d.day}: ${d.views} views, ${d.booked} booked</title>` +
        `<rect class="pu-ins-bar-views" x="${x.toFixed(2)}" y="${(H - vh).toFixed(2)}" width="${bw.toFixed(2)}" height="${vh.toFixed(2)}"/>` +
        `<rect class="pu-ins-bar-booked" x="${x.toFixed(2)}" y="${(H - bh).toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}"/></g>`
      )
    })
    .join('')
  const first = days[0]!.day
  const last = days[days.length - 1]!.day
  return `<figure class="pu-ins-chart">
  <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Views and bookings per day, ${first} to ${last}">${bars}</svg>
  <figcaption class="pu-muted"><span class="pu-ins-key pu-ins-key-views"></span> views <span class="pu-ins-key pu-ins-key-booked"></span> bookings · ${first} → ${last}, days in UTC</figcaption>
</figure>`
}

function row(r: InsightsRow, scope: 'mine' | 'instance', hasViews: boolean): string {
  const owner = scope === 'instance' || r.eventType.ownerTeamId ? ` <span class="pu-muted">— ${escapeHtml(r.ownerName)}</span>` : ''
  return `<tr>
  <td>${escapeHtml(r.eventType.title)}${owner}</td>
  ${hasViews ? `<td class="pu-num">${n(r.views)}</td><td class="pu-num">${n(r.confirms)}</td>` : ''}
  <td class="pu-num"><strong>${n(r.booked)}</strong></td>
  ${hasViews ? `<td class="pu-num">${pct(r.conversion)}</td>` : ''}
  <td class="pu-num">${n(r.rescheduled)}</td>
  <td class="pu-num">${n(r.cancelled)}</td>
</tr>`
}

export function insightsPage(d: InsightsPageData): string {
  const { report } = d
  const t = report.totals
  const base = `/dashboard/insights?scope=${d.scope}`
  const periods = INSIGHT_PERIODS.map((days) => {
    const current = days === report.period.days ? ' aria-current="page"' : ''
    return `<a class="pu-tab" href="${base}&days=${days}"${current}>${days} days</a>`
  }).join('\n    ')
  const scopes =
    d.user.role === 'admin'
      ? `<p class="pu-muted" style="font-size:.875rem;margin:.25rem 0 0">Showing: ${
          d.scope === 'mine'
            ? `<strong>my event types</strong> · <a href="/dashboard/insights?scope=instance&days=${report.period.days}">whole instance</a>`
            : `<a href="/dashboard/insights?scope=mine&days=${report.period.days}">my event types</a> · <strong>whole instance</strong>`
        }</p>`
      : ''
  const viewsNote = report.hasViews
    ? ''
    : d.viewsEnabled
      ? `<p class="pu-notice">Views are being recorded but cannot be read back yet: set the <code>INSIGHTS_API_TOKEN</code> secret (an API token with <em>Account Analytics: Read</em>) and <code>CLOUDFLARE_ACCOUNT_ID</code> — see <a href="/docs/self-hosting">self-hosting</a>. Bookings below are complete.</p>`
      : `<p class="pu-notice">Page views are not being recorded on this deployment: add the <code>[[analytics_engine_datasets]]</code> binding from <code>wrangler.toml</code> — see <a href="/docs/self-hosting">self-hosting</a>. Bookings below are complete.</p>`
  const kpis = [
    ...(report.hasViews ? [['Page views', n(t.views)], ['Picked a time', n(t.confirms)]] : []),
    ['Booked', n(t.booked)],
    ...(report.hasViews ? [['Conversion', pct(t.conversion)]] : []),
    ['Rescheduled', n(t.rescheduled)],
    ['Cancelled', n(t.cancelled)],
  ]
    .map(([label, value]) => `<div class="pu-ins-kpi"><span class="pu-ins-kpi-value">${value}</span><span class="pu-ins-kpi-label">${label}</span></div>`)
    .join('')
  const table =
    report.rows.length === 0
      ? '<p class="pu-muted">No event types to report on yet.</p>'
      : `<div class="pu-docs-table-wrap"><table class="pu-dash-table pu-ins-table">
  <thead><tr><th>Event type</th>${report.hasViews ? '<th class="pu-num">Views</th><th class="pu-num">Picked a time</th>' : ''}<th class="pu-num">Booked</th>${report.hasViews ? '<th class="pu-num">Conversion</th>' : ''}<th class="pu-num">Rescheduled</th><th class="pu-num">Cancelled</th></tr></thead>
  <tbody>${report.rows.map((r) => row(r, d.scope, report.hasViews)).join('\n')}</tbody>
</table></div>`
  const sources =
    report.hasViews && report.sources.length > 0
      ? `<section class="pu-card" aria-label="Sources" style="margin-top:1.25rem">
  <h2>Where visitors came from</h2>
  <p class="pu-muted" style="font-size:.8125rem">Referring site, or the <code>utm_source</code> on the link. Direct visits and visits from this site are not listed.</p>
  <table class="pu-dash-table" style="min-width:0"><tbody>${report.sources
    .map((s) => `<tr><td>${escapeHtml(s.source)}</td><td class="pu-num">${n(s.count)}</td></tr>`)
    .join('')}</tbody></table>
</section>`
      : ''
  return (
    shellTopFor(d) +
    `<h1>Insights</h1>
<p class="pu-muted" style="font-size:.8125rem;margin-top:-.5rem">Visitors are counted once per page load; crawlers and link previews are left out.</p>
${scopes}
<nav class="pu-tabs" aria-label="Period">
    ${periods}
</nav>
${viewsNote}
<section class="pu-card" aria-label="Totals">
  <div class="pu-ins-kpis">${kpis}</div>
  ${report.hasViews ? chart(report) : ''}
</section>
<section class="pu-card" aria-label="By event type" style="margin-top:1.25rem">
  <h2>By event type</h2>
  ${table}
</section>
${sources}` +
    shellBottomFor(d)
  )
}

// The dashboard shell helpers are module-private in dashboard.ts; a thin
// indirection keeps this page in its own file without widening that API.
import { dashboardShell } from './dashboard.js'
function shellTopFor(d: InsightsPageData): string {
  return dashboardShell.top(d, 'Insights', 'insights')
}
function shellBottomFor(d: InsightsPageData): string {
  return dashboardShell.bottom(d.brandName)
}
