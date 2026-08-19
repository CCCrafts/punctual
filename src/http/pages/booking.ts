/**
 * The public booking page (spec §5.1, ADR-0007 §3).
 *
 * Server-rendered strings rather than a component framework: the §7 budget is
 * <100 ms TTFB and <80 KB gzip, and the interaction model — pick a day, pick a
 * slot, fill a form — is three navigations, not an application.
 *
 * The page is session-free by design (ADR-0005 §5). It carries no cookie and
 * no ambient authority, which is what lets the dashboard cookie stay
 * SameSite=Lax while this page is embedded cross-origin in an iframe.
 *
 * Streaming: `shellHead` is flushed before any D1 read so TTFB is a function of
 * edge render, not of a replica round trip. We also hold a time-to-first-slot
 * budget (<400 ms) precisely so that flushing early cannot flatter the number
 * while the page is still useless (ADR-0007 §3).
 */

import type { EventType, Slot, User } from '../../core/domain/types.js'
import { slotStateClassName } from '../../core/slot-state.js'
import { formatInZone, localDateString, offsetLabel } from '../../core/time/zone.js'
import { embedResizeScriptTag } from '../embed.js'
import { pageCss } from '../styles.js'

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface PageChrome {
  title: string
  description?: string
  brandName: string
  themeColor?: string
  /**
   * Open Graph / Twitter card. Deliberately opt-in, not automatic: a
   * dashboard or guest-manage page carries a session or a guest's own manage
   * token in its URL, and neither should ever be the thing a chat app
   * unfurls a preview for. Only the public booking page passes this.
   *
   * `image` is required, not defaulted, because OG crawlers need an absolute
   * URL and this module has no `baseUrl` of its own to build one from — the
   * caller already has it.
   */
  og?: { url: string; image: string }
}

/**
 * Everything before the first data-dependent byte. Flushed immediately.
 */
export function shellHead(chrome: PageChrome): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(chrome.title)}</title>
${chrome.description ? `<meta name="description" content="${escapeHtml(chrome.description)}">` : ''}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${chrome.themeColor ?? '#0E7C4C'}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${
  chrome.og
    ? `<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(chrome.brandName)}">
<meta property="og:url" content="${escapeHtml(chrome.og.url)}">
<meta property="og:title" content="${escapeHtml(chrome.title)}">
${chrome.description ? `<meta property="og:description" content="${escapeHtml(chrome.description)}">` : ''}
<meta property="og:image" content="${escapeHtml(chrome.og.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(chrome.title)}">
${chrome.description ? `<meta name="twitter:description" content="${escapeHtml(chrome.description)}">` : ''}
<meta name="twitter:image" content="${escapeHtml(chrome.og.image)}">`
    : ''
}
<link rel="preload" href="/fonts/ibmplexmono-600.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/schibstedgrotesk-600.woff2" as="font" type="font/woff2" crossorigin>
<style>${pageCss()}</style>
</head>
<body>
<div class="pu-wrap">`
}

/**
 * `embed` appends the resize postMessage snippet (see `../embed.ts`). Without
 * it the iframe on a customer's page never learns the booking page's real
 * height and stays pinned at `data-height` (default 620px) for the whole
 * multi-step flow.
 */
export function shellFoot(brandName: string, poweredBy = true, embed = false): string {
  return `</div>
${poweredBy ? `<p class="pu-foot"><a class="pu-mark" href="/">${escapeHtml(brandName.toLowerCase())}<span>:</span></a> — scheduling that shows up on time</p>` : ''}
${embed ? embedResizeScriptTag() : ''}
</body></html>`
}

/** Placeholder emitted with the shell, replaced when slot data arrives. */
export function slotsSkeleton(): string {
  return `<div id="pu-slots" aria-busy="true" aria-live="polite">
  <p class="pu-sr">Loading available times…</p>
  ${Array.from({ length: 6 }, () => '<div class="pu-skeleton"></div>').join('\n  ')}
</div>`
}

export interface BookingPageData {
  host: User
  /**
   * The slug this page is actually reachable at — a user's OR a team's.
   * `host` is a representative user for display/timezone-default purposes
   * only (team-owned event types have no single "owner" user); using
   * `host.slug` for URL generation instead of this field routed every link
   * on a team event's page to a team member's personal page, 404ing there.
   */
  ownerSlug: string
  eventType: EventType
  /** The month being displayed, as a host-local `YYYY-MM`. */
  month: string
  /** Day → whether it has any bookable slot. */
  daysWithSlots: Map<string, boolean>
  selectedDate?: string
  slots?: Slot[]
  guestTimezone: string
  baseUrl: string
  /**
   * Set only on the confirm page, where the timezone picker must post back
   * to `/confirm` with the chosen slot's `start` rather than to the
   * month/day view — the confirm page has no `date`/`month` in its own URL
   * to fall back to, and the day-view form action would otherwise silently
   * discard the guest's already-chosen slot.
   */
  confirmStart?: number
  /** True when served inside the embed iframe (`?embed=1`) — propagated through every internal link so the resize snippet keeps firing past the first navigation. */
  embed?: boolean
}

/**
 * A `size`×`size` circle: the uploaded avatar/logo thumbnail if the
 * user or team has one, otherwise a CSS-only initials badge so the layout
 * never depends on whether a photo has been uploaded. Shared between the
 * booking page header and the dashboard settings page — the same key served
 * by the same `/avatars/:key` route either way.
 */
export function avatarHtml(opts: { key: string | null; name: string; size?: number; alt?: string }): string {
  const size = opts.size ?? 40
  if (opts.key) {
    return `<img src="/avatars/${encodeURIComponent(opts.key)}" alt="${escapeHtml(opts.alt ?? opts.name)}" width="${size}" height="${size}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block;flex:none" loading="lazy">`
  }
  const initial = (opts.name.trim().charAt(0) || '?').toUpperCase()
  return `<div aria-hidden="true" style="width:${size}px;height:${size}px;border-radius:50%;background:var(--pu-green-700);color:var(--pu-paper);display:flex;align-items:center;justify-content:center;font-family:var(--pu-font-mono);font-weight:600;font-size:${Math.round(size * 0.42)}px;flex:none">${escapeHtml(initial)}</div>`
}

export function eventHeader(d: BookingPageData): string {
  const durationLabel = `${d.eventType.durationMinutes} min`
  const location = locationLabel(d.eventType)
  return `<header class="pu-event-header">
  <p class="pu-kicker" style="display:flex;align-items:center;gap:.5rem">
    ${avatarHtml({ key: d.host.avatarKey, name: d.host.name || d.host.slug, size: 28 })}
    ${escapeHtml(d.host.name || d.host.slug)}
  </p>
  <h1>${escapeHtml(d.eventType.title)}</h1>
  ${d.eventType.description ? `<p class="pu-muted">${escapeHtml(d.eventType.description)}</p>` : ''}
  <ul class="pu-meta">
    <li><span class="pu-dot"></span> ${escapeHtml(durationLabel)}</li>
    ${location ? `<li>${escapeHtml(location)}</li>` : ''}
    <li>${timezonePicker(d)} (${escapeHtml(offsetLabel(Date.now(), d.guestTimezone))})</li>
  </ul>
</header>`
}

// Populated once per isolate, not per request — `Intl.supportedValuesOf`
// enumerates the runtime's whole tzdata, which doesn't change between
// requests.
const TIMEZONES: readonly string[] = (() => {
  try {
    // `supportedValuesOf('timeZone')` does not include `UTC` itself in this
    // runtime — without adding it back, a guest already on UTC can see it
    // (their own zone is always prepended, see `timezonePicker`), but no one
    // else can ever pick it.
    const zones = new Set(Intl.supportedValuesOf('timeZone'))
    zones.add('UTC')
    return [...zones].sort()
  } catch {
    return ['UTC']
  }
})()

// Escaping and joining ~400 <option> tags on every single booking-page
// request (month view, day view, confirm — every one renders this picker)
// was slow enough to measurably lengthen the request-rate-limiter smoke
// test's 120-request loop, giving the token bucket real wall-clock time to
// partially refill before the request meant to be denied. None of this
// output depends on the request, so it is built once per isolate; the only
// per-request work is marking one zone `selected`.
const TIMEZONE_OPTIONS_BASE: string = TIMEZONES.map(
  (z) => `<option value="${escapeHtml(z)}">${escapeHtml(z.replace(/_/g, ' '))}</option>`,
).join('')

function timezoneOptionsHtml(selected: string): string {
  if (!TIMEZONES.includes(selected)) {
    // Defensive fallback for a zone the runtime doesn't recognise — prepend
    // it rather than silently dropping the guest's own (mis-detected) zone
    // from the list.
    return (
      `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected.replace(/_/g, ' '))}</option>` +
      TIMEZONE_OPTIONS_BASE
    )
  }
  const marker = `value="${escapeHtml(selected)}">`
  return TIMEZONE_OPTIONS_BASE.replace(marker, `value="${escapeHtml(selected)}" selected>`)
}

/**
 * A real, submitting `<select>` rather than a static label: the guest's
 * detected zone is only a guess (see `resolveGuestTimezone`), and until this
 * existed the only way to correct it was editing `?tz=` in the URL by hand.
 * A GET form degrades to a plain submit button with no JS (`<noscript>`);
 * `onchange` submit is the enhancement, not the only path.
 */
function timezonePicker(d: BookingPageData): string {
  const options = timezoneOptionsHtml(d.guestTimezone)
  // The confirm page has already committed to one slot, which lives only in
  // `start` — its own URL carries no `date`/`month` to fall back to. Posting
  // to the month/day view like every other page would silently drop that
  // slot, so this page's picker instead posts back to `/confirm` itself.
  const action = d.confirmStart !== undefined ? `${bookingPath(d)}/confirm` : bookingPath(d)
  const hiddenFields =
    d.confirmStart !== undefined
      ? `<input type="hidden" name="start" value="${d.confirmStart}">`
      : `${d.selectedDate ? `<input type="hidden" name="date" value="${escapeHtml(d.selectedDate)}">` : ''}
    <input type="hidden" name="month" value="${escapeHtml(d.month)}">`
  return `<form class="pu-tz-form" method="get" action="${escapeHtml(action)}">
    ${hiddenFields}
    ${d.embed ? '<input type="hidden" name="embed" value="1">' : ''}
    <label class="pu-sr" for="pu-tz">Timezone</label>
    <select id="pu-tz" name="tz" class="pu-tz-select" onchange="this.form.submit()">${options}</select>
    <noscript><button type="submit" class="pu-btn pu-btn-ghost" style="padding:.15rem .5rem">Set</button></noscript>
  </form>`
}

function locationLabel(et: EventType): string {
  switch (et.locationType) {
    case 'google_meet':
      return 'Google Meet'
    case 'phone':
      return 'Phone call'
    case 'in_person':
      return et.locationValue ?? 'In person'
    case 'custom_link':
      return 'Online'
    default:
      return ''
  }
}

/**
 * The month grid.
 *
 * Rendered as links, not buttons: a day view is a URL, which means the back
 * button works, the page is shareable, and the whole flow degrades to plain
 * HTML with no JavaScript at all.
 */
export function monthGrid(d: BookingPageData): string {
  const [yStr, mStr] = d.month.split('-')
  const year = Number(yStr)
  const month = Number(mStr)
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1))
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const leading = firstOfMonth.getUTCDay()
  const todayLocal = localDateString(Date.now(), d.host.tz)

  const cells: string[] = []
  for (let i = 0; i < leading; i++) cells.push('<span></span>')

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const has = d.daysWithSlots.get(date) === true
    const current = date === todayLocal ? ' aria-current="date"' : ''
    if (has) {
      const href =
        `${bookingPath(d)}?date=${date}&tz=${encodeURIComponent(d.guestTimezone)}` +
        (d.embed ? '&embed=1' : '')
      cells.push(
        `<a class="pu-day" data-has-slots="1"${current} href="${escapeHtml(href)}" ` +
          `aria-label="${escapeHtml(humanDate(date, d.guestTimezone))}, times available">${day}</a>`,
      )
    } else {
      cells.push(`<span class="pu-day" aria-disabled="true"${current}>${day}</span>`)
    }
  }

  const monthLabel = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(firstOfMonth)

  const prev = shiftMonth(d.month, -1)
  const next = shiftMonth(d.month, 1)
  const base = bookingPath(d)
  const tzq = `&tz=${encodeURIComponent(d.guestTimezone)}${d.embed ? '&embed=1' : ''}`

  return `<section class="pu-card" aria-label="Choose a day">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
    <a class="pu-btn pu-btn-ghost" style="padding:.35rem .6rem"
       href="${escapeHtml(`${base}?month=${prev}${tzq}`)}" aria-label="Previous month">←</a>
    <h2 style="margin:0">${escapeHtml(monthLabel)}</h2>
    <a class="pu-btn pu-btn-ghost" style="padding:.35rem .6rem"
       href="${escapeHtml(`${base}?month=${next}${tzq}`)}" aria-label="Next month">→</a>
  </div>
  <div class="pu-cal" role="grid">
    ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .map((x) => `<div class="pu-cal-head" role="columnheader" aria-label="${x}day">${x}</div>`)
      .join('')}
    ${cells.join('\n    ')}
  </div>
</section>`
}

/** Slot list for a chosen day, in the GUEST's timezone. */
export function slotList(d: BookingPageData): string {
  if (!d.selectedDate) {
    return `<section class="pu-card" aria-label="Available times">
      <p class="pu-muted">Pick a day to see available times.</p></section>`
  }
  const slots = d.slots ?? []
  if (slots.length === 0) {
    return `<section class="pu-card" aria-label="Available times">
      <h2>${escapeHtml(humanDate(d.selectedDate, d.guestTimezone))}</h2>
      <p class="pu-muted">No times available on this day.</p></section>`
  }

  // Every slot the query engine hands back here has already cleared holds,
  // bookings, past times and the host's notice window (src/core/slots/
  // engine.ts never returns those) — so every slot on this page is, by
  // construction, in the 'available' state. slotStateClassName still goes
  // through the shared src/core/slot-state.ts mapping (rather than a literal
  // "pu-slot pu-slot-available" string here) so this call site and the CSS
  // in src/http/styles.ts can never drift from the one place that owns the
  // state → class relationship. The 'held'/'booked'/'past'/
  // 'outside-notice-window' classes it can also produce are exercised today
  // by the semantic-tokens reference page and by test/core/slot-state.test.ts,
  // not by live traffic — showing any of them here would mean the query
  // engine surfacing a status per slot instead of silently omitting it,
  // which is a product decision (does a guest get to see that a time is
  // held/booked at all?) outside this ticket's scope.
  const items = slots
    .map((s) => {
      const label = formatInZone(s.start, d.guestTimezone, { hour: 'numeric', minute: '2-digit' })
      const href =
        `${bookingPath(d)}/confirm?start=${s.start}` +
        `&tz=${encodeURIComponent(d.guestTimezone)}` +
        (d.embed ? '&embed=1' : '')
      return `<a class="${slotStateClassName('available')}" href="${escapeHtml(href)}">
        <time datetime="${new Date(s.start).toISOString()}">${escapeHtml(label)}</time></a>`
    })
    .join('\n    ')

  return `<section class="pu-card" aria-label="Available times">
  <h2>${escapeHtml(humanDate(d.selectedDate, d.guestTimezone))}</h2>
  <p class="pu-muted" style="font-size:.8125rem">
    Times shown in ${escapeHtml(d.guestTimezone)} (${escapeHtml(offsetLabel(slots[0]!.start, d.guestTimezone))})
  </p>
  <div class="pu-slots">
    ${items}
  </div>
</section>`
}

/** The confirmation form. Includes the hidden hold id when one was placed. */
export function confirmForm(
  d: BookingPageData,
  start: number,
  opts: { holdId?: string; errors?: Record<string, string>; values?: Record<string, string> } = {},
): string {
  const et = d.eventType
  const errors = opts.errors ?? {}
  const values = opts.values ?? {}
  const when = formatInZone(start, d.guestTimezone, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

  const questions = et.questions
    .map((q) => {
      const err = errors[q.id]
      const val = escapeHtml(values[q.id] ?? '')
      const req = q.required ? ' required aria-required="true"' : ''
      const desc = err ? ` aria-describedby="err-${escapeHtml(q.id)}"` : ''
      const field =
        q.type === 'textarea'
          ? `<textarea id="q-${escapeHtml(q.id)}" name="q_${escapeHtml(q.id)}"${req}${desc}>${val}</textarea>`
          : q.type === 'select'
            ? `<select id="q-${escapeHtml(q.id)}" name="q_${escapeHtml(q.id)}"${req}${desc}>
                 <option value=""></option>
                 ${(q.options ?? [])
                   .map(
                     (o) =>
                       `<option value="${escapeHtml(o)}"${values[q.id] === o ? ' selected' : ''}>${escapeHtml(o)}</option>`,
                   )
                   .join('')}
               </select>`
            : `<input id="q-${escapeHtml(q.id)}" name="q_${escapeHtml(q.id)}" value="${val}"${req}${desc}>`
      return `<label for="q-${escapeHtml(q.id)}">${escapeHtml(q.label)}${q.required ? '' : ' <span class="pu-muted">(optional)</span>'}</label>
        ${field}
        ${err ? `<p class="pu-err" id="err-${escapeHtml(q.id)}">${escapeHtml(err)}</p>` : ''}`
    })
    .join('\n')

  return `<section class="pu-card" aria-label="Confirm your booking">
  <h2>Confirm your booking</h2>
  <div class="pu-slot-chosen">
    <span class="pu-dot-lg" aria-hidden="true"></span>
    <span><strong class="pu-time">${escapeHtml(when)}</strong><br>
     <span class="pu-muted">${escapeHtml(d.guestTimezone)} · ${escapeHtml(String(et.durationMinutes))} min</span></span>
  </div>
  <form method="post" action="${escapeHtml(bookingPath(d))}/confirm">
    <input type="hidden" name="start" value="${start}">
    <input type="hidden" name="tz" value="${escapeHtml(d.guestTimezone)}">
    ${d.embed ? '<input type="hidden" name="embed" value="1">' : ''}
    ${opts.holdId ? `<input type="hidden" name="hold" value="${escapeHtml(opts.holdId)}">` : ''}
    <label for="name">Your name</label>
    <input id="name" name="name" required aria-required="true" autocomplete="name"
           value="${escapeHtml(values['name'] ?? '')}"
           ${errors['name'] ? 'aria-describedby="err-name"' : ''}>
    ${errors['name'] ? `<p class="pu-err" id="err-name">${escapeHtml(errors['name'])}</p>` : ''}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required aria-required="true" autocomplete="email"
           value="${escapeHtml(values['email'] ?? '')}"
           ${errors['email'] ? 'aria-describedby="err-email"' : ''}>
    ${errors['email'] ? `<p class="pu-err" id="err-email">${escapeHtml(errors['email'])}</p>` : ''}
    ${questions}
    <div style="margin-top:1.25rem;display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="pu-btn" type="submit">Confirm booking</button>
      <a class="pu-btn pu-btn-ghost" href="${escapeHtml(bookingPath(d))}?date=${escapeHtml(localDateString(start, d.guestTimezone))}${d.embed ? '&embed=1' : ''}">Back</a>
    </div>
  </form>
</section>`
}

export function bookedConfirmation(opts: {
  eventTitle: string
  hostName: string
  start: number
  guestTimezone: string
  manageUrl: string
  locationLabel?: string
}): string {
  const when = formatInZone(opts.start, opts.guestTimezone, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `<section class="pu-card pu-confirm" aria-label="Booking confirmed">
  <svg class="pu-confirm-icon" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
    <circle class="pu-ring-track" cx="28" cy="28" r="24" stroke-width="2"></circle>
    <circle class="pu-ring-fill" cx="28" cy="28" r="24" stroke-width="2.5" stroke-linecap="round"
      transform="rotate(-90 28 28)"></circle>
    <circle class="pu-ring-dot" cx="28" cy="4" r="4"></circle>
  </svg>
  <p><span class="pu-badge">Confirmed</span></p>
  <h1>You're booked</h1>
  <p class="pu-muted"><strong style="color:var(--pu-ink-950)">${escapeHtml(opts.eventTitle)}</strong> with ${escapeHtml(opts.hostName)}</p>
  <dl class="pu-confirm-details">
    <div><dt>When</dt><dd class="pu-time">${escapeHtml(when)}<br>
      <span class="pu-muted">${escapeHtml(opts.guestTimezone)}</span></dd></div>
    ${opts.locationLabel ? `<div><dt>Where</dt><dd>${escapeHtml(opts.locationLabel)}</dd></div>` : ''}
  </dl>
  <p class="pu-muted">A calendar invitation is on its way to your inbox.</p>
  <p style="margin-top:1.25rem">
    <a class="pu-btn pu-btn-ghost" href="${escapeHtml(opts.manageUrl)}">Reschedule or cancel</a>
  </p>
</section>`
}

/**
 * The 409 page.
 *
 * A slot can be listed and then lost: listings may come from a read replica
 * (ADR-0007 §2) and round-robin listings are advisory about who. This is an
 * expected outcome, so it reads as a normal step with the next action right
 * there — not as an error.
 */
export function slotTakenPage(d: BookingPageData, date: string): string {
  return `<section class="pu-card" aria-label="Time no longer available">
  <h1>That time was just taken</h1>
  <p class="pu-muted">Someone booked it while you were filling in the form. Here are the other times that day.</p>
  <p style="margin-top:1rem">
    <a class="pu-btn" href="${escapeHtml(bookingPath(d))}?date=${escapeHtml(date)}&tz=${encodeURIComponent(d.guestTimezone)}${d.embed ? '&embed=1' : ''}">See available times</a>
  </p>
</section>`
}

export function errorPage(title: string, message: string): string {
  return `<section class="pu-card">
  <h1>${escapeHtml(title)}</h1>
  <p class="pu-muted">${escapeHtml(message)}</p>
</section>`
}

// ---------------------------------------------------------------------------

export function bookingPath(d: { ownerSlug: string; eventType: EventType }): string {
  return `/${encodeURIComponent(d.ownerSlug)}/${encodeURIComponent(d.eventType.slug)}`
}

function humanDate(date: string, _tz: string): string {
  const [y, m, dd] = date.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, dd)))
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
