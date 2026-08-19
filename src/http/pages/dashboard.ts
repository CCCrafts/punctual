/**
 * The host dashboard (spec §5.1).
 *
 * Same rendering model as the public booking page: server-rendered template
 * strings, no component framework, no client bundle. The dashboard has no
 * <100 ms TTFB budget (ADR-0005 §2) — it is here for a different reason. Every
 * screen below is a form that submits to a URL, so the whole product works with
 * JavaScript disabled, degrades to plain HTML on a bad connection, and stays
 * auditable: what a POST does is visible in the markup that produced it.
 *
 * Two rules hold across this file and are load-bearing rather than stylistic:
 *
 *  - EVERY interpolation of user-controlled text goes through `escapeHtml`.
 *    Host names, event titles, calendar names and provider account addresses
 *    are all attacker-influenceable in a self-hosted deployment.
 *  - EVERY form that mutates carries the double-submit CSRF token (ADR-0005
 *    §5). The two exceptions are documented at their call sites: the login form
 *    (no session exists yet, so there is nothing to derive a token from) and
 *    the guest manage forms (no session and no ambient authority — the signed
 *    manage token IS the credential, exactly as on the booking page).
 *
 * Text formats (weekly windows, date overrides, custom questions) are defined
 * here together with their parsers. Rendering and parsing of one wire format
 * belong in one place; splitting them across the page and the route is how the
 * two silently diverge.
 */

import type {
  ApiKey,
  Availability,
  Booking,
  CalendarConnection,
  DateOverride,
  DayWindow,
  EventType,
  EventTypeQuestion,
  Slot,
  User,
} from '../../core/domain/types.js'
import type { CalendarProviderName } from '../../ports.js'
import { slotStateClassName } from '../../core/slot-state.js'
import { formatInZone, localDateString, offsetLabel } from '../../core/time/zone.js'
import { avatarHtml, escapeHtml, shellFoot, shellHead } from './booking.js'

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/** Form field carrying the double-submit token. Routes read the same name. */
export const CSRF_FIELD = 'csrf'

export type NavKey = 'events' | 'availability' | 'connections' | 'keys' | 'settings'

const NAV: ReadonlyArray<{ key: NavKey; href: string; label: string }> = [
  { key: 'events', href: '/dashboard', label: 'Event types' },
  { key: 'availability', href: '/dashboard/availability', label: 'Availability' },
  { key: 'connections', href: '/dashboard/connections', label: 'Calendars' },
  { key: 'keys', href: '/dashboard/api-keys', label: 'API keys' },
  { key: 'settings', href: '/dashboard/settings', label: 'Settings' },
]

/** Common shape of every authenticated page. */
export interface DashboardChrome {
  brandName: string
  user: User
  /** Double-submit token for this session (ADR-0005 §5). */
  csrf: string
}

export function csrfField(csrf: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(csrf)}">`
}

/**
 * Head + primary navigation.
 *
 * Sign-out is a POST, not a link: a GET that destroys a session can be fired by
 * any `<img>` on any page on the internet, and the CSRF token cannot travel on
 * a link the user might bookmark.
 */
function shellTop(chrome: DashboardChrome, title: string, active: NavKey | null): string {
  const links = NAV.map((item) => {
    const current = item.key === active ? ' aria-current="page"' : ''
    return `<a class="pu-nav-link" href="${item.href}"${current}>${escapeHtml(item.label)}</a>`
  }).join('\n      ')

  return (
    shellHead({ title: `${title} · ${chrome.brandName}`, brandName: chrome.brandName }) +
    `<header class="pu-dash-header" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem">
  <a class="pu-mark" href="/dashboard">${escapeHtml(chrome.brandName.toLowerCase())}<span>:</span></a>
  <nav aria-label="Dashboard" style="display:flex;gap:1rem;flex-wrap:wrap;font-size:.9375rem">
      ${links}
  </nav>
  <form method="post" action="/logout" style="margin:0">
    ${csrfField(chrome.csrf)}
    <button class="pu-btn pu-btn-ghost" type="submit" style="padding:.4rem .8rem;font-size:.875rem">Sign out</button>
  </form>
</header>
<p class="pu-sr">Signed in as ${escapeHtml(chrome.user.email)}</p>`
  )
}

function shellBottom(brandName: string): string {
  // No "powered by" on an authenticated surface: the host already knows.
  return shellFoot(brandName, false)
}

/** A dismissible-looking status strip. Not an error — errors use `.pu-err`. */
function notice(message: string): string {
  return `<p class="pu-badge" role="status" style="display:block;padding:.5rem .75rem;border-radius:var(--pu-radius)">${escapeHtml(message)}</p>`
}

function fieldError(id: string, errors: Record<string, string>): string {
  const err = errors[id]
  return err ? `<p class="pu-err" id="err-${escapeHtml(id)}">${escapeHtml(err)}</p>` : ''
}

/** `aria-describedby` only when there is something to describe. */
function describedBy(id: string, errors: Record<string, string>): string {
  return errors[id] ? ` aria-describedby="err-${escapeHtml(id)}"` : ''
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginPageData {
  brandName: string
  /** Providers with OAuth credentials configured. Empty is a normal deployment. */
  providers: CalendarProviderName[]
  /** True after a magic link request — identical for known and unknown addresses. */
  sent?: boolean
  error?: string
  /** Echoed back only on a malformed address, never on the neutral "sent" state. */
  email?: string
}

/**
 * The sign-in page.
 *
 * No CSRF token, deliberately. A double-submit token is derived from the
 * session id hash (ADR-0005 §5) and there is no session here — that is the
 * point of the page. What a forged submit could achieve is sending the victim
 * a login email they did not ask for, which the email itself flags with the
 * requesting IP and user agent (ADR-0005 §3), and which per-email and per-IP
 * rate limits bound (ADR-0006 §3). The token would add a cookie round trip and
 * no security.
 *
 * The success state says nothing about whether the address has an account. Any
 * branch here is an enumeration oracle, so the copy carries no address at all.
 */
export function loginPage(d: LoginPageData): string {
  const buttons = d.providers
    .map(
      (p) =>
        `<a class="pu-btn pu-btn-ghost" style="display:block;margin-top:.5rem"
       href="/auth/${p}/start?purpose=identity">Continue with ${escapeHtml(providerLabel(p))}</a>`,
    )
    .join('\n    ')

  const body = d.sent
    ? `<h1>Check your inbox</h1>
  <p class="pu-muted">If that address can sign in, a link is on its way. It works once and expires in 15 minutes.</p>
  <p style="margin-top:1.25rem"><a class="pu-btn pu-btn-ghost" href="/login">Back to sign in</a></p>`
    : `<h1>Sign in</h1>
  <p class="pu-muted">No password. We email you a link that works once.</p>
  <form method="post" action="/login">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required aria-required="true" autocomplete="email"
           inputmode="email" value="${escapeHtml(d.email ?? '')}"${describedBy('email', d.error ? { email: d.error } : {})}>
    ${d.error ? `<p class="pu-err" id="err-email">${escapeHtml(d.error)}</p>` : ''}
    <div style="margin-top:1.25rem"><button class="pu-btn" type="submit">Email me a link</button></div>
  </form>
  ${
    d.providers.length > 0
      ? `<div style="margin-top:1.5rem;border-top:1px solid var(--pu-line);padding-top:1.25rem">
    <p class="pu-muted" style="font-size:.8125rem">Signing in asks for your name and email only. Calendar access is
       requested later, when you connect a calendar.</p>
    ${buttons}
  </div>`
      : ''
  }`

  return (
    shellHead({ title: `Sign in · ${d.brandName}`, brandName: d.brandName }) +
    `<section class="pu-card" style="max-width:26rem;margin:3rem auto">${body}</section>` +
    shellFoot(d.brandName)
  )
}

function providerLabel(p: CalendarProviderName): string {
  return p === 'google' ? 'Google' : 'Microsoft'
}

// ---------------------------------------------------------------------------
// Home — event types and what is coming up
// ---------------------------------------------------------------------------

export interface UpcomingBooking {
  booking: Booking
  /** Resolved by the route; a deleted event type leaves the id as the label. */
  eventTitle: string
}

export interface DashboardHomeData extends DashboardChrome {
  eventTypes: EventType[]
  upcomingBookings: UpcomingBooking[]
  /** Public origin, so the copyable URL is the one a guest would receive. */
  baseUrl: string
  notice?: string
}

export function dashboardHome(d: DashboardHomeData): string {
  const events =
    d.eventTypes.length === 0
      ? `<p class="pu-muted">No event types yet. Create one and your booking page is live.</p>`
      : d.eventTypes.map((et) => eventTypeCard(d, et)).join('\n')

  const upcoming =
    d.upcomingBookings.length === 0
      ? `<p class="pu-muted">Nothing booked yet.</p>`
      : `<ul style="list-style:none;padding:0;margin:0;display:grid;gap:.75rem">
      ${d.upcomingBookings.map((u) => upcomingRow(u, d.user.tz)).join('\n      ')}
    </ul>`

  return (
    shellTop(d, 'Dashboard', 'events') +
    (d.notice ? notice(d.notice) : '') +
    `<div class="pu-grid" style="grid-template-columns:1fr">
  <section aria-label="Event types">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.75rem">
      <h1 style="margin:0">Event types</h1>
      <a class="pu-btn" href="/dashboard/event-types/new">New event type</a>
    </div>
    <div style="display:grid;gap:1rem">${events}</div>
  </section>
  <section class="pu-card" aria-label="Upcoming bookings">
    <h2>Upcoming</h2>
    <p class="pu-muted" style="font-size:.8125rem">Times in ${escapeHtml(d.user.tz)} (${escapeHtml(offsetLabel(Date.now(), d.user.tz))})</p>
    ${upcoming}
  </section>
</div>` +
    shellBottom(d.brandName)
  )
}

function eventTypeCard(d: DashboardHomeData, et: EventType): string {
  const url = `${trimSlash(d.baseUrl)}/${encodeURIComponent(d.user.slug)}/${encodeURIComponent(et.slug)}`
  const inputId = `url-${escapeHtml(et.id)}`
  return `<article class="pu-card">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap">
    <h2 style="margin:0">${escapeHtml(et.title)}</h2>
    ${et.active ? '' : '<span class="pu-badge" style="background:var(--pu-paper-dim);color:var(--pu-ink-500)">Hidden</span>'}
  </div>
  <ul class="pu-meta">
    <li><span class="pu-dot"></span> ${et.durationMinutes} min</li>
    <li>${escapeHtml(schedulingLabel(et))}</li>
    <li>${escapeHtml(locationLabel(et))}</li>
  </ul>
  <label for="${inputId}">Public link</label>
  <div class="pu-url">
    <input id="${inputId}" class="pu-url-input" readonly value="${escapeHtml(url)}">
  </div>
  <div style="margin-top:.75rem;display:flex;gap:.75rem;flex-wrap:wrap">
    <a class="pu-btn pu-btn-ghost" href="/dashboard/event-types/${encodeURIComponent(et.id)}">Edit</a>
    <a class="pu-btn pu-btn-ghost" href="${escapeHtml(url)}">Preview</a>
  </div>
</article>`
}

function upcomingRow(u: UpcomingBooking, tz: string): string {
  const when = formatInZone(u.booking.startUtc, tz, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `<li style="border-bottom:1px solid var(--pu-line);padding-bottom:.75rem">
        <strong class="pu-time">${escapeHtml(when)}</strong><br>
        ${escapeHtml(u.eventTitle)} — ${escapeHtml(u.booking.guestName)}
        <span class="pu-muted">(${escapeHtml(u.booking.guestEmail)})</span>
      </li>`
}

function schedulingLabel(et: EventType): string {
  switch (et.schedulingType) {
    case 'round_robin':
      return 'Round robin'
    case 'collective':
      return 'Collective'
    default:
      return 'Personal'
  }
}

function locationLabel(et: EventType): string {
  switch (et.locationType) {
    case 'google_meet':
      return 'Google Meet'
    case 'phone':
      return 'Phone call'
    case 'in_person':
      return et.locationValue ?? 'In person'
    default:
      return et.locationValue ?? 'Online'
  }
}

// ---------------------------------------------------------------------------
// Event type form
// ---------------------------------------------------------------------------

export interface EventTypeFormData extends DashboardChrome {
  /** Absent for a create. On a failed create the route passes the draft back. */
  eventType?: EventType
  /**
   * The raw question text as typed. Set when it failed to parse — the draft's
   * `questions` are empty in that case, and re-rendering from them would erase
   * exactly the text the host has to correct.
   */
  questionsText?: string
  errors?: Record<string, string>
}

const LOCATION_OPTIONS: ReadonlyArray<{ value: EventType['locationType']; label: string }> = [
  { value: 'google_meet', label: 'Google Meet' },
  { value: 'custom_link', label: 'Custom link' },
  { value: 'phone', label: 'Phone call' },
  { value: 'in_person', label: 'In person' },
]

export function eventTypeForm(d: EventTypeFormData): string {
  const et = d.eventType
  const errors = d.errors ?? {}
  // An id is what separates "edit this row" from "create a row"; a draft handed
  // back after a failed create has none, so it correctly re-posts as a create.
  const editing = Boolean(et && et.id !== '')
  const action = editing
    ? `/dashboard/event-types/${encodeURIComponent(et!.id)}`
    : '/dashboard/event-types'

  const num = (v: number | null | undefined, fallback: string): string =>
    v === null || v === undefined ? fallback : String(v)

  return (
    shellTop(d, editing ? 'Edit event type' : 'New event type', 'events') +
    `<section class="pu-card" aria-label="${editing ? 'Edit event type' : 'New event type'}">
  <h1>${editing ? 'Edit event type' : 'New event type'}</h1>
  <form method="post" action="${escapeHtml(action)}">
    ${csrfField(d.csrf)}

    <label for="title">Title</label>
    <input id="title" name="title" required aria-required="true" maxlength="120"
           value="${escapeHtml(et?.title ?? '')}"${describedBy('title', errors)}>
    ${fieldError('title', errors)}

    <label for="slug">URL slug</label>
    <input id="slug" name="slug" required aria-required="true" maxlength="60" pattern="[a-z0-9\-]+"
           value="${escapeHtml(et?.slug ?? '')}"${describedBy('slug', errors)}>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      Lowercase letters, numbers and hyphens. It becomes /${escapeHtml(d.user.slug)}/&lt;slug&gt;.</p>
    ${fieldError('slug', errors)}

    <label for="description">Description</label>
    <textarea id="description" name="description" maxlength="2000"${describedBy('description', errors)}>${escapeHtml(et?.description ?? '')}</textarea>
    ${fieldError('description', errors)}

    <div class="pu-grid" style="grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:0 1rem">
      <div>
        <label for="durationMinutes">Duration (minutes)</label>
        <input id="durationMinutes" name="durationMinutes" type="number" min="5" max="1440" step="5"
               required aria-required="true" value="${escapeHtml(num(et?.durationMinutes, '30'))}"${describedBy('durationMinutes', errors)}>
        <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">A multiple of 5 — the booking grid is 5-minute buckets.</p>
        ${fieldError('durationMinutes', errors)}
      </div>
      <div>
        <label for="slotIntervalMinutes">Slot interval (minutes)</label>
        <input id="slotIntervalMinutes" name="slotIntervalMinutes" type="number" min="5" max="1440" step="5"
               value="${escapeHtml(num(et?.slotIntervalMinutes, ''))}"${describedBy('slotIntervalMinutes', errors)}>
        <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">Blank means one slot per duration.</p>
        ${fieldError('slotIntervalMinutes', errors)}
      </div>
      <div>
        <label for="bufferBeforeMinutes">Buffer before (minutes)</label>
        <input id="bufferBeforeMinutes" name="bufferBeforeMinutes" type="number" min="0" max="240" step="5"
               value="${escapeHtml(num(et?.bufferBeforeMinutes, '0'))}"${describedBy('bufferBeforeMinutes', errors)}>
        ${fieldError('bufferBeforeMinutes', errors)}
      </div>
      <div>
        <label for="bufferAfterMinutes">Buffer after (minutes)</label>
        <input id="bufferAfterMinutes" name="bufferAfterMinutes" type="number" min="0" max="240" step="5"
               value="${escapeHtml(num(et?.bufferAfterMinutes, '0'))}"${describedBy('bufferAfterMinutes', errors)}>
        ${fieldError('bufferAfterMinutes', errors)}
      </div>
      <div>
        <label for="minNoticeMinutes">Minimum notice (minutes)</label>
        <input id="minNoticeMinutes" name="minNoticeMinutes" type="number" min="0" max="43200" step="5"
               value="${escapeHtml(num(et?.minNoticeMinutes, '60'))}"${describedBy('minNoticeMinutes', errors)}>
        ${fieldError('minNoticeMinutes', errors)}
      </div>
      <div>
        <label for="maxHorizonDays">Bookable up to (days ahead)</label>
        <input id="maxHorizonDays" name="maxHorizonDays" type="number" min="1" max="730"
               value="${escapeHtml(num(et?.maxHorizonDays, '60'))}"${describedBy('maxHorizonDays', errors)}>
        ${fieldError('maxHorizonDays', errors)}
      </div>
      <div>
        <label for="maxPerDay">Maximum per day</label>
        <input id="maxPerDay" name="maxPerDay" type="number" min="1" max="100"
               value="${escapeHtml(num(et?.maxPerDay, ''))}"${describedBy('maxPerDay', errors)}>
        <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">Blank means unlimited. Counted per host-local day.</p>
        ${fieldError('maxPerDay', errors)}
      </div>
    </div>

    <label for="locationType">Location</label>
    <select id="locationType" name="locationType"${describedBy('locationType', errors)}>
      ${LOCATION_OPTIONS.map(
        (o) =>
          `<option value="${o.value}"${(et?.locationType ?? 'google_meet') === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
      ).join('\n      ')}
    </select>
    ${fieldError('locationType', errors)}

    <label for="locationValue">Location details</label>
    <input id="locationValue" name="locationValue" maxlength="500"
           value="${escapeHtml(et?.locationValue ?? '')}"${describedBy('locationValue', errors)}>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      The meeting URL, phone number or address. Ignored for Google Meet, which mints its own link.</p>
    ${fieldError('locationValue', errors)}

    <label for="questions">Custom questions</label>
    <textarea id="questions" name="questions" rows="5"${describedBy('questions', errors)}>${escapeHtml(d.questionsText ?? formatQuestions(et?.questions ?? []))}</textarea>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      One per line: <code>Label | text|textarea|select | required|optional | option, option</code>.
      Name and email are always asked and are not listed here.</p>
    ${fieldError('questions', errors)}

    <label for="active" style="display:flex;align-items:center;gap:.5rem;margin-top:1rem">
      <input id="active" name="active" type="checkbox" value="1" style="width:auto"
             ${et === undefined || et.active ? 'checked' : ''}>
      <span>Visible on the booking page</span>
    </label>

    <div style="margin-top:1.5rem;display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="pu-btn" type="submit">${editing ? 'Save changes' : 'Create event type'}</button>
      <a class="pu-btn pu-btn-ghost" href="/dashboard">Cancel</a>
    </div>
  </form>
</section>
${
  editing
    ? `<form class="pu-card" method="post" style="margin-top:1.5rem"
        action="/dashboard/event-types/${encodeURIComponent(et!.id)}/delete">
  ${csrfField(d.csrf)}
  <h2>Delete this event type</h2>
  <p class="pu-muted">Existing bookings stay; the page stops accepting new ones.</p>
  <button class="pu-btn pu-btn-danger" type="submit">Delete event type</button>
</form>`
    : ''
}` +
    shellBottom(d.brandName)
  )
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const DAY_NAMES: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

/** Enough to cover most hosts without shipping the whole tz database. */
const COMMON_ZONES: readonly string[] = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Warsaw',
  'Europe/Kyiv',
  'Europe/Istanbul',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
]

export interface AvailabilityPageData extends DashboardChrome {
  availability: Availability
  errors?: Record<string, string>
  notice?: string
}

export function availabilityPage(d: AvailabilityPageData): string {
  const errors = d.errors ?? {}
  const rows = DAY_NAMES.map((name, index) => {
    const id = `day-${index}`
    const windows = d.availability.weekly[index] ?? []
    return `<div>
      <label for="${id}">${escapeHtml(name)}</label>
      <input id="${id}" name="${id}" value="${escapeHtml(formatWindows(windows))}"
             placeholder="09:00-17:00" autocomplete="off"${describedBy(id, errors)}>
      ${fieldError(id, errors)}
    </div>`
  }).join('\n    ')

  const zones = [...new Set([d.availability.timezone, ...COMMON_ZONES])]

  return (
    shellTop(d, 'Availability', 'availability') +
    (d.notice ? notice(d.notice) : '') +
    `<section class="pu-card" aria-label="Weekly availability">
  <h1>Availability</h1>
  <form method="post" action="/dashboard/availability">
    ${csrfField(d.csrf)}

    <label for="timezone">Timezone</label>
    <input id="timezone" name="timezone" list="pu-zones" required aria-required="true"
           value="${escapeHtml(d.availability.timezone)}"${describedBy('timezone', errors)}>
    <datalist id="pu-zones">
      ${zones.map((z) => `<option value="${escapeHtml(z)}"></option>`).join('\n      ')}
    </datalist>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      Your weekly hours below are read in this zone, so they follow you through daylight saving.</p>
    ${fieldError('timezone', errors)}

    <h2 style="margin-top:1.5rem">Weekly hours</h2>
    <p class="pu-muted" style="font-size:.8125rem">
      Comma-separated 24-hour ranges, for example <code>09:00-12:00, 13:00-17:00</code>. Leave a day blank for a day off.</p>
    ${rows}

    <h2 style="margin-top:1.5rem">Date overrides</h2>
    <label for="overrides">Specific dates</label>
    <textarea id="overrides" name="overrides" rows="5" placeholder="2026-12-24"${describedBy('overrides', errors)}>${escapeHtml(formatOverrides(d.availability.overrides))}</textarea>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      One per line: <code>YYYY-MM-DD 10:00-14:00</code>. A date with no ranges is a day off, and an override
      replaces that day's weekly hours entirely.</p>
    ${fieldError('overrides', errors)}

    <div style="margin-top:1.5rem"><button class="pu-btn" type="submit">Save availability</button></div>
  </form>
</section>` +
    shellBottom(d.brandName)
  )
}

// ---------------------------------------------------------------------------
// Calendar connections
// ---------------------------------------------------------------------------

export interface ConnectionView {
  connection: CalendarConnection
  /**
   * Calendars the provider lists. Empty when the provider could not be reached
   * — the page then falls back to showing the stored ids, so a host with a
   * broken connection can still see and fix what is selected.
   */
  calendars: Array<{ id: string; name: string; primary: boolean }>
}

export interface ConnectionsPageData extends DashboardChrome {
  connections: ConnectionView[]
  /** Providers with credentials configured in this deployment. */
  availableProviders: CalendarProviderName[]
  notice?: string
}

export function connectionsPage(d: ConnectionsPageData): string {
  const cards =
    d.connections.length === 0
      ? `<p class="pu-muted">No calendars connected. Bookings still work — nothing will be checked for conflicts.</p>`
      : d.connections.map((c) => connectionCard(d, c)).join('\n')

  const connectButtons =
    d.availableProviders.length === 0
      ? `<p class="pu-muted">No calendar provider is configured on this deployment. Set the provider's
       client id and secret to enable connecting.</p>`
      : d.availableProviders
          .map(
            (p) =>
              `<a class="pu-btn" style="margin-right:.75rem" href="/auth/${p}/start?purpose=calendar">Connect ${escapeHtml(providerLabel(p))} Calendar</a>`,
          )
          .join('\n    ')

  return (
    shellTop(d, 'Calendars', 'connections') +
    (d.notice ? notice(d.notice) : '') +
    `<section aria-label="Connected calendars">
  <h1>Calendars</h1>
  <p class="pu-muted">Calendars you read are checked for conflicts. The calendar you write to receives the booking.</p>
  <div style="display:grid;gap:1rem">${cards}</div>
  <div class="pu-card" style="margin-top:1.5rem">
    <h2>Connect another calendar</h2>
    <p class="pu-muted" style="font-size:.8125rem">
      Connecting asks for calendar permissions. Signing in never does — they are separate grants, so revoking
      one does not affect the other.</p>
    ${connectButtons}
  </div>
</section>` +
    shellBottom(d.brandName)
  )
}

function connectionCard(d: ConnectionsPageData, view: ConnectionView): string {
  const c = view.connection
  const id = encodeURIComponent(c.id)
  // A provider list we could not fetch must not silently drop the host's
  // selection, so fall back to the stored ids as their own labels.
  const calendars =
    view.calendars.length > 0
      ? view.calendars
      : c.calendarIdsRead.map((cid) => ({ id: cid, name: cid, primary: false }))

  const readRows = calendars
    .map((cal) => {
      const inputId = `read-${escapeHtml(c.id)}-${escapeHtml(cal.id)}`
      const checked = c.calendarIdsRead.includes(cal.id) ? ' checked' : ''
      return `<label for="${inputId}" style="display:flex;align-items:center;gap:.5rem;font-weight:400;margin:.35rem 0">
        <input id="${inputId}" name="read" type="checkbox" value="${escapeHtml(cal.id)}"${checked} style="width:auto">
        <span>${escapeHtml(cal.name)}${cal.primary ? ' <span class="pu-muted">(primary)</span>' : ''}</span>
      </label>`
    })
    .join('\n      ')

  const writeOptions = [
    `<option value=""${c.calendarIdWrite === null ? ' selected' : ''}>Do not write events</option>`,
    ...calendars.map(
      (cal) =>
        `<option value="${escapeHtml(cal.id)}"${c.calendarIdWrite === cal.id ? ' selected' : ''}>${escapeHtml(cal.name)}</option>`,
    ),
  ].join('\n        ')

  return `<article class="pu-card">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap">
    <h2 style="margin:0">${escapeHtml(providerLabel(c.provider))}</h2>
    ${syncBadge(c)}
  </div>
  <p class="pu-muted" style="margin:.25rem 0 0">${escapeHtml(c.providerAccountEmail || 'Unknown account')}</p>
  ${
    c.syncStatus === 'needs_reconnect'
      ? `<div style="margin:.75rem 0" role="alert">
    <p class="pu-err" style="font-size:.9375rem">Access was revoked or expired. Conflicts from this calendar are not
       being checked and new bookings are not written to it.</p>
    <a class="pu-btn" href="/auth/${c.provider}/start?purpose=calendar">Reconnect ${escapeHtml(providerLabel(c.provider))}</a>
  </div>`
      : ''
  }
  <form method="post" action="/dashboard/connections/${id}">
    ${csrfField(d.csrf)}
    <fieldset style="border:0;padding:0;margin:1rem 0 0">
      <legend style="font-size:.875rem;font-weight:600;padding:0">Check these for conflicts</legend>
      ${readRows || '<p class="pu-muted">No calendars to list.</p>'}
    </fieldset>
    <label for="write-${escapeHtml(c.id)}">Write bookings to</label>
    <select id="write-${escapeHtml(c.id)}" name="write">
        ${writeOptions}
    </select>
    <div style="margin-top:1rem"><button class="pu-btn" type="submit">Save</button></div>
  </form>
  <form method="post" action="/dashboard/connections/${id}/disconnect" style="margin-top:.75rem">
    ${csrfField(d.csrf)}
    <button class="pu-btn pu-btn-danger" type="submit">Disconnect</button>
  </form>
</article>`
}

function syncBadge(c: CalendarConnection): string {
  if (c.syncStatus === 'ok') return '<span class="pu-badge">Connected</span>'
  const label = c.syncStatus === 'needs_reconnect' ? 'Needs reconnect' : 'Sync error'
  return `<span class="pu-badge" style="background:var(--pu-paper-dim);color:var(--pu-danger)">${label}</span>`
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface ApiKeysPageData extends DashboardChrome {
  keys: ApiKey[]
  /**
   * The raw key, rendered EXACTLY once immediately after creation (ADR-0005
   * §7). Only its SHA-256 is stored, so this string cannot be produced again by
   * anyone, including us.
   */
  newKey?: string
  errors?: Record<string, string>
}

export function apiKeysPage(d: ApiKeysPageData): string {
  const errors = d.errors ?? {}

  const list =
    d.keys.length === 0
      ? '<p class="pu-muted">No API keys yet.</p>'
      : `<ul style="list-style:none;padding:0;margin:0;display:grid;gap:.75rem">
      ${d.keys.map((k) => apiKeyRow(d, k)).join('\n      ')}
    </ul>`

  return (
    shellTop(d, 'API keys', 'keys') +
    (d.newKey
      ? `<section class="pu-card" role="alert" aria-label="Your new API key"
    style="border-color:var(--pu-green-700);margin-bottom:1.5rem">
  <h2>Copy your key now</h2>
  <p><strong>This is the only time it will be shown.</strong> We store only a hash of it, so if you lose it
     you will have to create a new one.</p>
  <label for="new-key">New API key</label>
  <div class="pu-url">
    <input id="new-key" class="pu-url-input" readonly value="${escapeHtml(d.newKey)}">
  </div>
</section>`
      : '') +
    `<section aria-label="API keys">
  <h1>API keys</h1>
  <p class="pu-muted">Keys authenticate the REST API and the MCP server. An agent's authority is exactly its key's scopes.</p>
  ${list}
  <form class="pu-card" method="post" action="/dashboard/api-keys" style="margin-top:1.5rem">
    ${csrfField(d.csrf)}
    <h2>Create a key</h2>
    <label for="name">Name</label>
    <input id="name" name="name" required aria-required="true" maxlength="80"
           placeholder="Laptop CLI"${describedBy('name', errors)}>
    ${fieldError('name', errors)}
    <label for="scopes">Scopes</label>
    <input id="scopes" name="scopes" value="read write"
           maxlength="200"${describedBy('scopes', errors)}>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">Space-separated. Grant the fewest that work.</p>
    ${fieldError('scopes', errors)}
    <div style="margin-top:1.25rem"><button class="pu-btn" type="submit">Create key</button></div>
  </form>
</section>` +
    shellBottom(d.brandName)
  )
}

function apiKeyRow(d: ApiKeysPageData, k: ApiKey): string {
  const created = formatInZone(k.createdAt, d.user.tz, { month: 'short', day: 'numeric', year: 'numeric' })
  const used =
    k.lastUsedAt === null
      ? 'never used'
      : `last used ${formatInZone(k.lastUsedAt, d.user.tz, { month: 'short', day: 'numeric' })}`
  return `<li class="pu-card" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap">
        <div>
          <strong>${escapeHtml(k.name || 'Unnamed key')}</strong><br>
          <span class="pu-time pu-muted">pk_${escapeHtml(k.prefix)}…</span>
          <span class="pu-muted">· created ${escapeHtml(created)} · ${escapeHtml(used)}</span>
        </div>
        <form method="post" action="/dashboard/api-keys/${encodeURIComponent(k.id)}/delete" style="margin:0">
          ${csrfField(d.csrf)}
          <button class="pu-btn pu-btn-danger" type="submit"
                  style="padding:.4rem .8rem;font-size:.875rem">Revoke</button>
        </form>
      </li>`
}

// ---------------------------------------------------------------------------
// Settings — the host's own slug
// ---------------------------------------------------------------------------

export interface SettingsPageData extends DashboardChrome {
  /**
   * What the slug field shows. Defaults to the current slug. Set to the raw
   * typed value on a failed submit, same reasoning as `readEventTypeForm`:
   * discarding a bad value here would silently clear the field the host needs
   * to fix.
   */
  slugValue?: string
  errors?: Record<string, string>
  notice?: string
}

export function settingsPage(d: SettingsPageData): string {
  const errors = d.errors ?? {}
  const slugValue = d.slugValue ?? d.user.slug

  return (
    shellTop(d, 'Settings', 'settings') +
    (d.notice ? notice(d.notice) : '') +
    `<section class="pu-card" aria-label="Your photo" style="margin-bottom:1.25rem">
  <h1>Settings</h1>
  <h2>Your photo</h2>
  <p class="pu-muted">Shown on your booking page and in confirmation emails. PNG, JPEG or WebP, up to 5&nbsp;MB.</p>
  <div style="display:flex;align-items:center;gap:1rem;margin:.75rem 0">
    ${avatarHtml({ key: d.user.avatarKey, name: d.user.name || d.user.slug, size: 56 })}
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:.5rem">
      <form method="post" action="/dashboard/settings/avatar" enctype="multipart/form-data"
            style="display:flex;flex-wrap:wrap;align-items:center;gap:.5rem">
        ${csrfField(d.csrf)}
        <input type="file" name="avatar" accept="image/png,image/jpeg,image/webp" required
               aria-label="Choose a photo"${describedBy('avatar', errors)}>
        <button class="pu-btn" type="submit">Upload</button>
      </form>
      ${
        d.user.avatarKey
          ? `<form method="post" action="/dashboard/settings/avatar/delete">
        ${csrfField(d.csrf)}
        <button class="pu-btn pu-btn-ghost" type="submit">Remove</button>
      </form>`
          : ''
      }
    </div>
  </div>
  ${fieldError('avatar', errors)}
</section>
<section class="pu-card" aria-label="Account settings">
  <h2>Your booking page slug</h2>
  <p class="pu-muted">Every one of your event types is published at
    <code>/${escapeHtml(d.user.slug)}/&lt;event&gt;</code>. Changing your slug moves the address of
    <strong>every</strong> event type at once.</p>
  <div role="alert" class="pu-callout" style="margin:.75rem 0">
    <p style="margin:0">
      Any link or QR code you have already shared &mdash; in an email signature, on a website, on a printed
      flyer &mdash; will stop working the moment you save. There is no redirect from
      <code>${escapeHtml(d.user.slug)}</code> to the new slug: a guest who kept the old link lands on a
      &ldquo;not found&rdquo; page. Update every place you have posted your link, before or right after you
      change it.</p>
  </div>
  <form method="post" action="/dashboard/settings">
    ${csrfField(d.csrf)}
    <label for="slug">Slug</label>
    <input id="slug" name="slug" required aria-required="true" maxlength="40" pattern="[a-z0-9\-]+"
           value="${escapeHtml(slugValue)}"${describedBy('slug', errors)}>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      Lowercase letters, numbers and hyphens only, 2&ndash;40 characters. It becomes the first part of
      every one of your booking links: /&lt;slug&gt;/&lt;event&gt;.</p>
    ${fieldError('slug', errors)}
    <div style="margin-top:1.25rem"><button class="pu-btn" type="submit">Save slug</button></div>
  </form>
</section>` +
    shellBottom(d.brandName)
  )
}

// ---------------------------------------------------------------------------
// Guest manage page
// ---------------------------------------------------------------------------

export interface BookingDetailPageData {
  brandName: string
  booking: Booking
  /** Null when the event type has since been deleted; the booking still stands. */
  eventType: EventType | null
  host: User
  /**
   * The signed manage token from the query string. It is the credential
   * (ADR-0005 §4) and travels back on every form, which is also why these
   * forms carry no CSRF token: there is no session and no ambient authority to
   * forge, exactly as on the public booking page (ADR-0005 §5).
   */
  token: string
  /** What this token is allowed to do. A cancel link cannot reschedule. */
  /**
   * The token's real purpose. `manage` authorises BOTH actions and is the only
   * purpose the coordinator mints, so narrowing this type is what previously
   * hid the cancel form from every guest.
   */
  purpose: 'manage' | 'cancel' | 'reschedule'
  /** Times offered for a reschedule, when the guest picked a day. */
  slots?: Slot[]
  selectedDate?: string
  /** Set once the guest chose a time, so the page can ask for confirmation. */
  newStart?: number
  error?: string
}

export function bookingDetailPage(d: BookingDetailPageData): string {
  const tz = d.booking.guestTimezone
  const when = formatInZone(d.booking.startUtc, tz, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  const title = d.eventType?.title ?? 'Your booking'
  const cancelled = d.booking.status !== 'confirmed'
  const tokenField = `<input type="hidden" name="token" value="${escapeHtml(d.token)}">`

  return (
    shellHead({ title: `${title} · ${d.brandName}`, brandName: d.brandName }) +
    `<section class="pu-card" aria-label="Your booking">
  <p><span class="pu-badge"${cancelled ? ' style="background:var(--pu-paper-dim);color:var(--pu-ink-500)"' : ''}>${escapeHtml(statusLabel(d.booking))}</span></p>
  <h1>${escapeHtml(title)}</h1>
  <p>with ${escapeHtml(d.host.name || d.host.slug)}</p>
  <p class="pu-time"><strong>${escapeHtml(when)}</strong><br>
    <span class="pu-muted">${escapeHtml(tz)} (${escapeHtml(offsetLabel(d.booking.startUtc, tz))}) · ${
      Math.round((d.booking.endUtc - d.booking.startUtc) / 60000)
    } min</span></p>
  ${d.eventType ? `<p class="pu-muted">${escapeHtml(locationLabel(d.eventType))}</p>` : ''}
  ${d.error ? `<p class="pu-err" role="alert">${escapeHtml(d.error)}</p>` : ''}
</section>` +
    (cancelled
      ? `<section class="pu-card" style="margin-top:1.5rem">
  <p class="pu-muted">This booking is no longer active, so there is nothing left to change.</p>
</section>`
      : rescheduleSection(d, tokenField) + cancelSection(d, tokenField)) +
    shellFoot(d.brandName)
  )
}

function statusLabel(b: Booking): string {
  switch (b.status) {
    case 'cancelled':
      return 'Cancelled'
    case 'rescheduled':
      return 'Moved'
    default:
      return 'Confirmed'
  }
}

function rescheduleSection(d: BookingDetailPageData, tokenField: string): string {
  // Same as cancelSection: 'manage' authorises this too.
  if (d.purpose !== 'reschedule' && d.purpose !== 'manage') {
    return `<section class="pu-card" style="margin-top:1.5rem" aria-label="Reschedule">
  <h2>Need a different time?</h2>
  <p class="pu-muted">Use the reschedule link in your confirmation email — this one only cancels.</p>
</section>`
  }

  const path = d.eventType
    ? `/booking/${encodeURIComponent(d.booking.id)}?token=${encodeURIComponent(d.token)}`
    : null
  if (!path) {
    return `<section class="pu-card" style="margin-top:1.5rem" aria-label="Reschedule">
  <h2>Reschedule</h2>
  <p class="pu-muted">This event type is no longer offered, so it cannot be rescheduled. Cancel and book again.</p>
</section>`
  }

  if (d.newStart !== undefined) {
    const when = formatInZone(d.newStart, d.booking.guestTimezone, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    return `<section class="pu-card" style="margin-top:1.5rem" aria-label="Confirm new time">
  <h2>Move to this time?</h2>
  <p class="pu-time"><strong>${escapeHtml(when)}</strong><br>
    <span class="pu-muted">${escapeHtml(d.booking.guestTimezone)}</span></p>
  <form method="post" action="/booking/${encodeURIComponent(d.booking.id)}/reschedule">
    ${tokenField}
    <input type="hidden" name="start" value="${d.newStart}">
    <div style="display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="pu-btn" type="submit">Confirm new time</button>
      <a class="pu-btn pu-btn-ghost" href="${escapeHtml(path)}">Back</a>
    </div>
  </form>
</section>`
  }

  const date = d.selectedDate ?? localDateString(d.booking.startUtc, d.booking.guestTimezone)
  const slots = d.slots ?? []
  const list =
    slots.length === 0
      ? '<p class="pu-muted">No times available on this day.</p>'
      : `<div class="pu-slots">
    ${slots
      .map((s) => {
        const label = formatInZone(s.start, d.booking.guestTimezone, { hour: 'numeric', minute: '2-digit' })
        const href = `${path}&date=${encodeURIComponent(date)}&start=${s.start}`
        return `<a class="${slotStateClassName('available')}" href="${escapeHtml(href)}">
      <time datetime="${new Date(s.start).toISOString()}">${escapeHtml(label)}</time></a>`
      })
      .join('\n    ')}
  </div>`

  return `<section class="pu-card" style="margin-top:1.5rem" aria-label="Reschedule">
  <h2>Pick a new time</h2>
  <form method="get" action="/booking/${encodeURIComponent(d.booking.id)}">
    <input type="hidden" name="token" value="${escapeHtml(d.token)}">
    <label for="date">Day</label>
    <input id="date" name="date" type="date" value="${escapeHtml(date)}">
    <div style="margin-top:.75rem"><button class="pu-btn pu-btn-ghost" type="submit">Show times</button></div>
  </form>
  <p class="pu-muted" style="font-size:.8125rem;margin-top:1rem">
    Times in ${escapeHtml(d.booking.guestTimezone)}</p>
  ${list}
</section>`
}

function cancelSection(d: BookingDetailPageData, tokenField: string): string {
  // A 'manage' token authorises both actions, and it is the ONLY purpose the
  // coordinator mints. Refusing anything that is not literally 'cancel' left
  // every real guest looking at "use the cancel link in your email" — while
  // that email's cancel link is this same URL. The loop never terminated.
  if (d.purpose !== 'cancel' && d.purpose !== 'manage') {
    return `<section class="pu-card" style="margin-top:1.5rem" aria-label="Cancel">
  <h2>Need to cancel?</h2>
  <p class="pu-muted">Use the cancel link in your confirmation email — this one only reschedules.</p>
</section>`
  }
  return `<form class="pu-card" method="post" style="margin-top:1.5rem"
      action="/booking/${encodeURIComponent(d.booking.id)}/cancel">
  ${tokenField}
  <h2>Cancel this booking</h2>
  <p class="pu-muted">The host is notified and the time is released for someone else.</p>
  <button class="pu-btn pu-btn-danger" type="submit">Cancel booking</button>
</form>`
}

/** Shared "this link is not valid" page. Says nothing about why. */
export function manageLinkErrorPage(brandName: string, message: string): string {
  return (
    shellHead({ title: `Link not valid · ${brandName}`, brandName }) +
    `<section class="pu-card">
  <h1>This link is not valid</h1>
  <p class="pu-muted">${escapeHtml(message)}</p>
  <p class="pu-muted">Links expire, and rescheduling replaces the ones sent before it. The most recent
     confirmation email always has a working link.</p>
</section>` +
    shellFoot(brandName)
  )
}

// ---------------------------------------------------------------------------
// Text formats — rendered and parsed side by side, on purpose
// ---------------------------------------------------------------------------

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function timeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  // 24:00 is accepted as "end of day" — it is the only way to express a window
  // that runs to midnight without an off-by-one at the boundary.
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null
  return h * 60 + min
}

export function formatWindows(windows: DayWindow[]): string {
  return windows.map((w) => `${minutesToTime(w.startMinute)}-${minutesToTime(w.endMinute)}`).join(', ')
}

/**
 * `09:00-12:00, 13:00-17:00` → windows. Null on anything malformed.
 *
 * Rejects rather than repairs: silently dropping an unparseable range would
 * make a host believe they are bookable when they are not.
 */
export function parseWindows(value: string): DayWindow[] | null {
  const trimmed = value.trim()
  if (trimmed === '') return []
  const out: DayWindow[] = []
  for (const part of trimmed.split(',')) {
    const [rawStart, rawEnd, ...rest] = part.split('-')
    if (rawStart === undefined || rawEnd === undefined || rest.length > 0) return null
    const start = timeToMinutes(rawStart)
    const end = timeToMinutes(rawEnd)
    if (start === null || end === null || end <= start) return null
    // Snap INWARD to the 5-minute bucket grid: start up, end down. A window
    // beginning at 09:07 would anchor the slot grid off-grid, which lets two
    // adjacent offered slots claim the same bucket and 409 each other
    // (ADR-0004 §4). Snapping inward can never widen availability beyond what
    // the host typed.
    const snappedStart = Math.ceil(start / 5) * 5
    const snappedEnd = Math.floor(end / 5) * 5
    if (snappedEnd <= snappedStart) return null
    out.push({ startMinute: snappedStart, endMinute: snappedEnd })
  }
  return out.sort((a, b) => a.startMinute - b.startMinute)
}

export function formatOverrides(overrides: DateOverride[]): string {
  return overrides
    .map((o) => (o.windows.length === 0 ? o.date : `${o.date} ${formatWindows(o.windows)}`))
    .join('\n')
}

/** One override per line: `YYYY-MM-DD` alone is a day off. Null on malformed input. */
export function parseOverrides(text: string): DateOverride[] | null {
  const out: DateOverride[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const date = line.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    const windows = parseWindows(line.slice(10))
    if (windows === null) return null
    out.push({ date, windows })
  }
  return out
}

const QUESTION_TYPES: readonly EventTypeQuestion['type'][] = ['text', 'textarea', 'select']

export function formatQuestions(questions: EventTypeQuestion[]): string {
  return questions
    .map((q) => {
      const base = `${q.label} | ${q.type} | ${q.required ? 'required' : 'optional'}`
      return q.type === 'select' && q.options && q.options.length > 0
        ? `${base} | ${q.options.join(', ')}`
        : base
    })
    .join('\n')
}

/**
 * `Label | type | required | a, b` per line. Null on malformed input.
 *
 * The id is derived from the label rather than kept hidden in the form: this
 * editor has no client JS to carry ids around, and a stable derivation gives
 * the same id back for an unchanged label. Renaming a question therefore
 * changes its id and orphans answers already stored under the old one — which
 * is the honest outcome, since a renamed question is usually a different
 * question.
 */
export function parseQuestions(text: string): EventTypeQuestion[] | null {
  const out: EventTypeQuestion[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const parts = line.split('|').map((p) => p.trim())
    const label = parts[0] ?? ''
    if (label === '' || label.length > 200) return null

    const type = (parts[1] ?? 'text') as EventTypeQuestion['type']
    if (!QUESTION_TYPES.includes(type)) return null

    const requiredWord = (parts[2] ?? 'optional').toLowerCase()
    if (requiredWord !== 'required' && requiredWord !== 'optional') return null

    const options = (parts[3] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o !== '')
    if (type === 'select' && options.length === 0) return null

    let id = slugify(label)
    if (id === '') return null
    // Two questions with the same label would otherwise share an id, and the
    // second answer would overwrite the first.
    let n = 2
    while (seen.has(id)) id = `${slugify(label)}-${n++}`
    seen.add(id)

    const question: EventTypeQuestion = { id, label, type, required: requiredWord === 'required' }
    if (type === 'select') question.options = options
    out.push(question)
  }
  return out
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}
