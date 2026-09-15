/**
 * The instance's own front page (core/domain/home.ts, mode "index"): the
 * company logo, a title and intro, and the booking links an admin chose.
 * Same shell as the booking page, so it reads as the same product a guest
 * lands on one click later.
 */

import type { CompanyLogo } from '../../core/domain/types.js'
import type { HomeItem } from '../../core/domain/home.js'
import { escapeHtml, logoHtml, shellFoot, shellHead } from './booking.js'

export interface InstanceHomeData {
  brandName: string
  baseUrl: string
  title: string
  intro: string
  companyLogo: CompanyLogo | null
  items: HomeItem[]
  operator?: string
}

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

export function instanceHomePage(d: InstanceHomeData): string {
  const title = d.title || d.brandName
  const base = d.baseUrl.replace(/\/$/, '')
  const firstLine = d.intro.split('\n').find((l) => l.trim() !== '')?.trim()
  // With a logo the logo IS the heading — a wordmark says the name, a round
  // mark gets it written beside — so the h1 is for assistive tech only.
  const head = d.companyLogo
    ? `<div class="pu-host">
    ${logoHtml({ key: d.companyLogo.key, shape: d.companyLogo.shape, name: title, size: 56 })}
    ${d.companyLogo.shape === 'circle' ? `<div><p class="pu-host-name">${escapeHtml(title)}</p></div>` : ''}
  </div>`
    : ''
  const items = d.items
    .map(({ eventType, ownerSlug, ownerName }) => {
      const href = `/${encodeURIComponent(ownerSlug)}/${encodeURIComponent(eventType.slug)}`
      return `<li><a class="pu-home-item" href="${escapeHtml(href)}">
      <span class="pu-home-item-title">${escapeHtml(eventType.title)}</span>
      <span class="pu-home-item-meta"><span class="pu-dot"></span> ${eventType.durationMinutes} min · ${escapeHtml(ownerName)}</span>
      ${eventType.description ? `<span class="pu-home-item-desc">${escapeHtml(eventType.description)}</span>` : ''}
    </a></li>`
    })
    .join('\n')
  return (
    shellHead({
      title,
      ...(firstLine ? { description: firstLine.slice(0, 200) } : {}),
      brandName: d.brandName,
      canonical: `${base}/`,
    }) +
    `<main class="pu-home">
  <header class="pu-event-header">
    ${head}
    ${d.companyLogo ? `<h1 class="pu-sr">${escapeHtml(title)}</h1>` : `<h1>${escapeHtml(title)}</h1>`}
    ${d.intro ? `<div class="pu-home-intro pu-muted">${paragraphs(d.intro)}</div>` : ''}
  </header>
  ${items ? `<ul class="pu-home-list">${items}</ul>` : '<p class="pu-muted">Nothing to book here yet.</p>'}
</main>` +
    shellFoot(true, false, d.operator ?? null)
  )
}
