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
  EventTypeHost,
  LogoShape,
  EventTypeQuestion,
  Schedule,
  Slot,
  Team,
  TeamMember,
  User,
  WeeklySchedule,
} from '../../core/domain/types.js'
import type { BookingListView, CalendarProviderName } from '../../ports.js'
import type { HostChangeFailure } from '../../core/domain/booking-hosts.js'
import { slotStateClassName } from '../../core/slot-state.js'
import { slugify } from '../../core/domain/booking-service.js'
import { formatInZone, localDateString, offsetLabel } from '../../core/time/zone.js'
import type { ResolvedHost } from '../../core/domain/hosts.js'
import { avatarHtml, escapeHtml, hostsSentence, joinNames, logoHtml, shellFoot, shellHead } from './booking.js'

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/** Form field carrying the double-submit token. Routes read the same name. */
export const CSRF_FIELD = 'csrf'

export type NavKey = 'events' | 'bookings' | 'availability' | 'teams' | 'connections' | 'keys' | 'settings' | 'admin'

const NAV: ReadonlyArray<{ key: NavKey; href: string; label: string }> = [
  { key: 'events', href: '/dashboard', label: 'Event types' },
  { key: 'bookings', href: '/dashboard/bookings', label: 'Bookings' },
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
    `<header class="pu-dash-header">
  <a class="pu-mark" href="/dashboard">${escapeHtml(chrome.brandName.toLowerCase())}<span>:</span></a>
  <nav class="pu-nav" aria-label="Dashboard">
      ${links}
  </nav>
  <form class="pu-dash-signout" method="post" action="/logout">
    ${csrfField(chrome.csrf)}
    <button class="pu-btn pu-btn-ghost" type="submit" style="padding:.4rem .8rem;font-size:.875rem">Sign out</button>
  </form>
</header>
<p class="pu-sr">Signed in as ${escapeHtml(chrome.user.email)}</p>` +
    emailWarningBanner(chrome) +
    blankNameNotice(chrome, active)
  )
}

/**
 * A host with no name is "?" on their booking page and an empty line in
 * every confirmation. Settings makes the field required, but an account
 * created by magic link never visited Settings — so the nudge rides the
 * chrome. Not on Settings itself: the form there already says it.
 */
function blankNameNotice(chrome: DashboardChrome, active: NavKey | null): string {
  if (chrome.user.name.trim() !== '' || active === 'settings') return ''
  return `<p class="pu-notice">Add your name so guests know who they are booking with &mdash;
  <a href="/dashboard/settings">Settings</a></p>`
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

/** A status strip. Not an error — errors use `.pu-err` — and not a success badge either. */
function notice(message: string): string {
  return `<p class="pu-notice" role="status">${escapeHtml(message)}</p>`
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
  /**
   * True when anyone may create an account here. The page then says so:
   * a magic link is sign-in and sign-up at once, and a stranger reading
   * "Sign in" alone goes looking for a register button that does not exist.
   * States the instance's policy, never anything about a given address.
   */
  signupsOpen?: boolean
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
 *
 * The one script on the page fills a hidden `tz` field from the browser's
 * own zone, so a new account's default hours are 09:00–17:00 where the host
 * actually is instead of UTC. It is an enhancement, not a dependency: with
 * script off the field submits empty and the flow falls back exactly as
 * before.
 */
export function loginPage(d: LoginPageData): string {
  const buttons = d.providers
    .map(
      (p) =>
        `<a class="pu-btn pu-btn-ghost" style="display:block;margin-top:.5rem"
       href="/auth/${p}/start?purpose=identity">Continue with ${escapeHtml(providerLabel(p))}</a>`,
    )
    .join('\n    ')

  const mark = `<a class="pu-mark" href="/" style="display:inline-block;margin-bottom:1rem">${escapeHtml(d.brandName.toLowerCase())}<span>:</span></a>`
  const body = d.sent
    ? `${mark}
  <h1>Check your inbox</h1>
  <p class="pu-muted">If that address can sign in, a link is on its way. It works once and expires in 15 minutes.</p>
  <p style="margin-top:1.25rem"><a class="pu-btn pu-btn-ghost" href="/login">Back to sign in</a></p>`
    : `${mark}
  <h1>${d.signupsOpen ? 'Sign in or create an account' : 'Sign in'}</h1>
  <p class="pu-muted">${
    d.signupsOpen
      ? 'No password. Enter your email and we send a link that works once &mdash; the same link creates your account if you are new.'
      : 'No password. We email you a link that works once.'
  }</p>
  <form method="post" action="/login">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required aria-required="true" autocomplete="email"
           inputmode="email" value="${escapeHtml(d.email ?? '')}"${describedBy('email', d.error ? { email: d.error } : {})}>
    ${d.error ? `<p class="pu-err" id="err-email">${escapeHtml(d.error)}</p>` : ''}
    <input type="hidden" name="tz" id="login-tz" value="">
    <script>try{document.getElementById('login-tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}</script>
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
  /**
   * Inputs to the first-run checklist, which only renders while there are
   * no event types. Required rather than optional for the same reason as
   * `emailDelivery`: a route that forgets them would silently render every
   * step as "to do" for a host who has already done them.
   */
  hasCalendarConnection: boolean
  /** The host's default schedule — null only if the login backfill has not run yet. */
  defaultSchedule: Schedule | null
}

export function dashboardHome(d: DashboardHomeData): string {
  const events =
    d.eventTypes.length === 0
      ? setupChecklist(d)
      : d.eventTypes.map((item) => eventTypeCard(d, item)).join('\n')

  const upcoming =
    d.upcomingBookings.length === 0
      ? `<p class="pu-muted">Nothing booked yet.</p>`
      : `<ul class="pu-upcoming" style="list-style:none;padding:0;margin:0;display:grid;gap:.75rem">
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
    <div class="pu-card-title">
      <h2>Upcoming</h2>
      <a class="pu-card-title-action" href="/dashboard/bookings">See all</a>
    </div>
    <p class="pu-muted" style="font-size:.8125rem">Times in ${escapeHtml(d.user.tz)} (${escapeHtml(offsetLabel(Date.now(), d.user.tz))})</p>
    ${upcoming}
  </section>
</div>` +
    shellBottom(d.brandName)
  )
}

/**
 * The empty home: a checklist instead of a "nothing here" line.
 *
 * A muted "No event types yet" told a new host what was missing but not
 * what to do first, and the two things that silently make a booking page
 * wrong — hours read in the wrong timezone, no calendar checked for
 * conflicts — live on other tabs they had no reason to visit. Each step is
 * a link to the page that completes it; the ring/dot marks are the product's
 * own slot vocabulary (open ring = still to do, filled dot = done).
 *
 * "Check your hours" counts as done once the default schedule is in any
 * timezone but UTC: UTC is what the backfill falls back to when nothing told
 * it where the host is, so anything else means someone actually chose it.
 */
function setupChecklist(d: DashboardHomeData): string {
  const schedule = d.defaultSchedule
  const steps: Array<{ href: string; label: string; detail: string; done: boolean }> = [
    {
      href: '/dashboard/settings',
      label: 'Add your name',
      detail: 'Guests see it on your booking page and in every email.',
      done: d.user.name.trim().length > 0,
    },
    {
      href: '/dashboard/connections',
      label: 'Connect a calendar',
      detail: 'So busy time is never offered, and bookings land where you look.',
      done: d.hasCalendarConnection,
    },
    {
      href: schedule ? `/dashboard/availability/${encodeURIComponent(schedule.id)}` : '/dashboard/availability',
      label: 'Check your hours',
      detail: schedule ? `Currently ${hoursSummary(schedule)}.` : 'Set the hours guests may book.',
      done: schedule !== null && schedule.timezone !== 'UTC',
    },
    {
      href: '/dashboard/event-types/new',
      label: 'Create an event type',
      detail: 'Your booking page goes live with the first one.',
      done: false,
    },
  ]
  const items = steps
    .map(
      (s) => `<li class="pu-setup-step${s.done ? ' pu-setup-done' : ''}">
        <span class="pu-setup-mark" aria-hidden="true"></span>
        <div><a href="${escapeHtml(s.href)}">${escapeHtml(s.label)}</a><span class="pu-sr">${s.done ? ' — done' : ' — to do'}</span><br>
          <span class="pu-muted" style="font-size:.8125rem">${escapeHtml(s.detail)}</span></div>
      </li>`,
    )
    .join('\n      ')
  return `<section class="pu-card" aria-labelledby="setup-title">
  <h2 id="setup-title" style="margin-top:0">Get set up</h2>
  <p class="pu-muted">Four steps and your booking page is live.</p>
  <ol class="pu-setup-steps">
      ${items}
  </ol>
  <a class="pu-btn" href="/dashboard/event-types/new">Create an event type</a>
</section>`
}

const DAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * "Mon–Fri 09:00–17:00 UTC" for the checklist. The timezone is the point of
 * the line — a host reading their own hours next to a zone they never chose
 * is what sends them to fix it — so it is always stated, even when the days
 * and times are too irregular to compress into one range.
 */
function hoursSummary(s: Schedule): string {
  const active = s.weekly.map((windows, day) => ({ day, windows })).filter((x) => x.windows.length > 0)
  if (active.length === 0) return `no hours set, ${s.timezone}`
  const first = active[0]!.windows[0]!
  const uniform = active.every(
    (x) => x.windows.length === 1 && x.windows[0]!.startMinute === first.startMinute && x.windows[0]!.endMinute === first.endMinute,
  )
  const contiguous = active.every((x, i) => i === 0 || x.day === active[i - 1]!.day + 1)
  const days =
    active.length === 1
      ? DAY_ABBREVIATIONS[active[0]!.day]!
      : contiguous
        ? `${DAY_ABBREVIATIONS[active[0]!.day]}–${DAY_ABBREVIATIONS[active[active.length - 1]!.day]}`
        : active.map((x) => DAY_ABBREVIATIONS[x.day]).join(', ')
  const times = uniform ? ` ${minutesToTime(first.startMinute)}–${minutesToTime(first.endMinute)}` : ''
  return `${days}${times} ${s.timezone}`
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
  const logo = et.logoKey ? logoHtml({ key: et.logoKey, shape: et.logoShape, name: et.title, size: 28 }) : ''
  const url = `${trimSlash(d.baseUrl)}/${encodeURIComponent(item.ownerSlug)}/${encodeURIComponent(et.slug)}`
  const inputId = `url-${escapeHtml(et.id)}`
  // Edit and Preview sit in the header beside the badges, and the link row
  // has no visible caption: a list of ten event types is scanned, not read,
  // and a card three rows tall keeps the whole list on one screen.
  const edit =
    item.canEdit === false
      ? '<span class="pu-muted" style="font-size:.8125rem">Managed by the team&rsquo;s admins</span>'
      : `<a class="pu-btn pu-btn-ghost" href="/dashboard/event-types/${encodeURIComponent(et.id)}">Edit</a>`
  return `<article class="pu-card pu-et-card">
  <div class="pu-et-head">
    <h2 style="display:flex;align-items:center;gap:.5rem">${logo}${escapeHtml(et.title)}</h2>
    <div class="pu-et-actions">
      ${item.teamName ? `<span class="pu-badge">${escapeHtml(item.teamName)}</span>` : ''}
      ${et.active ? '' : '<span class="pu-badge" style="background:var(--pu-paper-dim);color:var(--pu-ink-500)">Hidden</span>'}
      ${edit}
      <a class="pu-btn pu-btn-ghost" href="${escapeHtml(url)}">Preview</a>
    </div>
  </div>
  <ul class="pu-meta pu-et-meta">
    <li>${et.durationMinutes} min</li>
    <li>${escapeHtml(schedulingLabel(et))}</li>
    <li>${escapeHtml(locationLabel(et))}</li>
  </ul>
  <div class="pu-url pu-et-url">
    <input id="${inputId}" class="pu-url-input" readonly value="${escapeHtml(url)}" onclick="this.select()"
           aria-label="Public link for ${escapeHtml(et.title)}">
    ${copyButton(url)}
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
  // The whole row is the link: a host scanning the list taps the row, not
  // a word inside it. The booking page is where cancel/reschedule live.
  return `<li style="border-bottom:1px solid var(--pu-line);padding-bottom:.75rem">
        <a class="pu-booking-link" href="/dashboard/bookings/${encodeURIComponent(u.booking.id)}">
        <strong class="pu-time">${escapeHtml(when)}</strong><br>
        ${escapeHtml(u.eventTitle)} — ${escapeHtml(u.booking.guestName)}
        <span class="pu-muted">(${escapeHtml(u.booking.guestEmail)})</span></a>
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
  /**
   * The owning team's members, as host choices — rendered only when the
   * event type is team-owned and saved (a create lands on the edit page so
   * the block has a team to list). See `hostsFields`.
   */
  hostChoices?: HostChoice[]
  /** Set after a create redirected here: the page says what to do next. */
  notice?: string
  errors?: Record<string, string>
}

/** One team member as a possible host of the event type being edited. */
export interface HostChoice {
  user: User
  /** The member's own schedules, for the per-event schedule select — an admin sees their names (core/domain/teams.ts). */
  schedules: Schedule[]
  /** The stored row, or null when the event type has no explicit set (then every member is a required host on their default). */
  row: EventTypeHost | null
  /** Whether this member hosts the event type as things stand. */
  selected: boolean
  /** Weight from the team, shown as the placeholder for a per-event override. */
  teamWeight: number
  /**
   * What the admin has on the form, unsaved — set on a re-render round trip
   * (move up/down, select all/none) and shown in place of `row`/`selected`,
   * so a reorder does not revert the attendance and schedules typed above it.
   */
  draft?: HostDraft
}

/** The Hosts block as submitted, echoed verbatim on a round trip that does not save. */
export interface HostDraft {
  selected: boolean
  required: boolean
  scheduleId: string | null
  /** The weight as typed: a round trip is a preview, not a save, so a half-typed value is not validated yet. */
  weightText: string
}

const LOCATION_OPTIONS: ReadonlyArray<{ value: EventType['locationType']; label: string }> = [
  { value: 'google_meet', label: 'Google Meet' },
  { value: 'custom_link', label: 'Custom link' },
  { value: 'phone', label: 'Phone call' },
  { value: 'in_person', label: 'In person' },
]

/**
 * Inputs in the order they appear on the page, so the first errored one can
 * take `autofocus` — a host who submits from the bottom of a long form and
 * lands back at the top otherwise has to hunt for what went wrong. `hosts`
 * is absent on purpose: its error belongs to a block, not to one control.
 */
const EVENT_TYPE_FIELD_ORDER: readonly string[] = [
  'title',
  'slug',
  'description',
  'owner',
  'schedulingType',
  'scheduleId',
  'durationMinutes',
  'slotIntervalMinutes',
  'bufferBeforeMinutes',
  'bufferAfterMinutes',
  'minNoticeMinutes',
  'maxHorizonDays',
  'maxPerDay',
  'locationType',
  'locationValue',
  'questions',
]

function autofocusAttr(id: string, errors: Record<string, string>): string {
  return EVENT_TYPE_FIELD_ORDER.find((f) => errors[f] !== undefined) === id ? ' autofocus' : ''
}

/** Everything the notice at the top of the form counts. The delete form has its own message. */
function formErrorCount(errors: Record<string, string>): number {
  return Object.keys(errors).filter((k) => k !== 'delete').length
}

/**
 * An image with Upload and Remove, the profile photo's pattern reused for
 * an event type's or a team's logo: one control that submits on change,
 * a real button without scripts, Remove only when there is something to
 * remove. Lives OUTSIDE any other form (nested forms are not HTML).
 */
function logoPanel(o: { csrf: string; action: string; key: string | null; shape?: LogoShape | null; name: string; errorKey: string; errors: Record<string, string>; hint: string }): string {
  const shape: LogoShape = o.shape ?? 'circle'
  // Only offered once there is a logo to shape. Radios submit on change,
  // with a real button without scripts; the route re-renders the page.
  const shapeForm = o.key
    ? `<form method="post" action="${escapeHtml(o.action)}-shape" class="pu-logo-shape" style="margin:.5rem 0 0">
          ${csrfField(o.csrf)}
          <span class="pu-muted" style="font-size:.8125rem">Shown as</span>
          <label style="display:inline-flex;align-items:center;gap:.3rem;margin:0 .75rem 0 .5rem;font-weight:400"><input type="radio" name="shape" value="circle"${shape === 'circle' ? ' checked' : ''} onchange="this.form.submit()"> a circle</label>
          <label style="display:inline-flex;align-items:center;gap:.3rem;margin:0;font-weight:400"><input type="radio" name="shape" value="natural"${shape === 'natural' ? ' checked' : ''} onchange="this.form.submit()"> its own proportions</label>
          <noscript><button class="pu-btn pu-btn-ghost" type="submit" style="margin-left:.5rem;padding:.2rem .5rem;font-size:.8125rem">Apply</button></noscript>
        </form>`
    : ''
  return `<div class="pu-profile-photo pu-logo-panel">
      ${logoHtml({ key: o.key, shape, name: o.name, size: 72 })}
      <div>
        <form method="post" action="${escapeHtml(o.action)}" enctype="multipart/form-data" style="margin:0">
          ${csrfField(o.csrf)}
          <label class="pu-btn pu-btn-ghost pu-file-btn">${o.key ? 'Replace logo' : 'Upload logo'}
            <input type="file" name="logo" accept="image/png,image/jpeg,image/webp" class="pu-sr"
                   aria-label="Choose a logo" onchange="this.form.submit()"${describedBy(o.errorKey, o.errors)}>
          </label>
          <noscript><button class="pu-btn" type="submit" style="margin-top:.5rem">Upload</button></noscript>
        </form>
        ${
          o.key
            ? `<form method="post" action="${escapeHtml(o.action)}/delete" style="margin:.35rem 0 0">
          ${csrfField(o.csrf)}
          <button class="pu-btn-plain" type="submit">Remove</button>
        </form>`
            : ''
        }
        ${shapeForm}
        <p class="pu-muted" style="font-size:.8125rem;margin:.35rem 0 0">${o.hint} PNG, JPEG or WebP, up to 5 MB.</p>
        ${fieldError(o.errorKey, o.errors)}
      </div>
    </div>`
}

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

  // The address a guest will actually use: the OWNER's slug first, and the
  // owner is the team when there is one. The user's own slug there would
  // print a link that 404s for every team-owned event type.
  const ownerTeam = teams.find((t) => t.id === et?.ownerTeamId)
  const prefix = ownerTeam ? ownerTeam.slug : d.user.slug
  // A slug that failed validation is not previewed as an address: the error
  // right above already quotes it, and "/support/Bad Slug!" reads as a claim.
  const slugPreview = et?.slug && /^[a-z0-9-]+$/.test(et.slug) ? escapeHtml(et.slug) : '&lt;slug&gt;'

  const errorCount = formErrorCount(errors)
  const errorNotice =
    errorCount === 0
      ? ''
      : `<div class="pu-callout pu-form-errors" role="alert">Fix the ${
          errorCount === 1 ? 'field' : `${errorCount} fields`
        } marked below.</div>`

  const numberField = (
    id: string,
    label: string,
    help: string,
    attrs: string,
    value: string,
  ): string => `<div>
        <label for="${id}">${label}</label>
        <input id="${id}" name="${id}" type="number" ${attrs}
               value="${escapeHtml(value)}"${describedBy(id, errors)}${autofocusAttr(id, errors)}>
        ${fieldError(id, errors)}
        <p class="pu-help">${help}</p>
      </div>`

  // Owner, scheduling, hosts and the personal schedule are each rendered only
  // when there is something to choose; a host with no team and one default
  // schedule gets no "Who hosts" group at all rather than an empty one.
  const whoHosts = [ownershipFields(d, teams, errors), hostsFields(d, errors), scheduleField(d, errors)]
    .join('\n    ')
    .trim()

  return (
    shellTop(d, editing ? 'Edit event type' : 'New event type', 'events') +
    (d.notice ? notice(d.notice) : '') +
    `<section class="pu-card" aria-label="${editing ? 'Edit event type' : 'New event type'}">
  <h1>${editing ? 'Edit event type' : 'New event type'}</h1>
  ${editing ? logoPanel({ csrf: d.csrf, action: `/dashboard/event-types/${encodeURIComponent(et!.id)}/logo`, key: et!.logoKey ?? null, shape: et!.logoShape ?? null, name: et!.title, errorKey: 'logo', errors, hint: "Heads this event type's booking page and social card instead of your photo or the team's logo. Square works best." }) : ''}
  <form method="post" action="${escapeHtml(action)}" class="pu-et-form">
    ${csrfField(d.csrf)}
    ${errorNotice}

    <fieldset class="pu-fs">
      <legend>Basics</legend>
      <label for="title">Title</label>
      <input id="title" name="title" required aria-required="true" maxlength="120" placeholder="30 min intro call"
             value="${escapeHtml(et?.title ?? '')}"${describedBy('title', errors)}${autofocusAttr('title', errors)}>
      ${fieldError('title', errors)}

      <label for="slug">URL slug</label>
      <input id="slug" name="slug" maxlength="60" pattern="[a-z0-9\-]+"
             value="${escapeHtml(et?.slug ?? '')}"${describedBy('slug', errors)}${autofocusAttr('slug', errors)}>
      ${fieldError('slug', errors)}
      <p class="pu-help">Booked at <code>/${escapeHtml(prefix)}/${slugPreview}</code>.
        Leave blank to use the title. Lowercase letters, numbers and hyphens.</p>

      <label for="description">Description</label>
      <textarea id="description" name="description" maxlength="2000"${describedBy('description', errors)}${autofocusAttr('description', errors)}>${escapeHtml(et?.description ?? '')}</textarea>
      ${fieldError('description', errors)}
    </fieldset>
${
  whoHosts === ''
    ? ''
    : `
    <fieldset class="pu-fs">
      <legend>Who hosts</legend>
      ${whoHosts}
    </fieldset>
`
}
    <fieldset class="pu-fs">
      <legend>When and how long</legend>
      <div class="pu-num-grid">
      ${numberField(
        'durationMinutes',
        'Duration (minutes)',
        'A multiple of 5.',
        'min="5" max="1440" step="5" required aria-required="true"',
        num(et?.durationMinutes, '30'),
      )}
      ${numberField(
        'slotIntervalMinutes',
        'Slot interval (minutes)',
        'Blank means one slot per duration.',
        'min="5" max="1440" step="5"',
        num(et?.slotIntervalMinutes, ''),
      )}
      ${numberField(
        'bufferBeforeMinutes',
        'Buffer before (minutes)',
        'Kept free before each booking.',
        'min="0" max="240" step="5"',
        num(et?.bufferBeforeMinutes, '0'),
      )}
      ${numberField(
        'bufferAfterMinutes',
        'Buffer after (minutes)',
        'Kept free after each booking.',
        'min="0" max="240" step="5"',
        num(et?.bufferAfterMinutes, '0'),
      )}
      ${numberField(
        'minNoticeMinutes',
        'Minimum notice (minutes, e.g. 1440 = 1 day)',
        'The earliest a guest can book from now.',
        'min="0" max="43200" step="5"',
        num(et?.minNoticeMinutes, '60'),
      )}
      ${numberField(
        'maxHorizonDays',
        'Bookable up to (days ahead)',
        'How far ahead a guest can book.',
        'min="1" max="730"',
        num(et?.maxHorizonDays, '60'),
      )}
      ${numberField(
        'maxPerDay',
        'Maximum per day',
        'Blank means unlimited. Counted per host-local day.',
        'min="1" max="100"',
        num(et?.maxPerDay, ''),
      )}
      </div>
    </fieldset>

    <fieldset class="pu-fs">
      <legend>Where</legend>
      <label for="locationType">Location</label>
      <select id="locationType" name="locationType"${describedBy('locationType', errors)}${autofocusAttr('locationType', errors)}>
        ${LOCATION_OPTIONS.map(
          (o) =>
            `<option value="${o.value}"${(et?.locationType ?? 'google_meet') === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
        ).join('\n        ')}
      </select>
      ${fieldError('locationType', errors)}

      <div class="pu-loc-wrap">
        <label for="locationValue">Location details</label>
        <input id="locationValue" name="locationValue" maxlength="500"
               value="${escapeHtml(et?.locationValue ?? '')}"${describedBy('locationValue', errors)}${autofocusAttr('locationValue', errors)}>
        ${fieldError('locationValue', errors)}
        <p class="pu-help">The meeting URL, phone number or address. Google Meet mints its own link.</p>
      </div>
    </fieldset>

    <fieldset class="pu-fs">
      <legend>Questions</legend>
      <label for="questions">Custom questions</label>
      <textarea id="questions" name="questions" rows="5"${describedBy('questions', errors)}${autofocusAttr('questions', errors)}
                placeholder="Company | text | required&#10;Topic | select | optional | Sales, Support">${escapeHtml(d.questionsText ?? formatQuestions(et?.questions ?? []))}</textarea>
      ${fieldError('questions', errors)}
      <p class="pu-help">One question per line &mdash; label, type, required?, options. Example above.
        Name and email are always asked and are not listed here.</p>
    </fieldset>

    <label for="active" style="display:flex;align-items:center;gap:.5rem;margin-top:1.25rem">
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
 * offer. No client JS: the scheduling column is hidden by a stylesheet rule
 * keyed on the owner select's checked option (`.pu-sched-wrap`), and the
 * SERVER remains the source of truth — with owner "me" the scheduling value
 * is ignored and forced to 'personal' (readEventTypeForm), so a stale or
 * crafted scheduling value cannot make a personal event round-robin.
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
        <select id="owner" name="owner"${describedBy('owner', errors)}${autofocusAttr('owner', errors)}>
      <option value=""${et?.ownerTeamId ? '' : ' selected'}>Me (personal)</option>
      ${teamOptions}
    </select>
        ${fieldError('owner', errors)}
      </div>
      <div class="pu-sched-wrap">
        <label for="schedulingType">Scheduling</label>
        <select id="schedulingType" name="schedulingType"${describedBy('schedulingType', errors)}${autofocusAttr('schedulingType', errors)}>
      <option value="round_robin"${et?.schedulingType === 'collective' ? '' : ' selected'}>Round robin</option>
      <option value="collective"${et?.schedulingType === 'collective' ? ' selected' : ''}>Collective</option>
    </select>
        ${fieldError('schedulingType', errors)}
        <p class="pu-help">Round robin: one host takes each booking. Collective: every host attends.</p>
      </div>
    </div>`
}

/**
 * The hosts of a team-owned event type: who, in what order, required or
 * optional (collective) or weighted (round-robin), and which of THEIR
 * schedules this event type draws from. Server-rendered checkboxes and
 * selects, no client JS; the route reads the whole block back and replaces
 * the set atomically.
 *
 * One `.pu-host-row` grid per host rather than a table: a table's columns
 * cannot stack, and on a phone three columns of controls squeeze each to a
 * few characters. The stylesheet collapses the row to one column under
 * 640px; the field names are the contract with `readHostsForm` and stay put.
 *
 * Ordering, select all/none: `formnovalidate` submit buttons the route
 * answers with a re-render of the same form, unsaved — the no-JS round trip
 * the schedule editor's "+ Add range" established. The rendered order IS
 * the stored order on save, so the rows carry no position field.
 *
 * Rendered only with `hostChoices` — an edit of a team-owned event type. A
 * create has no saved team to list yet, so it lands on the edit page.
 */
function hostsFields(d: EventTypeFormData, errors: Record<string, string>): string {
  const choices = d.hostChoices
  const et = d.eventType
  if (!et || !choices || choices.length === 0) return fieldError('hosts', errors)
  const collective = et.schedulingType === 'collective'
  const explicit = choices.some((c) => c.row !== null)
  const views = choices.map(hostView)
  const ticked = views.filter((v) => v.selected)
  const weightTotal = ticked.reduce((sum, v) => sum + v.weight, 0)

  const rows = views
    .map((v, i) => {
      const c = v.choice
      const uid = escapeHtml(c.user.id)
      const name = c.user.name || c.user.slug
      const scheduleOptions = c.schedules
        .map(
          (sch) =>
            `<option value="${escapeHtml(sch.id)}"${v.scheduleId === sch.id ? ' selected' : ''}>${escapeHtml(sch.name)}${sch.isDefault ? ' (default)' : ''}</option>`,
        )
        .join('')
      // The share is of the ticked hosts only: an unticked row takes none,
      // and saying "25%" beside it would promise a booking it never gets.
      const share =
        !collective && v.selected && weightTotal > 0
          ? `<span class="pu-host-share">&asymp; ${Math.round((v.weight / weightTotal) * 100)}%</span>`
          : ''
      const mode = collective
        ? `<select name="host-${uid}-mode" aria-label="${escapeHtml(name)}: required or optional">
            <option value="required"${v.required ? ' selected' : ''}>Required</option>
            <option value="optional"${v.required ? '' : ' selected'}>Optional</option>
          </select>`
        : `<span class="pu-host-weight"><input name="host-${uid}-weight" type="number" min="1" max="100" aria-label="${escapeHtml(name)}: round-robin weight"
                 value="${escapeHtml(v.weightText)}" placeholder="${c.teamWeight}">${share}</span>`
      // The first row cannot go up nor the last down: a disabled button says
      // so where a no-op round trip would only reload the page.
      const move = `<div class="pu-host-move">
          <button type="submit" name="host-move" value="${uid}:up" formnovalidate class="pu-host-move-btn"
                  aria-label="Move ${escapeHtml(name)} up" title="Move up"${i === 0 ? ' disabled' : ''}>&#9650;</button>
          <button type="submit" name="host-move" value="${uid}:down" formnovalidate class="pu-host-move-btn"
                  aria-label="Move ${escapeHtml(name)} down" title="Move down"${i === views.length - 1 ? ' disabled' : ''}>&#9660;</button>
        </div>`
      return `<div class="pu-host-row">
        <label class="pu-host-name">
          <input type="checkbox" name="host-${uid}" value="on"${v.selected ? ' checked' : ''}>
          ${avatarHtml({ key: c.user.avatarKey, name, size: 28 })}
          <span>${escapeHtml(name)}</span></label>
        <div>${mode}</div>
        <div><select name="host-${uid}-schedule" aria-label="${escapeHtml(name)}: schedule for this event type">
            <option value=""${v.scheduleId === null ? ' selected' : ''}>Default</option>${scheduleOptions}
          </select>
          <span class="pu-host-sched-note">${hostScheduleNote(c, v.scheduleId)}</span></div>
        ${move}
      </div>`
    })
    .join('\n')

  // The same sentence the booking page prints, from the same function, over
  // the hosts as they stand on THIS form — stored on a GET, as submitted on
  // a round trip — so the admin reads what a guest will read before saving.
  const previewHosts: ResolvedHost[] = ticked.map((v) => ({
    user: v.choice.user,
    required: v.required,
    scheduleId: v.scheduleId,
    rrWeight: v.weight,
  }))
  const sentence = hostsSentence({ eventType: et, hosts: previewHosts })
  const preview = `<p class="pu-host-preview">Guests will see: ${
    sentence === '' ? '<em>nobody yet &mdash; tick at least one host</em>' : sentence
  }</p>`

  // Links in a new tab: navigating away mid-form would drop every unsaved
  // edit above. The booking page is the team's, so the address uses the
  // team slug; a slug that failed validation gets no link, since the error
  // above already quotes it and the page would only 404.
  const teamSlug = (d.teams ?? []).find((t) => t.id === et.ownerTeamId)?.slug
  const previewLink =
    teamSlug && /^[a-z0-9-]+$/.test(et.slug)
      ? ` &middot; <a href="/${escapeHtml(teamSlug)}/${escapeHtml(et.slug)}" target="_blank" rel="noopener">Preview booking page (opens in a new tab)</a>`
      : ''

  return `<fieldset class="pu-fs">
      <legend>Hosts</legend>
      <!-- Implicit submission (Enter in any field) activates the FIRST submit
           button in tree order — without this it would be a host's "move up"
           button, reordering instead of saving. Same device as the schedule
           editor's "+ Add range". -->
      <button type="submit" class="pu-sr" tabindex="-1">Save changes</button>
      <p class="pu-help" style="margin:0 0 .5rem">
        ${
          collective
            ? 'Slots are when every <strong>required</strong> host is free. An optional host joins a booking when free and is left out when not.'
            : 'One of the ticked hosts takes each booking. A higher weight takes a proportionally larger share of them — weight 2 gets twice as many as weight 1; blank uses the team weight.'
        }
        ${
          explicit
            ? 'This event type has its own host list; new team members are not added to it automatically.'
            : 'Every team member hosts this event type until you change the list below; new members join it automatically.'
        }
        Guests see the hosts in this order.</p>
      <div class="pu-host-tools">
        <button type="submit" name="host-select" value="all" formnovalidate class="pu-btn pu-btn-ghost">Select all</button>
        <button type="submit" name="host-select" value="none" formnovalidate class="pu-btn pu-btn-ghost">Select none</button>
      </div>
      <div class="pu-host-row pu-host-head" aria-hidden="true">
        <span>Host</span><span>${collective ? 'Attendance' : 'Weight'}</span><span>Schedule for this event type</span><span>Order</span>
      </div>
      ${rows}
      ${fieldError('hosts', errors)}
      ${preview}
      <p class="pu-help"><a href="/dashboard/teams" target="_blank" rel="noopener">Manage member schedules (opens in a new tab)</a>${previewLink}</p>
    </fieldset>`
}

/** One host row's values as the form should show them: the unsaved draft when there is one, else the stored row. */
interface HostView {
  choice: HostChoice
  selected: boolean
  required: boolean
  scheduleId: string | null
  weightText: string
  /** The weight the share is computed from: a valid typed override, else the team weight. */
  weight: number
}

function hostView(choice: HostChoice): HostView {
  const draft = choice.draft
  const weightText = draft ? draft.weightText : choice.row?.rrWeight == null ? '' : String(choice.row.rrWeight)
  const typed = Number(weightText.trim())
  const weight = weightText.trim() !== '' && Number.isInteger(typed) && typed >= 1 && typed <= 100 ? typed : choice.teamWeight
  return {
    choice,
    selected: draft ? draft.selected : choice.selected,
    required: draft ? draft.required : choice.row?.required !== false,
    scheduleId: draft ? draft.scheduleId : (choice.row?.scheduleId ?? null),
    weightText,
    weight,
  }
}

/**
 * What the selected schedule amounts to, beside the select: "Default" on
 * its own says nothing about whose hours those are, and an admin assigning
 * a schedule by name deserves to see what they are assigning. A choice the
 * member's list no longer has (deleted since) falls back to their default,
 * which is what the engine draws from in that case.
 */
function hostScheduleNote(choice: HostChoice, scheduleId: string | null): string {
  const chosen =
    (scheduleId !== null ? choice.schedules.find((s) => s.id === scheduleId) : undefined) ??
    choice.schedules.find((s) => s.isDefault) ??
    choice.schedules[0]
  return chosen ? weeklyHoursSummary(chosen) : ''
}

const SHORT_DAYS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * "Mon–Fri 09:00–17:00 · Europe/Kyiv" when every working day keeps the same
 * hours — the common case, and the one worth reading at a glance. Days
 * with differing hours fall back to `scheduleSummary`'s count-and-total,
 * which stays honest without listing seven lines beside one select.
 */
function weeklyHoursSummary(s: Schedule): string {
  const active = s.weekly.map((windows, day) => ({ day, windows })).filter((d) => d.windows.length > 0)
  if (active.length === 0) return 'No hours set'
  const hours = (windows: DayWindow[]): string =>
    windows.map((w) => `${minutesToTime(w.startMinute)}\u2013${minutesToTime(w.endMinute)}`).join(', ')
  const first = hours(active[0]!.windows)
  if (!active.every((d) => hours(d.windows) === first)) return scheduleSummary(s)
  const days = active.map((d) => d.day)
  const contiguous = days.every((day, i) => i === 0 || day === days[i - 1]! + 1)
  const label =
    days.length === 1
      ? SHORT_DAYS[days[0]!]!
      : contiguous
        ? `${SHORT_DAYS[days[0]!]}\u2013${SHORT_DAYS[days[days.length - 1]!]}`
        : days.map((day) => SHORT_DAYS[day]).join(', ')
  return `${label} ${first} \u00b7 ${escapeHtml(s.timezone)}`
}

/**
 * Same discipline as `ownershipFields`'s scheduling select: no client JS
 * involved, and the value is ignored server-side (readEventTypeForm) for a
 * team-owned draft — a team event type has multiple hosts and no single
 * schedule fits all of them (engine.ts). Rendered only when the host has
 * more than their one default schedule to choose from, same "nothing
 * meaningful to choose" precedent as `teams` having none.
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
    <select id="scheduleId" name="scheduleId"${describedBy('scheduleId', errors)}${autofocusAttr('scheduleId', errors)}>
      <option value=""${et?.scheduleId ? '' : ' selected'}>Default</option>
      ${options}
    </select>
    ${fieldError('scheduleId', errors)}
    <p class="pu-help">Which hours this event type draws from. A team-owned event type sets this per host, in the Hosts block above.</p>`
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

/** One team event type the signed-in user hosts, and which of their schedules it draws from. */
export interface TeamEventChoice {
  eventType: EventType
  teamName: string
  /** The host's current per-event schedule; null = their default. */
  scheduleId: string | null
}

export interface SchedulesPageData extends DashboardChrome {
  schedules: Schedule[]
  scope?: ScheduleScope
  /** Personal page only: the "Team events" section. Absent or empty = not rendered. */
  teamEvents?: TeamEventChoice[]
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

/**
 * "set up by Alice" — for a schedule someone other than its owner created.
 * Empty for the owner's own rows. Neutral, not the green success badge:
 * provenance is information, and green next to "Default" reads as a state.
 */
function setUpByBadge(s: Schedule, subjectId: string, creatorNames: Record<string, string> | undefined): string {
  if (!s.createdBy || s.createdBy === subjectId) return ''
  const name = creatorNames?.[s.createdBy]
  return `<span class="pu-badge pu-badge-neutral" title="A team admin created this schedule on your behalf">set up by ${escapeHtml(name ?? 'a team admin')}</span>`
}

/**
 * The one line every on-behalf page carries, list and editor alike, so an
 * admin who has three members' tabs open can tell them apart at a glance.
 * Neutral colours on purpose: nothing is wrong, and the danger palette
 * would make routine admin work look like an incident.
 */
function contextStrip(scope: ScheduleScope): string {
  return `<p class="pu-context-strip">Managing <b>${escapeHtml(scope.subject.name || scope.subject.slug)}</b> · ${escapeHtml(scope.team.name)} · you are a team admin</p>`
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
  <div class="pu-card-title">
    <h2>${escapeHtml(s.name)}</h2>${s.isDefault ? '<span class="pu-badge">Default</span>' : ''}${setUpByBadge(s, subject.id, d.creatorNames)}
    <a href="${base}/${id}" class="pu-btn pu-btn-ghost pu-card-title-action" style="padding:.3rem .6rem;font-size:.8125rem;margin-left:auto">Edit</a>
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
  ${contextStrip(d.scope)}
  <p class="pu-muted">${escapeHtml(subject.name || subject.slug)} sees every schedule here on their own Availability page,
    marked with who set it up, and can change it at any time.</p>`
    : `<h1>Availability</h1>
  <p class="pu-muted">Each of your event types draws its hours from one of these schedules &mdash;
    assign a specific one from the event type's own edit page, or leave it on the default.</p>`

  // The follow-the-default option says WHICH schedule that is right now, so
  // a host with three schedules does not have to scroll up to check. The
  // named options carry no "(default)" suffix: picking the default by name
  // pins it, which is a different choice from following whatever is default.
  const defaultName = d.schedules.find((s) => s.isDefault)?.name
  const teamEvents =
    !d.scope && d.teamEvents && d.teamEvents.length > 0
      ? `<section class="pu-card" aria-label="Team events" style="margin-top:1.5rem">
    <h2>Team events</h2>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 .75rem">
      Team event types you host, and which of your schedules each one draws from. A team admin may have
      set these up; you can change them at any time.</p>
    <div style="display:grid;gap:.75rem">
      ${d.teamEvents
        .map((te) => {
          const id = escapeHtml(te.eventType.id)
          const options = d.schedules
            .map(
              (sch) =>
                `<option value="${escapeHtml(sch.id)}"${te.scheduleId === sch.id ? ' selected' : ''}>${escapeHtml(sch.name)}</option>`,
            )
            .join('')
          return `<form method="post" action="/dashboard/availability/team-events/${encodeURIComponent(te.eventType.id)}"
            style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;margin:0">
        ${csrfField(d.csrf)}
        <label for="team-event-${id}" style="margin:0;flex:1 1 12rem">${escapeHtml(te.eventType.title)}
          <span class="pu-muted" style="font-size:.8125rem"> · ${escapeHtml(te.teamName)} · ${te.eventType.schedulingType === 'collective' ? 'collective' : 'round robin'}</span></label>
        <select id="team-event-${id}" name="scheduleId">
          <option value=""${te.scheduleId ? '' : ' selected'}>Default${defaultName ? ` (${escapeHtml(defaultName)})` : ''}</option>${options}
        </select>
        <button class="pu-btn pu-btn-ghost" type="submit" style="padding:.3rem .6rem;font-size:.8125rem">Save</button>
        ${fieldError(`team-event-${te.eventType.id}`, errors)}
      </form>`
        })
        .join('\n')}
    </div>
  </section>`
      : ''

  return (
    shellTop(d, d.scope ? `${subject.name || subject.slug} · Availability` : 'Availability', d.scope ? 'teams' : 'availability') +
    (d.notice ? notice(d.notice) : '') +
    `<section aria-label="Availability schedules">
  ${heading}
  ${d.scope ? '' : utcDefaultCallout(d.schedules, base)}
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
  ${teamEvents}
</section>` +
    shellBottom(d.brandName)
  )
}

/**
 * A default schedule still in UTC is almost never a choice — it is the
 * backfill's fallback when nothing told it where the host is — and a host
 * who reads "09:00–17:00" on this page has no way to see that those numbers
 * mean something else where they live. Rendered only on the host's own
 * page: a team admin managing a member's hours cannot know the member's
 * zone either.
 */
function utcDefaultCallout(schedules: Schedule[], basePath: string): string {
  const fallback = schedules.find((s) => s.isDefault && s.timezone === 'UTC')
  if (!fallback) return ''
  return `<div class="pu-callout pu-callout-warn" role="note" style="margin:0 0 1rem">
    <p style="margin:0">Your hours are read in UTC. Set your timezone so 09:00 means 09:00 where you are
      &mdash; edit <a href="${basePath}/${encodeURIComponent(fallback.id)}">${escapeHtml(fallback.name)}</a>.</p>
  </div>`
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
  const banner = d.scope ? contextStrip(d.scope) : ''
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
    <input id="timezone" name="timezone" list="pu-zones" required aria-required="true" class="pu-tz-input"
           placeholder="Start typing a city, e.g. Europe/Kyiv" autocomplete="off"
           value="${escapeHtml(d.schedule.timezone)}"${describedBy('timezone', errors)}>
    <datalist id="pu-zones">
      ${zones.map((z) => `<option value="${escapeHtml(z)}"></option>`).join('\n      ')}
    </datalist>
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      ${d.scope ? 'The' : 'Your'} weekly hours below are read in this zone, so they follow ${d.scope ? 'the host' : 'you'} through daylight saving.</p>
    ${fieldError('timezone', errors)}

    <h2 style="margin-top:1.5rem">Weekly hours</h2>
    <p class="pu-muted" style="font-size:.8125rem">
      Turn a day on and set one or more ranges — add a second for a lunch break.</p>
    <div class="pu-week-editor">${rows}</div>

    <label for="overrides" style="margin-top:1.5rem;font-family:var(--pu-font-display);font-size:1.125rem">Date overrides — one per line</label>
    <p class="pu-muted" style="font-size:.8125rem;margin:0 0 .4rem">
      A date on its own is a day off. A date with a time range replaces that day's weekly hours
      entirely: <code>2026-12-24</code> or <code>2026-12-31 10:00-14:00</code>.</p>
    <textarea id="overrides" name="overrides" class="pu-overrides" rows="5"
              placeholder="2026-12-24&#10;2026-12-31 10:00-14:00"${describedBy('overrides', errors)}>${escapeHtml(d.overridesText ?? formatOverrides(d.schedule.overrides))}</textarea>
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
 * "Remove" appears only once a day has two or more rows: with one, the
 * switch already is the way to take a day off, and a Remove that leaves an
 * empty row behind would be a slower spelling of "clear both times". Both
 * buttons are `formnovalidate` submits the route answers with a re-render,
 * never a save — see `saveSchedule` in dashboard-routes.ts.
 *
 * The switch and the ranges are siblings inside `.pu-day-row`, not nested —
 * `:has()` in styles.ts is what shows/hides the ranges off the checkbox's
 * `:checked` state, and that needs no JavaScript at all to work.
 */
function dayRow(index: number, name: string, day: WeeklyDayDraft, errors: Record<string, string>): string {
  const fid = `day-${index}`
  const ranges = day.ranges.length > 0 ? day.ranges : [{ start: '', end: '' }]
  const canAddMore = day.ranges.length < MAX_RANGES_PER_DAY
  const removable = ranges.length > 1
  const rangeRows = ranges
    .map(
      (r, i) => `<div class="pu-range-row">
        <input type="time" name="${fid}-start-${i}" value="${escapeHtml(r.start)}" aria-label="${escapeHtml(name)} range ${i + 1} start">
        <span aria-hidden="true">&ndash;</span>
        <input type="time" name="${fid}-end-${i}" value="${escapeHtml(r.end)}" aria-label="${escapeHtml(name)} range ${i + 1} end">${
          removable
            ? `
        <button class="pu-btn pu-btn-ghost pu-remove-range" type="submit" name="remove-range" value="${index}-${i}" formnovalidate
                aria-label="Remove ${escapeHtml(name)} range ${i + 1}">Remove</button>`
            : ''
        }
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
          ? `<button class="pu-btn pu-btn-ghost pu-add-range" type="submit" name="add-range" value="${index}" formnovalidate>+ Add range</button>`
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
  /** Echo of a failed rename / re-slug submit, scoped to one team's settings form. */
  editValues?: { teamId: string; name: string; slug: string }
  errors?: Record<string, string>
  notice?: string
}

export function teamsPage(d: TeamsPageData): string {
  const errors = d.errors ?? {}
  const cards =
    d.teams.length === 0
      ? `<p class="pu-muted">No teams yet. Create one below, then pick it as the owner of an event type.</p>`
      : d.teams.map((view) => teamCard(d, view)).join('\n')

  return (
    shellTop(d, 'Teams', 'teams') +
    (d.notice ? notice(d.notice) : '') +
    `<section aria-label="Teams">
  <h1>Teams</h1>
  <p class="pu-muted">A team owns round-robin and collective event types, booked at
    /&lt;team-slug&gt;/&lt;event&gt;. Team admins manage members and the team's event types, and can
    set up each member's availability on their behalf. Deleting a team is not supported here yet.</p>
  <div style="display:grid;gap:1rem;grid-template-columns:minmax(0,1fr)">${cards}</div>
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
    ${fieldError('team-slug', errors)}
    <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">
      Lowercase letters, numbers and hyphens, 2&ndash;40 characters. It becomes the first part of the
      team's booking links: /&lt;slug&gt;/&lt;event&gt;. You join as its first member and admin.</p>
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
      const you = m.member.userId === d.user.id ? ' <span class="pu-muted">(you)</span>' : ''
      const label = `${escapeHtml(m.user ? m.user.name || m.user.slug : m.member.userId)}${you}`
      const email = m.user?.email ?? ''
      const uid = encodeURIComponent(m.member.userId)
      const isAdmin = isManagingRole(m.member.role)
      const role = isAdmin ? '<span class="pu-badge">Admin</span>' : '<span class="pu-muted">Member</span>'
      if (!view.canManage) {
        return `<tr>
        <td>${label}${email ? `<br><span class="pu-muted" style="font-size:.8125rem">${escapeHtml(email)}</span>` : ''}</td>
        <td>${role}</td>
        <td>${m.member.rrWeight}</td>
        <td></td>
      </tr>`
      }
      // Buttons that can only fail are not offered: the only member gets no
      // Remove, the only admin gets neither Remove nor "Make member". The
      // server refuses both anyway (removeMemberGuarded, setRole), so this
      // is about not lying, same as the admin page's last-admin row. The
      // footnote under the table says why, once, instead of a label in
      // every affected row.
      const onlyMember = view.members.length <= 1
      const onlyAdmin = isAdmin && adminCount <= 1
      const roleAction = onlyAdmin
        ? ''
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
        <td>${label}${email ? `<br><span class="pu-muted" style="font-size:.8125rem">${escapeHtml(email)}</span>` : ''}</td>
        <td>${role}</td>
        <td>${m.member.rrWeight}</td>
        <td><div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
          <a class="pu-btn pu-btn-ghost" style="${small}" href="/dashboard/teams/${teamId}/members/${uid}/availability">Set availability</a>
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

  // The inline min-width duplicates .pu-dash-table on purpose: the table
  // must not squeeze even before the stylesheet applies.
  const edit = d.editValues?.teamId === team.id ? d.editValues : { teamId: team.id, name: team.name, slug: team.slug }
  const settings = view.canManage
    ? `<details class="pu-team-settings"${d.editValues?.teamId === team.id || errors[`logo-${team.id}`] ? ' open' : ''}>
    <summary>Team settings — name, address, logo</summary>
    ${logoPanel({ csrf: d.csrf, action: `/dashboard/teams/${teamId}/logo`, key: team.logoKey, shape: team.logoShape ?? null, name: team.name, errorKey: `logo-${team.id}`, errors, hint: "Heads the team's booking pages and social cards." })}
    <form method="post" action="/dashboard/teams/${teamId}" style="margin-top:1rem">
      ${csrfField(d.csrf)}
      <div class="pu-grid" style="grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:0 1rem">
        <div>
          <label for="team-name-${escapeHtml(team.id)}">Name</label>
          <input id="team-name-${escapeHtml(team.id)}" name="name" required aria-required="true" maxlength="120"
                 value="${escapeHtml(edit.name)}"${describedBy(`team-name-${team.id}`, errors)}>
          ${fieldError(`team-name-${team.id}`, errors)}
        </div>
        <div>
          <label for="team-slug-${escapeHtml(team.id)}">URL slug</label>
          <input id="team-slug-${escapeHtml(team.id)}" name="slug" required aria-required="true" maxlength="40" pattern="[a-z0-9\\-]+"
                 value="${escapeHtml(edit.slug)}"${describedBy(`team-slug-${team.id}`, errors)}>
          ${fieldError(`team-slug-${team.id}`, errors)}
          <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">Changing it breaks every booking link already shared — there is no redirect from /${escapeHtml(team.slug)}.</p>
        </div>
      </div>
      <div style="margin-top:.75rem"><button class="pu-btn pu-btn-ghost" type="submit">Save team</button></div>
    </form>
  </details>`
    : ''

  return `<article class="pu-card">
  <div class="pu-card-title">
    ${team.logoKey ? logoHtml({ key: team.logoKey, shape: team.logoShape, name: team.name, size: 32 }) : ''}
    <h2>${escapeHtml(team.name)}</h2>${view.viaInstanceAdmin ? '<span class="pu-badge pu-badge-neutral">Instance admin view</span>' : ''}
    <span class="pu-time pu-muted pu-card-title-action" style="margin-left:auto">/${escapeHtml(team.slug)}</span>
  </div>
  ${fieldError(`members-${team.id}`, errors)}
  <div class="pu-docs-table-wrap"><table class="pu-dash-table pu-members" style="width:100%;min-width:34rem">
    <thead><tr><th scope="col">Member</th>
      <th scope="col">Role</th>
      <th scope="col">Weight</th><th scope="col"></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${view.canManage ? `<p class="pu-muted" style="font-size:.8125rem;margin:.5rem 0 0">A team's last admin can't be demoted or removed.</p>` : ''}
  ${addForm}
  ${settings}
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

  // The reader is the host, who usually cannot set a secret; only when they
  // also run the deployment is the fix theirs to make.
  const connectButtons =
    d.availableProviders.length === 0
      ? `<p class="pu-muted">This deployment has no Google or Microsoft credentials yet. If you run it, see
       <a href="/docs/self-hosting">self-hosting &rarr; calendar providers</a>; otherwise ask your admin.</p>`
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
    <h2>${d.connections.length === 0 ? 'Connect a calendar' : 'Connect another calendar'}</h2>
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

  // Nothing here can be saved until the host reconnects — the provider will
  // not even list calendars — so the form would only promise what Save
  // cannot do. Two actions, the only two that work.
  if (c.syncStatus === 'needs_reconnect') {
    return `<article class="pu-card">
  ${connectionHeading(c)}
  <div role="alert">
    <p class="pu-err" style="font-size:.9375rem;margin-top:.75rem">Access was revoked or expired. Conflicts from this calendar are not
       being checked and new bookings are not written to it.</p>
  </div>
  <div class="pu-form-row">
    <a class="pu-btn" href="/auth/${c.provider}/start?purpose=calendar">Reconnect ${escapeHtml(providerLabel(c.provider))}</a>
    <form method="post" action="/dashboard/connections/${id}/disconnect" style="margin:0">
      ${csrfField(d.csrf)}
      <button class="pu-btn pu-btn-ghost pu-btn-ghost-danger" type="submit">Disconnect</button>
    </form>
  </div>
</article>`
  }

  // A provider list we could not fetch must not silently drop the host's
  // selection, so fall back to the stored ids — labelled as ids we could
  // not resolve, so the host knows the name is missing and not the calendar.
  const listed = view.calendars.length > 0
  const calendars = listed
    ? view.calendars
    : c.calendarIdsRead.map((cid) => ({ id: cid, name: cid, primary: false }))

  const readRows = calendars
    .map((cal) => {
      const inputId = `read-${escapeHtml(c.id)}-${escapeHtml(cal.id)}`
      const checked = c.calendarIdsRead.includes(cal.id) ? ' checked' : ''
      const label = listed
        ? `${escapeHtml(cal.name)}${cal.primary ? ' <span class="pu-muted">(primary)</span>' : ''}`
        : `${escapeHtml(cal.id)} <span class="pu-muted">&mdash; could not list calendars</span>`
      return `<label class="pu-check" for="${inputId}">
        <input id="${inputId}" name="read" type="checkbox" value="${escapeHtml(cal.id)}"${checked}>
        <span>${label}</span>
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

  // Disconnect sits on Save's row but must not post to Save's action, and
  // forms cannot nest — the button's `form` attribute points it at its own
  // form, rendered after, which plain HTML honours without any script.
  return `<article class="pu-card">
  ${connectionHeading(c)}
  <form id="save-${escapeHtml(c.id)}" method="post" action="/dashboard/connections/${id}">
    ${csrfField(d.csrf)}
    <fieldset style="border:0;padding:0;margin:1rem 0 0">
      <legend style="font-size:.875rem;font-weight:600;padding:0">Check these for conflicts</legend>
      ${readRows || '<p class="pu-muted">No calendars to list.</p>'}
    </fieldset>
    <label for="write-${escapeHtml(c.id)}">Write bookings to</label>
    <select id="write-${escapeHtml(c.id)}" name="write">
        ${writeOptions}
    </select>
    <div class="pu-form-row">
      <button class="pu-btn" type="submit">Save</button>
      <button class="pu-btn pu-btn-ghost pu-btn-ghost-danger" type="submit" form="disconnect-${escapeHtml(c.id)}">Disconnect</button>
    </div>
  </form>
  <form id="disconnect-${escapeHtml(c.id)}" method="post" action="/dashboard/connections/${id}/disconnect" style="margin:0">
    ${csrfField(d.csrf)}
  </form>
</article>`
}

function connectionHeading(c: CalendarConnection): string {
  return `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap">
    <h2 style="margin:0">${escapeHtml(providerLabel(c.provider))}</h2>
    ${syncBadge(c)}
  </div>
  <p class="pu-muted" style="margin:.25rem 0 0">${escapeHtml(c.providerAccountEmail || 'Unknown account')}</p>`
}

function syncBadge(c: CalendarConnection): string {
  if (c.syncStatus === 'ok') return '<span class="pu-badge pu-badge-dot">Connected</span>'
  const label = c.syncStatus === 'needs_reconnect' ? 'Needs reconnect' : 'Sync error'
  return `<span class="pu-badge pu-badge-dot pu-badge-danger">${label}</span>`
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
  /** Echoed on a failed submit so the host does not retype the name. */
  nameValue?: string
  /** Scopes ticked on a failed submit; both by default. */
  scopesValue?: readonly string[]
  errors?: Record<string, string>
}

/**
 * The whole scope vocabulary the form offers, with the words a host needs
 * to choose. Mirrors `API_SCOPE_READ`/`API_SCOPE_WRITE` in the REST layer;
 * the route accepts nothing outside this list.
 */
export const API_KEY_SCOPES: ReadonlyArray<{ value: string; what: string }> = [
  { value: 'read', what: 'list event types, availability, bookings' },
  { value: 'write', what: 'create, reschedule, cancel bookings' },
]

export function apiKeysPage(d: ApiKeysPageData): string {
  const errors = d.errors ?? {}
  const ticked = d.scopesValue ?? API_KEY_SCOPES.map((s) => s.value)
  const scopeRows = API_KEY_SCOPES.map(
    (s) => `<label class="pu-check" for="scope-${s.value}">
      <input id="scope-${s.value}" name="scopes" type="checkbox" value="${s.value}"${ticked.includes(s.value) ? ' checked' : ''}>
      <span><strong>${s.value}</strong> &mdash; ${s.what}</span>
    </label>`,
  ).join('\n    ')

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
  <h3 style="font-size:.875rem;margin:1rem 0 .35rem">New API key</h3>
  <code id="new-key" class="pu-key">${escapeHtml(d.newKey)}</code>
  <div class="pu-form-row" style="justify-content:flex-start">
    ${revealCopyButton(d.newKey)}
    <span class="pu-muted" style="font-size:.8125rem">Send it as <code>Authorization: Bearer &lt;key&gt;</code>
      &mdash; see the <a href="/docs/api">API docs</a>.</span>
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
           placeholder="Laptop CLI" value="${escapeHtml(d.nameValue ?? '')}"${describedBy('name', errors)}>
    ${fieldError('name', errors)}
    <fieldset style="border:0;padding:0;margin:1rem 0 0"${describedBy('scopes', errors)}>
      <legend style="font-size:.875rem;font-weight:600;padding:0">Scopes</legend>
      ${scopeRows}
      <p class="pu-muted" style="font-size:.8125rem;margin:.25rem 0 0">Grant the fewest that work.</p>
    </fieldset>
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
  const keyId = encodeURIComponent(k.id)
  return `<li class="pu-card" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap">
        <div>
          <strong>${escapeHtml(k.name || 'Unnamed key')}</strong><br>
          <span class="pu-time pu-muted">pk_${escapeHtml(k.prefix)}…</span>
          <span class="pu-muted">· created ${escapeHtml(created)} · ${escapeHtml(used)}</span>
        </div>
        <form method="post" action="/dashboard/api-keys/${keyId}/delete" style="margin:0"
              onsubmit="return confirm(${escapeHtml(JSON.stringify(revokePrompt(k)))})">
          ${csrfField(d.csrf)}
          <a class="pu-btn pu-btn-danger" href="/dashboard/api-keys/${keyId}/revoke"
             onclick="var f=this.closest('form');if(f&&f.requestSubmit){f.requestSubmit();return false}"
             style="padding:.4rem .8rem;font-size:.875rem">Revoke</a>
        </form>
      </li>`
}

function revokePrompt(k: ApiKey): string {
  return `Revoke ${k.name || 'this key'}? Anything using it stops working immediately.`
}

/**
 * The one-time key's copy control. `copyButton` selects a sibling input as
 * its no-clipboard fallback; the key is a block of text here, so the
 * fallback selects that block instead — the host can still copy by hand.
 */
function revealCopyButton(value: string): string {
  return `<button type="button" class="pu-btn pu-btn-ghost pu-copy" data-copy="${escapeHtml(value)}"
    onclick="var b=this,f=function(){var e=document.getElementById('new-key'),s=window.getSelection(),r=document.createRange();r.selectNodeContents(e);s.removeAllRanges();s.addRange(r)};if(navigator.clipboard){navigator.clipboard.writeText(b.dataset.copy).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)}).catch(f)}else{f()}">Copy</button>`
}

export interface RevokeKeyPageData extends DashboardChrome {
  apiKey: ApiKey
}

/**
 * The no-script path of the revoke confirmation. With script, the row's
 * `confirm()` asks before the POST; without it, the row's control is a
 * plain link that lands here and the question is a page. Both end at the
 * same POST.
 */
export function revokeKeyPage(d: RevokeKeyPageData): string {
  const k = d.apiKey
  return (
    shellTop(d, 'Revoke API key', 'keys') +
    `<section class="pu-card" aria-labelledby="revoke-title" style="max-width:36rem">
  <h1 id="revoke-title" style="font-size:1.25rem">Revoke ${escapeHtml(k.name || 'this key')}?</h1>
  <p>Anything using it stops working immediately. There is no undo &mdash; a key is only ever shown once, so a
     revoked key can only be replaced by a new one.</p>
  <p class="pu-muted"><span class="pu-time">pk_${escapeHtml(k.prefix)}&hellip;</span></p>
  <form method="post" action="/dashboard/api-keys/${encodeURIComponent(k.id)}/delete" class="pu-form-row" style="justify-content:flex-start">
    ${csrfField(d.csrf)}
    <button class="pu-btn pu-btn-danger" type="submit">Revoke key</button>
    <a class="pu-btn pu-btn-ghost" href="/dashboard/api-keys">Keep it</a>
  </form>
</section>` +
    shellBottom(d.brandName)
  )
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
  /** Public origin, so "View your booking page" opens the address a guest would use. */
  baseUrl: string
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
    // The page title and its one-line lede sit above the cards, as on
    // Calendars and API keys — inside the first card they read as that
    // card's own heading, and the slug card below looked like a footnote.
    //
    // One profile panel, one identity: the photo IS part of the profile, and
    // split cards read as two unrelated features. Photo column left (the
    // file input is visually hidden — the styled label is the whole control,
    // and choosing a file submits immediately, so there is no separate
    // Upload step to explain), fields right.
    `<section aria-label="Settings">
  <h1>Settings</h1>
  <p class="pu-muted">Who guests see when they book with you, and the address your booking links start with.</p>
<section class="pu-card" aria-label="Your profile" style="margin-bottom:1.25rem">
  <h2>Your profile</h2>
  <p class="pu-muted">Shown on your booking page and in confirmation emails.</p>
  <p style="margin:.75rem 0 0">Signed in as <code>${escapeHtml(d.user.email)}</code><br>
    <span class="pu-muted" style="font-size:.8125rem">The sign-in address can&rsquo;t be changed here.</span></p>
  <div class="pu-profile">
    <div class="pu-profile-photo">
      ${avatarHtml({ key: d.user.avatarKey, name: d.user.name, size: 88 })}
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
             placeholder="Your name, as guests will see it"
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
    <strong>every</strong> event type at once.
    <a href="${escapeHtml(`${trimSlash(d.baseUrl)}/${encodeURIComponent(d.user.slug)}`)}">View your booking page</a></p>
  <div class="pu-callout pu-callout-warn" role="note" style="margin:.75rem 0">
    <p style="margin:0">Changing it breaks every link and QR code you have already shared &mdash; there is no
      redirect from <code>/${escapeHtml(d.user.slug)}</code>.</p>
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
</section>
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
// Host bookings — the list, one booking, and the host's reschedule picker
// ---------------------------------------------------------------------------

export interface BookingListRow {
  booking: Booking
  /** Resolved by the route; a deleted event type leaves "Meeting". */
  eventTitle: string
  /** The other attending hosts, named — empty for a personal booking. */
  coHostNames: string[]
}

export interface BookingsPageData extends DashboardChrome {
  view: BookingListView
  rows: BookingListRow[]
  /** True when the list was cut at the cap, so the page can say so. */
  truncated: boolean
}

const BOOKING_VIEWS: ReadonlyArray<{ key: BookingListView; label: string; empty: string }> = [
  { key: 'upcoming', label: 'Upcoming', empty: 'Nothing booked yet. New bookings appear here as guests pick times.' },
  { key: 'past', label: 'Past', empty: 'No meetings have happened yet.' },
  { key: 'cancelled', label: 'Cancelled', empty: 'Nothing has been cancelled.' },
]

/**
 * Every booking the signed-in host attends, one view at a time. Tabs are
 * links (`?view=`), rows are cards rather than a table: a table wider than
 * a phone would need to scroll inside the card, and the row has only four
 * things to say.
 */
export function bookingsPage(d: BookingsPageData): string {
  const tabs = BOOKING_VIEWS.map((v) => {
    const current = v.key === d.view ? ' aria-current="page"' : ''
    return `<a class="pu-tab" href="/dashboard/bookings?view=${v.key}"${current}>${v.label}</a>`
  }).join('\n    ')
  const active = BOOKING_VIEWS.find((v) => v.key === d.view) ?? BOOKING_VIEWS[0]!

  const list =
    d.rows.length === 0
      ? `<p class="pu-muted pu-bookings-empty">${escapeHtml(active.empty)}</p>`
      : `<ul class="pu-bookings">
    ${d.rows.map((row) => bookingListRow(row, d.user.tz)).join('\n    ')}
  </ul>` +
        (d.truncated
          ? `<p class="pu-muted" style="font-size:.8125rem;margin-top:.75rem">Showing the first ${d.rows.length}.</p>`
          : '')

  return (
    shellTop(d, 'Bookings', 'bookings') +
    `<h1>Bookings</h1>
<p class="pu-muted" style="font-size:.8125rem;margin-top:-.5rem">Times in ${escapeHtml(d.user.tz)} (${escapeHtml(offsetLabel(Date.now(), d.user.tz))})</p>
<nav class="pu-tabs" aria-label="Bookings">
    ${tabs}
</nav>
<section aria-label="${escapeHtml(active.label)} bookings">
  ${list}
</section>` +
    shellBottom(d.brandName)
  )
}

function bookingListRow(row: BookingListRow, tz: string): string {
  const b = row.booking
  const when = formatInZone(b.startUtc, tz, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  const coHosts =
    row.coHostNames.length > 0
      ? `<span class="pu-muted">with ${escapeHtml(joinNames(row.coHostNames))}</span>`
      : ''
  return `<li class="pu-booking-row">
      <a class="pu-booking-link" href="/dashboard/bookings/${encodeURIComponent(b.id)}">
        <span class="pu-time">${escapeHtml(when)}</span>
        <span class="pu-booking-main"><strong>${escapeHtml(row.eventTitle)}</strong> — ${escapeHtml(b.guestName)} ${coHosts}</span>
        ${statusBadge(b)}
      </a>
    </li>`
}

/** Confirmed is the green dot; cancelled the danger ring; moved is neutral — the replacement carries the green. */
function statusBadge(b: Booking): string {
  const cls =
    b.status === 'confirmed'
      ? 'pu-badge pu-badge-dot'
      : b.status === 'cancelled'
        ? 'pu-badge pu-badge-dot pu-badge-danger'
        : 'pu-badge pu-badge-neutral'
  return `<span class="${cls}">${escapeHtml(statusLabel(b))}</span>`
}

export interface BookingParticipant {
  user: User
  /**
   * From the event type's current host settings (core/domain/hosts.ts).
   * Null when this person is no longer in the event type's host set —
   * they attend the booking, but the event type stopped naming them.
   */
  required: boolean | null
  /** In the booking's `hostUserIds`. */
  attends: boolean
}

export interface HostBookingPageData extends DashboardChrome {
  booking: Booking
  /** Null when the event type has since been deleted; the booking still stands. */
  eventType: EventType | null
  /** Link the title to the editor only when the route confirmed the user may edit it. */
  canEditEventType: boolean
  /** Set for a team-owned event type, so the page can say whose. */
  teamName: string | null
  participants: BookingParticipant[]
  /**
   * Whether this user may add or remove co-hosts: a team booking, and the
   * user attends it or manages the team. The route decides; the page
   * only draws the forms.
   */
  canChangeHosts: boolean
  /** Team members not yet attending, for the "Add a co-host" select. */
  addable: User[]
  now: number
  notice?: string
  error?: string
}

/** One sentence per refusal from `changeBookingHosts`, for the page. */
export function hostChangeFailureMessage(reason: HostChangeFailure): string {
  switch (reason) {
    case 'not_found':
      return 'That booking no longer exists.'
    case 'not_allowed':
      return 'You cannot change who hosts this booking.'
    case 'not_a_team_booking':
      return 'Only a team booking can have co-hosts.'
    case 'not_a_member':
      return 'That person is not a member of the team.'
    case 'already_host':
      return 'That person is already attending.'
    case 'not_host':
      return 'That person is not attending this booking.'
    case 'stale':
      return 'The participants changed while you were looking — this page is reloaded; check it and try again.'
    case 'last_host':
      return 'A booking needs at least one host. Add someone else before removing them.'
    case 'slot_taken':
      return 'That person is not free at this time.'
    case 'past':
      return 'This booking has already happened, so its hosts cannot change.'
  }
}

const LONG_WHEN: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}

/** "Wednesday, September 9, 11:40 PM – 12:10 AM" in one zone. */
function spanInZone(startUtc: number, endUtc: number, tz: string): string {
  const start = formatInZone(startUtc, tz, LONG_WHEN)
  const end = formatInZone(endUtc, tz, { hour: 'numeric', minute: '2-digit' })
  return `${start} – ${end}`
}

export function hostBookingPage(d: HostBookingPageData): string {
  const b = d.booking
  const title = d.eventType?.title ?? 'Meeting'
  const confirmed = b.status === 'confirmed'
  const past = b.endUtc <= d.now
  const minutes = Math.round((b.endUtc - b.startUtc) / 60000)
  const path = `/dashboard/bookings/${encodeURIComponent(b.id)}`

  const heading =
    d.canEditEventType && d.eventType
      ? `<a href="/dashboard/event-types/${encodeURIComponent(d.eventType.id)}">${escapeHtml(title)}</a>`
      : escapeHtml(title)
  const synced = Object.keys(b.externalEventIds).length
  const syncState =
    synced === 0
      ? 'Not yet on a calendar'
      : synced === 1
        ? 'On 1 calendar'
        : `On ${synced} calendars`

  const location = d.eventType ? locationLabel(d.eventType) : null
  const locationRow = b.conferenceUrl
    ? `<dd><a href="${escapeHtml(b.conferenceUrl)}" target="_blank" rel="noopener">${escapeHtml(b.conferenceUrl)}</a></dd>`
    : location
      ? `<dd>${escapeHtml(location)}</dd>`
      : ''

  const answers = Object.entries(b.answers)
  const questionLabels = new Map((d.eventType?.questions ?? []).map((q) => [q.id, q.label]))

  return (
    shellTop(d, title, 'bookings') +
    `<p class="pu-muted" style="margin:0 0 .5rem;font-size:.875rem"><a href="/dashboard/bookings">&larr; Bookings</a></p>
${d.notice ? notice(d.notice) : ''}
${d.error ? `<p class="pu-err" role="alert">${escapeHtml(d.error)}</p>` : ''}
<div class="pu-grid" style="grid-template-columns:1fr">
  <section class="pu-card" aria-label="Booking">
    <div class="pu-card-title">
      <h1 style="margin:0">${heading}</h1>
      ${d.teamName ? `<span class="pu-badge pu-badge-neutral">${escapeHtml(d.teamName)}</span>` : ''}
      <span class="pu-card-title-action">${statusBadge(b)}</span>
    </div>
    <dl class="pu-booking-facts">
      <dt>When</dt>
      <dd><span class="pu-time">${escapeHtml(spanInZone(b.startUtc, b.endUtc, d.user.tz))}</span>
        <span class="pu-muted">${escapeHtml(d.user.tz)} (${escapeHtml(offsetLabel(b.startUtc, d.user.tz))}) · ${minutes} min</span></dd>
      ${
        b.guestTimezone !== d.user.tz
          ? `<dt>For the guest</dt>
      <dd><span class="pu-time">${escapeHtml(spanInZone(b.startUtc, b.endUtc, b.guestTimezone))}</span>
        <span class="pu-muted">${escapeHtml(b.guestTimezone)} (${escapeHtml(offsetLabel(b.startUtc, b.guestTimezone))})</span></dd>`
          : ''
      }
      ${locationRow ? `<dt>Where</dt>\n      ${locationRow}` : ''}
      <dt>Calendar</dt>
      <dd>${escapeHtml(syncState)}</dd>
    </dl>
  </section>

  <section class="pu-card" aria-label="Guest">
    <h2>Guest</h2>
    <p><strong>${escapeHtml(b.guestName)}</strong><br>
      <a href="mailto:${escapeHtml(b.guestEmail)}">${escapeHtml(b.guestEmail)}</a></p>
    ${
      answers.length > 0
        ? `<dl class="pu-booking-facts">
      ${answers
        .map(
          ([id, value]) =>
            `<dt>${escapeHtml(questionLabels.get(id) ?? id)}</dt>\n      <dd>${escapeHtml(value)}</dd>`,
        )
        .join('\n      ')}
    </dl>`
        : ''
    }
  </section>

  ${participantsSection(d, path)}

  ${actionsSection(d, path, confirmed, past)}
</div>` +
    shellBottom(d.brandName)
  )
}

function participantsSection(d: HostBookingPageData, path: string): string {
  const attending = d.participants.filter((p) => p.attends)
  const rows = d.participants
    .map((p) => {
      const name = p.user.name || p.user.slug
      const you = p.user.id === d.user.id ? ' <span class="pu-muted">(you)</span>' : ''
      const mode =
        p.required === null
          ? ''
          : `<span class="pu-badge pu-badge-neutral">${p.required ? 'Required' : 'Optional'}</span>`
      const attends = p.attends
        ? '<span class="pu-badge pu-badge-dot">Attending</span>'
        : '<span class="pu-muted" style="font-size:.8125rem">Not on this one</span>'
      // The last attending host cannot be removed — the booking would have
      // nobody — so the button is not drawn for them. The domain refuses it
      // too; hiding the control just spares the host a pointless error.
      const remove =
        d.canChangeHosts && p.attends && attending.length > 1
          ? `<form method="post" action="${path}/hosts/${encodeURIComponent(p.user.id)}/remove" class="pu-participant-action">
          ${csrfField(d.csrf)}
          <button class="pu-btn pu-btn-ghost pu-btn-ghost-danger" type="submit">Remove</button>
        </form>`
          : ''
      return `<li class="pu-participant">
        ${avatarHtml({ key: p.user.avatarKey, name, size: 32 })}
        <span class="pu-participant-name"><strong>${escapeHtml(name)}</strong>${you}<br>
          <span class="pu-muted" style="font-size:.8125rem">${escapeHtml(p.user.email)}</span></span>
        <span class="pu-participant-badges">${mode} ${attends}</span>
        ${remove}
      </li>`
    })
    .join('\n      ')

  const add =
    d.canChangeHosts && d.addable.length > 0
      ? `<form method="post" action="${path}/hosts/add" class="pu-add-cohost">
      ${csrfField(d.csrf)}
      <label for="cohost">Add a co-host</label>
      <div class="pu-add-cohost-row">
        <select id="cohost" name="userId" required>
          <option value="">Choose a team member</option>
          ${d.addable
            .map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name || u.slug)}</option>`)
            .join('\n          ')}
        </select>
        <button class="pu-btn pu-btn-ghost" type="submit">Add</button>
      </div>
    </form>`
      : ''

  return `<section class="pu-card" aria-label="Participants">
    <h2>Participants</h2>
    <ul class="pu-participants">
      ${rows}
    </ul>
    ${add}
  </section>`
}

function actionsSection(d: HostBookingPageData, path: string, confirmed: boolean, past: boolean): string {
  if (!confirmed) {
    return `<section class="pu-card" aria-label="Actions">
    <p class="pu-muted">This booking is ${d.booking.status === 'cancelled' ? 'cancelled' : 'moved'}, so there is nothing left to change.${
      d.booking.rescheduledTo
        ? ` <a href="/dashboard/bookings/${encodeURIComponent(d.booking.rescheduledTo)}">See the new time.</a>`
        : ''
    }</p>
  </section>`
  }
  if (past) {
    return `<section class="pu-card" aria-label="Actions">
    <p class="pu-muted">This meeting has already happened, so it can no longer be moved or cancelled.</p>
  </section>`
  }
  // Only the guest is mailed about a host's cancellation, so the prompt
  // says so — and the note is addressed to them, not filed as a reason.
  return `<section class="pu-card" aria-label="Actions">
    <h2>Change this booking</h2>
    <p><a class="pu-btn" href="${path}/reschedule">Reschedule</a></p>
    <form method="post" action="${path}/cancel" class="pu-cancel-form"
          onsubmit="return confirm('Cancel this booking? The guest will be emailed.')">
      ${csrfField(d.csrf)}
      <label for="note">Note to the guest <span class="pu-muted">(optional)</span></label>
      <textarea id="note" name="note" rows="3" maxlength="500" placeholder="Something came up — sorry for the short notice."></textarea>
      <p class="pu-help">Sent to ${escapeHtml(d.booking.guestName)} with the cancellation. The time is released.</p>
      <button class="pu-btn pu-btn-ghost pu-btn-ghost-danger" type="submit">Cancel booking</button>
    </form>
  </section>`
}

export interface HostReschedulePageData extends DashboardChrome {
  booking: Booking
  eventType: EventType | null
  /** Slots grouped by host-local day, in order. Absent when `blocked` is set. */
  days?: Array<{ date: string; slots: Slot[] }>
  /** Why the booking cannot be moved, when it cannot. */
  blocked?: string
  /** The time the host picked, awaiting confirmation. */
  newStart?: number
  error?: string
}

/**
 * The host's picker: the next two weeks of the event type's slots, in the
 * HOST's zone (the guest's is shown on the confirm step). Every slot is a
 * link to `?start=`, and the confirm step is a form — the same two-step
 * shape as the guest's picker, so a misclick on a slot moves nothing.
 */
export function hostReschedulePage(d: HostReschedulePageData): string {
  const b = d.booking
  const title = d.eventType?.title ?? 'Meeting'
  const path = `/dashboard/bookings/${encodeURIComponent(b.id)}`
  const tz = d.user.tz

  let body: string
  if (d.blocked) {
    body = `<section class="pu-card"><p class="pu-muted">${escapeHtml(d.blocked)}</p>
  <p><a class="pu-btn pu-btn-ghost" href="${path}">Back to the booking</a></p></section>`
  } else if (d.newStart !== undefined) {
    const end = d.newStart + (b.endUtc - b.startUtc)
    body = `<section class="pu-card" aria-label="Confirm new time">
  <h2>Move to this time?</h2>
  <dl class="pu-booking-facts">
    <dt>New time</dt>
    <dd><span class="pu-time">${escapeHtml(spanInZone(d.newStart, end, tz))}</span>
      <span class="pu-muted">${escapeHtml(tz)}</span></dd>
    ${
      b.guestTimezone !== tz
        ? `<dt>For the guest</dt>
    <dd><span class="pu-time">${escapeHtml(spanInZone(d.newStart, end, b.guestTimezone))}</span>
      <span class="pu-muted">${escapeHtml(b.guestTimezone)}</span></dd>`
        : ''
    }
    <dt>Was</dt>
    <dd><span class="pu-time" style="text-decoration:line-through">${escapeHtml(spanInZone(b.startUtc, b.endUtc, tz))}</span></dd>
  </dl>
  <form method="post" action="${path}/reschedule">
    ${csrfField(d.csrf)}
    <input type="hidden" name="start" value="${d.newStart}">
    <p class="pu-help">${escapeHtml(b.guestName)} is emailed the new time; their calendar invite is updated.</p>
    <div style="display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="pu-btn" type="submit">Move booking</button>
      <a class="pu-btn pu-btn-ghost" href="${path}/reschedule">Pick another</a>
    </div>
  </form>
</section>`
  } else {
    const days = d.days ?? []
    const groups =
      days.length === 0
        ? '<p class="pu-muted">No open times in the next two weeks. Check your availability, or free a slot first.</p>'
        : days
            .map((day) => {
              const heading = formatInZone(day.slots[0]!.start, tz, { weekday: 'long', month: 'long', day: 'numeric' })
              const slots = day.slots
                .map((s) => {
                  const label = formatInZone(s.start, tz, { hour: 'numeric', minute: '2-digit' })
                  return `<a class="${slotStateClassName('available')}" href="${path}/reschedule?start=${s.start}">
        <time datetime="${new Date(s.start).toISOString()}">${escapeHtml(label)}</time></a>`
                })
                .join('\n      ')
              return `<h3 class="pu-day-heading">${escapeHtml(heading)}</h3>
    <div class="pu-slots">
      ${slots}
    </div>`
            })
            .join('\n    ')
    body = `<section class="pu-card" aria-label="Pick a new time">
  <p class="pu-muted" style="font-size:.8125rem">Currently <span class="pu-time">${escapeHtml(spanInZone(b.startUtc, b.endUtc, tz))}</span> · times in ${escapeHtml(tz)} (${escapeHtml(offsetLabel(Date.now(), tz))})</p>
  ${d.error ? `<p class="pu-err" role="alert">${escapeHtml(d.error)}</p>` : ''}
    ${groups}
</section>`
  }

  return (
    shellTop(d, `Reschedule · ${title}`, 'bookings') +
    `<p class="pu-muted" style="margin:0 0 .5rem;font-size:.875rem"><a href="${path}">&larr; ${escapeHtml(title)} with ${escapeHtml(b.guestName)}</a></p>
<h1>Reschedule</h1>
${body}` +
    shellBottom(d.brandName)
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

/** Which line of the questions box could not be read, and why. */
export interface QuestionsParseError {
  /** 1-based, counting blank lines too, so it matches what the host sees in the box. */
  line: number
  text: string
  reason: string
}

/**
 * `Label | type | required | a, b` per line. Null on malformed input; see
 * `questionsParseError` for the message that names the line.
 *
 * The id is derived from the label rather than kept hidden in the form: this
 * editor has no client JS to carry ids around, and a stable derivation gives
 * the same id back for an unchanged label. Renaming a question therefore
 * changes its id and orphans answers already stored under the old one — which
 * is the honest outcome, since a renamed question is usually a different
 * question.
 */
export function parseQuestions(text: string): EventTypeQuestion[] | null {
  const result = parseQuestionLines(text)
  return Array.isArray(result) ? result : null
}

/**
 * The form message for a questions box that did not parse — quoting the
 * offending line, because "check the format" against ten lines of text sends
 * the host back to re-read all ten. Null when the text parses.
 */
export function questionsParseError(text: string): string | null {
  const result = parseQuestionLines(text)
  if (Array.isArray(result)) return null
  return `Line ${result.line} ("${result.text}"): ${result.reason}`
}

function parseQuestionLines(text: string): EventTypeQuestion[] | QuestionsParseError {
  const out: EventTypeQuestion[] = []
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    const fail = (reason: string): QuestionsParseError => ({ line: i + 1, text: line, reason })
    const parts = line.split('|').map((p) => p.trim())
    const label = parts[0] ?? ''
    if (label === '') return fail('the label before the first | is missing')
    if (label.length > 200) return fail('the label is over 200 characters')

    const type = (parts[1] ?? 'text') as EventTypeQuestion['type']
    if (!QUESTION_TYPES.includes(type)) return fail(`the type must be text, textarea or select, not "${type}"`)

    const requiredWord = (parts[2] ?? 'optional').toLowerCase()
    if (requiredWord !== 'required' && requiredWord !== 'optional') {
      return fail(`the third part must be required or optional, not "${parts[2]}"`)
    }

    const options = (parts[3] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o !== '')
    if (type === 'select' && options.length === 0) return fail('a select needs its options after a fourth |, separated by commas')

    let id = slugify(label)
    if (id === '') return fail('the label needs at least one letter or number')
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
            <button class="pu-btn pu-btn-ghost" type="submit" style="padding:.3rem .6rem;font-size:.8125rem;white-space:nowrap">
              ${u.role === 'admin' ? 'Remove admin' : 'Make admin'}</button>
          </form>`
      return `<tr>
        <td>${escapeHtml(u.name || u.slug)}${isSelf ? ' <span class="pu-muted">(you)</span>' : ''}<br>
          <span class="pu-muted" style="font-size:.8125rem">${escapeHtml(u.email)}</span></td>
        <td class="pu-time" style="white-space:nowrap">/${escapeHtml(u.slug)}</td>
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
      <span><strong>Closed</strong> — existing users only; nobody new can register<br>
        <span class="pu-muted" style="font-size:.8125rem">To add someone later, switch to Allowlist and enter their email.</span></span>
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
    // Title and lede above the cards, same shape as Settings, Calendars and
    // API keys — an <h1> inside the sign-ups card made it read as that
    // card's heading. The table keeps an inline width floor as a fallback
    // for the shared .pu-dash-table rule: on a phone the wrapper scrolls
    // rather than squeezing four columns into one-word-per-line cells.
    `<section aria-label="Admin">
  <h1>Admin</h1>
  <p class="pu-muted">Who may join this instance, and who runs it.</p>
<section class="pu-card" aria-label="Sign-ups" style="margin-bottom:1.25rem">
  <h2>Sign-ups</h2>
  <p class="pu-muted">Who may create an account on this instance. Existing users always sign in.</p>
  ${signupsBody}
</section>
<section class="pu-card" aria-label="Users">
  <h2>Users</h2>
  ${fieldError('role', errors)}
  <div class="pu-docs-table-wrap"><table class="pu-dash-table" style="width:100%;min-width:30rem">
    <thead><tr><th scope="col" style="text-align:left">User</th><th scope="col" style="text-align:left">Booking page</th>
      <th scope="col" style="text-align:left">Role</th><th scope="col" style="text-align:left"><span class="pu-sr">Actions</span></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>
</section>` +
    shellBottom(d.brandName)
  )
}
