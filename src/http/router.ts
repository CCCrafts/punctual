/**
 * HTTP routing (spec §5.1).
 *
 * Two consistency worlds meet here, and keeping them straight is the point:
 *
 *   public booking pages → `unconstrained`, reading the nearest replica,
 *     because listings are advisory and the commit path arbitrates
 *   host dashboard + commits → `bookmark`, because a host must never read a
 *     replica older than their own last write
 *
 * (ADR-0007 §2.)
 */

import { Hono, type Context } from 'hono'
import { streamPage } from './streaming.js'
import { buildApiRoutes } from './api/rest.js'
import { buildMcpRoutes } from './mcp/server.js'
import { buildEmbedRoutes } from './embed.js'
import { buildDashboardRoutes } from './dashboard-routes.js'
import { buildOgRoutes } from './og/route.js'
import { buildAvatarRoutes } from './avatars/route.js'
import { privacyPage, termsPage } from './pages/legal.js'
import { calendlyAlternativePage, landingPage } from './pages/landing.js'
import { docsApiPage, docsIndexPage, docsMcpPage, docsSelfHostingPage } from './pages/docs.js'
import type { EnginePorts, RequestScope } from '../ports.js'
import type { SlotService } from '../engine.js'
import { daysWithSlots, monthRange } from '../engine.js'
import type { User } from '../core/domain/types.js'
import { hostUsers as hostUsers_, resolveHosts as resolveEventTypeHosts } from '../core/domain/hosts.js'
import { isValidTimeZone, localDateString } from '../core/time/zone.js'
import {
  bookedConfirmation,
  confirmForm,
  displayCompany,
  errorPage,
  eventHeader,
  monthGrid,
  shellFoot,
  shellHead,
  slotList,
  slotTakenPage,
  type BookingPageData,
  hostsRow,
  joinNames,
} from './pages/booking.js'

type Env = Record<string, unknown>

export function buildRouter(ports: EnginePorts, slots: SlotService): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  const publicScope: RequestScope = { consistency: 'unconstrained' }

  // `ok` stays a pure liveness signal — a deployment deliberately running
  // without an email provider (local dev, a first boot) is UP, and flipping
  // `ok` to false for it would train whoever wired the monitor to ignore the
  // field. Degradations that are invisible from the outside go in `warnings`
  // instead, so a monitor can alert on `warnings.length > 0` and a human can
  // curl this and immediately see what is silently not happening.
  app.get('/health', (c) => {
    const warnings: string[] = []
    if (ports.config.emailDelivery === 'console') {
      warnings.push(
        'email_not_configured: no RESEND_API_KEY or BREVO_API_KEY — booking confirmations, ' +
          'reschedule and cancellation notices and reminders are logged, not delivered',
      )
    }
    return c.json({
      ok: true,
      service: 'punctual',
      emailDelivery: ports.config.emailDelivery,
      warnings,
    })
  })

  // Marketing landing page and docs index. Registered before every other
  // route so they win regardless of what else claims '/' — same reasoning as
  // the /privacy and /terms mounts below.
  app.get('/', (c) =>
    c.html(
      landingPage({
        brandName: ports.config.brandName,
        baseUrl: ports.config.baseUrl,
        ...(ports.config.demoBookingPath ? { demoPath: ports.config.demoBookingPath } : {}),
        ...(ports.config.legalOperator ? { operator: ports.config.legalOperator } : {}),
        ...(ports.config.analyticsId ? { analyticsId: ports.config.analyticsId } : {}),
      }),
    ),
  )
  app.get('/docs', (c) =>
    c.html(
      docsIndexPage({
        brandName: ports.config.brandName,
        baseUrl: ports.config.baseUrl,
        ...(ports.config.legalOperator ? { operator: ports.config.legalOperator } : {}),
        ...(ports.config.analyticsId ? { analyticsId: ports.config.analyticsId } : {}),
      }),
    ),
  )
  app.get('/docs/self-hosting', (c) =>
    c.html(
      docsSelfHostingPage({
        brandName: ports.config.brandName,
        baseUrl: ports.config.baseUrl,
        ...(ports.config.legalOperator ? { operator: ports.config.legalOperator } : {}),
        ...(ports.config.analyticsId ? { analyticsId: ports.config.analyticsId } : {}),
      }),
    ),
  )
  app.get('/docs/api', (c) =>
    c.html(
      docsApiPage({
        brandName: ports.config.brandName,
        baseUrl: ports.config.baseUrl,
        ...(ports.config.legalOperator ? { operator: ports.config.legalOperator } : {}),
        ...(ports.config.analyticsId ? { analyticsId: ports.config.analyticsId } : {}),
      }),
    ),
  )
  app.get('/docs/mcp', (c) =>
    c.html(
      docsMcpPage({
        brandName: ports.config.brandName,
        baseUrl: ports.config.baseUrl,
        ...(ports.config.legalOperator ? { operator: ports.config.legalOperator } : {}),
        ...(ports.config.analyticsId ? { analyticsId: ports.config.analyticsId } : {}),
      }),
    ),
  )
  app.get('/calendly-alternative', (c) =>
    c.html(
      calendlyAlternativePage({
        brandName: ports.config.brandName,
        baseUrl: ports.config.baseUrl,
        ...(ports.config.legalOperator ? { operator: ports.config.legalOperator } : {}),
        ...(ports.config.analyticsId ? { analyticsId: ports.config.analyticsId } : {}),
      }),
    ),
  )

  // Programmatic surfaces. Mounted before the /:userSlug/:eventSlug catch-all
  // so a host cannot claim the slug "api" and shadow them.
  app.route('/api/v1', buildApiRoutes(ports, slots))
  // The MCP sub-app registers its handlers at '/', so it mounts at '/mcp'.
  app.route('/mcp', buildMcpRoutes(ports, slots))
  app.route('/', buildEmbedRoutes(ports))

  // Dashboard, auth and guest-manage routes. Mount order is load-bearing:
  // `/:userSlug/:eventSlug` below swallows ANY two-segment path, so
  // `/dashboard/event-types` would resolve as a booking page for a host called
  // "dashboard" if this came after it.
  app.route('/', buildDashboardRoutes(ports, slots))

  // Google's OAuth verification checks that both URLs resolve and describe the
  // handling of the scopes actually requested; a missing or generic page is a
  // common rejection. Registered before the /:userSlug/:eventSlug catch-all.
  const legal = () => ({
    brandName: ports.config.brandName,
    supportEmail: ports.config.supportEmail,
    baseUrl: ports.config.baseUrl,
    // The actual data controller — Google's OAuth verification checks this
    // against the real legal entity behind the app, and "Punctual" (the
    // brand name) alone is not one. Deployment-configured (LEGAL_OPERATOR),
    // not hardcoded: this file ships to every self-hoster, and hardcoding
    // one company's name here would put it on every deployment's own
    // privacy policy regardless of who actually operates it.
    ...(ports.config.legalOperator ? { operator: ports.config.legalOperator } : {}),
  })
  app.get('/privacy', (c) =>
    c.html(
      shellHead({ title: `Privacy · ${ports.config.brandName}`, brandName: ports.config.brandName }) +
        privacyPage(legal()) +
        shellFoot(),
    ),
  )
  app.get('/terms', (c) =>
    c.html(
      shellHead({ title: `Terms · ${ports.config.brandName}`, brandName: ports.config.brandName }) +
        termsPage(legal()) +
        shellFoot(),
    ),
  )

  app.get('/favicon.svg', (c) =>
    c.body(FAVICON, 200, {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=86400',
    }),
  )

  // /og/:userSlug/:eventSlug.png. Three path segments, so it never
  // collides with the two-segment catch-all below regardless of mount order —
  // registered here anyway for the same reason as everything else above it.
  app.route('/', buildOgRoutes(ports))

  // /avatars/:key — single segment under a reserved first path
  // component, so it never collides with the two-segment catch-all below
  // either. `avatars` is reserved in `core/domain/slugs.ts` for this reason.
  app.route('/', buildAvatarRoutes(ports))

  // -------------------------------------------------------------------------
  // Booking page: /:userSlug/:eventSlug
  // -------------------------------------------------------------------------
  app.get('/:userSlug/:eventSlug', async (c) => {
    const denied = await bookingPageRateLimited(ports, c)
    if (denied) return denied

    const repos = ports.repositories(publicScope)
    const { userSlug, eventSlug } = c.req.param()

    // One round trip, not two awaits — see EventTypeRepository.bookingPageContext.
    const ctx = await repos.eventTypes.bookingPageContext(userSlug, eventSlug)
    if (!ctx) return notFound(c, ports)
    const { host, eventType, team } = ctx

    const guestTimezone = resolveGuestTimezone(c.req.query('tz'), c.req.raw, host.tz)
    const embed = c.req.query('embed') === '1'
    const currentMonth = localDateString(ports.clock.now(), host.tz).slice(0, 7)
    // The floor `clampMonth` snaps back to, below: the EARLIER of
    // the two parties' current months, not just the host's. A guest near the
    // opposite extreme of the date line from the host can have their own
    // "today" fall a calendar month behind the host's — Kiritimati (UTC+14)
    // already on Sep 1 while Los Angeles (UTC-7) is still on Aug 31 — and a
    // host-only floor clamped exactly that guest's default "today" away,
    // onto a month grid with no cell for it. This leaves the CEILING
    // (maxHorizonDays) anchored purely to the host's month below, unchanged:
    // that is a host-local scheduling constraint, not something a guest's
    // timezone should stretch or shrink.
    const guestCurrentMonth = localDateString(ports.clock.now(), guestTimezone).slice(0, 7)
    const monthFloor = guestCurrentMonth < currentMonth ? guestCurrentMonth : currentMonth
    // Clamp to the event type's own horizon. Without this, walking ?month=
    // forever mints a new freeBusy cache key each time and forces one live
    // provider call per connection per request — which burns the deployment's
    // Google/Graph quota and eventually degrades conflict checking for every
    // host on it.
    const dateParam = validDate(c.req.query('date'))
    const monthParam = validMonth(c.req.query('month'))
    // No `?date=` AND no `?month=` means a fresh page load (every calendar/
    // day link the page itself renders always includes at least one of
    // them), which used to leave the day list unset and render "Pick a day
    // to see available times" even when today has open slots right there in
    // the calendar. Defaulting to the GUEST's own today — not the host's —
    // matches what `daysWithSlots`/the day filter below are already keyed
    // on, so the auto-selected day always lines up with a real bucket in
    // that map instead of occasionally landing on a host-local date the
    // guest-local calendar never marks.
    //
    // Guarded on `monthParam` too (caught by review): the Previous/Next
    // month links carry `?month=` alone, no `?date=`. Defaulting
    // unconditionally there re-applied THIS month's "today" as the selected
    // date against a DIFFERENT month's slot set, rendering a bogus "No times
    // available on this day" instead of just the calendar for browsing.
    const requestedDate = dateParam ?? (monthParam ? undefined : localDateString(ports.clock.now(), guestTimezone))
    // A selected date decides the month. Slots are computed for ONE month and
    // the day view filters that set, so taking the month from `?month=` alone
    // meant picking any day outside the current month returned "No times
    // available" — the calendar offered days it then refused to show.
    const month = clampMonth(
      monthParam ?? requestedDate?.slice(0, 7) ?? currentMonth,
      monthFloor,
      currentMonth,
      eventType.maxHorizonDays,
    )
    // Dropped when the clamp moved the calendar off the selected day's own
    // month (caught by review). `currentMonth` is HOST-local while the
    // default above is GUEST-local, so on a date-line split at a month
    // boundary — host already on Sep 1, guest still on Aug 31 — the clamp
    // pulls the calendar to September while the day list would still be
    // filtering for August 31. Rendering a day panel for a month the
    // calendar beside it isn't showing is worse than falling back to "pick
    // a day": the slots it lists are unreachable from the visible grid.
    const selectedDate = requestedDate?.slice(0, 7) === month ? requestedDate : undefined

    // Flush the shell and the event header before touching D1 for slots: TTFB
    // then measures edge render rather than a replica round trip (ADR-0007 §3).
    // The header is safe to emit early because it comes from the context read
    // we already have.
    const headerData: BookingPageData = {
      host,
      team,
      ownerSlug: userSlug,
      eventType,
      month,
      daysWithSlots: new Map(),
      selectedDate,
      guestTimezone,
      baseUrl: ports.config.baseUrl,
      embed,
    }

    const head =
      shellHead({
        title: `${eventType.title} · ${team ? team.name : host.name || host.slug}`,
        description: eventType.description || undefined,
        brandName: ports.config.brandName,
        // The one link that's actually meant to be shared — a host posts it
        // in an email signature or a chat app, so it's the one page in the
        // whole engine worth unfurling. /og/:userSlug/:eventSlug.png
        // renders "Book N min with {host}" on first hit and falls back to the
        // static default card on any failure — see src/http/og/route.ts.
        og: {
          url: `${ports.config.baseUrl.replace(/\/$/, '')}/${userSlug}/${eventSlug}`,
          image: `${ports.config.baseUrl.replace(/\/$/, '')}/og/${userSlug}/${eventSlug}.png`,
        },
      }) + eventHeader(headerData)

    return streamPage(head, async () => {
      const resolved = await resolveEventTypeHosts(repos, eventType, host)
      const hostUsers = hostUsers_(resolved)

      // Month view drives the calendar; a selected day narrows the slot list.
      // The calendar and the day filter both key on guestTimezone, but slots
      // are generated for a HOST-local month — so a guest far enough from the
      // host's offset can have a local month edge that spills a day outside
      // the host-local month's UTC range. Padding the query window by a day
      // on each side covers that edge without changing what "month" means for
      // the host-local scheduling constraints (per-day cap, max horizon).
      const DAY_MS = 24 * 60 * 60 * 1000
      const hostMonthRange = monthRange(month, host.tz)
      const monthSlots = await slots.forEventType({
        eventType,
        hostUsers,
        range: { start: hostMonthRange.start - DAY_MS, end: hostMonthRange.end + DAY_MS },
        scope: publicScope,
      })

      const daySlots = selectedDate
        ? monthSlots.filter((s) => localDateString(s.start, guestTimezone) === selectedDate)
        : undefined

      const data: BookingPageData = {
        ...headerData,
        hosts: resolved,
        // Keyed on guestTimezone to match the day filter above — otherwise a
        // day the calendar marks bookable can filter to zero slots (or vice
        // versa) once the guest's local date diverges from the host's.
        daysWithSlots: daysWithSlots(monthSlots, guestTimezone),
        selectedDate,
        slots: daySlots,
      }

      return `${hostsRow(data)}<div class="pu-grid">${monthGrid(data)}${slotList(data)}</div>`
    }, shellFoot(true, embed, displayCompany(headerData)))
  })

  // -------------------------------------------------------------------------
  // Confirm form
  // -------------------------------------------------------------------------
  app.get('/:userSlug/:eventSlug/confirm', async (c) => {
    const denied = await bookingPageRateLimited(ports, c)
    if (denied) return denied

    const repos = ports.repositories(publicScope)
    const { userSlug, eventSlug } = c.req.param()
    const ctx = await repos.eventTypes.bookingPageContext(userSlug, eventSlug)
    if (!ctx) return notFound(c, ports)
    const { host, eventType, team } = ctx

    const start = Number(c.req.query('start'))
    if (!Number.isSafeInteger(start) || Math.abs(start) > 8.64e15) return notFound(c, ports)
    const guestTimezone = resolveGuestTimezone(c.req.query('tz'), c.req.raw, host.tz)
    const embed = c.req.query('embed') === '1'

    const data: BookingPageData = {
      host,
      team,
      hosts: await resolveEventTypeHosts(repos, eventType, host),
      ownerSlug: userSlug,
      eventType,
      month: localDateString(start, host.tz).slice(0, 7),
      daysWithSlots: new Map(),
      guestTimezone,
      baseUrl: ports.config.baseUrl,
      embed,
      confirmStart: start,
    }

    const html =
      shellHead({ title: `Confirm · ${eventType.title}`, brandName: ports.config.brandName }) +
      eventHeader(data) +
      hostsRow(data) +
      confirmForm(data, start) +
      shellFoot(true, embed, displayCompany(data))
    return c.html(html)
  })

  // -------------------------------------------------------------------------
  // Commit — the only place a booking is written
  // -------------------------------------------------------------------------
  app.post('/:userSlug/:eventSlug/confirm', async (c) => {
    const { userSlug, eventSlug } = c.req.param()
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown'

    // Abuse limit, not a plan quota (ADR-0006 §3).
    const limit = await ports.rateLimiter.check('booking:ip', ip, 10, 3600)
    if (!limit.allowed) {
      return c.html(
        shellHead({ title: 'Too many requests', brandName: ports.config.brandName }) +
          errorPage('Too many bookings', 'Please wait a little and try again.') +
          shellFoot(),
        429,
        { 'retry-after': String(Math.ceil((limit.resetAt - ports.clock.now()) / 1000)) },
      )
    }

    // The commit path reads its own writes.
    const repos = ports.repositories({ consistency: 'bookmark' })
    const ctx = await repos.eventTypes.bookingPageContext(userSlug, eventSlug)
    if (!ctx) return notFound(c, ports)
    const { host, eventType, team } = ctx

    const form = await c.req.formData()
    const start = Number(form.get('start'))
    // Finite is not enough: 1e20 passes and then throws inside Intl, which
    // surfaces as a bare 500. 8.64e15 is the JS Date range.
    if (!Number.isSafeInteger(start) || Math.abs(start) > 8.64e15) return notFound(c, ports)
    const guestTimezone = resolveGuestTimezone(String(form.get('tz') ?? ''), c.req.raw, host.tz)
    const name = String(form.get('name') ?? '').trim()
    const email = String(form.get('email') ?? '').trim()
    const holdId = form.get('hold') ? String(form.get('hold')) : undefined
    // The form posts to a query-string-free action, so embed state only
    // survives as the hidden field `confirmForm` renders — see booking.ts.
    const embed = form.get('embed') === '1'

    const answers: Record<string, string> = {}
    for (const [k, v] of form.entries()) {
      if (k.startsWith('q_')) answers[k.slice(2)] = String(v)
    }

    const data: BookingPageData = {
      host,
      team,
      hosts: await resolveEventTypeHosts(repos, eventType, host),
      ownerSlug: userSlug,
      eventType,
      month: localDateString(start, host.tz).slice(0, 7),
      daysWithSlots: new Map(),
      guestTimezone,
      baseUrl: ports.config.baseUrl,
      embed,
      confirmStart: start,
    }

    const { validateAnswers, isValidEmail, pickDeclaredAnswers } = await import(
      '../core/domain/booking-service.js'
    )
    const declared = pickDeclaredAnswers(eventType, answers)
    const errors = validateAnswers(eventType, declared)
    if (name === '') errors['name'] = 'Please tell us your name'
    // REST and MCP both cap this at 200; the public form did not. An oversized
    // name pushes the queued email past Cloudflare's 128 KB message limit, and
    // BOTH confirmations are lost while the slot stays booked.
    else if (name.length > 200) errors['name'] = 'Please use 200 characters or fewer'
    if (!isValidEmail(email)) errors['email'] = 'Please enter a valid email address'

    if (Object.keys(errors).length > 0) {
      return c.html(
        shellHead({ title: `Confirm · ${eventType.title}`, brandName: ports.config.brandName }) +
          eventHeader(data) +
          // `declared` (not raw `answers`): a stale-form submission that
          // posted under the built-in q_agenda key while the event type's
          // effective question has a different id needs to reappear under
          // THAT id, or confirmForm's `values[q.id]` lookup renders it as
          // empty and the guest's typed text looks lost on the error page.
          confirmForm(data, start, { errors, values: { name, email, ...declared }, holdId }) +
          shellFoot(true, embed, displayCompany(data)),
        400,
      )
    }

    const hostUsers = data.hosts ? hostUsers_(data.hosts) : [host]
    const outcome = await ports.coordinator.book(host.id, {
      eventTypeId: eventType.id,
      hostUserIds: hostUsers.map((u) => u.id),
      start,
      end: start + eventType.durationMinutes * 60_000,
      guestName: name,
      guestEmail: email,
      guestTimezone,
      answers: declared,
      holdId,
      idempotencyKey: c.req.header('idempotency-key') ?? undefined,
    })

    if (!outcome.ok) {
      // A listed slot can be lost — replicas lag, and round-robin listings are
      // advisory about who. Expected, so it reads as a step, not a failure.
      const body =
        outcome.reason === 'slot_taken' || outcome.reason === 'outside_availability'
          ? slotTakenPage(data, localDateString(start, guestTimezone))
          : errorPage('Could not complete booking', outcome.detail ?? 'Please try another time.')
      return c.html(
        shellHead({ title: 'Time unavailable', brandName: ports.config.brandName }) +
          eventHeader(data) +
          body +
          shellFoot(true, embed, displayCompany(data)),
        409,
      )
    }

    // Without the token this button is a 400 — the "Reschedule or cancel"
    // link on the just-booked page was dead.
    const manageUrl =
      `${ports.config.baseUrl}/booking/${outcome.booking.id}` +
      (outcome.manageToken ? `?token=${encodeURIComponent(outcome.manageToken)}` : '')
    return c.html(
      shellHead({ title: 'Booked', brandName: ports.config.brandName }) +
        bookedConfirmation({
          eventTitle: eventType.title,
          // Who actually attends — the round-robin pick, or the required
          // hosts plus the optional ones that were free — not the page's
          // representative member.
          hostName: joinNames(
            outcome.booking.hostUserIds
              .map((id) => hostUsers.find((u) => u.id === id))
              .filter((u): u is User => u !== undefined)
              .map((u) => u.name || u.slug),
          ) || host.name || host.slug,
          start: outcome.booking.startUtc,
          guestTimezone,
          manageUrl,
        }) +
        shellFoot(true, embed, displayCompany(data)),
    )
  })

  app.notFound((c) => notFound(c, ports))

  return app
}

// ---------------------------------------------------------------------------


/**
 * The guest's timezone.
 *
 * Explicit query parameter wins, then Cloudflare's `cf.timezone` (free, no
 * client JS, no round trip), then the host's zone as a last resort. An invalid
 * IANA name is rejected rather than passed to Intl, where it would throw deep
 * inside slot rendering.
 */
function resolveGuestTimezone(param: string | undefined, req: Request, fallback: string): string {
  if (param && isValidTimeZone(param)) return param
  const cf = (req as { cf?: { timezone?: string } }).cf?.timezone
  if (cf && isValidTimeZone(cf)) return cf
  return fallback
}

function validMonth(v: string | undefined): string | undefined {
  return v && /^\d{4}-\d{2}$/.test(v) ? v : undefined
}

/**
 * Keep `month` inside [floorMonth, horizonAnchorMonth + horizonDays];
 * anything else snaps back.
 *
 * The floor and the horizon anchor are deliberately separate parameters
 *, not the same "current month" used for both: the floor exists so
 * a guest's own default "today" is never clamped away by a HOST-local month
 * that has already ticked over across a date-line split (host already on
 * Sep 1, guest still on Aug 31) — the caller passes it the earlier of the
 * two parties' current months. The ceiling stays anchored purely to the
 * host's month regardless, because `maxHorizonDays` is a host-local
 * scheduling constraint (how far out the host accepts bookings), not
 * something a guest's timezone should be able to stretch or shrink.
 */
export function clampMonth(month: string, floorMonth: string, horizonAnchorMonth: string, horizonDays: number): string {
  if (month < floorMonth) return floorMonth
  const [cy, cm] = horizonAnchorMonth.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(cy, cm - 1 + Math.ceil(Math.max(0, horizonDays) / 28), 1))
  const lastMonth = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`
  return month > lastMonth ? lastMonth : month
}

function validDate(v: string | undefined): string | undefined {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined
}

/** Hono's `c.html` can return a promise, so the helper mirrors that. */
function notFound(c: Context<{ Bindings: Env }>, ports: EnginePorts): Response | Promise<Response> {
  return c.html(
    shellHead({ title: 'Not found', brandName: ports.config.brandName }) +
      errorPage('Not found', 'That booking page does not exist.') +
      shellFoot(),
    404,
  )
}

/**
 * Abuse limit on the public booking-page GETs (ADR-0006 §3 — same philosophy
 * as the POST confirm route's `booking:ip` check above: uniform per
 * deployment, generous enough that no real guest ever meets it, tunable
 * upward by the operator).
 *
 * These are unauthenticated, D1-reading endpoints with no limit at all
 * before this change. Month-walking is already clamped to the event type's
 * horizon, so this is no longer an amplification vector into freeBusy calls
 * — but the page render itself still costs a real `bookingPageContext` read
 * (and, for the calendar view, a month of slot computation) per request, and
 * an attacker or bot can otherwise hammer it for free.
 *
 * 120 requests/minute/IP: a real guest browsing a calendar, flipping months
 * and reloading does not sustain anywhere near 2 requests/sec for a full
 * minute, while a script hammering the page hits this quickly. That is
 * roughly 700x the POST route's 10/hour limit, deliberately — GET traffic
 * from one guest across an embed, a shared link opened by several tabs, or a
 * flaky connection retrying is normal in a way that repeated booking
 * *attempts* are not.
 */
async function bookingPageRateLimited(
  ports: EnginePorts,
  c: Context<{ Bindings: Env }>,
): Promise<Response | Promise<Response> | undefined> {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  const limit = await ports.rateLimiter.check('booking_page:ip', ip, 120, 60)
  if (limit.allowed) return undefined
  return c.html(
    shellHead({ title: 'Too many requests', brandName: ports.config.brandName }) +
      errorPage('Too many requests', 'Please wait a little and try again.') +
      shellFoot(),
    429,
    { 'retry-after': String(Math.ceil((limit.resetAt - ports.clock.now()) / 1000)) },
  )
}

/** The colon mark on an ink tile (docs/branding). Inline to avoid an asset fetch. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#0F1512"/>
<rect x="13" y="9" width="6" height="6" rx="2" fill="#1FC16B"/>
<rect x="13" y="19" width="6" height="6" rx="2" fill="#1FC16B"/>
</svg>`
