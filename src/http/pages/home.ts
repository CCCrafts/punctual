/**
 * The instance's own front page (core/domain/home.ts, mode "index").
 *
 * A hero — the company logo, the title, the intro with its links, the site
 * and a contact address — beside the one meeting the admin featured, then
 * a section per owner: a team under its name and a stack of its members'
 * faces, a person under their photo, title and company. The booking page's
 * shell and tokens, so a guest lands one click later on the same product.
 */

import type { CompanyLogo } from '../../core/domain/types.js'
import type { HomeGroup, HomeItem, HomeOwner } from '../../core/domain/home.js'
import { avatarHtml, escapeHtml, logoHtml, shellHead } from './booking.js'

export interface InstanceHomeData {
  brandName: string
  baseUrl: string
  title: string
  intro: string
  website: string
  contactEmail: string
  companyLogo: CompanyLogo | null
  featured: HomeItem | null
  groups: HomeGroup[]
  operator?: string
}

/** The Punctual site, for the one small line of attribution. */
const PUNCTUAL_SITE_URL = 'https://punctual.sh'

/**
 * Text with its URLs and addresses made clickable. One pass over the RAW
 * text, escaping each piece — the plain runs, every href, every label —
 * on its own: a second pass over already-built anchors took the `@` in a
 * profile URL for an address and wrote a tag inside a tag, and escaping
 * before matching let a quote's entity ride into the href (caught by
 * review). Quotes and angle brackets end a URL; a trailing `.,;:!?)` is
 * punctuation, not part of it.
 */
const LINK = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)])|((?<=^|[\s(])[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,})/gi

export function linkify(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(LINK)) {
    out += escapeHtml(text.slice(last, m.index))
    if (m[1] !== undefined) {
      out += `<a href="${escapeHtml(m[1])}" target="_blank" rel="noopener">${escapeHtml(m[1].replace(/^https?:\/\//, ''))}</a>`
    } else {
      out += `<a href="mailto:${escapeHtml(m[2]!)}">${escapeHtml(m[2]!)}</a>`
    }
    last = m.index + m[0].length
  }
  return out + escapeHtml(text.slice(last))
}

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `<p>${linkify(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

function hostLabel(text: string): string {
  return text.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function bookingHref(item: HomeItem): string {
  return `/${encodeURIComponent(item.owner.slug)}/${encodeURIComponent(item.eventType.slug)}`
}

function ownerLine(owner: HomeOwner): string {
  if (owner.kind === 'team') {
    const n = owner.peopleCount ?? 0
    return n > 0 ? `${n} ${n === 1 ? 'person' : 'people'}` : 'Team'
  }
  return [owner.jobTitle, owner.company].filter((s): s is string => Boolean(s)).map(escapeHtml).join(', ')
}

function faces(owner: HomeOwner, size: number): string {
  if (owner.kind === 'user') return avatarHtml({ key: owner.avatarKey, name: owner.name, size })
  const people = owner.people ?? []
  if (people.length === 0) return ''
  const more = (owner.peopleCount ?? people.length) - people.length
  return `<div class="pu-hosts-stack">${people.map((p) => avatarHtml({ key: p.avatarKey, name: p.name, size })).join('')}${
    more > 0 ? `<span class="pu-hosts-count" aria-hidden="true">+${more}</span>` : ''
  }</div>`
}

function card(item: HomeItem): string {
  const { eventType, owner } = item
  return `<li><a class="pu-home-item" href="${escapeHtml(bookingHref(item))}">
      <span class="pu-home-item-title">${escapeHtml(eventType.title)}</span>
      <span class="pu-home-item-meta"><span class="pu-dot"></span> ${eventType.durationMinutes} min${owner.kind === 'team' && eventType.schedulingType === 'round_robin' ? ' · with one of the team' : ''}</span>
      ${eventType.description ? `<span class="pu-home-item-desc">${escapeHtml(eventType.description)}</span>` : ''}
    </a></li>`
}

function featuredCard(item: HomeItem): string {
  const { eventType, owner } = item
  const line = ownerLine(owner)
  return `<a class="pu-home-featured" href="${escapeHtml(bookingHref(item))}">
      <span class="pu-home-featured-who">${faces(owner, 40)}<span><strong>${escapeHtml(owner.name)}</strong>${line ? `<br><span class="pu-muted">${line}</span>` : ''}</span></span>
      <span class="pu-home-featured-title">${escapeHtml(eventType.title)}</span>
      <span class="pu-home-item-meta"><span class="pu-dot"></span> ${eventType.durationMinutes} min${owner.kind === 'team' && eventType.schedulingType === 'round_robin' ? ' · with one of the team' : ''}</span>
      ${eventType.description ? `<span class="pu-home-item-desc">${escapeHtml(eventType.description)}</span>` : ''}
      <span class="pu-btn pu-home-featured-cta">Pick a time</span>
    </a>`
}

function group(g: HomeGroup): string {
  const line = ownerLine(g.owner)
  return `<section class="pu-home-group" aria-label="${escapeHtml(g.owner.name)}">
    <header class="pu-home-group-head">
      ${faces(g.owner, 36)}
      <div><h2>${escapeHtml(g.owner.name)}</h2>${line ? `<p class="pu-muted">${line}</p>` : ''}</div>
    </header>
    <ul class="pu-home-list">${g.items.map(card).join('\n')}</ul>
  </section>`
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
  </div>
  <h1 class="pu-sr">${escapeHtml(title)}</h1>`
    : `<h1>${escapeHtml(title)}</h1>`
  const contacts = [
    d.website ? `<a href="${escapeHtml(d.website)}" target="_blank" rel="noopener">${escapeHtml(hostLabel(d.website))}</a>` : '',
    d.contactEmail ? `<a href="mailto:${escapeHtml(d.contactEmail)}">${escapeHtml(d.contactEmail)}</a>` : '',
  ].filter(Boolean)
  const nothing = !d.featured && d.groups.length === 0
  return (
    shellHead({
      title,
      ...(firstLine ? { description: firstLine.slice(0, 200) } : {}),
      brandName: d.brandName,
      canonical: `${base}/`,
    }) +
    `<main class="pu-home">
  <section class="pu-home-hero${d.featured ? ' pu-home-hero-split' : ''}">
    <div class="pu-home-hero-text">
      ${head}
      ${d.intro ? `<div class="pu-home-intro">${paragraphs(d.intro)}</div>` : ''}
      ${contacts.length > 0 ? `<p class="pu-home-contacts">${contacts.join(' <span aria-hidden="true">·</span> ')}</p>` : ''}
    </div>
    ${d.featured ? featuredCard(d.featured) : ''}
  </section>
  ${d.groups.map(group).join('\n')}
  ${nothing ? '<p class="pu-muted">Nothing to book here yet.</p>' : ''}
</main>
</div>
<footer class="pu-home-foot">
  <p>${[
    d.operator ? escapeHtml(d.operator) : '',
    ...contacts,
    '<a href="/privacy">Privacy</a>',
    '<a href="/terms">Terms</a>',
  ]
    .filter(Boolean)
    .join(' <span aria-hidden="true">·</span> ')}</p>
  <p class="pu-home-foot-by">Scheduling by <a class="pu-mark" href="${PUNCTUAL_SITE_URL}" target="_blank" rel="noopener">punctual<span>:</span></a></p>
</footer>
</body></html>`
  )
}
