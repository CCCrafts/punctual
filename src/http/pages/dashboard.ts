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

import { isManagingRole } from '../../core/domain/teams.js'
import type {
  ApiKey,
  Booking,
  CalendarConnection,
  DateOverride,
  DayWindow,
  EventType,
  EventTypeQuestion,
  Schedule,
  Slot,
  Team,
  TeamMember,
  User,
  WeeklySchedule,
} from '../../core/domain/types.js'
import type { CalendarProviderName } from '../../ports.js'
import { slotStateClassName } from '../../core/slot-state.js'
import { slugify } from '../../core/domain/booking-service.js'
import { formatInZone, localDateString, offsetLabel } from '../../core/time/zone.js'
import { avatarHtml, escapeHtml, shellFoot, shellHead } from './booking.js'

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/** Form field carrying the double-submit token. Routes read the same name. */
export const CSRF_FIELD = 'csrf'

export type NavKey = 'events' | 'availability' | 'teams' | 'connections' | 'keys' | 'settings' | 'admin'

const NAV: ReadonlyArray<{ key: NavKey; href: string; label: string }> = [
  { key: 'events', href: '/dashboard', label: 'Event types' },
  { key: 'availability', href: '/dashboard/availability', label: 'Availability' },
  { key: 'teams', href: '/dashboard/teams', label: 'Teams' },
  { key: 'connections', href: '/dashboard/connections', label: 'Calendars' },
  { key: 'keys', href: '/dashboard/api-keys', label: 'API keys' },
  { key: 'settings', href: '/dashboard/settings', label: 'Settings' },
  // Rendered for admins only (shellTop filters on chrome.user.role); the
  // routes behind it are gated separately — hiding a link is not access
  // control.
  { key: 'admin', href: '/dashboard/admin', label: 'Admin' },
]

/** Common shape of every authenticated page. */
export interface DashboardChrome {
  brandName: string
  user: User
  /** Double-submit token for this session (ADR-0005 §5). */
  csrf: string
  /**
   * `EngineConfig.emailDelivery`. When `'console'`, `shellTop` renders a
   * standing warning: this instance is not delivering ANY mail, and a host
   * whose guests get no confirmation needs to know that whether or not they
   * are the admin who can fix it.
   *
   * REQUIRED, deliberately. It was optional for exactly one review cycle,
   * and in that cycle `/dashboard/settings` was already silently missing it
   * — a page that looks healthy while mail goes nowhere, which is the very
   * failure this banner exists to catch. Optional made the warning something
   * each new page has to REMEMBER; required makes forgetting a compile
   * error. Guest-facing pages (the manage page, the login page) are
   * unaffected: they do not carry `DashboardChrome` and must not show an
   * operator's config problems to a booker.
   */
  emailDelivery: 'resend' | 'brevo' | 'console'
}

/**
 * The one degradation that is invisible from the product itself: bookings
 * commit, calendars sync, the dashboard looks healthy, and every guest gets
 * nothing. Deliberately not dismissible and not admin-gated.
 */
function emailWarningBanner(chrome: DashboardChrome): string {
  if (chrome.emailDelivery !== 'console') return ''
  return `<div role="alert" class="pu-callout" style="margin:0 0 1.25rem">
  <p style="margin:0"><strong>Email is not configured — no one is receiving confirmations.</strong>
    Bookings are being saved and synced to calendars, but every confirmation, reschedule notice,
    cancellation and reminder is written to the log instead of sent. Set
    <code>RESEND_API_KEY</code> or <code>BREVO_API_KEY</code> as a secret, then redeploy
    &mdash; see <a href="/docs/self-hosting">self-hosting</a>.</p>
</div>`
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
  const links = NAV.filter((item) => item.key !== 'admin' || chrome.user.role === 'admin')
    .map((item) => {
      const current = item.key === active ? ' aria-current="page"' : ''
      return `<a class="pu-nav-link" href="${item.href}"${current}>${escapeHtml(item.label)}</a>`
    })
    .join('\n      ')

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
<p class="pu-sr">Signed in as ${escapeHtml(chrome.user.email)}</p>` +
    emailWarningBanner(chrome)
  )
}

function shellBottom(brandName: string): string {
  // A utility footer, not the marketing one: the host already knows what
  // powers this — what they reach for down here is the documentation. The
  // wordmark links home; every other link is a page the engine serves
  // unconditionally, so this needs no per-deployment config.
  return (
    `</div>
<footer class="pu-dash-foot">
  <div class="pu-wrap pu-dash-foot-row">
    <a class="pu-mark" href="/">${escapeHtml(brandName.toLowerCase())}<span>:</span></a>
    <nav aria-label="Dashboard footer">
      <a href="/docs">Docs</a>
      <a href="/docs/api">API</a>
      <a href="/docs/mcp">MCP</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </nav>
  </div>
</footer>
</body></html>`
  )
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
    shellFoot()
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

/**
 * One row of the home list. The owner slug travels WITH the event type rather
 * than being derived from the signed-in user, because a team-owned event's
 * public link starts with the TEAM's slug — using the user's slug there would
 * print a URL that 404s.
 */
export interface EventTypeListItem {
  eventType: EventType
  /** First path segment of the public link: the user's slug, or the owning team's. */
  ownerSlug: string
  /** Set for team-owned rows, so the card can say whose event this is. */
  teamName?: string
  /**
   * False for a team-owned row the signed-in user may only look at — they
   * host it but are not one of the team's admins (core/domain/teams.ts).
   * The card then says so instead of offering an Edit link that 404s.
   */
  canEdit?: boolean
}

export interface DashboardHomeData extends DashboardChrome {
  eventTypes: EventTypeListItem[]
  upcomingBookings: UpcomingBooking[]
  /** Public origin, so the copyable URL is the one a guest would receive. */
  baseUrl: string
  notice?: string
}

export function dashboardHome(d: DashboardHomeData): string {
  const events =
    d.eventTypes.length === 0
      ? `<p class="pu-muted">No event types yet. Create one and your booking page is live.</p>`
      : d.eventTypes.map((item) => eventTypeCard(d, item)).join('\n')

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

/**
 * One-tap copy for a `.pu-url` value. Inline handler, same minimal-island
 * policy as the timezone picker's `onchange` — no shared script to load, and
 * the page works without it (the input still select-alls on click).
 * `navigator.clipboard` only EXISTS in a secure context — on plain http from
 * a non-localhost origin (a LAN IP, an untls'd proxy) it is `undefined` and
 * calling it throws synchronously, before any promise a `.catch` could see —
 * so the guard has to come first; both failure paths land on the same
 * select-the-input fallback rather than a button that silently does nothing.
 */
function copyButton(value: string): string {
  return `<button type="button" class="pu-btn pu-btn-ghost pu-copy" data-copy="${escapeHtml(value)}"
    onclick="var b=this,f=function(){var i=b.parentElement.querySelector('input');i.focus();i.select()};if(navigator.clipboard){navigator.clipboard.writeText(b.dataset.copy).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)}).catch(f)}else{f()}">Copy</button>`
}

function eventTypeCard(d: DashboardHomeData, item: EventTypeListItem): string {
  const et = item.eventType
  const url = `${trimSlash(d.baseUrl)}/${encodeURIComponent(item.ownerSlug)}/${encodeURIComponent(et.slug)}`
  const inputId = `url-${escapeHtml(et.id)}`
  return `<article class="pu-card">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap">
    <h2 style="margin:0">${escapeHtml(et.title)}</h2>
    <div style="display:flex;gap:.5rem">
      ${item.teamName ? `<span class="pu-badge">${escapeHtml(item.teamName)}</span>` : ''}
      ${et.active ? '' : '<span class="pu-badge" style="background:var(--pu-paper-dim);color:var(--pu-ink-500)">Hidden</span>'}
    </div>
  </div>
  <ul class="pu-meta">
    <li><span class="pu-dot"></span> ${et.durationMinutes} min</li>
    <li>${escapeHtml(schedulingLabel(et))}</li>
    <li>${escapeHtml(locationLabel(et))}</li>
  </ul>
  <label for="${inputId}">Public link</label>
  <div class="pu-url">
    <input id="${inputId}" class="pu-url-input" readonly value="${escapeHtml(url)}" onclick="this.select()">
    ${copyButton(url)}
  </div>
  <div style="margin-top:.75rem;display:flex;gap:.75rem;flex-wrap:wrap;align-items:center">
    ${
      item.canEdit === false
        ? '<span class="pu-muted" style="font-size:.8125rem">Managed by the team&rsquo;s admins</span>'
        : `<a class="pu-btn pu-btn-ghost" href="/dashboard/event-types/${encodeURIComponent(et.id)}">Edit</a>`
    }
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
   * Teams the host belongs to — the owner choices beside "Me (personal)".
   * When empty the owner/scheduling selects are not rendered at all, and the
   * route forces a personal event: a host with no teams has nothing to choose.
   */
  teams?: Team[]
  /**
   * The raw question text as typed. Set when it failed to parse — the draft's
   * `questions` are empty in that case, and re-rendering from them would erase
   * exactly the text the host has to correct.
   */
  questionsText?: string
  /**
   * The host's own schedules — the "Availability schedule" choices beside
   * "Default". Same precedent as `teams` above: when there's only the one
   * default, the select is not rendered at all, since a one-option dropdown
   * offers nothing a host with no other schedule could meaningfully choose.
   */
  schedules?: Schedule[]
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
  const teams = d.teams ?? []
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

    ${ownershipFields(d, teams, errors)}

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

    ${scheduleField(d, errors)}

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
  <p class="pu-muted">Only possible once it has no upcoming confirmed bookings &mdash; deleting it out
    from under a booking leaves that guest with no confirmation at all. To stop taking new bookings
    while keeping the meetings you already have, untick &ldquo;Visible on the booking page&rdquo; instead.</p>
  ${fieldError('delete', errors)}
  <button class="pu-btn pu-btn-danger" type="submit">Delete event type</button>
</form>`
    : ''
}` +
    shellBottom(d.brandName)
  )
}

/**
 * The owner and scheduling selects, rendered only when the host has a team to
 * offer. Both selects are always visible when rendered — no client JS shows
 * or hides anything — and the SERVER is the source of truth: with owner "me"
 * the scheduling value is ignored and forced to 'personal' (readEventTypeForm),
 * so a stale or crafted scheduling value cannot make a personal event
 * round-robin.
 */
function ownershipFields(d: EventTypeFormData, teams: Team[], errors: Record<string, string>): string {
  // No teams, no selects — but a crafted POST naming a team the user is not
  // in still needs its refusal VISIBLE, or the 400 renders with no explanation.
  if (teams.length === 0) return fieldError('owner', errors)
  const et = d.eventType
  const teamOptions = teams
    .map(
      (t) =>
        `<option value="${escapeHtml(t.id)}"${et?.ownerTeamId === t.id ? ' selected' : ''}>${escapeHtml(t.name)}</option>`,
    )
    .join('\n      ')
  return `<div class="pu-grid" style="grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:0 1rem">
      <div>
        <label for="owner">Owner</label>
        <select id="owner" name="owner"${describedBy('owner', errors)}>
      <option value=""${et?.ownerTeamId ? '' : ' selected'}>Me (personal)</option>
      ${teamOptions}
    </select>
        <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
          A team-owned event is booked at /&lt;team-slug&gt;/&lt;slug&gt;.</p>
        ${fieldError('owner', errors)}
      </div>
      <div>
        <label for="schedulingType">Scheduling</label>
        <select id="schedulingType" name="schedulingType"${describedBy('schedulingType', errors)}>
      <option value="round_robin"${et?.schedulingType === 'collective' ? '' : ' selected'}>Round robin — one member takes each booking</option>
      <option value="collective"${et?.schedulingType === 'collective' ? ' selected' : ''}>Collective — every member attends</option>
    </select>
        <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
          Applies when a team owns the event. Ignored for a personal one.</p>
        ${fieldError('schedulingType', errors)}
      </div>
    </div>`
}

/**
 * Same discipline as `ownershipFields`'s scheduling select: always visible
 * when rendered, no client JS involved, and the value is ignored server-side
 * (readEventTypeForm) for a team-owned draft — a team event type has
 * multiple hosts and no single schedule fits all of them (engine.ts).
 * Rendered only when the host has more than their one default schedule to
 * choose from, same "nothing meaningful to choose" precedent as `teams`
 * having none.
 */
function scheduleField(d: EventTypeFormData, errors: Record<string, string>): string {
  const schedules = d.schedules ?? []
  if (schedules.length <= 1) return fieldError('scheduleId', errors)
  const et = d.eventType
  const options = schedules
    .map(
      (s) =>
        `<option value="${escapeHtml(s.id)}"${et?.scheduleId === s.id ? ' selected' : ''}>${escapeHtml(s.name)}${s.isDefault ? ' (default)' : ''}</option>`,
    )
    .join('\n      ')
  return `<label for="scheduleId">Availability schedule</label>
    <select id="scheduleId" name="scheduleId"${describedBy('scheduleId', errors)}>
      <option value=""${et?.scheduleId ? '' : ' selected'}>Default</option>
      ${options}
    </select>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      Which hours this event type draws from. Ignored for a team-owned event.</p>
    ${fieldError('scheduleId', errors)}`
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

/** A short, honest readout — not a redesign; the visual widget itself is the weekly-hours editor. */
function scheduleSummary(s: Schedule): string {
  const activeDays = s.weekly.filter((day) => day.length > 0).length
  if (activeDays === 0) return 'No hours set'
  const totalMinutes = s.weekly.reduce(
    (sum, day) => sum + day.reduce((daySum, w) => daySum + (w.endMinute - w.startMinute), 0),
    0,
  )
  const hours = Math.round(totalMinutes / 6) / 10 // one decimal, e.g. "37.5h"
  return `${activeDays} day${activeDays === 1 ? '' : 's'}/week &middot; ~${hours}h total &middot; ${escapeHtml(s.timezone)}`
}

/**
 * Whose schedules a page is about. Absent = the signed-in user's own. Set
 * when a team admin is on a member's availability page (core/domain/teams.ts):
 * every link and form action then hangs off `basePath` instead of
 * /dashboard/availability, and the page says whose hours these are.
 */
export interface ScheduleScope {
  subject: User
  basePath: string
  team: Team
}

export interface SchedulesPageData extends DashboardChrome {
  schedules: Schedule[]
  scope?: ScheduleScope
  /**
   * Display names for `Schedule.createdBy` ids that are NOT the subject —
   * the "set up by …" badge. An id missing here (creator since deleted)
   * renders as "a team admin".
   */
  creatorNames?: Record<string, string>
  /** Echo of a failed "new schedule" submit. */
  nameValue?: string
  errors?: Record<string, string>
  notice?: string
}

/** "set up by Alice" — for a schedule someone other than its owner created. Empty for the owner's own rows. */
function setUpByBadge(s: Schedule, subjectId: string, creatorNames: Record<string, string> | undefined): string {
  if (!s.createdBy || s.createdBy === subjectId) return ''
  const name = creatorNames?.[s.createdBy]
  return ` <span class="pu-badge" title="A team admin created this schedule on your behalf">set up by ${escapeHtml(name ?? 'a team admin')}</span>`
}

export function schedulesPage(d: SchedulesPageData): string {
  const errors = d.errors ?? {}
  const base = d.scope?.basePath ?? '/dashboard/availability'
  const subject = d.scope?.subject ?? d.user
  const whose = d.scope ? `${escapeHtml(subject.name || subject.slug)}'s` : 'your'
  const cards = d.schedules
    .map((s) => {
      const id = encodeURIComponent(s.id)
      // A schedule that's the default, or the host's only one, has nothing
      // a Delete button could do but fail — hiding it here matches the
      // "only member" precedent on the Teams page rather than offering a
      // control that can only 400. Deleting on a member's behalf is not
      // offered at all: an admin sets availability up, the member decides
      // what of theirs goes away.
      const canDelete = !d.scope && !s.isDefault && d.schedules.length > 1
      return `<article class="pu-card">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap">
    <h2 style="margin:0">${escapeHtml(s.name)}${s.isDefault ? ' <span class="pu-badge">Default</span>' : ''}${setUpByBadge(s, subject.id, d.creatorNames)}</h2>
    <a href="${base}/${id}" class="pu-btn pu-btn-ghost" style="padding:.3rem .6rem;font-size:.8125rem">Edit</a>
  </div>
  <p class="pu-muted" style="font-size:.8125rem;margin:.5rem 0 0">${scheduleSummary(s)}</p>
  ${fieldError(`schedule-${s.id}`, errors)}
  <div style="display:flex;gap:.5rem;margin-top:.75rem;flex-wrap:wrap">
    <form method="post" action="${base}/${id}/duplicate" style="margin:0">
      ${csrfField(d.csrf)}
      <button class="pu-btn pu-btn-ghost" type="submit" style="padding:.3rem .6rem;font-size:.8125rem">Duplicate</button>
    </form>
    ${
      s.isDefault
        ? ''
        : `<form method="post" action="${base}/${id}/set-default" style="margin:0">
      ${csrfField(d.csrf)}
      <button class="pu-btn pu-btn-ghost" type="submit" style="padding:.3rem .6rem;font-size:.8125rem">Set as default</button>
    </form>`
    }
    ${
      canDelete
        ? `<form method="post" action="${base}/${id}/delete" style="margin:0">
      ${csrfField(d.csrf)}
      <button class="pu-btn pu-btn-ghost" type="submit" style="padding:.3rem .6rem;font-size:.8125rem">Delete</button>
    </form>`
        : ''
    }
  </div>
</article>`
    })
    .join('\n')

  const heading = d.scope
    ? `<p><a href="/dashboard/teams" class="pu-muted">&larr; Teams</a></p>
  <h1>${escapeHtml(subject.name || subject.slug)}&rsquo;s availability</h1>
  <p class="pu-muted">You are managing these as an admin of <strong>${escapeHtml(d.scope.team.name)}</strong>.
    ${escapeHtml(subject.name || subject.slug)} sees every schedule here on their own Availability page, marked
    with who set it up, and can change it at any time.</p>`
    : `<h1>Availability</h1>
  <p class="pu-muted">Each of your event types draws its hours from one of these schedules &mdash;
    assign a specific one from the event type's own edit page, or leave it on the default.</p>`

  return (
    shellTop(d, d.scope ? `${subject.name || subject.slug} · Availability` : 'Availability', d.scope ? 'teams' : 'availability') +
    (d.notice ? notice(d.notice) : '') +
    `<section aria-label="Availability schedules">
  ${heading}
  <div style="display:grid;gap:1rem">${cards}</div>
  <form class="pu-card" method="post" action="${base}/new" style="margin-top:1.5rem">
    ${csrfField(d.csrf)}
    <h2>New schedule</h2>
    <label for="schedule-name">Name</label>
    <input id="schedule-name" name="name" required aria-required="true" maxlength="120"
           placeholder="Evenings" value="${escapeHtml(d.nameValue ?? '')}"${describedBy('schedule-name', errors)}>
    ${fieldError('schedule-name', errors)}
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      Starts as a copy of ${whose} default schedule's hours &mdash; edit it after creating.</p>
    <div style="margin-top:1.25rem"><button class="pu-btn" type="submit">Create schedule</button></div>
  </form>
</section>` +
    shellBottom(d.brandName)
  )
}

export interface ScheduleFormData extends DashboardChrome {
  schedule: Schedule
  /** See `SchedulesPageData.scope`. */
  scope?: ScheduleScope
  /** Echo of a failed rename, same reasoning as settingsPage's slugValue. */
  nameValue?: string
  errors?: Record<string, string>
  notice?: string
  /**
   * Raw day-editor state from a round trip — a rejected save, or a no-JS
   * "+ Add range" submit — overrides deriving rows from `schedule.weekly`
   * when present, so the host's in-progress typing (including a freshly
   * added, still-empty range) survives the re-render instead of reverting
   * to whatever was last actually saved.
   */
  weeklyDraft?: WeeklyDayDraft[]
  /**
   * Same reasoning as `weeklyDraft`, for the free-text overrides box: on a
   * "+ Add range" round trip the typed text hasn't been validated yet (that
   * only happens on an actual save), so it's echoed as raw text rather than
   * parsed-then-reformatted — a half-finished line would otherwise silently
   * revert to whatever was last saved, with no error to explain why.
   */
  overridesText?: string
}

export function scheduleForm(d: ScheduleFormData): string {
  const errors = d.errors ?? {}
  const id = encodeURIComponent(d.schedule.id)
  const base = d.scope?.basePath ?? '/dashboard/availability'
  const subjectName = d.scope ? d.scope.subject.name || d.scope.subject.slug : ''
  const banner = d.scope
    ? `<p class="pu-muted" style="margin:0 0 1rem">You are editing <strong>${escapeHtml(subjectName)}</strong>&rsquo;s schedule as an admin of
    ${escapeHtml(d.scope.team.name)}. They can change it at any time.</p>`
    : ''
  const draft = d.weeklyDraft ?? weeklyDraftFromSchedule(d.schedule.weekly)
  const rows = DAY_NAMES.map((name, index) => dayRow(index, name, draft[index]!, errors)).join('\n    ')

  const zones = [...new Set([d.schedule.timezone, ...COMMON_ZONES])]

  return (
    shellTop(d, `${d.schedule.name} · Availability`, d.scope ? 'teams' : 'availability') +
    (d.notice ? notice(d.notice) : '') +
    `<p><a href="${base}" class="pu-muted">&larr; ${d.scope ? `${escapeHtml(subjectName)}&rsquo;s schedules` : 'All schedules'}</a></p>
<section class="pu-card" aria-label="Edit schedule">
  <h1>${escapeHtml(d.schedule.name)}${d.schedule.isDefault ? ' <span class="pu-badge">Default</span>' : ''}</h1>
  ${banner}
  <form method="post" action="${base}/${id}">
    ${csrfField(d.csrf)}
    <!-- Implicit submission (pressing Enter in any field) activates the FIRST
         submit button in tree order — without this, that would be Sunday's
         "+ Add range" button, silently appending an empty row instead of
         saving. formnovalidate matches the real Save button below: every
         field is validated server-side with fieldError output regardless. -->
    <button type="submit" class="pu-sr" tabindex="-1" formnovalidate>Save schedule</button>

    <label for="schedule-name">Name</label>
    <input id="schedule-name" name="name" required aria-required="true" maxlength="120"
           value="${escapeHtml(d.nameValue ?? d.schedule.name)}"${describedBy('schedule-name', errors)}>
    ${fieldError('schedule-name', errors)}

    <label for="timezone" style="margin-top:1rem">Timezone</label>
    <input id="timezone" name="timezone" list="pu-zones" required aria-required="true"
           value="${escapeHtml(d.schedule.timezone)}"${describedBy('timezone', errors)}>
    <datalist id="pu-zones">
      ${zones.map((z) => `<option value="${escapeHtml(z)}"></option>`).join('\n      ')}
    </datalist>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      ${d.scope ? 'The' : 'Your'} weekly hours below are read in this zone, so they follow ${d.scope ? 'the host' : 'you'} through daylight saving.</p>
    ${fieldError('timezone', errors)}

    <h2 style="margin-top:1.5rem">Weekly hours</h2>
    <p class="pu-muted" style="font-size:.8125rem">
      Turn a day on and set one or more ranges — add a second for a lunch break. To drop a range, clear both its times and save.</p>
    <div class="pu-week-editor">${rows}</div>

    <h2 style="margin-top:1.5rem">Date overrides</h2>
    <label for="overrides">Specific dates</label>
    <textarea id="overrides" name="overrides" rows="5" placeholder="2026-12-24"${describedBy('overrides', errors)}>${escapeHtml(d.overridesText ?? formatOverrides(d.schedule.overrides))}</textarea>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      One per line: <code>YYYY-MM-DD 10:00-14:00</code>. A date with no ranges is a day off, and an override
      replaces that day's weekly hours entirely.</p>
    ${fieldError('overrides', errors)}

    <div style="margin-top:1.5rem">
      <!-- formnovalidate: a day switched off after its (hidden, still-invalid)
           time inputs were partially typed would otherwise block submission
           entirely — the browser can't report on a display:none control it
           can't focus. Server-side validation already covers every field. -->
      <button class="pu-btn" type="submit" formnovalidate>Save schedule</button>
    </div>
  </form>
</section>` +
    shellBottom(d.brandName)
  )
}

/** One day's editor state — the switch position and whatever's typed in its range rows, as raw strings. */
export interface DayRangeDraft {
  start: string
  end: string
}
export interface WeeklyDayDraft {
  enabled: boolean
  ranges: DayRangeDraft[]
}

/**
 * A day may hold this many ranges at once (a lunch-break split is 2; this is
 * headroom, not an expected count) — bounds how large "+ Add range" can grow
 * a single day and how many `day-N-start-I`/`day-N-end-I` pairs the route
 * handler will ever read back, regardless of what a crafted POST claims.
 *
 * Must match `rest.ts`'s `dayWindowSchema` array cap (`.max(12)`): a schedule
 * saved with 12 windows on one day via the REST API or MCP is still this
 * user's default schedule, and a lower cap here would silently drop windows
 * 9-12 the moment the host next saves this form from the dashboard.
 */
export const MAX_RANGES_PER_DAY = 12

function weeklyDraftFromSchedule(weekly: WeeklySchedule): WeeklyDayDraft[] {
  return weekly.map((windows) => ({
    enabled: windows.length > 0,
    ranges: windows.map((w) => ({ start: minutesToTimeInput(w.startMinute), end: minutesToTimeInput(w.endMinute) })),
  })) as WeeklyDayDraft[]
}

/**
 * Same mapping as `minutesToTime`, except the end-of-day case: a native
 * `<input type="time">` cannot hold "24:00" (its own valid range tops out at
 * 23:59), so an end minute of 1440 renders as "23:59" here — and
 * `parseWeeklyDraft` below maps that string back to 1440 on the way in, so a
 * window that runs to midnight (settable via the REST API/MCP, which use raw
 * minutes and have no such ceiling) round-trips through the editor exactly,
 * not truncated by a minute.
 *
 * Accepted tradeoff, not an oversight: a host who types exactly "23:59"
 * meaning THAT minute, not midnight, gets 1440 anyway — indistinguishable in
 * the widget's own value space from a schedule that already ended at
 * midnight. Rejected as unfixable within a native time input (which refuses
 * "24:00" outright) and not worth a bespoke midnight checkbox for a value no
 * host has a real reason to pick over a round number or midnight itself.
 */
function minutesToTimeInput(minutes: number): string {
  return minutes >= 24 * 60 ? '23:59' : minutesToTime(minutes)
}

/**
 * One day's switch + its range rows. Always renders at least one range row,
 * even for a day with zero saved windows, so there is always something for
 * "+ Add range" to build from and something for a newly-enabled day to fill
 * in — an enabled day with a genuinely empty row is simply not yet finished,
 * the same state a fresh "day off" toggled on would start from.
 *
 * The switch and the ranges are siblings inside `.pu-day-row`, not nested —
 * `:has()` in styles.ts is what shows/hides the ranges off the checkbox's
 * `:checked` state, and that needs no JavaScript at all to work.
 */
function dayRow(index: number, name: string, day: WeeklyDayDraft, errors: Record<string, string>): string {
  const fid = `day-${index}`
  const ranges = day.ranges.length > 0 ? day.ranges : [{ start: '', end: '' }]
  const canAddMore = day.ranges.length < MAX_RANGES_PER_DAY
  const rangeRows = ranges
    .map(
      (r, i) => `<div class="pu-range-row">
        <input type="time" name="${fid}-start-${i}" value="${escapeHtml(r.start)}" aria-label="${escapeHtml(name)} range ${i + 1} start">
        <span aria-hidden="true">&ndash;</span>
        <input type="time" name="${fid}-end-${i}" value="${escapeHtml(r.end)}" aria-label="${escapeHtml(name)} range ${i + 1} end">
      </div>`,
    )
    .join('\n      ')

  return `<div class="pu-day-row">
    <label class="pu-switch">
      <input type="checkbox" name="${fid}-enabled" class="pu-switch-input"${day.enabled ? ' checked' : ''}>
      <span class="pu-switch-track" aria-hidden="true"><span class="pu-switch-thumb"></span></span>
      <span class="pu-day-name">${escapeHtml(name)}</span>
    </label>
    <div class="pu-day-ranges">
      ${rangeRows}
      ${
        canAddMore
          ? `<button class="pu-btn-plain pu-add-range" type="submit" name="add-range" value="${index}" formnovalidate>+ Add range</button>`
          : ''
      }
      ${fieldError(fid, errors)}
    </div>
  </div>`
}

/**
 * `readWeeklyDraftFromForm`'s output, resolved into real minutes — the write
 * side of the pair above, same "rendered and parsed side by side" reasoning
 * as `formatWindows`/`parseWindows`.
 *
 * A range row where BOTH times are blank is a still-empty "+ Add range" row,
 * not an error — skipped silently. Exactly one of the two blank, or either
 * one unparseable, or the end not after the start, IS an error: rejected
 * rather than repaired, same reasoning as `parseWindows`'s own doc comment —
 * silently dropping a range a host thinks they set would make them believe
 * they are bookable when they are not. A disabled day ignores whatever its
 * rows hold, same as the old format's blank-line-means-day-off.
 */
export function parseWeeklyDraft(draft: WeeklyDayDraft[]): { weekly: WeeklySchedule; errors: Record<string, string> } {
  const weekly = emptyWeekSchedule()
  const errors: Record<string, string> = {}
  for (let day = 0; day < 7; day++) {
    const { enabled, ranges } = draft[day]!
    if (!enabled) continue

    const windows: DayWindow[] = []
    for (const r of ranges) {
      const start = r.start.trim()
      const end = r.end.trim()
      if (start === '' && end === '') continue // an unused row, not a day off

      const startMinute = timeToMinutes(start)
      // "23:59" is the editor's stand-in for "24:00" (see `minutesToTimeInput`).
      const endMinute = end === '23:59' ? 24 * 60 : timeToMinutes(end)
      if (startMinute === null || endMinute === null || endMinute <= startMinute) {
        errors[`day-${day}`] = 'Each range needs a start before its end'
        continue
      }
      // Snap INWARD to the 5-minute bucket grid, same as `parseWindows` —
      // never widens availability beyond what the host set.
      const snappedStart = Math.ceil(startMinute / 5) * 5
      const snappedEnd = Math.floor(endMinute / 5) * 5
      if (snappedEnd <= snappedStart) {
        errors[`day-${day}`] = 'Each range needs a start before its end'
        continue
      }
      windows.push({ startMinute: snappedStart, endMinute: snappedEnd })
    }
    if (!errors[`day-${day}`]) weekly[day] = windows.sort((a, b) => a.startMinute - b.startMinute)
  }
  return { weekly, errors }
}

function emptyWeekSchedule(): WeeklySchedule {
  return [[], [], [], [], [], [], []]
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export interface TeamMemberView {
  member: TeamMember
  /** Null when the user row is gone; the id is then the only label left. */
  user: User | null
}

export interface TeamView {
  team: Team
  members: TeamMemberView[]
  /** Whether the signed-in user manages this team (core/domain/teams.ts): a team admin, or the instance admin. */
  canManage: boolean
  /** True on the instance admin's view of a team they are not on — the card says so, since "why do I see this" is a fair question. */
  viaInstanceAdmin?: boolean
}

export interface TeamsPageData extends DashboardChrome {
  /** Teams the signed-in user belongs to, with their full member lists. */
  teams: TeamView[]
  /** Echo of a failed create, same reasoning as settingsPage's slugValue. */
  nameValue?: string
  slugValue?: string
  /** Echo of a failed add-member submit, scoped to one team's form. */
  addValues?: { teamId: string; email: string; weight: string }
  errors?: Record<string, string>
  notice?: string
}

export function teamsPage(d: TeamsPageData): string {
  const errors = d.errors ?? {}
  const cards =
    d.teams.length === 0
      ? `<p class="pu-muted">No teams yet. A team owns round-robin and collective event types —
       create one below, then pick it as the owner on an event type.</p>`
      : d.teams.map((view) => teamCard(d, view)).join('\n')

  return (
    shellTop(d, 'Teams', 'teams') +
    (d.notice ? notice(d.notice) : '') +
    `<section aria-label="Teams">
  <h1>Teams</h1>
  <p class="pu-muted">A team owns round-robin and collective event types, booked at
    /&lt;team-slug&gt;/&lt;event&gt;. Team admins manage members and the team's event types, and can
    set up each member's availability on their behalf. Deleting a team is not supported here yet.</p>
  <div style="display:grid;gap:1rem">${cards}</div>
  <form class="pu-card" method="post" action="/dashboard/teams" style="margin-top:1.5rem">
    ${csrfField(d.csrf)}
    <h2>Create a team</h2>
    <label for="team-name">Name</label>
    <input id="team-name" name="name" required aria-required="true" maxlength="120"
           value="${escapeHtml(d.nameValue ?? '')}"${describedBy('team-name', errors)}>
    ${fieldError('team-name', errors)}
    <label for="team-slug">URL slug</label>
    <input id="team-slug" name="slug" required aria-required="true" maxlength="40" pattern="[a-z0-9\-]+"
           value="${escapeHtml(d.slugValue ?? '')}"${describedBy('team-slug', errors)}>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      Lowercase letters, numbers and hyphens, 2&ndash;40 characters. It becomes the first part of the
      team's booking links: /&lt;slug&gt;/&lt;event&gt;. You join as its first member and admin.</p>
    ${fieldError('team-slug', errors)}
    <div style="margin-top:1.25rem"><button class="pu-btn" type="submit">Create team</button></div>
  </form>
</section>` +
    shellBottom(d.brandName)
  )
}

function teamCard(d: TeamsPageData, view: TeamView): string {
  const team = view.team
  const teamId = encodeURIComponent(team.id)
  const errors = d.errors ?? {}
  const add = d.addValues?.teamId === team.id ? d.addValues : { teamId: team.id, email: '', weight: '1' }
  const adminCount = view.members.filter((m) => isManagingRole(m.member.role)).length
  const small = 'padding:.3rem .6rem;font-size:.8125rem'

  const rows = view.members
    .map((m) => {
      const label = m.user ? m.user.name || m.user.slug : m.member.userId
      const email = m.user?.email ?? ''
      const uid = encodeURIComponent(m.member.userId)
      const isAdmin = isManagingRole(m.member.role)
      const role = isAdmin ? 'Admin' : 'Member'
      if (!view.canManage) {
        return `<tr>
        <td>${escapeHtml(label)}${email ? `<br><span class="pu-muted" style="font-size:.8125rem">${escapeHtml(email)}</span>` : ''}</td>
        <td>${role}</td>
        <td>${m.member.rrWeight}</td>
        <td></td>
      </tr>`
      }
      // Buttons that can only fail are not offered: the only member gets no
      // Remove, the only admin gets neither Remove nor "Make member". The
      // server refuses both anyway (removeMemberGuarded, setRole), so this
      // is about not lying, same as the admin page's last-admin row.
      const onlyMember = view.members.length <= 1
      const onlyAdmin = isAdmin && adminCount <= 1
      const roleAction = onlyAdmin
        ? '<span class="pu-muted" style="font-size:.8125rem">Only admin</span>'
        : `<form method="post" style="margin:0" action="/dashboard/teams/${teamId}/members/${uid}/role">
            ${csrfField(d.csrf)}
            <input type="hidden" name="role" value="${isAdmin ? 'member' : 'admin'}">
            <button class="pu-btn pu-btn-ghost" type="submit" style="${small}">${isAdmin ? 'Make member' : 'Make admin'}</button>
          </form>`
      const removeAction =
        onlyMember || onlyAdmin
          ? ''
          : `<form method="post" style="margin:0"
            action="/dashboard/teams/${teamId}/members/${uid}/remove">
            ${csrfField(d.csrf)}
            <button class="pu-btn pu-btn-ghost" type="submit" style="${small}">Remove</button>
          </form>`
      return `<tr>
        <td>${escapeHtml(label)}${email ? `<br><span class="pu-muted" style="font-size:.8125rem">${escapeHtml(email)}</span>` : ''}</td>
        <td>${role}</td>
        <td>${m.member.rrWeight}</td>
        <td><div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
          <a class="pu-btn pu-btn-ghost" style="${small}" href="/dashboard/teams/${teamId}/members/${uid}/availability">Availability</a>
          ${roleAction}
          ${removeAction}
        </div></td>
      </tr>`
    })
    .join('\n')

  const addForm = view.canManage
    ? `<form method="post" action="/dashboard/teams/${teamId}/members" style="margin-top:1rem">
    ${csrfField(d.csrf)}
    <div class="pu-grid" style="grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:0 1rem">
      <div>
        <label for="email-${escapeHtml(team.id)}">Add a member by email</label>
        <input id="email-${escapeHtml(team.id)}" name="email" type="email" required aria-required="true"
               inputmode="email" value="${escapeHtml(add.email)}"${describedBy(`email-${team.id}`, errors)}>
        ${fieldError(`email-${team.id}`, errors)}
      </div>
      <div>
        <label for="weight-${escapeHtml(team.id)}">Round-robin weight</label>
        <input id="weight-${escapeHtml(team.id)}" name="weight" type="number" min="1" max="100"
               value="${escapeHtml(add.weight)}"${describedBy(`weight-${team.id}`, errors)}>
        ${fieldError(`weight-${team.id}`, errors)}
      </div>
    </div>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      Anyone with an account on this instance. A higher weight takes a proportionally larger share of
      round-robin bookings. Adding someone already on the team updates their weight.</p>
    <div style="margin-top:.75rem"><button class="pu-btn" type="submit">Add member</button></div>
  </form>`
    : `<p class="pu-muted" style="font-size:.8125rem;margin:1rem 0 0">
    Members, weights and the team's event types are managed by its admins. Your own availability is
    under <a href="/dashboard/availability">Availability</a>.</p>`

  return `<article class="pu-card">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap">
    <h2 style="margin:0">${escapeHtml(team.name)}${view.viaInstanceAdmin ? ' <span class="pu-badge">Instance admin view</span>' : ''}</h2>
    <span class="pu-time pu-muted">/${escapeHtml(team.slug)}</span>
  </div>
  ${fieldError(`members-${team.id}`, errors)}
  <div class="pu-docs-table-wrap"><table style="width:100%">
    <thead><tr><th scope="col" style="text-align:left">Member</th>
      <th scope="col" style="text-align:left">Role</th>
      <th scope="col" style="text-align:left">Weight</th><th scope="col" style="text-align:left"></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${addForm}
</article>`
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
    <input id="new-key" class="pu-url-input" readonly value="${escapeHtml(d.newKey)}" onclick="this.select()">
    ${copyButton(d.newKey)}
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
  /** Same reasoning as `slugValue`, for the profile form's Name field. */
  nameValue?: string
  /** Same reasoning as `slugValue`, for the profile form's Position field. */
  jobTitleValue?: string
  /** Same reasoning as `slugValue`, for the profile form's Company field. */
  companyValue?: string
  /** Same reasoning as `slugValue`, for the profile form's Company link field. */
  companyUrlValue?: string
  errors?: Record<string, string>
  notice?: string
}

export function settingsPage(d: SettingsPageData): string {
  const errors = d.errors ?? {}
  const slugValue = d.slugValue ?? d.user.slug
  const nameValue = d.nameValue ?? d.user.name
  const jobTitleValue = d.jobTitleValue ?? d.user.jobTitle ?? ''
  const companyValue = d.companyValue ?? d.user.company ?? ''
  const companyUrlValue = d.companyUrlValue ?? d.user.companyUrl ?? ''

  return (
    shellTop(d, 'Settings', 'settings') +
    (d.notice ? notice(d.notice) : '') +
    // One panel, one identity: the photo IS part of the profile, and the
    // split cards read as two unrelated features. Photo column left (the
    // file input is visually hidden — the styled label is the whole control,
    // and choosing a file submits immediately, so there is no separate
    // Upload step to explain), fields right.
    `<section class="pu-card" aria-label="Your profile" style="margin-bottom:1.25rem">
  <h1>Settings</h1>
  <h2>Your profile</h2>
  <p class="pu-muted">Shown on your booking page and in confirmation emails.</p>
  <div class="pu-profile">
    <div class="pu-profile-photo">
      ${avatarHtml({ key: d.user.avatarKey, name: d.user.name || d.user.slug, size: 88 })}
      <form method="post" action="/dashboard/settings/avatar" enctype="multipart/form-data">
        ${csrfField(d.csrf)}
        <label class="pu-btn pu-btn-ghost pu-file-btn">Upload photo
          <input type="file" name="avatar" accept="image/png,image/jpeg,image/webp" class="pu-sr"
                 aria-label="Choose a photo" onchange="this.form.submit()"${describedBy('avatar', errors)}>
        </label>
        <noscript><button class="pu-btn" type="submit" style="margin-top:.5rem">Upload</button></noscript>
      </form>
      ${
        d.user.avatarKey
          ? `<form method="post" action="/dashboard/settings/avatar/delete">
        ${csrfField(d.csrf)}
        <button class="pu-btn-plain" type="submit">Remove</button>
      </form>`
          : ''
      }
      <p class="pu-muted" style="font-size:.75rem;margin:0;text-align:center">PNG, JPEG or WebP,<br>up to 5&nbsp;MB</p>
      ${fieldError('avatar', errors)}
    </div>
    <form method="post" action="/dashboard/settings/profile" class="pu-profile-fields">
      ${csrfField(d.csrf)}
      <label for="name">Name</label>
      <input id="name" name="name" required aria-required="true" maxlength="120"
             value="${escapeHtml(nameValue)}"${describedBy('name', errors)}>
      ${fieldError('name', errors)}
      <label for="job_title">Position</label>
      <input id="job_title" name="job_title" maxlength="120" placeholder="Optional"
             value="${escapeHtml(jobTitleValue)}"${describedBy('job_title', errors)}>
      ${fieldError('job_title', errors)}
      <label for="company">Company</label>
      <input id="company" name="company" maxlength="120" placeholder="Optional"
             value="${escapeHtml(companyValue)}"${describedBy('company', errors)}>
      ${fieldError('company', errors)}
      <label for="company_url">Company link</label>
      <input id="company_url" name="company_url" type="url" maxlength="200" placeholder="https://… (optional)"
             value="${escapeHtml(companyUrlValue)}"${describedBy('company_url', errors)}>
      <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">Wraps the company name on your booking page.</p>
      ${fieldError('company_url', errors)}
      <div style="margin-top:1.25rem"><button class="pu-btn" type="submit">Save profile</button></div>
    </form>
  </div>
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
    shellFoot()
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
    shellFoot()
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

export { slugify }

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminPageData extends DashboardChrome {
  /** Every user on the instance, oldest first. */
  allUsers: User[]
  /**
   * The signup policy as stored/effective, in SIGNUPS env syntax
   * ('open' | 'closed' | comma list), plus whether the env var pins it —
   * a pinned policy renders read-only, because silently out-ranking an
   * operator's wrangler config from a web form is how two people each
   * believe they control the same setting.
   */
  signups: { value: string; pinnedByEnv: boolean }
  errors?: Record<string, string>
  notice?: string
}

export function adminPage(d: AdminPageData): string {
  const errors = d.errors ?? {}
  const parsedMode = d.signups.value === 'closed' ? 'closed' : d.signups.value === 'open' || d.signups.value === '' ? 'open' : 'allowlist'
  const allowlistValue = parsedMode === 'allowlist' ? d.signups.value : ''

  const admins = d.allUsers.filter((u) => u.role === 'admin').length
  const rows = d.allUsers
    .map((u) => {
      const isSelf = u.id === d.user.id
      const lastAdmin = u.role === 'admin' && admins <= 1
      // The last admin gets no demote button at all — the server enforces it
      // too, but offering a button that can only fail is UI lying.
      const action = lastAdmin
        ? '<span class="pu-muted">Last admin</span>'
        : `<form method="post" action="/dashboard/admin/users/${encodeURIComponent(u.id)}/role" style="margin:0">
            ${csrfField(d.csrf)}
            <input type="hidden" name="role" value="${u.role === 'admin' ? 'member' : 'admin'}">
            <button class="pu-btn pu-btn-ghost" type="submit" style="padding:.3rem .6rem;font-size:.8125rem">
              ${u.role === 'admin' ? 'Remove admin' : 'Make admin'}</button>
          </form>`
      return `<tr>
        <td>${escapeHtml(u.name || u.slug)}${isSelf ? ' <span class="pu-muted">(you)</span>' : ''}<br>
          <span class="pu-muted" style="font-size:.8125rem">${escapeHtml(u.email)}</span></td>
        <td class="pu-time">/${escapeHtml(u.slug)}</td>
        <td>${u.role === 'admin' ? '<span class="pu-badge">Admin</span>' : '<span class="pu-muted">Member</span>'}</td>
        <td>${action}</td>
      </tr>`
    })
    .join('\n')

  const signupsBody = d.signups.pinnedByEnv
    ? `<p class="pu-muted">Pinned to <code>${escapeHtml(d.signups.value)}</code> by the <code>SIGNUPS</code>
        variable on this deployment. Remove that variable to manage sign-ups from here.</p>`
    : `<form method="post" action="/dashboard/admin/signups">
    ${csrfField(d.csrf)}
    <label style="display:flex;align-items:baseline;gap:.5rem;font-weight:400;margin:.5rem 0 0">
      <input type="radio" name="mode" value="open"${parsedMode === 'open' ? ' checked' : ''} style="width:auto">
      <span><strong>Open</strong> — anyone who reaches the sign-in page can create an account</span>
    </label>
    <label style="display:flex;align-items:baseline;gap:.5rem;font-weight:400;margin:.5rem 0 0">
      <input type="radio" name="mode" value="closed"${parsedMode === 'closed' ? ' checked' : ''} style="width:auto">
      <span><strong>Closed</strong> — existing users only; nobody new can register</span>
    </label>
    <label style="display:flex;align-items:baseline;gap:.5rem;font-weight:400;margin:.5rem 0 0">
      <input type="radio" name="mode" value="allowlist"${parsedMode === 'allowlist' ? ' checked' : ''} style="width:auto">
      <span><strong>Allowlist</strong> — only these emails and <code>@domains</code>:</span>
    </label>
    <input name="allowlist" value="${escapeHtml(allowlistValue)}" placeholder="jo@acme.com, @acme.com"
           style="margin-top:.5rem"${describedBy('allowlist', errors)}>
    ${fieldError('allowlist', errors)}
    <div style="margin-top:1.25rem"><button class="pu-btn" type="submit">Save sign-up policy</button></div>
  </form>`

  return (
    shellTop(d, 'Admin', 'admin') +
    (d.notice ? notice(d.notice) : '') +
    `<section class="pu-card" aria-label="Sign-ups" style="margin-bottom:1.25rem">
  <h1>Admin</h1>
  <h2>Sign-ups</h2>
  <p class="pu-muted">Who may create an account on this instance. Existing users always sign in.</p>
  ${signupsBody}
</section>
<section class="pu-card" aria-label="Users">
  <h2>Users</h2>
  ${fieldError('role', errors)}
  <div class="pu-docs-table-wrap"><table style="width:100%">
    <thead><tr><th scope="col" style="text-align:left">User</th><th scope="col" style="text-align:left">Booking page</th>
      <th scope="col" style="text-align:left">Role</th><th scope="col" style="text-align:left"></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>` +
    shellBottom(d.brandName)
  )
}
