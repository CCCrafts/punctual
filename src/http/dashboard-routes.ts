/**
 * Authenticated routes: sign-in, the host dashboard, and the guest manage page
 * (spec §5.1, ADR-0005, ADR-0007 §2).
 *
 * Returned as a sub-app so the composition root decides where it mounts —
 * `buildRouter` owns `/:userSlug/:eventSlug`, which would otherwise swallow
 * every two-segment path registered here.
 *
 * Three invariants run through the file:
 *
 *  1. **Identity and calendar consent are different flows** (ADR-0005 §1).
 *     `/auth/:provider/start?purpose=identity` asks for `openid email profile`
 *     and ends in a session; `?purpose=calendar` asks for calendar scopes and
 *     ends in a `calendar_connections` row. They have different redirect URIs
 *     (the `purpose` is part of the registered URI, see `oauth.ts`), different
 *     preconditions — connecting requires a session, signing in must not — and
 *     an authorization code issued for one is useless at the other.
 *
 *  2. **Every mutating dashboard request verifies a CSRF token** (ADR-0005 §5),
 *     derived from the session id hash rather than stored. Two POST families
 *     legitimately have none, for the same reason the booking page has none:
 *     they carry no session and therefore no ambient authority — `POST /login`
 *     (no session exists yet; rate limits bound it) and the guest manage
 *     endpoints (the signed token IS the credential, ADR-0005 §4).
 *
 *  3. **Every dashboard read is bookmark-constrained** (ADR-0007 §2). A host
 *     who just saved their availability must not then read a replica that has
 *     not seen it. The bookmark lives on the session row and is advanced after
 *     each write.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { notifyBookingCancelled, notifyBookingRescheduled } from '../adapters/notify.js'
import type {
  CalendarProviderName,
  EnginePorts,
  Repositories,
  RequestScope,
} from '../ports.js'
import type { SlotService } from '../engine.js'
import type {
  Availability,
  Booking,
  CalendarConnection,
  EventType,
  Session,
  User,
  WeeklySchedule,
} from '../core/domain/types.js'
import {
  SESSION_COOKIE_NAME,
  constantTimeEqual,
  csrfTokenFor,
  parseManageToken,
  serializeSessionCookie,
  sessionCookieOptions,
  verifyCsrf,
  type ManageTokenPurpose,
} from '../core/domain/auth-service.js'
import {
  consumeMagicLink,
  createApiKey,
  requestMagicLink,
  revokeSession,
  validateSession,
  verifyManageToken,
} from '../core/domain/auth-flows.js'
import { OAUTH_ENDPOINTS, scopesFor, type OAuthPurpose } from '../adapters/oauth.js'
import { dayRange } from '../engine.js'
import { isValidTimeZone, localDateString } from '../core/time/zone.js'
import { validateSlug } from '../core/domain/slugs.js'
import {
  MAX_DECODED_PIXELS,
  MAX_UPLOAD_BYTES,
  THUMB_CONTENT_TYPE,
  deriveBlobKey,
  isAllowedImageType,
  readImageDimensions,
  thumbKeyFor,
} from '../core/domain/media.js'
import { resizeToSquareThumbnail } from '../adapters/image/resize.js'
import { errorPage, shellFoot, shellHead } from './pages/booking.js'
import {
  CSRF_FIELD,
  apiKeysPage,
  availabilityPage,
  bookingDetailPage,
  connectionsPage,
  dashboardHome,
  eventTypeForm,
  loginPage,
  manageLinkErrorPage,
  parseOverrides,
  parseQuestions,
  parseWindows,
  settingsPage,
  slugify,
  type ConnectionView,
  type UpcomingBooking,
} from './pages/dashboard.js'

type Env = Record<string, unknown>

interface Vars {
  session: Session
  user: User
  /** Bookmark-constrained for the whole request (ADR-0007 §2). */
  repos: Repositories
  csrf: string
}

type App = Hono<{ Bindings: Env; Variables: Vars }>
type Ctx = Context<{ Bindings: Env; Variables: Vars }>

/** Slugs the router needs for itself; an event type may not claim them. */
const RESERVED_SLUGS = new Set([
  'auth',
  'booking',
  'dashboard',
  'favicon.svg',
  'health',
  'login',
  'logout',
])

/** How far ahead the dashboard lists bookings. */
const UPCOMING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

const OAUTH_STATE_COOKIE = 'punctual_oauth'
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export function buildDashboardRoutes(ports: EnginePorts, slots: SlotService): App {
  const app: App = new Hono<{ Bindings: Env; Variables: Vars }>()
  const brandName = ports.config.brandName
  const secureCookies = ports.config.baseUrl.startsWith('https://')
  const hash = (value: string): Promise<string> => ports.crypto.hash(value)

  // ===========================================================================
  // Session middleware
  // ===========================================================================

  /**
   * Resolve the cookie to a session and a user, or send the visitor to /login.
   *
   * Two repository instances, deliberately. The bookmark that pins this
   * request's reads is stored ON the session row, so the read that fetches it
   * cannot itself be pinned by it. The bootstrap instance is bookmark-mode with
   * no bookmark — the freshest thing available without knowing what to ask for
   * — and everything after it uses the session's own bookmark (ADR-0007 §2).
   */
  const requireSession: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
    const cookie = readCookie(c.req.header('cookie'), SESSION_COOKIE_NAME)
    const bootstrap = ports.repositories({ consistency: 'bookmark' })
    const auth = await validateSession(
      { repos: bootstrap, crypto: ports.crypto },
      cookie,
      ports.clock.now(),
    )
    if (!auth) return c.redirect('/login', 302)

    c.set('session', auth.session)
    c.set('user', auth.user)
    c.set('repos', ports.repositories(sessionScope(auth.session)))
    c.set('csrf', await csrfTokenFor(hash, auth.session.idHash))
    await next()
    return undefined
  }

  /** 403 unless the form carries this session's double-submit token. */
  async function csrfOk(c: Ctx, form: FormData): Promise<boolean> {
    return verifyCsrf(hash, c.get('session').idHash, String(form.get(CSRF_FIELD) ?? ''))
  }

  function csrfRejected(c: Ctx): Response | Promise<Response> {
    return c.html(
      shellHead({ title: 'Request not accepted', brandName }) +
        errorPage(
          'Request not accepted',
          'This form was submitted without a valid security token. Reload the page and try again.',
        ) +
        shellFoot(brandName),
      403,
    )
  }

  /**
   * Persist the bookmark produced by this request's writes.
   *
   * Without this the next request would pin to the bookmark from the write
   * BEFORE this one and could read a replica that has not caught up — the exact
   * "I saved it and it did not change" bug ADR-0007 §2 exists to prevent.
   */
  async function advanceBookmark(c: Ctx): Promise<void> {
    const repos = c.get('repos')
    const session = c.get('session')
    const bookmark = repos.bookmark()
    if (bookmark) await repos.sessions.touch(session.idHash, session.expiresAt, bookmark)
  }

  // ===========================================================================
  // Sign in
  // ===========================================================================

  app.get('/login', (c) => c.html(loginPage({ brandName, providers: ports.calendars.available() })))

  /**
   * Request a magic link.
   *
   * The response is the same page for an address with an account and one
   * without (ADR-0005 §3): `requestMagicLink` has no existence branch, and
   * nothing here adds one. Rate limiting lives inside the flow, per email and
   * per IP (ADR-0006 §3).
   */
  app.post('/login', async (c) => {
    const form = await c.req.formData()
    const email = String(form.get('email') ?? '').trim()

    const result = await requestMagicLink(
      {
        repos: ports.repositories({ consistency: 'bookmark' }),
        crypto: ports.crypto,
        email: ports.email,
        rateLimiter: ports.rateLimiter,
        config: ports.config,
      },
      {
        email,
        ip: c.req.header('cf-connecting-ip') ?? 'unknown',
        userAgent: c.req.header('user-agent') ?? '',
        now: ports.clock.now(),
      },
    )

    const providers = ports.calendars.available()
    if (result.status === 'malformed') {
      // Safe to distinguish: address SYNTAX is something the sender can compute
      // themselves. Account existence is not, and is never revealed.
      return c.html(
        loginPage({ brandName, providers, email, error: 'That does not look like an email address' }),
        400,
      )
    }
    if (result.status === 'rate_limited') {
      return c.html(
        loginPage({ brandName, providers, email, error: 'Too many attempts. Try again shortly.' }),
        429,
        { 'retry-after': String(result.retryAfterSeconds) },
      )
    }
    return c.html(loginPage({ brandName, providers, sent: true }))
  })

  /**
   * Redeem a magic link.
   *
   * Registered at two paths on purpose: `/auth/verify` is the name the
   * dashboard uses, and `/auth/callback` is the path baked into the link that
   * `requestMagicLink` emails. Both are the same handler so old mail keeps
   * working.
   */
  const verifyMagicLink = async (c: Ctx): Promise<Response> => {
    const token = c.req.query('token') ?? ''
    const repos = ports.repositories({ consistency: 'bookmark' })
    const result = await consumeMagicLink(
      { repos, crypto: ports.crypto },
      { token, now: ports.clock.now(), timezone: timezoneHint(c) },
    )
    if (!result.ok) {
      return c.html(
        loginPage({
          brandName,
          providers: ports.calendars.available(),
          error: 'That link has expired or was already used. Request a new one.',
        }),
        400,
      )
    }
    return startSession(c, result.sessionToken)
  }

  app.get('/auth/verify', verifyMagicLink)
  app.get('/auth/callback', verifyMagicLink)

  app.post('/logout', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const cookie = readCookie(c.req.header('cookie'), SESSION_COOKIE_NAME)
    if (cookie) await revokeSession({ repos: c.get('repos'), crypto: ports.crypto }, cookie)
    c.header('set-cookie', serializeSessionCookie('', sessionCookieOptions(secureCookies), 0))
    return c.redirect('/login', 302)
  })

  function startSession(c: Ctx, sessionToken: string): Response {
    c.header('set-cookie', serializeSessionCookie(sessionToken, sessionCookieOptions(secureCookies)))
    return c.redirect('/dashboard', 302)
  }

  // ===========================================================================
  // OAuth — identity and calendar are SEPARATE flows (ADR-0005 §1)
  // ===========================================================================

  app.get('/auth/:provider/start', async (c) => {
    const provider = validProvider(c.req.param('provider'))
    const purpose = validPurpose(c.req.query('purpose'))
    if (!provider || !purpose) return oauthError(c, 'Unknown sign-in method.')

    const creds = ports.oauth.forProvider(provider)
    if (!creds) {
      return oauthError(
        c,
        `${provider === 'google' ? 'Google' : 'Microsoft'} is not configured on this deployment.`,
      )
    }

    // Connecting a calendar attaches authorisation to an existing identity, so
    // it requires a session; signing in obviously must not (ADR-0005 §1).
    if (purpose === 'calendar') {
      const auth = await currentSession(c)
      if (!auth) return c.redirect('/login', 302)
    }

    // State is signed AND bound to a cookie: the signature stops a forged state
    // and the cookie stops an attacker completing their own authorization in
    // the victim's browser.
    const nonce = ports.crypto.randomToken(16)
    const exp = ports.clock.now() + OAUTH_STATE_TTL_MS
    const state = await signState(provider, purpose, exp, nonce)
    c.header(
      'set-cookie',
      `${OAUTH_STATE_COOKIE}=${nonce}; Path=/auth; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL_MS / 1000}; HttpOnly${
        secureCookies ? '; Secure' : ''
      }`,
    )

    const url = new URL(OAUTH_ENDPOINTS[provider].authorize)
    url.searchParams.set('client_id', creds.clientId)
    url.searchParams.set('redirect_uri', ports.oauth.redirectUri(provider, purpose))
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', scopesFor(provider, purpose).join(' '))
    url.searchParams.set('state', state)
    if (provider === 'google' && purpose === 'calendar') {
      // Only the calendar flow needs a refresh token, and Google issues one
      // only with offline access plus an explicit consent prompt.
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'consent')
    }
    return c.redirect(url.toString(), 302)
  })

  // Two registrations, one handler: Google's redirect URI carries `purpose`
  // as a query string; Microsoft's Entra app registration rejects a query
  // string on any redirect URI, so Microsoft's carries it as a path segment
  // instead (see `redirectUri` in oauth.ts). Whichever one is present wins —
  // a request only ever has one, since a provider echoes back exactly the
  // redirect_uri we registered and sent.
  const oauthCallback = async (c: Ctx): Promise<Response> => {
    const provider = validProvider(c.req.param('provider'))
    const purpose = validPurpose(c.req.param('purpose') ?? c.req.query('purpose'))
    if (!provider || !purpose) return oauthError(c, 'Unknown sign-in method.')

    // The provider reports a refused consent screen here; it is a normal
    // outcome, not an error to log.
    if (c.req.query('error')) return oauthError(c, 'The permission request was declined.')

    const state = c.req.query('state') ?? ''
    const nonce = readCookie(c.req.header('cookie'), OAUTH_STATE_COOKIE)
    if (!(await verifyState(provider, purpose, state, nonce))) {
      return oauthError(c, 'This sign-in attempt could not be verified. Start again.')
    }
    // One state, one use.
    c.header('set-cookie', `${OAUTH_STATE_COOKIE}=; Path=/auth; SameSite=Lax; Max-Age=0; HttpOnly`)

    const code = c.req.query('code') ?? ''
    if (code === '') return oauthError(c, 'The provider returned no authorization code.')

    const tokens = await exchangeCode(provider, purpose, code)
    if (!tokens) return oauthError(c, 'The provider rejected the sign-in. Please try again.')

    return purpose === 'identity'
      ? completeIdentity(c, provider, tokens)
      : completeCalendarConnect(c, provider, tokens)
  }
  app.get('/auth/:provider/callback', oauthCallback)
  app.get('/auth/:provider/callback/:purpose', oauthCallback)

  /**
   * Finish an identity sign-in.
   *
   * The address comes from the `id_token`, whose signature we do not check:
   * this token arrived in the body of a direct TLS response from the provider's
   * own token endpoint, which is the case OpenID Connect Core §3.1.3.7
   * explicitly exempts. A token forwarded by a third party would need
   * verification; one we fetched ourselves does not.
   */
  async function completeIdentity(
    c: Ctx,
    provider: CalendarProviderName,
    tokens: TokenResponse,
  ): Promise<Response> {
    const email = emailFromIdToken(tokens.idToken, provider)
    if (!email) return oauthError(c, 'The provider did not share an email address.')

    const now = ports.clock.now()
    const repos = ports.repositories({ consistency: 'bookmark' })

    // Reuse the magic-link redemption path rather than reimplementing
    // find-or-create and slug allocation. A verified OAuth address and a
    // redeemed magic link prove exactly the same thing — control of an email
    // address — so they must produce exactly the same account, and the only way
    // to guarantee that is to share the code.
    const linkToken = ports.crypto.randomToken(32)
    await repos.sessions.createMagicLink({
      tokenHash: await hash(linkToken),
      email,
      expiresAt: now + 60_000,
      createdAt: now,
    })
    const result = await consumeMagicLink(
      { repos, crypto: ports.crypto },
      { token: linkToken, now, timezone: timezoneHint(c) },
    )
    if (!result.ok) return oauthError(c, 'Could not complete sign-in. Please try again.')
    return startSession(c, result.sessionToken)
  }

  /**
   * Finish a calendar connection.
   *
   * The connection is assembled in memory and its calendars listed BEFORE the
   * row is written, so a host lands on a connection that already reads their
   * primary calendar instead of an empty one they must configure.
   */
  async function completeCalendarConnect(
    c: Ctx,
    provider: CalendarProviderName,
    tokens: TokenResponse,
  ): Promise<Response> {
    const auth = await currentSession(c)
    if (!auth) return c.redirect('/login', 302)

    const repos = ports.repositories(sessionScope(auth.session))
    const now = ports.clock.now()
    const id = `cal_${ports.crypto.randomToken(12)}`
    const { ciphertext, keyVersion } = await ports.crypto.encrypt(
      JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: now + tokens.expiresInMs,
        scope: tokens.scope,
      }),
      // AAD binds the ciphertext to this row (ADR-0005 §6).
      `${auth.user.id}|${provider}|${id}`,
    )

    const connection: CalendarConnection = {
      id,
      userId: auth.user.id,
      provider,
      providerAccountEmail: emailFromIdToken(tokens.idToken, provider) ?? '',
      encryptedTokens: ciphertext,
      keyVersion,
      calendarIdsRead: [],
      calendarIdWrite: null,
      syncStatus: 'ok',
      createdAt: now,
    }

    try {
      const calendars = await ports.calendars.get(provider).listCalendars(connection)
      const primary = calendars.find((cal) => cal.primary) ?? calendars[0]
      if (primary) {
        // Microsoft's `getBusy` keys on the mailbox SMTP address, not a
        // calendar id (see adapters/microsoft/provider.ts) — it falls back to
        // `providerAccountEmail` only when `calendarIdsRead` is empty.
        // Filling it with a calendar id here defeated that fallback and made
        // every Microsoft conflict check silently see an empty schedule,
        // i.e. treat busy time as free.
        if (provider !== 'microsoft') connection.calendarIdsRead = [primary.id]
        connection.calendarIdWrite = primary.id
      }
    } catch {
      // A provider having a bad minute must not lose a grant the host just
      // gave us. The connections page lets them pick calendars by hand.
    }

    await repos.connections.create(connection)
    await repos.sessions.touch(auth.session.idHash, auth.session.expiresAt, repos.bookmark())
    return c.redirect('/dashboard/connections?connected=1', 302)
  }

  // ===========================================================================
  // Dashboard — home
  // ===========================================================================

  app.get('/dashboard', requireSession, async (c) => {
    const repos = c.get('repos')
    const user = c.get('user')
    const now = ports.clock.now()

    const eventTypes = await repos.eventTypes.listForUser(user.id)
    const bookings = await repos.bookings.listForHost(user.id, {
      start: now,
      end: now + UPCOMING_WINDOW_MS,
    })
    const titles = new Map(eventTypes.map((et) => [et.id, et.title]))
    const upcomingBookings: UpcomingBooking[] = bookings
      .filter((b) => b.status === 'confirmed' && b.startUtc >= now)
      .map((booking) => ({ booking, eventTitle: titles.get(booking.eventTypeId) ?? 'Meeting' }))

    return c.html(
      dashboardHome({
        brandName,
        user,
        csrf: c.get('csrf'),
        eventTypes,
        upcomingBookings,
        baseUrl: ports.config.baseUrl,
      }),
    )
  })

  // ===========================================================================
  // Dashboard — event types
  // ===========================================================================

  // Registered before `/:id`, or Hono would read "new" as an id.
  app.get('/dashboard/event-types/new', requireSession, (c) =>
    c.html(eventTypeForm({ brandName, user: c.get('user'), csrf: c.get('csrf') })),
  )

  app.get('/dashboard/event-types/:id', requireSession, async (c) => {
    const eventType = await ownedEventType(c)
    if (!eventType) return notFound(c)
    return c.html(eventTypeForm({ brandName, user: c.get('user'), csrf: c.get('csrf'), eventType }))
  })

  app.post('/dashboard/event-types', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const repos = c.get('repos')
    const { draft, questionsText } = readEventTypeForm(form, user.id)
    const errors = await validateEventType(repos, user, draft, questionsText, null)
    if (Object.keys(errors).length > 0) {
      return c.html(
        eventTypeForm({ brandName, user, csrf: c.get('csrf'), eventType: draft, questionsText, errors }),
        400,
      )
    }

    await repos.eventTypes.create({ ...draft, id: `evt_${ports.crypto.randomToken(12)}` })
    await advanceBookmark(c)
    return c.redirect('/dashboard', 302)
  })

  app.post('/dashboard/event-types/:id', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const existing = await ownedEventType(c)
    if (!existing) return notFound(c)

    const user = c.get('user')
    const repos = c.get('repos')
    const read = readEventTypeForm(form, user.id)
    const draft = { ...read.draft, id: existing.id, createdAt: existing.createdAt }
    const errors = await validateEventType(repos, user, draft, read.questionsText, existing.id)
    if (Object.keys(errors).length > 0) {
      return c.html(
        eventTypeForm({
          brandName,
          user,
          csrf: c.get('csrf'),
          eventType: draft,
          questionsText: read.questionsText,
          errors,
        }),
        400,
      )
    }

    await repos.eventTypes.update(existing.id, draft)
    await advanceBookmark(c)
    return c.redirect('/dashboard', 302)
  })

  app.post('/dashboard/event-types/:id/delete', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const existing = await ownedEventType(c)
    if (!existing) return notFound(c)
    await c.get('repos').eventTypes.delete(existing.id)
    await advanceBookmark(c)
    return c.redirect('/dashboard', 302)
  })

  /** Ownership is checked here, once, rather than trusted from the URL. */
  async function ownedEventType(c: Ctx): Promise<EventType | null> {
    const found = await c.get('repos').eventTypes.byId(c.req.param('id') ?? '')
    return found && found.ownerUserId === c.get('user').id ? found : null
  }

  // ===========================================================================
  // Dashboard — availability
  // ===========================================================================

  app.get('/dashboard/availability', requireSession, async (c) => {
    const user = c.get('user')
    const availability = (await c.get('repos').availability.forUser(user.id)) ?? defaultAvailability(user)
    return c.html(availabilityPage({ brandName, user, csrf: c.get('csrf'), availability }))
  })

  app.post('/dashboard/availability', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const repos = c.get('repos')
    const errors: Record<string, string> = {}

    const timezone = String(form.get('timezone') ?? '').trim()
    if (!isValidTimeZone(timezone)) errors['timezone'] = 'Not a recognised timezone name'

    const weekly = emptyWeek()
    for (let day = 0; day < 7; day++) {
      const parsed = parseWindows(String(form.get(`day-${day}`) ?? ''))
      if (parsed === null) errors[`day-${day}`] = 'Use ranges like 09:00-17:00, separated by commas'
      else weekly[day] = parsed
    }

    const overrides = parseOverrides(String(form.get('overrides') ?? ''))
    if (overrides === null) errors['overrides'] = 'Use lines like 2026-12-24 10:00-14:00'

    const availability: Availability = {
      userId: user.id,
      timezone: isValidTimeZone(timezone) ? timezone : user.tz,
      weekly,
      overrides: overrides ?? [],
    }

    if (Object.keys(errors).length > 0) {
      return c.html(
        availabilityPage({ brandName, user, csrf: c.get('csrf'), availability, errors }),
        400,
      )
    }

    await repos.availability.save(user.id, availability)
    // The booking page renders the host's month grid in `users.tz`, so leaving
    // the two to drift would show a calendar that disagrees with the schedule.
    if (availability.timezone !== user.tz) await repos.users.update(user.id, { tz: availability.timezone })
    await advanceBookmark(c)

    return c.html(
      availabilityPage({
        brandName,
        user: { ...user, tz: availability.timezone },
        csrf: c.get('csrf'),
        availability,
        notice: 'Availability saved.',
      }),
    )
  })

  // ===========================================================================
  // Dashboard — calendar connections
  // ===========================================================================

  app.get('/dashboard/connections', requireSession, async (c) => {
    const user = c.get('user')
    const connections = await c.get('repos').connections.listForUser(user.id)

    const views: ConnectionView[] = []
    for (const connection of connections) {
      views.push({ connection, calendars: await listCalendarsSafely(connection) })
    }

    return c.html(
      connectionsPage({
        brandName,
        user,
        csrf: c.get('csrf'),
        connections: views,
        availableProviders: ports.calendars.available(),
        ...(c.req.query('connected') ? { notice: 'Calendar connected.' } : {}),
      }),
    )
  })

  app.post('/dashboard/connections/:id', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const repos = c.get('repos')
    const existing = await ownedConnection(c)
    if (!existing) return notFound(c)

    const writeRaw = String(form.get('write') ?? '')
    // The picker lists calendar ids (from `listCalendars`), but Microsoft's
    // `getBusy` reads `calendarIdsRead` as mailbox SMTP addresses, not
    // calendar ids — there is no UI here that produces those, so storing
    // the picked ids would make every future conflict check silently see
    // an empty schedule (busy time reads as free). Leaving it empty keeps
    // `getBusy`'s existing fallback to `providerAccountEmail` in effect.
    const read = existing.provider === 'microsoft' ? [] : form.getAll('read').map((v) => String(v))
    const write = writeRaw === '' ? null : writeRaw

    await repos.connections.updateCalendars(existing.id, { read, write })
    await advanceBookmark(c)
    return c.redirect('/dashboard/connections', 302)
  })

  app.post('/dashboard/connections/:id/disconnect', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const existing = await ownedConnection(c)
    if (!existing) return notFound(c)
    await c.get('repos').connections.delete(existing.id)
    await advanceBookmark(c)
    return c.redirect('/dashboard/connections', 302)
  })

  async function ownedConnection(c: Ctx): Promise<CalendarConnection | null> {
    const id = c.req.param('id') ?? ''
    const mine = await c.get('repos').connections.listForUser(c.get('user').id)
    return mine.find((conn) => conn.id === id) ?? null
  }

  /**
   * A connection that needs reconnecting cannot list calendars, and that is the
   * moment the host most needs the page to render — so a failure yields an
   * empty list and the page falls back to the stored ids.
   */
  async function listCalendarsSafely(
    connection: CalendarConnection,
  ): Promise<Array<{ id: string; name: string; primary: boolean }>> {
    try {
      return await ports.calendars.get(connection.provider).listCalendars(connection)
    } catch {
      return []
    }
  }

  // ===========================================================================
  // Dashboard — API keys
  // ===========================================================================

  app.get('/dashboard/api-keys', requireSession, async (c) => {
    const user = c.get('user')
    const keys = await c.get('repos').apiKeys.listForUser(user.id)
    return c.html(apiKeysPage({ brandName, user, csrf: c.get('csrf'), keys }))
  })

  /**
   * Create a key.
   *
   * Renders 200 instead of the usual redirect-after-post: the raw key exists
   * only in this response (ADR-0005 §7), and a redirect would either lose it or
   * park it in a URL, a history entry and every proxy log on the way.
   */
  app.post('/dashboard/api-keys', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const repos = c.get('repos')
    const name = String(form.get('name') ?? '').trim()
    if (name === '' || name.length > 80) {
      const keys = await repos.apiKeys.listForUser(user.id)
      return c.html(
        apiKeysPage({
          brandName,
          user,
          csrf: c.get('csrf'),
          keys,
          errors: { name: 'Give the key a name you will recognise' },
        }),
        400,
      )
    }

    const scopes = String(form.get('scopes') ?? '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s !== '')

    const created = await createApiKey(
      { repos, crypto: ports.crypto },
      { userId: user.id, name, scopes, now: ports.clock.now() },
    )
    await advanceBookmark(c)

    const keys = await repos.apiKeys.listForUser(user.id)
    return c.html(apiKeysPage({ brandName, user, csrf: c.get('csrf'), keys, newKey: created.raw }))
  })

  app.post('/dashboard/api-keys/:id/delete', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const repos = c.get('repos')
    const id = c.req.param('id') ?? ''
    const mine = await repos.apiKeys.listForUser(c.get('user').id)
    if (!mine.some((k) => k.id === id)) return notFound(c)

    await repos.apiKeys.delete(id)
    await advanceBookmark(c)
    return c.redirect('/dashboard/api-keys', 302)
  })

  // ===========================================================================
  // Dashboard — settings (the host's own slug)
  // ===========================================================================

  app.get('/dashboard/settings', requireSession, (c) =>
    c.html(settingsPage({ brandName, user: c.get('user'), csrf: c.get('csrf') })),
  )

  app.post('/dashboard/settings', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const repos = c.get('repos')
    const raw = String(form.get('slug') ?? '').trim()
    const errors: Record<string, string> = {}

    // `validateSlug` lowercases before checking format, so on its own it would
    // silently accept "Mixed-Case" as if it were "mixed-case". A slug is a URL
    // segment a host reads aloud and types from memory (same reasoning as
    // `validateSlug`'s own docstring), so a case difference must be refused,
    // not folded away — hence the equality check ahead of it.
    if (raw !== raw.toLowerCase()) {
      errors['slug'] = 'Lowercase letters, numbers and hyphens only'
    } else {
      const validation = validateSlug(raw)
      if (!validation.ok) {
        errors['slug'] = validation.message ?? 'Not a valid slug'
      } else {
        // The same namespace signup allocation checks (uniqueSlug in
        // auth-flows.ts) — checked against the live table, not cached, since a
        // stale check here would surface as a UNIQUE constraint violation
        // instead of a form message.
        //
        // Both users AND teams, not just users: `bookingPageContext` resolves
        // a public booking page by matching the owner slug against EITHER
        // table (`WHERE u.slug = ? OR t.slug = ?`), so a user slug colliding
        // with an existing team's slug would make `/that-slug/<event>`
        // ambiguous between the two — which row a `LIMIT 1` returns is
        // undefined.
        const [existingUser, existingTeam] = await Promise.all([
          repos.users.bySlug(raw),
          repos.teams.bySlug(raw),
        ])
        if (existingUser && existingUser.id !== user.id) errors['slug'] = 'That slug is already taken'
        else if (existingTeam) errors['slug'] = 'That slug is already taken'
      }
    }

    if (Object.keys(errors).length > 0) {
      return c.html(
        settingsPage({ brandName, user, csrf: c.get('csrf'), slugValue: raw, errors }),
        400,
      )
    }

    // A user's slug is the FIRST path segment of every one of their booking
    // pages, so changing it moves every existing link and QR code at once —
    // the warning on the form says so. There is deliberately no redirect from
    // the old slug: the booking-page route resolves purely off the current
    // `users.slug` column.
    if (raw !== user.slug) {
      // The check above is read-then-write: two concurrent saves of the same
      // slug can both pass it before either commits. `update`'s own return
      // value is the real guard — it reports false if the write lost that
      // race against the `users_slug_idx` UNIQUE constraint — so that lands
      // as the same clean form error, never an uncaught 500.
      const ok = await repos.users.update(user.id, { slug: raw })
      if (!ok) {
        return c.html(
          settingsPage({
            brandName,
            user,
            csrf: c.get('csrf'),
            slugValue: raw,
            errors: { slug: 'That slug is already taken' },
          }),
          400,
        )
      }
      await advanceBookmark(c)
    }

    return c.html(
      settingsPage({
        brandName,
        user: { ...user, slug: raw },
        csrf: c.get('csrf'),
        notice: 'Slug updated. Links using the old address now show "not found".',
      }),
    )
  })

  /**
   * Name and company — shown next to the avatar on the booking page and in
   * confirmation emails. No uniqueness check needed here (unlike slug):
   * neither is part of a URL or any lookup key, so two hosts sharing a name
   * or company is unremarkable, not a collision.
   */
  app.post('/dashboard/settings/profile', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const name = String(form.get('name') ?? '').trim()
    const companyRaw = String(form.get('company') ?? '').trim()
    const errors: Record<string, string> = {}

    if (name.length === 0) errors['name'] = 'Name is required'
    else if (name.length > 120) errors['name'] = 'Must be 120 characters or fewer'
    if (companyRaw.length > 120) errors['company'] = 'Must be 120 characters or fewer'

    if (Object.keys(errors).length > 0) {
      return c.html(
        settingsPage({
          brandName,
          user,
          csrf: c.get('csrf'),
          nameValue: name,
          companyValue: companyRaw,
          errors,
        }),
        400,
      )
    }

    // Empty company clears the field (null), same "unset" convention as avatarKey.
    const company = companyRaw.length > 0 ? companyRaw : null
    const repos = c.get('repos')
    await repos.users.update(user.id, { name, company })
    await advanceBookmark(c)

    return c.html(
      settingsPage({
        brandName,
        user: { ...user, name, company },
        csrf: c.get('csrf'),
        notice: 'Profile updated.',
      }),
    )
  })

  /**
   * Avatar upload.
   *
   * Validation order matters: type and size are checked BEFORE anything
   * touches R2 or the resizer, so a bad upload is a clean 400 with no wasted
   * work. The resize happens here, at upload time — never on the booking-page
   * request path, which has its own <100 ms budget (ADR-0007 §3).
   */
  app.post('/dashboard/settings/avatar', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const file = form.get('avatar')
    const fail = (message: string) =>
      c.html(settingsPage({ brandName, user, csrf: c.get('csrf'), errors: { avatar: message } }), 400)

    if (!(file instanceof File) || file.size === 0) return fail('Choose an image to upload')
    if (file.size > MAX_UPLOAD_BYTES) return fail('That file is larger than 5 MB')
    if (!isAllowedImageType(file.type)) return fail('PNG, JPEG or WebP images only')

    const bytes = new Uint8Array(await file.arrayBuffer())

    // Read from the header only, before anything decodes a pixel — a highly
    // compressible image can be tiny on disk and still be a decompression
    // bomb (see MAX_DECODED_PIXELS's doc comment). A header that doesn't
    // parse is treated the same as "too large": it also won't decode.
    const dimensions = readImageDimensions(bytes, file.type)
    if (!dimensions || dimensions.width * dimensions.height > MAX_DECODED_PIXELS) {
      return fail('That image is too large. Try a smaller photo.')
    }

    const originalKey = await deriveBlobKey(bytes, file.type)
    const thumbKey = thumbKeyFor(originalKey)

    // Content-addressed, so an identical re-upload (the common case: a host
    // re-saving the same photo) is a cache hit here and skips both the R2
    // write and the resize entirely.
    if (!(await ports.blobStorage.get(thumbKey))) {
      const thumb = resizeToSquareThumbnail(bytes)
      if (!thumb) return fail('Could not process that image. Try a different file.')
      await ports.blobStorage.put(originalKey, bytes, file.type)
      await ports.blobStorage.put(thumbKey, thumb, THUMB_CONTENT_TYPE)
    }

    const repos = c.get('repos')
    await repos.users.update(user.id, { avatarKey: thumbKey })
    await advanceBookmark(c)

    return c.html(
      settingsPage({
        brandName,
        user: { ...user, avatarKey: thumbKey },
        csrf: c.get('csrf'),
        notice: 'Photo updated.',
      }),
    )
  })

  app.post('/dashboard/settings/avatar/delete', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const repos = c.get('repos')
    // The R2 object is left in place — it is content-addressed and may be
    // shared with another user's identical upload, so nothing here can prove
    // it is safe to delete. Only the reference is cleared.
    await repos.users.update(user.id, { avatarKey: null })
    await advanceBookmark(c)

    return c.html(
      settingsPage({
        brandName,
        user: { ...user, avatarKey: null },
        csrf: c.get('csrf'),
        notice: 'Photo removed.',
      }),
    )
  })

  // ===========================================================================
  // Guest manage page — authenticated by the manage token, never by a session
  // ===========================================================================

  app.get('/booking/:id', async (c) => {
    const token = c.req.query('token') ?? ''
    const verified = await verifyManageLink(token, c.req.param('id') ?? '')
    if (!verified.ok) return manageError(c, verified.message)

    const { booking, purpose } = verified
    const repos = ports.repositories(guestScope())
    const eventType = await repos.eventTypes.byId(booking.eventTypeId)
    const host = await repos.users.byId(booking.hostUserId)
    if (!host) return manageError(c, 'This booking is no longer available.')

    const startRaw = Number(c.req.query('start'))
    // Same guard as the public booking page: `Number.isFinite` alone lets a
    // huge-but-finite value through, and formatting it later (Intl inside
    // `formatInZone`) throws an uncaught RangeError instead of a clean
    // fallback — 8.64e15 is the JS Date range.
    const startParam = Number.isSafeInteger(startRaw) && Math.abs(startRaw) <= 8.64e15 ? startRaw : NaN
    const dateParam = validDate(c.req.query('date'))

    // Slot listing for the reschedule picker is advisory and reads the nearest
    // replica, exactly like the public booking page (ADR-0007 §2). The commit
    // path arbitrates.
    let offered: Awaited<ReturnType<SlotService['forEventType']>> | undefined
    let selectedDate: string | undefined
    // `rescheduleSection` (dashboard.ts) renders the same picker for BOTH
    // 'reschedule' and 'manage' — 'manage' is what every real booking's
    // token actually carries (issueManageToken always mints 'manage'), so
    // restricting this to 'reschedule' alone meant the picker never had
    // slots to show on the link every guest actually receives.
    if ((purpose === 'reschedule' || purpose === 'manage') && eventType && !Number.isFinite(startParam)) {
      selectedDate = dateParam ?? localDateString(booking.startUtc, booking.guestTimezone)
      // `selectedDate` is a GUEST-local date (from the picker, or from the
      // guest's own booking), but `dayRange` resolves a date string in a
      // given timezone — passing host.tz here computed the wrong 24h window
      // whenever host and guest sit on opposite sides of a date line, the
      // same host/guest tz mismatch fixed on the public booking page. Pad the
      // host-local window by a day on each side and then filter down to the
      // guest's actual selected day.
      const DAY_MS = 24 * 60 * 60 * 1000
      const hostDayRange = dayRange(selectedDate, host.tz)
      const daySlots = await slots.forEventType({
        eventType,
        hostUsers: await resolveHosts(repos, eventType, host),
        range: { start: hostDayRange.start - DAY_MS, end: hostDayRange.end + DAY_MS },
        scope: { consistency: 'unconstrained' },
      })
      offered = daySlots.filter((s) => localDateString(s.start, booking.guestTimezone) === selectedDate)
    }

    return c.html(
      bookingDetailPage({
        brandName,
        booking,
        eventType,
        host,
        token,
        // Pass the RAW purpose. Collapsing 'manage' to 'reschedule' here is
        // what hid the cancel form from every real guest.
        purpose,
        ...(offered ? { slots: offered } : {}),
        ...(selectedDate ? { selectedDate } : {}),
        ...(Number.isFinite(startParam) ? { newStart: startParam } : {}),
      }),
    )
  })

  app.post('/booking/:id/cancel', async (c) => {
    const form = await c.req.formData()
    const token = String(form.get('token') ?? '')
    if (!(await manageRateLimitOk(c))) return manageError(c, 'Too many attempts. Try again shortly.')

    const verified = await verifyManageLink(token, c.req.param('id') ?? '', 'cancel')
    if (!verified.ok) return manageError(c, verified.message)

    const repos = ports.repositories(guestScope())

    // A booking that is already cancelled or superseded must not be acted on
    // again: without this, one link stays replayable forever.
    if (verified.booking.status !== 'confirmed') {
      return manageError(c, 'This booking is no longer active.')
    }

    // The status check above is read-then-write: a concurrent request (a
    // second tab, a double-submitted reschedule) can change the booking
    // between that read and this write. The conditional UPDATE is the real
    // guard — if it reports no row changed, someone else already moved this
    // booking, so treat it the same as the pre-check above rather than
    // sending a cancellation for a booking that is actually rescheduled.
    const cancelledAt = ports.clock.now()
    const cancelled = await repos.bookings.cancelWithLockRelease(verified.booking.id, cancelledAt)
    if (!cancelled) return manageError(c, 'This booking is no longer active.')

    // Rotate the hash so the link in the guest's inbox stops working. ADR-0005
    // §4 names rotation-on-state-change as THE invalidation mechanism, and it
    // had no production call site.
    await repos.bookings.rotateManageToken(
      verified.booking.id,
      await ports.crypto.hash(ports.crypto.randomToken(32)),
    )

    // The confirmation page tells the guest "the host is notified". Nothing
    // here was sending anything, so that sentence was untrue on the path real
    // guests use.
    const cancelEt = await repos.eventTypes.byId(verified.booking.eventTypeId)
    const cancelHost = await repos.users.byId(verified.booking.hostUserId)
    if (cancelEt && cancelHost) {
      await notifyBookingCancelled({
        ports,
        // Patched, not the pre-write booking: notifyWebhooks serializes
        // `booking.status` straight into the payload, which would otherwise
        // report "confirmed" on a `booking.cancelled` event.
        booking: { ...verified.booking, status: 'cancelled', cancelledAt },
        eventType: cancelEt,
        host: cancelHost,
        cancelledBy: 'guest',
      }).catch((err) => console.error('[punctual] cancellation emails failed', err))
    }
    // After the commit, deliberately: a calendar or mail failure must not
    // leave a booking the guest believes is cancelled still holding the slot.
    await ports.queue
      .send({ kind: 'calendar.sync', bookingId: verified.booking.id, action: 'delete' })
      .catch(() => {})

    return c.html(
      shellHead({ title: `Cancelled · ${brandName}`, brandName }) +
        errorPage('Booking cancelled', 'The time has been released and the host has been notified.') +
        shellFoot(brandName),
    )
  })

  app.post('/booking/:id/reschedule', async (c) => {
    const form = await c.req.formData()
    const token = String(form.get('token') ?? '')
    if (!(await manageRateLimitOk(c))) return manageError(c, 'Too many attempts. Try again shortly.')

    const verified = await verifyManageLink(token, c.req.param('id') ?? '', 'reschedule')
    if (!verified.ok) return manageError(c, verified.message)

    const start = Number(form.get('start'))
    // `isFinite` alone lets a huge-but-finite value through, and it eventually
    // reaches Date/Intl formatting downstream (confirmation email, .ics),
    // which throws an uncaught RangeError instead of this clean error page.
    // 8.64e15 is the JS Date range.
    if (!Number.isSafeInteger(start) || Math.abs(start) > 8.64e15) {
      return manageError(c, 'No new time was chosen.')
    }

    const old = verified.booking

    // Same guard as cancel: without it a reschedule link is replayable, and
    // each submission creates ANOTHER booking that consumes another slot on
    // the host's calendar.
    if (old.status !== 'confirmed') {
      return manageError(c, 'This booking is no longer active.')
    }

    const repos = ports.repositories(guestScope())
    const eventType = await repos.eventTypes.byId(old.eventTypeId)
    const host = await repos.users.byId(old.hostUserId)
    if (!eventType || !host) return manageError(c, 'This booking can no longer be moved.')

    const hosts = await resolveHosts(repos, eventType, host)
    const outcome = await ports.coordinator.book(host.id, {
      eventTypeId: eventType.id,
      hostUserIds: hosts.map((u) => u.id),
      start,
      end: start + eventType.durationMinutes * 60_000,
      guestName: old.guestName,
      guestEmail: old.guestEmail,
      guestTimezone: old.guestTimezone,
      answers: old.answers,
      rescheduleOf: old.id,
    })

    if (!outcome.ok) {
      return c.html(
        bookingDetailPage({
          brandName,
          booking: old,
          eventType,
          host,
          token,
          purpose: 'reschedule',
          error: 'That time was just taken. Pick another one.',
        }),
        409,
      )
    }

    // Only after the new booking exists: `markRescheduled` releases the old
    // slot locks, and releasing them before the replacement is committed would
    // open a window where neither time is held.
    //
    // The `old.status !== 'confirmed'` check above is read-then-write, so a
    // second concurrent reschedule (or a cancel) of the same link can land
    // between that read and here. markRescheduled's UPDATE is conditional on
    // the CURRENT status — if it reports no change, another request already
    // moved or cancelled `old`, and the booking just created above is a real,
    // confirmed, but orphaned duplicate. It must be released, not left live.
    const moved = await repos.bookings.markRescheduled(old.id, outcome.booking.id)
    if (!moved) {
      await repos.bookings.cancelWithLockRelease(outcome.booking.id, ports.clock.now())
      await ports.queue
        .send({ kind: 'calendar.sync', bookingId: outcome.booking.id, action: 'delete' })
        .catch(() => {})
      return c.html(
        bookingDetailPage({
          brandName,
          booking: old,
          eventType,
          host,
          token,
          purpose: 'reschedule',
          error: 'This booking was already updated elsewhere. Refresh and try again.',
        }),
        409,
      )
    }

    // Kill the old link. The new booking carries its own freshly signed token,
    // so the guest's superseded email stops working (ADR-0005 §4).
    await repos.bookings.rotateManageToken(
      old.id,
      await ports.crypto.hash(ports.crypto.randomToken(32)),
    )

    // notifyBookingCreated deliberately skips a booking with rescheduleOf set,
    // expecting the moving route to send this instead — which the REST path
    // did and this one did not.
    //
    // Resolve the host from the NEW booking, not from `old`. Round-robin
    // re-picks a host at commit time, so reusing the old one mails whoever is
    // no longer on the meeting, leaves the newly-assigned host uninformed, and
    // prints the wrong name in the guest's copy.
    const newHost = (await repos.users.byId(outcome.booking.hostUserId)) ?? host
    await notifyBookingRescheduled({
      ports,
      booking: outcome.booking,
      previous: old,
      eventType,
      host: newHost,
      ...(outcome.manageToken ? { manageToken: outcome.manageToken } : {}),
    }).catch((err) => console.error('[punctual] reschedule emails failed', err))
    await ports.queue
      .send({ kind: 'calendar.sync', bookingId: old.id, action: 'delete' })
      .catch(() => {})

    // Carry the new booking's token: /booking/:id without one is a 400, so
    // a guest who successfully rescheduled landed on an error page.
    const nextToken = outcome.manageToken
    return c.redirect(
      `/booking/${encodeURIComponent(outcome.booking.id)}` +
        (nextToken ? `?token=${encodeURIComponent(nextToken)}` : ''),
      302,
    )
  })

  type ManageResult =
    | { ok: true; booking: Booking; purpose: ManageTokenPurpose }
    | { ok: false; message: string }

  /**
   * Verify a guest manage token.
   *
   * `expected` pins the purpose for a mutation — a cancel link must not be
   * replayable as a reschedule (ADR-0005 §4). The read-only page passes none
   * and accepts whichever purpose the token carries, because `bookings` stores
   * a single `manage_token_hash`: only one purpose can be live at a time, and
   * refusing to render the page for the other one would leave the guest with a
   * link that shows nothing.
   *
   * The failure message is the same for every reason. Distinguishing "expired"
   * from "bad signature" tells an attacker which half of the token to work on.
   */
  async function verifyManageLink(
    token: string,
    expectedBookingId: string,
    expected?: ManageTokenPurpose,
  ): Promise<ManageResult> {
    const parsed = parseManageToken(token)
    if (!parsed) return { ok: false, message: 'The link is incomplete or was cut short by an email client.' }
    // A 'manage' token authorises both actions — it is what the coordinator
    // actually issues. Pinning to 'cancel'/'reschedule' made every real guest
    // link 400 on both, while the tests passed because they seeded purposes
    // production never mints.
    if (expected && parsed.purpose !== expected && parsed.purpose !== 'manage') {
      return { ok: false, message: 'This link cannot perform that action.' }
    }

    const result = await verifyManageToken(
      { crypto: ports.crypto, repos: ports.repositories(guestScope()) },
      token,
      parsed.purpose,
      ports.clock.now(),
    )
    if (!result.ok) return { ok: false, message: 'The link is no longer valid.' }
    // The token names a booking; the URL must not disagree with it.
    if (result.booking.id !== expectedBookingId) {
      return { ok: false, message: 'The link is no longer valid.' }
    }
    return { ok: true, booking: result.booking, purpose: parsed.purpose }
  }

  /** Abuse limit on the unauthenticated mutation surface (ADR-0006 §3). */
  async function manageRateLimitOk(c: Ctx): Promise<boolean> {
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
    const result = await ports.rateLimiter.check('booking_manage:ip', ip, 30, 3600)
    return result.allowed
  }

  function manageError(c: Ctx, message: string): Response | Promise<Response> {
    return c.html(manageLinkErrorPage(brandName, message), 400)
  }

  // ===========================================================================
  // Shared helpers that need `ports`
  // ===========================================================================

  async function currentSession(c: Ctx): Promise<{ session: Session; user: User } | null> {
    return validateSession(
      { repos: ports.repositories({ consistency: 'bookmark' }), crypto: ports.crypto },
      readCookie(c.req.header('cookie'), SESSION_COOKIE_NAME),
      ports.clock.now(),
    )
  }

  function notFound(c: Ctx): Response | Promise<Response> {
    return c.html(
      shellHead({ title: 'Not found', brandName }) +
        errorPage('Not found', 'That page does not exist, or is not yours.') +
        shellFoot(brandName),
      404,
    )
  }

  function oauthError(c: Ctx, message: string): Response | Promise<Response> {
    return c.html(
      shellHead({ title: 'Sign-in failed', brandName }) + errorPage('Sign-in failed', message) + shellFoot(brandName),
      400,
    )
  }

  function signState(
    provider: CalendarProviderName,
    purpose: OAuthPurpose,
    exp: number,
    nonce: string,
  ): Promise<string> {
    return ports.crypto
      .sign(statePayload(provider, purpose, exp, nonce))
      .then((sig) => `${exp}.${nonce}.${sig}`)
  }

  async function verifyState(
    provider: CalendarProviderName,
    purpose: OAuthPurpose,
    state: string,
    cookieNonce: string | null,
  ): Promise<boolean> {
    const parts = state.split('.')
    if (parts.length !== 3) return false
    const [expRaw, nonce, signature] = parts as [string, string, string]
    if (!/^\d{1,15}$/.test(expRaw)) return false
    if (Number(expRaw) <= ports.clock.now()) return false
    // The cookie is what binds the flow to this browser; without it a valid
    // state observed anywhere could be completed by anyone.
    if (!cookieNonce || !constantTimeEqual(cookieNonce, nonce)) return false
    return ports.crypto.verify(statePayload(provider, purpose, Number(expRaw), nonce), signature)
  }

  interface TokenResponse {
    accessToken: string
    refreshToken: string
    expiresInMs: number
    scope: string
    idToken: string
  }

  async function exchangeCode(
    provider: CalendarProviderName,
    purpose: OAuthPurpose,
    code: string,
  ): Promise<TokenResponse | null> {
    const creds = ports.oauth.forProvider(provider)
    if (!creds) return null

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      // Must match the URI the authorization request used, byte for byte —
      // which is why `purpose` is part of it rather than merely part of state.
      redirect_uri: ports.oauth.redirectUri(provider, purpose),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    })

    const res = await fetch(OAUTH_ENDPOINTS[provider].token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) return null

    const json: unknown = await res.json().catch(() => null)
    if (!isRecord(json) || typeof json['access_token'] !== 'string') return null
    return {
      accessToken: json['access_token'],
      refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : '',
      expiresInMs: typeof json['expires_in'] === 'number' ? json['expires_in'] * 1000 : 3_600_000,
      scope: typeof json['scope'] === 'string' ? json['scope'] : '',
      idToken: typeof json['id_token'] === 'string' ? json['id_token'] : '',
    }
  }

  return app
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sessionScope(session: Session): RequestScope {
  return { consistency: 'bookmark', bookmark: session.bookmark }
}

/**
 * Guest manage reads.
 *
 * Bookmark mode with no bookmark: the guest has no session to carry one, but
 * these reads decide whether a credential is still valid and whether a booking
 * is still confirmed. A replica that has not seen a rotation would accept a
 * superseded link, so this must not be `unconstrained` (ADR-0007 §2).
 */
function guestScope(): RequestScope {
  return { consistency: 'bookmark' }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/** Cloudflare gives us the visitor's zone for free; no client round trip. */
function timezoneHint(c: Ctx): string | undefined {
  const cf = (c.req.raw as { cf?: { timezone?: string } }).cf?.timezone
  return cf && isValidTimeZone(cf) ? cf : undefined
}

function validProvider(value: string | undefined): CalendarProviderName | null {
  return value === 'google' || value === 'microsoft' ? value : null
}

function validPurpose(value: string | undefined): OAuthPurpose | null {
  return value === 'identity' || value === 'calendar' ? value : null
}

function validDate(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

/** Provider and purpose are inside the signature, so neither can be swapped. */
function statePayload(
  provider: CalendarProviderName,
  purpose: OAuthPurpose,
  exp: number,
  nonce: string,
): string {
  return `oauth|${provider}|${purpose}|${exp}|${nonce}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The email an OIDC provider asserted, from the id_token payload.
 *
 * Decoded without verifying the signature — see `completeIdentity` for why
 * that is sound here, and why it would not be if the token arrived any other
 * way.
 */
function emailFromIdToken(idToken: string, provider: CalendarProviderName): string | null {
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  try {
    const payload: unknown = JSON.parse(base64UrlDecode(parts[1]!))
    if (!isRecord(payload)) return null
    const email = payload['email']
    if (typeof email !== 'string' || email.trim() === '') return null
    // Google puts `email_verified` on every id_token and we require it there.
    // Microsoft's v2.0 id_tokens never carry this claim at all — for any
    // account type — so requiring it made every Microsoft sign-in fail
    // regardless of the `email` claim's presence. Microsoft only populates
    // `email` when the directory/account has a validated addressable mailbox,
    // so for Microsoft the claim's presence is itself the verification.
    if (provider === 'google') {
      if (payload['email_verified'] !== true && payload['email_verified'] !== 'true') return null
    }
    return email.trim().toLowerCase()
  } catch {
    return null
  }
}

function base64UrlDecode(value: string): string {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function emptyWeek(): WeeklySchedule {
  return [[], [], [], [], [], [], []]
}

/** Weekdays 09:00–17:00 — a schedule that works before anyone edits anything. */
function defaultAvailability(user: User): Availability {
  const weekly = emptyWeek()
  for (let day = 1; day <= 5; day++) weekly[day] = [{ startMinute: 9 * 60, endMinute: 17 * 60 }]
  return { userId: user.id, timezone: user.tz, weekly, overrides: [] }
}

/**
 * Read the event-type form into a draft.
 *
 * Returns whatever was typed, unvalidated: the draft is what gets rendered back
 * when validation fails, so discarding a bad value here would silently clear
 * the field the host needs to fix.
 */
function readEventTypeForm(
  form: FormData,
  ownerUserId: string,
): { draft: EventType; questionsText: string } {
  const text = (name: string): string => String(form.get(name) ?? '').trim()
  const int = (name: string, fallback: number): number => {
    const raw = text(name)
    const n = Number(raw)
    return raw === '' || !Number.isFinite(n) ? fallback : Math.trunc(n)
  }
  const optionalInt = (name: string): number | null => {
    const raw = text(name)
    const n = Number(raw)
    return raw === '' || !Number.isFinite(n) ? null : Math.trunc(n)
  }

  const title = text('title')
  const questionsText = String(form.get('questions') ?? '')
  const draft: EventType = {
    id: '',
    ownerUserId,
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: text('slug') || slugify(title),
    title,
    description: text('description'),
    durationMinutes: int('durationMinutes', 30),
    slotIntervalMinutes: optionalInt('slotIntervalMinutes'),
    bufferBeforeMinutes: int('bufferBeforeMinutes', 0),
    bufferAfterMinutes: int('bufferAfterMinutes', 0),
    minNoticeMinutes: int('minNoticeMinutes', 0),
    maxHorizonDays: int('maxHorizonDays', 60),
    maxPerDay: optionalInt('maxPerDay'),
    locationType: locationTypeOf(text('locationType')),
    locationValue: text('locationValue') || null,
    questions: parseQuestions(questionsText) ?? [],
    active: form.get('active') !== null,
    createdAt: 0,
  }
  return { draft, questionsText }
}

function locationTypeOf(value: string): EventType['locationType'] {
  return value === 'custom_link' || value === 'phone' || value === 'in_person' ? value : 'google_meet'
}

/**
 * Field-level validation for an event type.
 *
 * The duration rule is not cosmetic: bookings claim 5-minute buckets
 * (ADR-0002 §1), so a duration off the grid would claim a bucket it does not
 * fill and quietly block time nobody booked.
 */
async function validateEventType(
  repos: Repositories,
  user: User,
  draft: EventType,
  questionsText: string,
  currentId: string | null,
): Promise<Record<string, string>> {
  const errors: Record<string, string> = {}

  if (draft.title === '' || draft.title.length > 120) errors['title'] = 'Give it a title (up to 120 characters)'

  if (!/^[a-z0-9-]{1,60}$/.test(draft.slug)) {
    errors['slug'] = 'Lowercase letters, numbers and hyphens only'
  } else if (RESERVED_SLUGS.has(draft.slug)) {
    errors['slug'] = 'That word is reserved'
  } else {
    // Checked against every event type, not just the visible ones: the unique
    // index does not care whether a row is active, and a duplicate would
    // otherwise surface as a database error instead of a form message.
    const mine = await repos.eventTypes.listForUser(user.id)
    if (mine.some((et) => et.slug === draft.slug && et.id !== currentId)) {
      errors['slug'] = 'You already have an event type with this slug'
    }
  }

  if (draft.durationMinutes < 5 || draft.durationMinutes > 1440 || draft.durationMinutes % 5 !== 0) {
    errors['durationMinutes'] = 'Between 5 and 1440 minutes, in steps of 5'
  }
  if (draft.slotIntervalMinutes !== null && (draft.slotIntervalMinutes < 5 || draft.slotIntervalMinutes % 5 !== 0)) {
    errors['slotIntervalMinutes'] = 'Leave blank, or use a multiple of 5'
  }
  // The form's step="5" is a UI hint only; a raw POST bypasses it. Off-grid
  // buffers are not unsafe (slot_locks buckets floor/ceil to cover them
  // regardless), but they round up to the next 5-minute bucket and quietly
  // block more of the calendar than the host configured.
  if (draft.bufferBeforeMinutes < 0 || draft.bufferBeforeMinutes > 240 || draft.bufferBeforeMinutes % 5 !== 0) {
    errors['bufferBeforeMinutes'] = 'Between 0 and 240 minutes, in steps of 5'
  }
  if (draft.bufferAfterMinutes < 0 || draft.bufferAfterMinutes > 240 || draft.bufferAfterMinutes % 5 !== 0) {
    errors['bufferAfterMinutes'] = 'Between 0 and 240 minutes, in steps of 5'
  }
  if (draft.minNoticeMinutes < 0 || draft.minNoticeMinutes > 43200) {
    errors['minNoticeMinutes'] = 'Between 0 minutes and 30 days'
  }
  if (draft.maxHorizonDays < 1 || draft.maxHorizonDays > 730) {
    errors['maxHorizonDays'] = 'Between 1 and 730 days'
  }
  if (draft.maxPerDay !== null && (draft.maxPerDay < 1 || draft.maxPerDay > 100)) {
    errors['maxPerDay'] = 'Leave blank for unlimited, or use 1 to 100'
  }
  if (parseQuestions(questionsText) === null) {
    errors['questions'] =
      'One per line: Label | text, textarea or select | required or optional | options for select'
  }

  return errors
}

/** Every host who takes part. Mirrors the public router's resolution. */
async function resolveHosts(repos: Repositories, eventType: EventType, owner: User): Promise<User[]> {
  if (!eventType.ownerTeamId) return [owner]
  const members = await repos.teams.members(eventType.ownerTeamId)
  const users: User[] = []
  for (const member of members) {
    const found = await repos.users.byId(member.userId)
    if (found) users.push(found)
  }
  return users.length > 0 ? users : [owner]
}
