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
import { notifyBookingCancelled, notifyWebhooks } from '../adapters/notify.js'
import { dispatchConfirmation } from '../adapters/queue/consumer.js'
import type {
  BookingListView,
  CalendarProviderName,
  EnginePorts,
  Repositories,
  RequestScope,
  SignupPolicy,
} from '../ports.js'
import type { SlotService } from '../engine.js'
import type {
  Booking,
  CalendarConnection,
  EventType,
  EventTypeHost,
  Schedule,
  Session,
  Team,
  TeamMember,
  TeamRole,
  User,
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
  defaultSchedule,
  parseSignupPolicy,
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
import { canManageTeam, isManagingRole } from '../core/domain/teams.js'
import { hostUsers, resolveHosts as resolveEventTypeHosts } from '../core/domain/hosts.js'
import { changeBookingHosts } from '../core/domain/booking-hosts.js'
import { notifyNewHosts as notifyNewHostsShared } from './host-notifications.js'
import {
  MAX_DECODED_PIXELS,
  MAX_UPLOAD_BYTES,
  THUMB_CONTENT_TYPE,
  deriveBlobKey,
  isAllowedImageType,
  readImageDimensions,
  thumbKeyFor, fitKeyFor, originalKeyCandidates, isLogoShape,
} from '../core/domain/media.js'
import { resizeToFitThumbnail, resizeToSquareThumbnail } from '../adapters/image/resize.js'
import { errorPage, shellFoot, shellHead } from './pages/booking.js'
import {
  CSRF_FIELD,
  MAX_RANGES_PER_DAY,
  API_KEY_SCOPES,
  apiKeysPage,
  schedulesPage,
  scheduleForm,
  bookingDetailPage,
  bookingsPage,
  connectionsPage,
  dashboardHome,
  hostBookingPage,
  hostChangeFailureMessage,
  hostReschedulePage,
  eventTypeForm,
  loginPage,
  manageLinkErrorPage,
  parseOverrides,
  parseQuestions,
  questionsParseError,
  parseWeeklyDraft,
  adminPage,
  settingsPage,
  slugify,
  teamsPage,
  revokeKeyPage,
  type BookingListRow,
  type BookingParticipant,
  type ConnectionView,
  type EventTypeListItem,
  type HostBookingPageData,
  type TeamView,
  type SchedulesPageData,
  type ScheduleFormData,
  type ScheduleScope,
  type HostChoice,
  type TeamEventChoice,
  type TeamsPageData,
  type EventTypeFormData,
  type UpcomingBooking,
  type WeeklyDayDraft,
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
  // Closed over beside brandName because it travels with it into every
  // DashboardChrome literal below — see emailWarningBanner in pages/dashboard.ts.
  const emailDelivery = ports.config.emailDelivery
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

  /**
   * Admin routes: session first, then role. A member who guesses the URL is
   * redirected to their own dashboard — the nav never shows them the link,
   * but hiding a link is not access control.
   */
  const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
    if (c.get('user').role !== 'admin') return c.redirect('/dashboard', 302)
    await next()
    return undefined
  }

  /**
   * The signup policy in force. The SIGNUPS env var, when set, PINS the
   * policy (an operator's wrangler config must never be silently out-ranked
   * from a web form); otherwise the admin-editable stored setting applies,
   * and with neither the instance is open.
   */
  async function effectiveSignupPolicy(repos: Repositories): Promise<SignupPolicy> {
    if (ports.config.signupPolicy) return ports.config.signupPolicy
    const stored = await repos.settings.get('signups')
    return parseSignupPolicy(stored ?? undefined)
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
        shellFoot(),
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

  /**
   * What every render of the sign-in page shares. The wording depends on
   * the sign-up policy in force — an open instance says the link also
   * creates an account — which is the instance's policy, not a fact about
   * any address, so it is safe to state before the form is submitted.
   */
  async function loginChrome() {
    const policy = await effectiveSignupPolicy(ports.repositories({ consistency: 'bookmark' }))
    return { brandName, providers: ports.calendars.available(), signupsOpen: policy.mode === 'open' }
  }

  app.get('/login', async (c) => c.html(loginPage(await loginChrome())))

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
        // Empty without script — the flow then falls back to the redeeming
        // request's network location, and after that to UTC.
        timezone: String(form.get('tz') ?? '').trim(),
      },
    )

    const chrome = await loginChrome()
    if (result.status === 'malformed') {
      // Safe to distinguish: address SYNTAX is something the sender can compute
      // themselves. Account existence is not, and is never revealed.
      return c.html(
        loginPage({ ...chrome, email, error: 'That does not look like an email address' }),
        400,
      )
    }
    if (result.status === 'rate_limited') {
      return c.html(
        loginPage({ ...chrome, email, error: 'Too many attempts. Try again shortly.' }),
        429,
        { 'retry-after': String(result.retryAfterSeconds) },
      )
    }
    return c.html(loginPage({ ...chrome, sent: true }))
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
      { repos, crypto: ports.crypto, signupPolicy: await effectiveSignupPolicy(repos) },
      { token, now: ports.clock.now(), timezone: timezoneHint(c) },
    )
    if (!result.ok) {
      return c.html(
        loginPage({
          ...(await loginChrome()),
          error:
            result.reason === 'signups_closed'
              ? 'Sign-ups are closed on this instance. Ask its operator for access.'
              : 'That link has expired or was already used. Request a new one.',
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
      { repos, crypto: ports.crypto, signupPolicy: await effectiveSignupPolicy(repos) },
      { token: linkToken, now, timezone: timezoneHint(c) },
    )
    if (!result.ok) {
      // Telling THIS person signups are closed is not an oracle: they just
      // proved control of the address via the provider, so the only thing
      // revealed is the instance's policy about their own email.
      return oauthError(
        c,
        result.reason === 'signups_closed'
          ? 'Sign-ups are closed on this instance. Ask its operator for access.'
          : 'Could not complete sign-in. Please try again.',
      )
    }
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

    // Personal event types first, then each team's — with the OWNER slug on
    // every row, because a team event's public link starts with the team's
    // slug, not the signed-in user's.
    const eventTypes: EventTypeListItem[] = (await repos.eventTypes.listForUser(user.id)).map(
      (eventType) => ({ eventType, ownerSlug: user.slug }),
    )
    const memberships = await repos.teams.memberships(user.id)
    for (const team of await userTeams(c)) {
      const canEdit = canManageTeam(user, memberships.find((m) => m.teamId === team.id))
      for (const eventType of await repos.eventTypes.listForTeam(team.id)) {
        eventTypes.push({ eventType, ownerSlug: team.slug, teamName: team.name, canEdit })
      }
    }

    const bookings = await repos.bookings.listForHost(user.id, {
      start: now,
      end: now + UPCOMING_WINDOW_MS,
    })
    const titles = new Map(eventTypes.map((item) => [item.eventType.id, item.eventType.title]))
    const upcomingBookings: UpcomingBooking[] = bookings
      .filter((b) => b.status === 'confirmed' && b.startUtc >= now)
      .map((booking) => ({ booking, eventTitle: titles.get(booking.eventTypeId) ?? 'Meeting' }))

    // Only the empty home reads these — but they are cheap, and loading them
    // conditionally is how the checklist would one day render against stale
    // assumptions when the condition changes.
    const hasCalendarConnection = (await repos.connections.listForUser(user.id)).length > 0
    const defaultSchedule = await repos.availability.forUser(user.id)

    return c.html(
      dashboardHome({
        brandName,
        user,
        csrf: c.get('csrf'),
        emailDelivery,
        eventTypes,
        upcomingBookings,
        baseUrl: ports.config.baseUrl,
        hasCalendarConnection,
        defaultSchedule,
      }),
    )
  })

  // ===========================================================================
  // Dashboard — event types
  // ===========================================================================

  // Registered before `/:id`, or Hono would read "new" as an id.
  app.get('/dashboard/event-types/new', requireSession, async (c) =>
    c.html(
      eventTypeForm({
        brandName,
        user: c.get('user'),
        csrf: c.get('csrf'),
        emailDelivery,
        teams: await managedTeams(c),
        schedules: await c.get('repos').availability.listForUser(c.get('user').id),
      }),
    ),
  )

  app.get('/dashboard/event-types/:id', requireSession, async (c) => {
    const eventType = await ownedEventType(c)
    if (!eventType) return notFound(c)
    return c.html(
      eventTypeForm({
        brandName,
        user: c.get('user'),
        csrf: c.get('csrf'),
        emailDelivery,
        eventType,
        teams: await managedTeams(c),
        schedules: await c.get('repos').availability.listForUser(c.get('user').id),
        hostChoices: await hostChoicesFor(c, eventType),
        ...(c.req.query('created')
          ? { notice: 'Event type created. Every team member hosts it for now — adjust the hosts below if you want a subset.' }
          : {}),
      }),
    )
  })

  /**
   * The owning team's members as host choices for the form, with each
   * member's schedules by name — an admin arranging a joint meeting sees
   * what they are assigning (core/domain/teams.ts). Empty for a personal
   * event type, which has no hosts block.
   */
  async function hostChoicesFor(c: Ctx, eventType: EventType): Promise<HostChoice[]> {
    if (!eventType.ownerTeamId) return []
    const repos = c.get('repos')
    const [members, rows] = await Promise.all([
      repos.teams.members(eventType.ownerTeamId),
      repos.eventTypeHosts.forEventType(eventType.id),
    ])
    const byUser = new Map(rows.map((r) => [r.userId, r]))
    const explicit = rows.length > 0
    const choices: HostChoice[] = []
    for (const m of members) {
      const user = await repos.users.byId(m.userId)
      if (!user) continue
      const row = byUser.get(m.userId) ?? null
      choices.push({
        user,
        schedules: await repos.availability.listForUser(m.userId),
        row,
        selected: explicit ? row !== null : true,
        teamWeight: m.rrWeight,
      })
    }
    // Stored order first, then the rest in join order — the same order the
    // booking page will show them in.
    return choices.sort((a, b) => (a.row?.position ?? Number.MAX_SAFE_INTEGER) - (b.row?.position ?? Number.MAX_SAFE_INTEGER))
  }

  /**
   * The Hosts block, read back. Returns the rows to store — or `null` when
   * the admin left everything at its default (everyone ticked, required, no
   * schedule, no weight), which keeps the IMPLICIT set so that new members
   * keep joining automatically. Validation errors go to `errors['hosts']`.
   */
  function readHostsForm(
    form: FormData,
    eventType: EventType,
    choices: HostChoice[],
    errors: Record<string, string>,
  ): Array<Omit<EventTypeHost, 'eventTypeId' | 'position'>> | null {
    const collective = eventType.schedulingType === 'collective'
    const rows: Array<Omit<EventTypeHost, 'eventTypeId' | 'position'>> = []
    let touched = false
    for (const choice of choices) {
      const uid = choice.user.id
      const on = form.get(`host-${uid}`) !== null
      if (!on) {
        touched = true
        continue
      }
      const required = collective ? String(form.get(`host-${uid}-mode`) ?? 'required') !== 'optional' : true
      const scheduleRaw = String(form.get(`host-${uid}-schedule`) ?? '').trim()
      const scheduleId = scheduleRaw === '' ? null : scheduleRaw
      const weightRaw = String(form.get(`host-${uid}-weight`) ?? '').trim()
      let rrWeight: number | null = null
      if (!collective && weightRaw !== '') {
        const n = Number(weightRaw)
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          errors['hosts'] = `${choice.user.name || choice.user.slug}: weight must be a whole number from 1 to 100`
        } else {
          rrWeight = n
        }
      }
      if (!required || scheduleId !== null || rrWeight !== null) touched = true
      rows.push({ userId: uid, required, scheduleId, rrWeight })
    }
    if (rows.length === 0) {
      errors['hosts'] = 'Tick at least one host'
      return null
    }
    if (collective && !rows.some((r) => r.required)) {
      errors['hosts'] = 'A collective event type needs at least one required host'
      return null
    }
    return touched ? rows : null
  }

  /**
   * The Hosts block in the order the page RENDERED it, recovered from the
   * form: a browser serialises fields in tree order, and every row carries
   * at least its schedule select whether or not it is ticked, so the first
   * `host-<id>…` key per host is that host's place on the page. This is
   * what makes a reorder stick — `readHostsForm` walks the choices in the
   * order it is handed, and `replace` numbers positions from that. A host
   * the form never mentioned (a member who joined since the page loaded)
   * keeps their place after the rest.
   */
  function orderChoicesByForm(form: FormData, choices: HostChoice[]): HostChoice[] {
    const rank = new Map<string, number>()
    for (const key of form.keys()) {
      for (const ch of choices) {
        const id = ch.user.id
        if (!rank.has(id) && (key === `host-${id}` || key.startsWith(`host-${id}-`))) rank.set(id, rank.size)
      }
    }
    const place = (ch: HostChoice, i: number): number => rank.get(ch.user.id) ?? choices.length + i
    return choices
      .map((ch, i) => ({ ch, at: place(ch, i) }))
      .sort((a, b) => a.at - b.at)
      .map((x) => x.ch)
  }

  /**
   * The block as submitted, attached to each choice as its unsaved draft
   * for a re-render that does not save (move, select all/none): the
   * attendance, schedule and weight the admin has typed survive the round
   * trip instead of reverting to D1. The weight is echoed as text, not
   * parsed — nothing is being saved, so nothing is validated yet.
   */
  function withHostDrafts(form: FormData, choices: HostChoice[], collective: boolean): HostChoice[] {
    return choices.map((ch) => {
      const uid = ch.user.id
      return {
        ...ch,
        draft: {
          selected: form.get(`host-${uid}`) !== null,
          required: collective ? String(form.get(`host-${uid}-mode`) ?? 'required') !== 'optional' : true,
          scheduleId: String(form.get(`host-${uid}-schedule`) ?? '').trim() || null,
          weightText: String(form.get(`host-${uid}-weight`) ?? ''),
        },
      }
    })
  }

  /** See host-notifications.ts — shared with the API, which adds hosts too. */
  async function notifyNewHosts(
    c: Ctx,
    eventType: EventType,
    before: Set<string>,
    after: Array<{ userId: string; required: boolean; scheduleId: string | null }>,
  ): Promise<void> {
    await notifyNewHostsShared(ports, c.get('repos'), c.get('user'), eventType, before, after)
  }

  app.post('/dashboard/event-types', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const repos = c.get('repos')
    const { draft, questionsText } = readEventTypeForm(form, user.id)
    const errors = await validateEventType(repos, user, draft, questionsText, null)
    if (Object.keys(errors).length > 0) {
      return c.html(
        eventTypeForm({
          brandName,
          user,
          csrf: c.get('csrf'),
          emailDelivery,
          eventType: draft,
          questionsText,
          errors,
          teams: await managedTeams(c),
          schedules: await repos.availability.listForUser(user.id),
        }),
        400,
      )
    }

    const created = await repos.eventTypes.create({ ...draft, id: `evt_${ports.crypto.randomToken(12)}` })
    await advanceBookmark(c)
    if (created.ownerTeamId) {
      // Every member hosts a new team event type until the admin narrows
      // it: tell them, and land on the edit page where the Hosts block is.
      const members = await repos.teams.members(created.ownerTeamId)
      await notifyNewHosts(
        c,
        created,
        new Set(),
        members.map((m) => ({ userId: m.userId, required: true, scheduleId: null })),
      )
      return c.redirect(`/dashboard/event-types/${encodeURIComponent(created.id)}?created=1`, 302)
    }
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

    // The Hosts block only exists for the team the event type was SAVED
    // under: a change of owner clears the set (every member of the new
    // team, until the admin narrows it), same as a fresh create.
    const sameTeam = draft.ownerTeamId !== null && draft.ownerTeamId === existing.ownerTeamId
    const choices = sameTeam
      ? orderChoicesByForm(form, await hostChoicesFor(c, { ...existing, schedulingType: draft.schedulingType }))
      : []

    // Move up/down and select all/none: no-JS-safe `formnovalidate` submits
    // that change the Hosts block and re-render — never a save, and never a
    // validation pass, since the admin is mid-edit (same reasoning as the
    // schedule editor's "+ Add range"). Everything else typed on the form
    // rides along in `draft`, `questionsText` and the per-host drafts.
    const move = form.get('host-move')
    const select = form.get('host-select')
    if (sameTeam && (typeof move === 'string' || typeof select === 'string')) {
      const collective = draft.schedulingType === 'collective'
      let drafted = withHostDrafts(form, choices, collective)
      let notice: string | undefined
      if (typeof move === 'string') {
        // "<id>:up" / "<id>:down" as `hostsFields` renders it. A crafted id,
        // or the first row up / last row down, changes nothing and just
        // re-renders; there is nothing to repair.
        const at = move.lastIndexOf(':')
        const id = move.slice(0, at)
        const dir = move.slice(at + 1)
        const from = drafted.findIndex((ch) => ch.user.id === id)
        const to = dir === 'up' ? from - 1 : dir === 'down' ? from + 1 : -1
        if (from >= 0 && to >= 0 && to < drafted.length) {
          const next = [...drafted]
          next.splice(from, 1)
          next.splice(to, 0, drafted[from]!)
          drafted = next
          notice = 'Order changed — save to keep it'
        }
      } else if (select === 'all' || select === 'none') {
        drafted = drafted.map((ch) => ({ ...ch, draft: { ...ch.draft!, selected: select === 'all' } }))
        notice = select === 'all' ? 'Every host ticked — save to keep it' : 'Every host unticked — save to keep it'
      }
      return c.html(
        eventTypeForm({
          brandName,
          user,
          csrf: c.get('csrf'),
          emailDelivery,
          eventType: draft,
          questionsText: read.questionsText,
          teams: await managedTeams(c),
          schedules: await repos.availability.listForUser(user.id),
          hostChoices: drafted,
          ...(notice ? { notice } : {}),
        }),
      )
    }

    const hostRows = sameTeam ? readHostsForm(form, draft, choices, errors) : null

    if (Object.keys(errors).length > 0) {
      return c.html(
        eventTypeForm({
          brandName,
          user,
          csrf: c.get('csrf'),
          emailDelivery,
          eventType: draft,
          questionsText: read.questionsText,
          errors,
          teams: await managedTeams(c),
          schedules: await repos.availability.listForUser(user.id),
          hostChoices: choices,
        }),
        400,
      )
    }

    const before = new Set(choices.filter((ch) => ch.selected).map((ch) => ch.user.id))
    await repos.eventTypes.update(existing.id, draft)
    if (draft.ownerTeamId !== null) {
      // Atomic replace, guarded in SQL: a host who left the team or a
      // schedule deleted since the page loaded fails the whole set, and the
      // form comes back saying so rather than storing a dangling reference.
      const ok = await repos.eventTypeHosts.replace(existing.id, sameTeam ? (hostRows ?? []) : [])
      if (!ok) {
        return c.html(
          eventTypeForm({
            brandName,
            user,
            csrf: c.get('csrf'),
            emailDelivery,
            eventType: draft,
            questionsText: read.questionsText,
            errors: { hosts: 'A host is no longer on the team, or a schedule was deleted. Reload the page and try again.' },
            teams: await managedTeams(c),
            schedules: await repos.availability.listForUser(user.id),
            hostChoices: await hostChoicesFor(c, draft),
          }),
          409,
        )
      }
      const after = sameTeam
        ? (hostRows ?? choices.map((ch) => ({ userId: ch.user.id, required: true, scheduleId: null })))
        : (await repos.teams.members(draft.ownerTeamId)).map((m) => ({ userId: m.userId, required: true, scheduleId: null }))
      await notifyNewHosts(c, draft, before, after)
    } else if (existing.ownerTeamId) {
      await repos.eventTypeHosts.replace(existing.id, [])
    }
    await advanceBookmark(c)
    return c.redirect('/dashboard', 302)
  })

  /** The edit form with everything it needs, for the logo routes' re-render. */
  async function editFormData(c: Ctx, eventType: EventType): Promise<EventTypeFormData> {
    return {
      brandName,
      user: c.get('user'),
      csrf: c.get('csrf'),
      emailDelivery,
      eventType,
      teams: await managedTeams(c),
      schedules: await c.get('repos').availability.listForUser(c.get('user').id),
      hostChoices: await hostChoicesFor(c, eventType),
    }
  }

  app.post('/dashboard/event-types/:id/logo', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const existing = await ownedEventType(c)
    if (!existing) return notFound(c)
    const stored = await storeUploadedImage(form.get('logo'))
    if (!stored.ok) return c.html(eventTypeForm({ ...(await editFormData(c, existing)), errors: { logo: stored.message } }), 400)
    await c.get('repos').eventTypes.update(existing.id, { logoKey: stored.key })
    await advanceBookmark(c)
    return c.html(eventTypeForm({ ...(await editFormData(c, { ...existing, logoKey: stored.key })), notice: 'Logo updated.' }))
  })

  app.post('/dashboard/event-types/:id/logo-shape', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const existing = await ownedEventType(c)
    if (!existing) return notFound(c)
    const shape = String(form.get('shape') ?? '')
    if (!isLogoShape(shape)) return c.html(eventTypeForm({ ...(await editFormData(c, existing)), errors: { logo: 'Choose a circle or its own proportions.' } }), 400)
    if (!existing.logoKey) return c.html(eventTypeForm({ ...(await editFormData(c, existing)), errors: { logo: 'Upload a logo first.' } }), 400)
    if (shape === 'natural' && !(await ensureFitThumb(existing.logoKey))) {
      return c.html(eventTypeForm({ ...(await editFormData(c, existing)), errors: { logo: 'The original of this logo is gone — upload it again to show it in its own proportions.' } }), 400)
    }
    await c.get('repos').eventTypes.update(existing.id, { logoShape: shape })
    await advanceBookmark(c)
    return c.html(eventTypeForm({ ...(await editFormData(c, { ...existing, logoShape: shape })), notice: shape === 'natural' ? 'Logo shown in its own proportions.' : 'Logo shown as a circle.' }))
  })

  app.post('/dashboard/event-types/:id/logo/delete', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const existing = await ownedEventType(c)
    if (!existing) return notFound(c)
    await c.get('repos').eventTypes.update(existing.id, { logoKey: null })
    await advanceBookmark(c)
    return c.html(eventTypeForm({ ...(await editFormData(c, { ...existing, logoKey: null })), notice: 'Logo removed.' }))
  })

  app.post('/dashboard/event-types/:id/delete', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const existing = await ownedEventType(c)
    if (!existing) return notFound(c)
    const deleted = await c.get('repos').eventTypes.delete(existing.id, ports.clock.now())
    await advanceBookmark(c)
    if (!deleted) {
      // Deleting it would strand those guests: the queued sync reads this row
      // to render their confirmation, so the booking would exist with nobody
      // told about it. Deactivating stops new bookings without that cost.
      return c.html(
        eventTypeForm({
          brandName,
          user: c.get('user'),
          csrf: c.get('csrf'),
          emailDelivery,
          eventType: existing,
          teams: await managedTeams(c),
          schedules: await c.get('repos').availability.listForUser(c.get('user').id),
          // The message below tells the admin to untick "Visible" on THIS
          // form and save; without the Hosts block that save would read
          // every host as unticked and 400.
          hostChoices: await hostChoicesFor(c, existing),
          errors: {
            delete:
              'This event type still has upcoming confirmed bookings. Cancel them first, or untick ' +
              '"Visible on the booking page" to stop taking new ones while keeping those meetings.',
          },
        }),
        409,
      )
    }
    return c.redirect('/dashboard', 302)
  })

  /**
   * Ownership is checked here, once, rather than trusted from the URL.
   * A team-owned event type is edited by the team's ADMINS (and the
   * instance admin) — a plain member hosts it and sees it on the home page,
   * but the same person who picks the hosts arranges the event type
   * (core/domain/teams.ts). Non-admins get the same 404 as a wrong id.
   */
  async function ownedEventType(c: Ctx): Promise<EventType | null> {
    const found = await c.get('repos').eventTypes.byId(c.req.param('id') ?? '')
    if (!found) return null
    const user = c.get('user')
    if (found.ownerUserId === user.id) return found
    if (found.ownerTeamId && (await managesTeam(c, found.ownerTeamId))) return found
    return null
  }

  /** The signed-in user's own row on `teamId`, or null when they are not on it. */
  async function membershipOn(c: Ctx, teamId: string): Promise<TeamMember | null> {
    const memberships = await c.get('repos').teams.memberships(c.get('user').id)
    return memberships.find((m) => m.teamId === teamId) ?? null
  }

  /** `canManageTeam` for the signed-in user and one team. */
  async function managesTeam(c: Ctx, teamId: string): Promise<boolean> {
    return canManageTeam(c.get('user'), await membershipOn(c, teamId))
  }

  /** The signed-in user's teams, resolved from their memberships. */
  async function userTeams(c: Ctx): Promise<Team[]> {
    const repos = c.get('repos')
    const memberships = await repos.teams.memberships(c.get('user').id)
    const teams: Team[] = []
    for (const membership of memberships) {
      const team = await repos.teams.byId(membership.teamId)
      if (team) teams.push(team)
    }
    return teams
  }

  /**
   * The teams the signed-in user can put an event type under: the ones they
   * are an admin of, plus every team for an instance admin. Offered by the
   * event-type form's owner select, so the select never lists a team the
   * validator would then refuse.
   */
  async function managedTeams(c: Ctx): Promise<Team[]> {
    const repos = c.get('repos')
    const user = c.get('user')
    if (user.role === 'admin') return repos.teams.list()
    const memberships = await repos.teams.memberships(user.id)
    const teams: Team[] = []
    for (const membership of memberships) {
      if (!isManagingRole(membership.role)) continue
      const team = await repos.teams.byId(membership.teamId)
      if (team) teams.push(team)
    }
    return teams
  }

  // ===========================================================================
  // Dashboard — availability (named schedules)
  // ===========================================================================

  /**
   * Whose schedules a request is about. The personal routes below are about
   * the signed-in user. The team routes further down are about the member
   * named in the URL, on behalf of whom a team admin is acting — `scope`
   * carries that, and every page link and form action then hangs off the
   * team path instead of /dashboard/availability.
   */
  interface ScheduleSubject {
    subject: User
    scope?: ScheduleScope
  }

  const selfSubject = (c: Ctx): ScheduleSubject => ({ subject: c.get('user') })

  async function schedulesData(c: Ctx, who: ScheduleSubject): Promise<SchedulesPageData> {
    const repos = c.get('repos')
    const schedules = await repos.availability.listForUser(who.subject.id)
    // "set up by …" needs names for creators other than the owner. Deleted
    // creators simply stay out of the map; the page says "a team admin".
    const creatorNames: Record<string, string> = {}
    const creatorIds = new Set(
      schedules.map((sc) => sc.createdBy).filter((id): id is string => typeof id === 'string' && id !== who.subject.id),
    )
    for (const id of creatorIds) {
      const creator = await repos.users.byId(id)
      if (creator) creatorNames[id] = creator.name || creator.slug
    }
    return {
      brandName,
      user: c.get('user'),
      csrf: c.get('csrf'),
      emailDelivery,
      schedules,
      creatorNames,
      ...(who.scope ? { scope: who.scope } : { teamEvents: await teamEventsFor(c, who.subject) }),
    }
  }

  /**
   * The team event types `subject` hosts — explicitly, or as a member of a
   * team whose event type has no explicit set — with their per-event
   * schedule choice. The "Team events" section of the personal page.
   */
  async function teamEventsFor(c: Ctx, subject: User): Promise<TeamEventChoice[]> {
    const repos = c.get('repos')
    const out: TeamEventChoice[] = []
    for (const membership of await repos.teams.memberships(subject.id)) {
      const team = await repos.teams.byId(membership.teamId)
      if (!team) continue
      for (const eventType of await repos.eventTypes.listForTeam(team.id)) {
        const rows = await repos.eventTypeHosts.forEventType(eventType.id)
        const mine = rows.find((r) => r.userId === subject.id)
        if (rows.length > 0 && !mine) continue
        out.push({ eventType, teamName: team.name, scheduleId: mine?.scheduleId ?? null })
      }
    }
    return out
  }

  app.post('/dashboard/availability/team-events/:eventTypeId', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const repos = c.get('repos')
    const who = selfSubject(c)
    const eventType = await repos.eventTypes.byId(c.req.param('eventTypeId') ?? '')
    const choice = eventType
      ? (await teamEventsFor(c, user)).find((te) => te.eventType.id === eventType.id)
      : undefined
    if (!eventType || !choice || !eventType.ownerTeamId) return notFound(c)

    const raw = String(form.get('scheduleId') ?? '').trim()
    const scheduleId = raw === '' ? null : raw
    const errorKey = `team-event-${eventType.id}`
    if (scheduleId && !(await repos.availability.byId(user.id, scheduleId))) {
      return c.html(schedulesPage({ ...(await schedulesData(c, who)), errors: { [errorKey]: 'Not one of your schedules' } }), 400)
    }

    // No explicit set yet: the host's choice makes it explicit — every
    // current member, required, as the implicit set already meant. Insert-
    // if-absent, not replace: two hosts converting at the same moment each
    // keep their own row, and the setSchedule below is the only write that
    // touches THIS host's. From here on an admin edits the list; new
    // members no longer join it automatically, and the form says so.
    if ((await repos.eventTypeHosts.forEventType(eventType.id)).length === 0) {
      const members = await repos.teams.members(eventType.ownerTeamId)
      await repos.eventTypeHosts.ensure(
        eventType.id,
        members.map((m) => ({ userId: m.userId, required: true, scheduleId: null, rrWeight: null })),
      )
    }
    const ok = await repos.eventTypeHosts.setSchedule(eventType.id, user.id, scheduleId)
    if (!ok) {
      return c.html(
        schedulesPage({ ...(await schedulesData(c, who)), errors: { [errorKey]: 'That could not be saved — reload and try again.' } }),
        409,
      )
    }
    await advanceBookmark(c)
    return c.html(schedulesPage({ ...(await schedulesData(c, who)), notice: `"${eventType.title}" now uses ${scheduleId ? 'that schedule' : 'your default schedule'}.` }))
  })

  /** Scoped by the subject, same reasoning as `managedTeam` — no cross-user id-guessing. */
  async function subjectSchedule(c: Ctx, who: ScheduleSubject, param: string): Promise<Schedule | null> {
    return c.get('repos').availability.byId(who.subject.id, c.req.param(param) ?? '')
  }

  function scheduleFormData(c: Ctx, who: ScheduleSubject, schedule: Schedule): ScheduleFormData {
    return {
      brandName,
      user: c.get('user'),
      csrf: c.get('csrf'),
      emailDelivery,
      schedule,
      ...(who.scope ? { scope: who.scope } : {}),
    }
  }

  async function listSchedules(c: Ctx, who: ScheduleSubject): Promise<Response> {
    return c.html(schedulesPage(await schedulesData(c, who)))
  }

  async function createSchedule(c: Ctx, who: ScheduleSubject): Promise<Response> {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const repos = c.get('repos')
    const name = String(form.get('name') ?? '').trim()
    if (name === '' || name.length > 120) {
      return c.html(
        schedulesPage({
          ...(await schedulesData(c, who)),
          nameValue: name,
          errors: { 'schedule-name': 'Required, up to 120 characters' },
        }),
        400,
      )
    }

    // Starts as a copy of the default's hours — a blank week is a worse
    // starting point than "the same as what already works," and the host
    // edits it immediately after on its own page anyway.
    const base = (await repos.availability.forUser(who.subject.id)) ?? defaultSchedule(who.subject, '')
    const created = await repos.availability.create(
      who.subject.id,
      {
        id: `sch_${ports.crypto.randomToken(12)}`,
        userId: who.subject.id,
        name,
        isDefault: false,
        timezone: base.timezone,
        weekly: base.weekly,
        overrides: [],
      },
      c.get('user').id,
    )
    await advanceBookmark(c)
    const basePath = who.scope?.basePath ?? '/dashboard/availability'
    return c.redirect(`${basePath}/${encodeURIComponent(created.id)}`, 302)
  }

  async function editSchedule(c: Ctx, who: ScheduleSubject, param: string): Promise<Response> {
    const schedule = await subjectSchedule(c, who, param)
    if (!schedule) return notFound(c)
    return c.html(scheduleForm(scheduleFormData(c, who, schedule)))
  }

  async function saveSchedule(c: Ctx, who: ScheduleSubject, param: string): Promise<Response> {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const actor = c.get('user')
    const repos = c.get('repos')
    const schedule = await subjectSchedule(c, who, param)
    if (!schedule) return notFound(c)

    const weeklyDraft = readWeeklyDraftFromForm(form)

    // Every day's editor renders at least one range row (`dayRow`,
    // pages/dashboard.ts), so a POST from THIS form always carries a
    // `day-N-start-0` field per day, even when it's blank. Zero ranges on
    // every single day means the POST came from the OLD single-text-field
    // layout instead (a tab left open across a deploy) — parsing that as
    // "every day disabled" would silently blank the whole schedule on save.
    if (weeklyDraft.every((d) => d.ranges.length === 0)) {
      return c.html(
        shellHead({ title: 'Request not accepted', brandName }) +
          errorPage('Request not accepted', 'This page was open from before an update. Reload and try again.') +
          shellFoot(),
        409,
      )
    }

    // "+ Add range" and "Remove": no-JS-safe `formnovalidate` submits that
    // add or drop one range row on ONE day and re-render — never a save.
    // The rest of the form's in-progress values round-trip through
    // `weeklyDraft` (every day, not just the one that changed), `nameValue`,
    // `timezoneValue` and `overridesText`, rather than reverting to whatever
    // is in D1 — same reasoning as the rejected-save path just below. Losing
    // an edited timezone here would be worse than a display glitch: the
    // eventual save would write the host's hours under the OLD zone,
    // silently offering guests the wrong wall-clock times. Overrides is
    // echoed as RAW TEXT rather than parsed — this branch never saves, so a
    // half-finished line has no business being validated (let alone silently
    // dropped) yet.
    const addRangeDay = form.get('add-range')
    const removeRange = form.get('remove-range')
    if (typeof addRangeDay === 'string' || typeof removeRange === 'string') {
      if (typeof addRangeDay === 'string') {
        const day = Number(addRangeDay)
        if (Number.isInteger(day) && day >= 0 && day < 7 && weeklyDraft[day]!.ranges.length < MAX_RANGES_PER_DAY) {
          weeklyDraft[day]!.ranges.push({ start: '', end: '' })
        }
      } else {
        // "<day>-<index>" as `dayRow` renders it. Anything else — a crafted
        // POST, or an index past the rows this submit actually carried —
        // changes nothing and just re-renders; there is nothing to repair.
        const match = /^([0-6])-(\d{1,2})$/.exec(String(removeRange))
        if (match) {
          const ranges = weeklyDraft[Number(match[1])]!.ranges
          const index = Number(match[2])
          if (index < ranges.length) ranges.splice(index, 1)
        }
      }
      const nameValue = String(form.get('name') ?? '')
      const timezoneValue = String(form.get('timezone') ?? '').trim()
      const overridesText = String(form.get('overrides') ?? '')
      const draft: Schedule = {
        ...schedule,
        name: nameValue || schedule.name,
        timezone: isValidTimeZone(timezoneValue) ? timezoneValue : schedule.timezone,
      }
      return c.html(scheduleForm({ ...scheduleFormData(c, who, draft), nameValue, weeklyDraft, overridesText }))
    }

    const errors: Record<string, string> = {}

    const name = String(form.get('name') ?? '').trim()
    if (name === '' || name.length > 120) errors['schedule-name'] = 'Required, up to 120 characters'

    const timezone = String(form.get('timezone') ?? '').trim()
    if (!isValidTimeZone(timezone)) errors['timezone'] = 'Not a recognised timezone name'

    const { weekly, errors: weeklyErrors } = parseWeeklyDraft(weeklyDraft)
    Object.assign(errors, weeklyErrors)

    const overrides = parseOverrides(String(form.get('overrides') ?? ''))
    if (overrides === null) errors['overrides'] = 'Use lines like 2026-12-24 10:00-14:00'

    const draft: Schedule = {
      ...schedule,
      name: name === '' ? schedule.name : name,
      timezone: isValidTimeZone(timezone) ? timezone : schedule.timezone,
      weekly,
      overrides: overrides ?? [],
    }

    if (Object.keys(errors).length > 0) {
      // Same reasoning as the add-range branch's `overridesText`: echo the
      // raw typed lines, not `draft.overrides` (which is `[]` whenever
      // `overrides` is exactly the field that failed to parse) — otherwise a
      // reject on ANY field wipes every override line the host just typed,
      // including the ones that were valid, right when the error message is
      // pointing at this box asking them to fix it.
      return c.html(
        scheduleForm({
          ...scheduleFormData(c, who, draft),
          errors,
          weeklyDraft,
          overridesText: String(form.get('overrides') ?? ''),
        }),
        400,
      )
    }

    await repos.availability.update(
      who.subject.id,
      schedule.id,
      { name: draft.name, timezone: draft.timezone, weekly: draft.weekly, overrides: draft.overrides },
      actor.id,
    )
    // The booking page renders the host's month grid in `users.tz`, so for
    // the DEFAULT schedule specifically, leaving the two to drift would show
    // a calendar that disagrees with the schedule actually in effect for
    // most of the host's event types. A non-default schedule's timezone has
    // no such single-field mirror to keep in sync. The subject's row, not
    // the actor's: an admin editing a member's default moves the MEMBER's
    // calendar.
    if (schedule.isDefault && draft.timezone !== who.subject.tz) {
      await repos.users.update(who.subject.id, { tz: draft.timezone })
    }
    await advanceBookmark(c)

    const chromeUser = !who.scope && schedule.isDefault ? { ...actor, tz: draft.timezone } : actor
    return c.html(scheduleForm({ ...scheduleFormData(c, who, draft), user: chromeUser, notice: 'Schedule saved.' }))
  }

  async function duplicateSchedule(c: Ctx, who: ScheduleSubject, param: string): Promise<Response> {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const repos = c.get('repos')
    const schedule = await subjectSchedule(c, who, param)
    if (!schedule) return notFound(c)

    // The 120-char cap enforced on the name field (both here and on the
    // create/edit forms) applies to the GENERATED name too — an untruncated
    // "${name} copy" on an already-120-char schedule would insert a 125-char
    // name today and then refuse to save on the very next edit, since that
    // route re-validates the same limit.
    const copyName = `${schedule.name} copy`.slice(0, 120)
    await repos.availability.create(
      who.subject.id,
      {
        id: `sch_${ports.crypto.randomToken(12)}`,
        userId: who.subject.id,
        name: copyName,
        isDefault: false,
        timezone: schedule.timezone,
        weekly: schedule.weekly,
        overrides: schedule.overrides,
      },
      c.get('user').id,
    )
    await advanceBookmark(c)
    return c.html(schedulesPage({ ...(await schedulesData(c, who)), notice: 'Schedule duplicated.' }))
  }

  async function setDefaultSchedule(c: Ctx, who: ScheduleSubject, param: string): Promise<Response> {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const repos = c.get('repos')
    const schedule = await subjectSchedule(c, who, param)
    if (!schedule) return notFound(c)
    if (schedule.isDefault) return c.html(schedulesPage(await schedulesData(c, who))) // stale page double-submit

    const didSetDefault = await repos.availability.setDefault(who.subject.id, schedule.id)
    if (!didSetDefault) {
      // Refused because the target vanished between the read above and this
      // write (a concurrent delete from another tab) — the repository's own
      // guard already keeps the OLD default intact for exactly this case, so
      // there is nothing to roll back here. A stale-page no-op, same
      // distinction as team-member removal and admin demotion elsewhere.
      await advanceBookmark(c)
      return c.html(schedulesPage(await schedulesData(c, who)))
    }
    // Mirrors the save route's reasoning: the booking page renders in
    // `users.tz`, which must track whichever schedule is now the default.
    if (schedule.timezone !== who.subject.tz) await repos.users.update(who.subject.id, { tz: schedule.timezone })
    await advanceBookmark(c)
    const owner = who.scope ? `${who.subject.name || who.subject.slug}'s` : 'your'
    return c.html(
      schedulesPage({ ...(await schedulesData(c, who)), notice: `"${schedule.name}" is now ${owner} default.` }),
    )
  }

  app.get('/dashboard/availability', requireSession, (c) => listSchedules(c, selfSubject(c)))
  app.post('/dashboard/availability/new', requireSession, (c) => createSchedule(c, selfSubject(c)))
  app.get('/dashboard/availability/:id', requireSession, (c) => editSchedule(c, selfSubject(c), 'id'))
  app.post('/dashboard/availability/:id', requireSession, (c) => saveSchedule(c, selfSubject(c), 'id'))
  app.post('/dashboard/availability/:id/duplicate', requireSession, (c) => duplicateSchedule(c, selfSubject(c), 'id'))
  app.post('/dashboard/availability/:id/set-default', requireSession, (c) => setDefaultSchedule(c, selfSubject(c), 'id'))

  // Delete is personal-only, by design: an admin sets a member's
  // availability up; what of theirs goes away is the member's call.
  app.post('/dashboard/availability/:id/delete', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const who = selfSubject(c)
    const user = c.get('user')
    const repos = c.get('repos')
    const schedule = await subjectSchedule(c, who, 'id')
    // A stale page double-submit (already gone) is a no-op, same distinction
    // as team-member removal and admin demotion below.
    if (!schedule) return c.html(schedulesPage(await schedulesData(c, who)))

    const deleted = await repos.availability.delete(user.id, schedule.id)
    if (!deleted) {
      // The guard refuses for three different reasons (default, last
      // remaining, or still referenced by an event type) — cheap to
      // distinguish here since the page just re-fetched the full list.
      const reason = schedule.isDefault
        ? 'Cannot delete your default schedule — set another one as default first.'
        : 'Cannot delete a schedule an event type is still using.'
      return c.html(schedulesPage({ ...(await schedulesData(c, who)), errors: { [`schedule-${schedule.id}`]: reason } }), 400)
    }
    await advanceBookmark(c)
    return c.html(schedulesPage({ ...(await schedulesData(c, who)), notice: 'Schedule deleted.' }))
  })

  // ===========================================================================
  // Dashboard — teams
  //
  // Permission model (core/domain/teams.ts): a team's ADMINS manage its
  // members, roles, event types and — on each member's behalf — availability.
  // A plain member hosts meetings and adjusts their own hours. The instance
  // admin manages every team, member or not. Deleting a whole team is
  // deliberately out of scope; the page copy says so.
  // ===========================================================================

  /**
   * Everything the teams page renders: the signed-in user's own teams, and
   * for an instance admin every other team on the instance as well, marked
   * as such.
   */
  async function teamsData(c: Ctx): Promise<Pick<TeamsPageData, 'brandName' | 'user' | 'csrf' | 'emailDelivery' | 'teams'>> {
    const repos = c.get('repos')
    const user = c.get('user')
    const memberships = await repos.teams.memberships(user.id)
    const views: TeamView[] = []
    const seen = new Set<string>()
    const view = async (team: Team, viaInstanceAdmin: boolean): Promise<TeamView> => {
      const members = []
      for (const member of await repos.teams.members(team.id)) {
        members.push({ member, user: await repos.users.byId(member.userId) })
      }
      const canManage = canManageTeam(user, memberships.find((m) => m.teamId === team.id))
      return { team, members, canManage, ...(viaInstanceAdmin ? { viaInstanceAdmin } : {}) }
    }
    for (const team of await userTeams(c)) {
      seen.add(team.id)
      views.push(await view(team, false))
    }
    if (user.role === 'admin') {
      for (const team of await repos.teams.list()) {
        if (!seen.has(team.id)) views.push(await view(team, true))
      }
    }
    return { brandName, user, csrf: c.get('csrf'), emailDelivery, teams: views }
  }

  /**
   * The team the URL names, IF the signed-in user manages it. Anyone else —
   * outsider or plain member — gets the same 404 as a wrong id: confirming
   * the team exists would leak instance structure to anyone with an account.
   */
  async function managedTeam(c: Ctx): Promise<Team | null> {
    const teamId = c.req.param('id') ?? ''
    if (!(await managesTeam(c, teamId))) return null
    return c.get('repos').teams.byId(teamId)
  }

  /**
   * A member of the managed team, as the subject of the availability routes
   * below. Not a member (any more) → 404, same as the team itself.
   */
  async function managedMember(c: Ctx): Promise<ScheduleSubject | null> {
    const team = await managedTeam(c)
    if (!team) return null
    const repos = c.get('repos')
    const userId = c.req.param('userId') ?? ''
    if (!(await repos.teams.members(team.id)).some((m) => m.userId === userId)) return null
    const subject = await repos.users.byId(userId)
    if (!subject) return null
    const basePath = `/dashboard/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(userId)}/availability`
    return { subject, scope: { subject, team, basePath } }
  }

  app.get('/dashboard/teams', requireSession, async (c) =>
    c.html(
      teamsPage({
        ...(await teamsData(c)),
        ...(c.req.query('created') ? { notice: 'Team created. You are its first member.' } : {}),
      }),
    ),
  )

  app.post('/dashboard/teams', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const repos = c.get('repos')
    const name = String(form.get('name') ?? '').trim()
    const raw = String(form.get('slug') ?? '').trim()
    const errors: Record<string, string> = {}

    if (name === '' || name.length > 120) errors['team-name'] = 'Give the team a name (up to 120 characters)'

    // Same slug rules and the same TWO-table collision check as the settings
    // slug-change route, for the same reason: `bookingPageContext` resolves a
    // public page's owner slug against users OR teams, so a team slug
    // colliding with an existing user's slug makes /that-slug/<event>
    // ambiguous. Case is refused rather than folded, as in settings.
    //
    // The collision lookup runs BEFORE the reserved-word check: a slug that
    // is both (a team on "support" from before the word was reserved) is
    // refused for the reason the host can see and act on — who has it —
    // rather than a reservation they have no way to verify. Format errors
    // still come first; a malformed slug cannot be anyone's.
    if (raw !== raw.toLowerCase()) {
      errors['team-slug'] = 'Lowercase letters, numbers and hyphens only'
    } else {
      const validation = validateSlug(raw)
      if (!validation.ok && validation.reason !== 'reserved') {
        errors['team-slug'] = validation.message ?? 'Not a valid slug'
      } else {
        const [existingUser, existingTeam] = await Promise.all([
          repos.users.bySlug(raw),
          repos.teams.bySlug(raw),
        ])
        const owner = existingUser ? existingUser.name || existingUser.slug : existingTeam?.name
        if (owner !== undefined) errors['team-slug'] = `That slug is already taken by ${owner}`
        else if (!validation.ok) errors['team-slug'] = validation.message ?? 'Not a valid slug'
      }
    }

    if (Object.keys(errors).length > 0) {
      return c.html(
        teamsPage({ ...(await teamsData(c)), nameValue: name, slugValue: raw, errors }),
        400,
      )
    }

    // Read-then-write: a concurrent create of the same slug — by another
    // team, a signup, or a slug change — can slip past the check above and
    // hit teams_slug_idx or the shared slug_claims constraint instead
    //. That window is a form re-submit away from fixed, so
    // createWithFirstMember catches the constraint and returns null rather
    // than growing the repository a compare-and-swap for it — but the
    // caller still has to turn that into the same form error, not an
    // uncaught 500.
    // The creator is the first member, in the SAME atomic write as the team
    // row — a team with no members can be seen and managed by nobody, and a
    // transient failure between two separate inserts would strand exactly
    // that, with the slug squatted forever.
    const created = await repos.teams.createWithFirstMember(
      { id: `team_${ports.crypto.randomToken(12)}`, name, slug: raw, logoKey: null },
      { userId: user.id, role: 'admin', rrWeight: 1 },
    )
    if (!created) {
      return c.html(
        teamsPage({
          ...(await teamsData(c)),
          nameValue: name,
          slugValue: raw,
          errors: { 'team-slug': 'That slug is already taken' },
        }),
        400,
      )
    }
    await advanceBookmark(c)
    return c.redirect('/dashboard/teams?created=1', 302)
  })

  app.post('/dashboard/teams/:id/members', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const team = await managedTeam(c)
    if (!team) return notFound(c)

    const repos = c.get('repos')
    const email = String(form.get('email') ?? '').trim().toLowerCase()
    const weightRaw = String(form.get('weight') ?? '').trim()
    const weight = weightRaw === '' ? 1 : Number(weightRaw)
    const errors: Record<string, string> = {}

    const target = email === '' ? null : await repos.users.byEmail(email)
    if (email === '') errors[`email-${team.id}`] = 'Enter an email address'
    else if (!target) errors[`email-${team.id}`] = 'No user with that email on this instance'
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
      errors[`weight-${team.id}`] = 'A whole number from 1 to 100'
    }

    if (Object.keys(errors).length > 0 || !target) {
      return c.html(
        teamsPage({
          ...(await teamsData(c)),
          addValues: { teamId: team.id, email, weight: weightRaw },
          errors,
        }),
        400,
      )
    }

    // `addMember` upserts on (team, user), which is how a weight is changed
    // without JS: re-add the same email with the new weight. The role given
    // here applies only when the row is new — an existing member keeps
    // theirs inside the statement itself, so a stale submit racing a
    // promotion cannot demote anyone.
    await repos.teams.addMember({ teamId: team.id, userId: target.id, role: 'member', rrWeight: weight })
    await advanceBookmark(c)
    return c.html(
      teamsPage({
        ...(await teamsData(c)),
        notice: `${target.email} is on ${team.name}.`,
      }),
    )
  })

  app.post('/dashboard/teams/:id/members/:userId/remove', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const team = await managedTeam(c)
    if (!team) return notFound(c)

    const repos = c.get('repos')
    const members = await repos.teams.members(team.id)
    const target = members.find((m) => m.userId === c.req.param('userId'))
    // A stale page double-submit: the member is already gone, nothing to do.
    if (!target) return c.html(teamsPage(await teamsData(c)))

    // A team must keep at least one member — with zero, nobody's memberships
    // resolve it, so it becomes unmanageable by everyone forever (deleting
    // teams is out of scope this pass). The guard lives INSIDE the delete
    // statement (removeMemberGuarded), so two concurrent removals on a
    // two-member team cannot both pass a separate count and zero the team
    // out. The page hides the button on the only member as well.
    const removed = await repos.teams.removeMemberGuarded(team.id, target.userId)
    if (!removed) {
      // Refused for one of two reasons, and only one is an error: the target
      // being the last member. Already-gone (a concurrent removal or a stale
      // page's double submit) is a no-op — same distinction as admin
      // demotion.
      const still = (await repos.teams.members(team.id)).some((m) => m.userId === target.userId)
      if (!still) return c.html(teamsPage(await teamsData(c)))
      // Three guards share the statement; the page just re-read the state
      // that tells them apart. Required-host first, since it is the one
      // with something the admin can go and change.
      const requiredOn = await repos.eventTypeHosts.requiredOn(team.id, target.userId)
      const reason =
        requiredOn.length > 0
          ? `Still a required host on ${requiredOn.map((et) => `"${et.title}"`).join(', ')} — take them off it, or make them optional, first.`
          : 'A team must keep at least one member, and at least one admin.'
      return c.html(teamsPage({ ...(await teamsData(c)), errors: { [`members-${team.id}`]: reason } }), 400)
    }
    await advanceBookmark(c)
    // Removing YOURSELF is allowed — the page after the write simply no
    // longer lists that team, which is the honest rendering of what happened.
    return c.html(teamsPage({ ...(await teamsData(c)), notice: 'Member removed.' }))
  })

  app.post('/dashboard/teams/:id/logo', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const team = await managedTeam(c)
    if (!team) return notFound(c)
    const stored = await storeUploadedImage(form.get('logo'))
    if (!stored.ok) {
      return c.html(teamsPage({ ...(await teamsData(c)), errors: { [`logo-${team.id}`]: stored.message } }), 400)
    }
    await c.get('repos').teams.updateLogo(team.id, stored.key)
    await advanceBookmark(c)
    return c.html(teamsPage({ ...(await teamsData(c)), notice: `${team.name}'s logo updated.` }))
  })

  app.post('/dashboard/teams/:id/logo-shape', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const team = await managedTeam(c)
    if (!team) return notFound(c)
    const shape = String(form.get('shape') ?? '')
    const fail = async (message: string) => c.html(teamsPage({ ...(await teamsData(c)), errors: { [`logo-${team.id}`]: message } }), 400)
    if (!isLogoShape(shape)) return fail('Choose a circle or its own proportions.')
    if (!team.logoKey) return fail('Upload a logo first.')
    if (shape === 'natural' && !(await ensureFitThumb(team.logoKey))) {
      return fail('The original of this logo is gone — upload it again to show it in its own proportions.')
    }
    await c.get('repos').teams.update(team.id, { logoShape: shape })
    await advanceBookmark(c)
    return c.html(teamsPage({ ...(await teamsData(c)), notice: shape === 'natural' ? `${team.name}'s logo shown in its own proportions.` : `${team.name}'s logo shown as a circle.` }))
  })

  app.post('/dashboard/teams/:id/logo/delete', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const team = await managedTeam(c)
    if (!team) return notFound(c)
    await c.get('repos').teams.updateLogo(team.id, null)
    await advanceBookmark(c)
    return c.html(teamsPage({ ...(await teamsData(c)), notice: `${team.name}'s logo removed.` }))
  })

  /**
   * Rename or re-slug a team. The slug rules and the two-table collision
   * check are the settings page's, for the same reason: a team's slug is
   * the first segment of its booking links and shares one namespace with
   * every user's. Changing it breaks every link already shared — the page
   * says so next to the field.
   */
  app.post('/dashboard/teams/:id', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const team = await managedTeam(c)
    if (!team) return notFound(c)

    const repos = c.get('repos')
    const name = String(form.get('name') ?? '').trim()
    const raw = String(form.get('slug') ?? '').trim()
    const errors: Record<string, string> = {}
    if (name === '' || name.length > 120) errors[`team-name-${team.id}`] = 'Give the team a name (up to 120 characters)'
    if (raw !== raw.toLowerCase()) {
      errors[`team-slug-${team.id}`] = 'Lowercase letters, numbers and hyphens only'
    } else if (raw !== team.slug) {
      const [existingUser, existingTeam] = await Promise.all([repos.users.bySlug(raw), repos.teams.bySlug(raw)])
      if (existingUser) errors[`team-slug-${team.id}`] = `That slug is already taken by ${existingUser.name || existingUser.slug}`
      else if (existingTeam) errors[`team-slug-${team.id}`] = `That slug is already taken by ${existingTeam.name}`
      else {
        const validation = validateSlug(raw)
        if (!validation.ok) errors[`team-slug-${team.id}`] = validation.message ?? 'Not a valid slug'
      }
    }
    if (Object.keys(errors).length > 0) {
      return c.html(teamsPage({ ...(await teamsData(c)), editValues: { teamId: team.id, name, slug: raw }, errors }), 400)
    }
    const patch = { ...(name !== team.name ? { name } : {}), ...(raw !== team.slug ? { slug: raw } : {}) }
    if (Object.keys(patch).length === 0) return c.html(teamsPage({ ...(await teamsData(c)), notice: 'Nothing to change.' }))
    const ok = await repos.teams.update(team.id, patch)
    if (!ok) {
      return c.html(
        teamsPage({ ...(await teamsData(c)), editValues: { teamId: team.id, name, slug: raw }, errors: { [`team-slug-${team.id}`]: 'That slug is already taken' } }),
        400,
      )
    }
    await advanceBookmark(c)
    return c.html(teamsPage({ ...(await teamsData(c)), notice: raw !== team.slug ? `Team updated. Its booking links now start with /${raw}.` : 'Team updated.' }))
  })

  app.post('/dashboard/teams/:id/members/:userId/role', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const team = await managedTeam(c)
    if (!team) return notFound(c)

    const repos = c.get('repos')
    const roleRaw = String(form.get('role') ?? '')
    if (roleRaw !== 'admin' && roleRaw !== 'member') {
      return c.html(
        teamsPage({ ...(await teamsData(c)), errors: { [`members-${team.id}`]: 'Not a role this team has.' } }),
        400,
      )
    }
    const role: TeamRole = roleRaw
    const targetId = c.req.param('userId') ?? ''
    const target = (await repos.teams.members(team.id)).find((m) => m.userId === targetId)
    // Already gone, or already that role: a stale page's double submit.
    if (!target || target.role === role || (isManagingRole(target.role) && role === 'admin')) {
      return c.html(teamsPage(await teamsData(c)))
    }

    // The last-admin guard is inside the UPDATE (setRole): two demotions
    // racing on a two-admin team cannot both pass. Demoting YOURSELF as the
    // last admin is refused the same way — the page then simply shows you
    // as a member next time, if another admin demotes you.
    const changed = await repos.teams.setRole(team.id, targetId, role)
    if (!changed) {
      return c.html(
        teamsPage({
          ...(await teamsData(c)),
          errors: { [`members-${team.id}`]: 'A team must keep at least one admin — make someone else an admin first.' },
        }),
        400,
      )
    }
    await advanceBookmark(c)
    const name = (await repos.users.byId(targetId))?.name || targetId
    return c.html(
      teamsPage({ ...(await teamsData(c)), notice: `${name} is now ${role === 'admin' ? 'an admin' : 'a member'} of ${team.name}.` }),
    )
  })

  // A member's availability, managed by a team admin on their behalf. The
  // same handlers as the personal routes above, with the URL naming whose
  // schedules these are and `scope` making every page say so.
  const memberAvailability = '/dashboard/teams/:id/members/:userId/availability'
  const onBehalf =
    (handler: (c: Ctx, who: ScheduleSubject) => Promise<Response>) =>
    async (c: Ctx): Promise<Response> => {
      const who = await managedMember(c)
      if (!who) return notFound(c)
      return handler(c, who)
    }
  app.get(memberAvailability, requireSession, onBehalf(listSchedules))
  app.post(`${memberAvailability}/new`, requireSession, onBehalf(createSchedule))
  app.get(`${memberAvailability}/:sid`, requireSession, onBehalf((c, who) => editSchedule(c, who, 'sid')))
  app.post(`${memberAvailability}/:sid`, requireSession, onBehalf((c, who) => saveSchedule(c, who, 'sid')))
  app.post(`${memberAvailability}/:sid/duplicate`, requireSession, onBehalf((c, who) => duplicateSchedule(c, who, 'sid')))
  app.post(`${memberAvailability}/:sid/set-default`, requireSession, onBehalf((c, who) => setDefaultSchedule(c, who, 'sid')))

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
        emailDelivery,
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
    return c.html(apiKeysPage({ brandName, user, csrf: c.get('csrf'),
 emailDelivery, keys }))
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
    // Checkboxes, not free text: a key's scopes are its whole authority, so
    // the form offers exactly the vocabulary the API checks and anything
    // else on the wire — "admin", "*", a typo — is dropped, never stored.
    const offered = API_KEY_SCOPES.map((s) => s.value)
    const scopes = offered.filter((scope) => form.getAll('scopes').some((v) => String(v) === scope))

    const errors: Record<string, string> = {}
    if (name === '' || name.length > 80) errors['name'] = 'Give the key a name you will recognise'
    if (scopes.length === 0) errors['scopes'] = 'Pick at least one scope — a key with none can do nothing'
    if (Object.keys(errors).length > 0) {
      const keys = await repos.apiKeys.listForUser(user.id)
      return c.html(
        apiKeysPage({
          brandName,
          user,
          csrf: c.get('csrf'),
          emailDelivery,
          keys,
          nameValue: name,
          scopesValue: scopes,
          errors,
        }),
        400,
      )
    }

    const created = await createApiKey(
      { repos, crypto: ports.crypto },
      { userId: user.id, name, scopes, now: ports.clock.now() },
    )
    await advanceBookmark(c)

    const keys = await repos.apiKeys.listForUser(user.id)
    return c.html(apiKeysPage({ brandName, user, csrf: c.get('csrf'),
 emailDelivery, keys, newKey: created.raw }))
  })

  /**
   * The confirmation page for a browser without script. The row's Revoke is
   * a link here; with script it becomes a `confirm()` and posts directly.
   * A GET never revokes — that stays behind the CSRF-checked POST below.
   */
  app.get('/dashboard/api-keys/:id/revoke', requireSession, async (c) => {
    const user = c.get('user')
    const id = c.req.param('id') ?? ''
    const apiKey = (await c.get('repos').apiKeys.listForUser(user.id)).find((k) => k.id === id)
    if (!apiKey) return notFound(c)
    return c.html(revokeKeyPage({ brandName, user, csrf: c.get('csrf'), emailDelivery, apiKey }))
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
    c.html(settingsPage({ brandName, baseUrl: ports.config.baseUrl, user: c.get('user'), csrf: c.get('csrf'), emailDelivery })),
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
        settingsPage({ brandName, baseUrl: ports.config.baseUrl, user, csrf: c.get('csrf'),
 emailDelivery, slugValue: raw, errors }),
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
      // slug — including a team claiming it — can both pass it before either
      // commits. `update`'s own return value is the real guard — it reports
      // false if the write lost that race against `users_slug_idx` or the
      // shared slug_claims constraint — so that lands as the same
      // clean form error, never an uncaught 500.
      const ok = await repos.users.update(user.id, { slug: raw })
      if (!ok) {
        return c.html(
          settingsPage({
            brandName,
            baseUrl: ports.config.baseUrl,
            user,
            csrf: c.get('csrf'),
            emailDelivery,
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
        baseUrl: ports.config.baseUrl,
        user: { ...user, slug: raw },
        csrf: c.get('csrf'),
        emailDelivery,
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
    const jobTitleRaw = String(form.get('job_title') ?? '').trim()
    const companyRaw = String(form.get('company') ?? '').trim()
    const companyUrlRaw = String(form.get('company_url') ?? '').trim()
    const errors: Record<string, string> = {}

    if (name.length === 0) errors['name'] = 'Name is required'
    else if (name.length > 120) errors['name'] = 'Must be 120 characters or fewer'
    if (jobTitleRaw.length > 120) errors['job_title'] = 'Must be 120 characters or fewer'
    if (companyRaw.length > 120) errors['company'] = 'Must be 120 characters or fewer'
    // The URL lands in an href on a public page — only absolute http(s), so a
    // stored value can never be a javascript:/data: scheme.
    if (companyUrlRaw.length > 200) errors['company_url'] = 'Must be 200 characters or fewer'
    else if (companyUrlRaw !== '' && !isHttpUrl(companyUrlRaw)) {
      errors['company_url'] = 'Must be a full link starting with https://'
    }

    if (Object.keys(errors).length > 0) {
      return c.html(
        settingsPage({
          brandName,
          baseUrl: ports.config.baseUrl,
          user,
          csrf: c.get('csrf'),
          emailDelivery,
          nameValue: name,
          jobTitleValue: jobTitleRaw,
          companyValue: companyRaw,
          companyUrlValue: companyUrlRaw,
          errors,
        }),
        400,
      )
    }

    // Empty fields clear (null), same "unset" convention as avatarKey.
    const company = companyRaw.length > 0 ? companyRaw : null
    const jobTitle = jobTitleRaw.length > 0 ? jobTitleRaw : null
    const companyUrl = companyUrlRaw.length > 0 ? companyUrlRaw : null
    const repos = c.get('repos')
    await repos.users.update(user.id, { name, company, jobTitle, companyUrl })
    await advanceBookmark(c)

    return c.html(
      settingsPage({
        brandName,
        baseUrl: ports.config.baseUrl,
        user: { ...user, name, company, jobTitle, companyUrl },
        csrf: c.get('csrf'),
        emailDelivery,
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
  /**
   * Validate an uploaded image and store it with its square thumbnail —
   * shared by the profile photo, an event type's logo and a team's logo,
   * so the three cannot drift on limits or on what "too large" means.
   * Returns the THUMBNAIL key, the only one a page ever references.
   */
  async function storeUploadedImage(file: string | File | null): Promise<{ ok: true; key: string } | { ok: false; message: string }> {
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose an image to upload' }
    if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: 'That file is larger than 5 MB' }
    if (!isAllowedImageType(file.type)) return { ok: false, message: 'PNG, JPEG or WebP images only' }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const dimensions = readImageDimensions(bytes, file.type)
    if (!dimensions || dimensions.width * dimensions.height > MAX_DECODED_PIXELS) {
      return { ok: false, message: 'That image is too large. Try a smaller one.' }
    }
    const originalKey = await deriveBlobKey(bytes, file.type)
    const thumbKey = thumbKeyFor(originalKey)
    if (!(await ports.blobStorage.get(thumbKey))) {
      const thumb = resizeToSquareThumbnail(bytes)
      if (!thumb) return { ok: false, message: 'Could not process that image. Try a different file.' }
      await ports.blobStorage.put(originalKey, bytes, file.type)
      await ports.blobStorage.put(thumbKey, thumb, THUMB_CONTENT_TYPE)
    }
    // The uncropped sibling, for a logo shown in its own proportions. Made
    // here so switching shape later is a column change, not a re-upload.
    if (!(await ports.blobStorage.get(fitKeyFor(thumbKey)))) {
      const fit = resizeToFitThumbnail(bytes)
      if (fit) await ports.blobStorage.put(fitKeyFor(thumbKey), fit, THUMB_CONTENT_TYPE)
    }
    return { ok: true, key: thumbKey }
  }

  /**
   * A logo uploaded before the fit thumbnail existed has only the square
   * one; regenerate the fit variant from the stored original on the first
   * switch to "natural". False when no original can be found either.
   */
  async function ensureFitThumb(thumbKey: string): Promise<boolean> {
    const fitKey = fitKeyFor(thumbKey)
    if (await ports.blobStorage.get(fitKey)) return true
    for (const candidate of originalKeyCandidates(thumbKey)) {
      const original = await ports.blobStorage.get(candidate)
      if (!original) continue
      const fit = resizeToFitThumbnail(original.bytes)
      if (!fit) return false
      await ports.blobStorage.put(fitKey, fit, THUMB_CONTENT_TYPE)
      return true
    }
    return false
  }

  app.post('/dashboard/settings/avatar', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const user = c.get('user')
    const fail = (message: string) =>
      c.html(settingsPage({ brandName, baseUrl: ports.config.baseUrl, user, csrf: c.get('csrf'),
 emailDelivery, errors: { avatar: message } }), 400)

    const stored = await storeUploadedImage(form.get('avatar'))
    if (!stored.ok) return fail(stored.message)
    const thumbKey = stored.key

    const repos = c.get('repos')
    await repos.users.update(user.id, { avatarKey: thumbKey })
    await advanceBookmark(c)

    return c.html(
      settingsPage({
        brandName,
        baseUrl: ports.config.baseUrl,
        user: { ...user, avatarKey: thumbKey },
        csrf: c.get('csrf'),
        emailDelivery,
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
        baseUrl: ports.config.baseUrl,
        user: { ...user, avatarKey: null },
        csrf: c.get('csrf'),
        emailDelivery,
        notice: 'Photo removed.',
      }),
    )
  })

  // ===========================================================================
  // Admin — instance administration, admins only
  // ===========================================================================

  async function renderAdmin(
    c: Ctx,
    extra: { notice?: string; errors?: Record<string, string> } = {},
    status = 200,
  ): Promise<Response> {
    const repos = c.get('repos')
    const pinnedByEnv = ports.config.signupPolicy !== undefined
    const value = pinnedByEnv
      ? policyToValue(ports.config.signupPolicy!)
      : ((await repos.settings.get('signups')) ?? 'open')
    return c.html(
      adminPage({
        brandName,
        user: c.get('user'),
        csrf: c.get('csrf'),
        emailDelivery,
        allUsers: await repos.users.listAll(),
        signups: { value, pinnedByEnv },
        ...extra,
      }),
      status as 200,
    )
  }

  app.get('/dashboard/admin', requireSession, requireAdmin, (c) => renderAdmin(c))

  app.post('/dashboard/admin/signups', requireSession, requireAdmin, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    // Env-pinned policy is read-only from here — the form is not rendered in
    // that state, so reaching this is a crafted request, not a lost update.
    if (ports.config.signupPolicy) return c.redirect('/dashboard/admin', 302)

    const mode = String(form.get('mode') ?? '')
    let value: string
    if (mode === 'open' || mode === 'closed') value = mode
    else if (mode === 'allowlist') {
      const raw = String(form.get('allowlist') ?? '')
      const parsed = parseSignupPolicy(raw)
      // parseSignupPolicy falls back to open on an empty list (an env typo
      // must not lock an operator out) — but from THIS form an empty list is
      // a mistake worth stopping, since the admin explicitly chose allowlist.
      if (parsed.mode !== 'allowlist') {
        return renderAdmin(c, { errors: { allowlist: 'Add at least one email or @domain' } }, 400)
      }
      value = parsed.entries.join(', ')
    } else return renderAdmin(c, { errors: { allowlist: 'Choose a sign-up mode' } }, 400)

    await c.get('repos').settings.set('signups', value, ports.clock.now())
    await advanceBookmark(c)
    return renderAdmin(c, { notice: 'Sign-up policy saved.' })
  })

  app.post('/dashboard/admin/users/:id/role', requireSession, requireAdmin, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)

    const repos = c.get('repos')
    const target = await repos.users.byId(c.req.param('id'))
    if (!target) return c.redirect('/dashboard/admin', 302)

    const role = String(form.get('role') ?? '') === 'admin' ? 'admin' : 'member'
    if (role === target.role) return renderAdmin(c) // stale page double-submit; nothing to do

    if (role === 'member') {
      // Demotion goes through the repository's ATOMIC guard, never a
      // count-then-update here: two concurrent demotions (two admins
      // removing each other) would both pass a separate count and leave the
      // instance with zero admins — a lockout only recoverable by
      // hand-editing the database. The page also hides the button on the
      // last admin, but the statement-level guard is the invariant.
      const ok = await repos.users.demoteAdmin(target.id)
      if (!ok) {
        // The guard refuses for two different reasons, and only one is an
        // error: the target being the last admin. The other — the target is
        // ALREADY a member because a concurrent request (or a double submit
        // from a stale page) demoted them between our read above and the
        // guarded write — is a no-op, and claiming "last admin" over it would
        // contradict the very user list rendered under the message.
        const fresh = await repos.users.byId(target.id)
        if (fresh && fresh.role === 'admin') {
          return renderAdmin(c, { errors: { role: 'Cannot remove the last admin.' } }, 400)
        }
        return renderAdmin(c)
      }
    } else {
      await repos.users.update(target.id, { role })
    }
    await advanceBookmark(c)
    return renderAdmin(c, {
      notice: role === 'admin' ? `${target.email} is now an admin.` : `${target.email} is now a member.`,
    })
  })

  // ===========================================================================
  // Dashboard — bookings
  // ===========================================================================

  /** Rows per list view. One more is fetched, to know whether to say "showing the first N". */
  const BOOKINGS_LIST_LIMIT = 100
  /** How far ahead the host's reschedule picker looks. */
  const RESCHEDULE_HORIZON_MS = 14 * 24 * 60 * 60 * 1000

  app.get('/dashboard/bookings', requireSession, async (c) => {
    const repos = c.get('repos')
    const user = c.get('user')
    const view = bookingView(c.req.query('view'))
    const found = await repos.bookings.listForHostByStatus(user.id, {
      view,
      now: ports.clock.now(),
      limit: BOOKINGS_LIST_LIMIT + 1,
    })

    // Titles and co-host names are looked up once per distinct id, not per
    // row: a hundred bookings of one event type is one read, not a hundred.
    const titles = new Map<string, string>()
    const names = new Map<string, string>()
    const rows: BookingListRow[] = []
    for (const booking of found.slice(0, BOOKINGS_LIST_LIMIT)) {
      let title = titles.get(booking.eventTypeId)
      if (title === undefined) {
        title = (await repos.eventTypes.byId(booking.eventTypeId))?.title ?? 'Meeting'
        titles.set(booking.eventTypeId, title)
      }
      const coHostNames: string[] = []
      for (const id of booking.hostUserIds) {
        if (id === user.id) continue
        let name = names.get(id)
        if (name === undefined) {
          const coHost = await repos.users.byId(id)
          name = coHost ? coHost.name || coHost.slug : ''
          names.set(id, name)
        }
        if (name !== '') coHostNames.push(name)
      }
      rows.push({ booking, eventTitle: title, coHostNames })
    }

    return c.html(
      bookingsPage({
        brandName,
        user,
        csrf: c.get('csrf'),
        emailDelivery,
        view,
        rows,
        truncated: found.length > BOOKINGS_LIST_LIMIT,
      }),
    )
  })

  interface HostBookingAccess {
    booking: Booking
    /** Null when the event type has since been deleted. */
    eventType: EventType | null
    /** The owning team of a team booking, when the event type still exists. */
    team: Team | null
    /** The signed-in user is one of the booking's hosts. */
    attends: boolean
    /** The signed-in user manages the owning team (core/domain/teams.ts). */
    managesTeam: boolean
  }

  /**
   * The booking behind `/dashboard/bookings/:id`, or null — a 404 — unless
   * the signed-in user attends it or manages the team whose event type it
   * was booked through. A stranger gets the same 404 as a wrong id: the
   * page shows the guest's name, email and answers, which are not the
   * instance's to show to every host on it.
   */
  async function hostBookingAccess(c: Ctx): Promise<HostBookingAccess | null> {
    const repos = c.get('repos')
    const user = c.get('user')
    const booking = await repos.bookings.byId(c.req.param('id') ?? '')
    if (!booking) return null
    const eventType = await repos.eventTypes.byId(booking.eventTypeId)
    const attends = booking.hostUserId === user.id || booking.hostUserIds.includes(user.id)
    const team = eventType?.ownerTeamId ? await repos.teams.byId(eventType.ownerTeamId) : null
    const manages = team ? await managesTeam(c, team.id) : false
    if (!attends && !manages) return null
    return { booking, eventType, team, attends, managesTeam: manages }
  }

  /** Everyone on the booking: its stored host list, or the primary host for rows written before the list existed. */
  function attendingIds(booking: Booking): Set<string> {
    return new Set(booking.hostUserIds.length > 0 ? booking.hostUserIds : [booking.hostUserId])
  }

  async function hostBookingPageData(
    c: Ctx,
    access: HostBookingAccess,
    extra: { notice?: string; error?: string } = {},
  ): Promise<HostBookingPageData> {
    const repos = c.get('repos')
    const user = c.get('user')
    const { booking, eventType, team } = access
    const attending = attendingIds(booking)

    // The event type's CURRENT host set first, each marked with whether
    // they are on this booking — then anyone on the booking the event type
    // no longer names (removed from the team since, say), so the list never
    // hides a person who will actually be in the meeting.
    const participants: BookingParticipant[] = []
    const seen = new Set<string>()
    if (eventType) {
      for (const h of await resolveEventTypeHosts(repos, eventType, user)) {
        seen.add(h.user.id)
        participants.push({
          user: h.user,
          required: eventType.ownerTeamId ? h.required : null,
          attends: attending.has(h.user.id),
        })
      }
    }
    for (const id of attending) {
      if (seen.has(id)) continue
      const stray = await repos.users.byId(id)
      if (stray) participants.push({ user: stray, required: null, attends: true })
    }
    participants.sort((a, b) => Number(b.attends) - Number(a.attends))

    const canChangeHosts = team !== null && (access.attends || access.managesTeam)
    const addable: User[] = []
    if (canChangeHosts && team) {
      for (const m of await repos.teams.members(team.id)) {
        if (attending.has(m.userId)) continue
        const member = await repos.users.byId(m.userId)
        if (member) addable.push(member)
      }
    }

    return {
      brandName,
      user,
      csrf: c.get('csrf'),
      emailDelivery,
      booking,
      eventType,
      canEditEventType: eventType !== null && (eventType.ownerUserId === user.id || access.managesTeam),
      teamName: team?.name ?? null,
      participants,
      canChangeHosts,
      addable,
      now: ports.clock.now(),
      ...extra,
    }
  }

  app.get('/dashboard/bookings/:id', requireSession, async (c) => {
    const access = await hostBookingAccess(c)
    if (!access) return notFound(c)
    const notice = c.req.query('cancelled')
      ? 'Booking cancelled. The guest has been emailed.'
      : c.req.query('moved')
        ? 'Booking moved. The guest has been emailed the new time.'
        : c.req.query('hosts')
          ? 'Participants updated.'
          : undefined
    return c.html(hostBookingPage(await hostBookingPageData(c, access, notice ? { notice } : {})))
  })

  app.post('/dashboard/bookings/:id/cancel', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const access = await hostBookingAccess(c)
    if (!access) return notFound(c)

    const blocked = rescheduleBlocker(access, ports.clock.now(), 'cancelled')
    if (blocked) return c.html(hostBookingPage(await hostBookingPageData(c, access, { error: blocked })), 400)

    // The textarea says 500; a raw POST is cut to the same, so the email
    // stays an email and not a pasted document.
    const note = String(form.get('note') ?? '').trim().slice(0, 500)
    const cancelled = await cancelBooking(c.get('repos'), access.booking, {
      cancelledBy: 'host',
      actor: c.get('user'),
      ...(note ? { reason: note } : {}),
    })
    if (!cancelled) {
      return c.html(
        hostBookingPage(
          await hostBookingPageData(c, access, { error: 'This booking was already updated elsewhere. Reload to see its current state.' }),
        ),
        409,
      )
    }
    await advanceBookmark(c)
    return c.redirect(`/dashboard/bookings/${encodeURIComponent(access.booking.id)}?cancelled=1`, 302)
  })

  /**
   * Why a booking cannot be moved (or cancelled), as the sentence the page
   * shows — or null when it can. `verb` only changes the wording.
   */
  function rescheduleBlocker(access: HostBookingAccess, now: number, verb: 'moved' | 'cancelled'): string | null {
    const { booking, eventType } = access
    if (booking.status === 'cancelled') return `This booking is cancelled, so it cannot be ${verb}.`
    if (booking.status === 'rescheduled') return `This booking was already moved, so it cannot be ${verb} again.`
    if (booking.endUtc <= now) return `This meeting has already happened, so it cannot be ${verb}.`
    if (!eventType && verb === 'moved') return 'This event type no longer exists, so the booking cannot be moved. Cancel it instead.'
    return null
  }

  /**
   * The host's picker data: the event type's slots for the next two weeks,
   * grouped by day in the HOST's zone. Advisory, like every listing —
   * the commit re-checks (ADR-0007 §2).
   */
  async function hostRescheduleDays(
    c: Ctx,
    access: HostBookingAccess & { eventType: EventType },
  ): Promise<Array<{ date: string; slots: Awaited<ReturnType<SlotService['forEventType']>> }>> {
    const repos = c.get('repos')
    const user = c.get('user')
    const now = ports.clock.now()
    const primary = (await repos.users.byId(access.booking.hostUserId)) ?? user
    const offered = await slots.forEventType({
      eventType: access.eventType,
      hostUsers: await resolveHosts(repos, access.eventType, primary),
      range: { start: now, end: now + RESCHEDULE_HORIZON_MS },
      scope: { consistency: 'unconstrained' },
    })
    const byDay = new Map<string, typeof offered>()
    for (const slot of offered) {
      const date = localDateString(slot.start, user.tz)
      const day = byDay.get(date)
      if (day) day.push(slot)
      else byDay.set(date, [slot])
    }
    return [...byDay.entries()].map(([date, daySlots]) => ({ date, slots: daySlots }))
  }

  /** The `start` a picker link or form carried, or NaN — same range guard as the guest route. */
  function chosenStart(raw: string | undefined | null): number {
    const value = Number(raw)
    return Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15 ? value : NaN
  }

  app.get('/dashboard/bookings/:id/reschedule', requireSession, async (c) => {
    const access = await hostBookingAccess(c)
    if (!access) return notFound(c)
    const chrome = { brandName, user: c.get('user'), csrf: c.get('csrf'), emailDelivery }
    const base = { ...chrome, booking: access.booking, eventType: access.eventType }

    const blocked = rescheduleBlocker(access, ports.clock.now(), 'moved')
    if (blocked || !access.eventType) {
      return c.html(hostReschedulePage({ ...base, blocked: blocked ?? 'This booking cannot be moved.' }))
    }
    const start = chosenStart(c.req.query('start'))
    if (Number.isFinite(start)) return c.html(hostReschedulePage({ ...base, newStart: start }))
    return c.html(
      hostReschedulePage({ ...base, days: await hostRescheduleDays(c, { ...access, eventType: access.eventType }) }),
    )
  })

  app.post('/dashboard/bookings/:id/reschedule', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const access = await hostBookingAccess(c)
    if (!access) return notFound(c)
    const repos = c.get('repos')
    const user = c.get('user')
    const base = { brandName, user, csrf: c.get('csrf'), emailDelivery, booking: access.booking, eventType: access.eventType }

    const blocked = rescheduleBlocker(access, ports.clock.now(), 'moved')
    const eventType = access.eventType
    if (blocked || !eventType) {
      return c.html(hostReschedulePage({ ...base, blocked: blocked ?? 'This booking cannot be moved.' }), 400)
    }
    const start = chosenStart(form.get('start') as string | null)
    if (!Number.isFinite(start)) {
      return c.html(
        hostReschedulePage({ ...base, days: await hostRescheduleDays(c, { ...access, eventType }), error: 'No new time was chosen.' }),
        400,
      )
    }

    // The same host set the picker listed from, so what was shown and what
    // is committed agree — the primary host is the fallback, exactly as on
    // the guest's route, not the signed-in user (who may be a team admin
    // who is not on the booking at all).
    const primary = (await repos.users.byId(access.booking.hostUserId)) ?? user
    const hosts = await hostsForBooking(repos, eventType, access.booking, primary)
    const moved = await rescheduleBooking(repos, access.booking, eventType, primary, hosts, start)
    if (!moved.ok) {
      return c.html(
        hostReschedulePage({
          ...base,
          days: await hostRescheduleDays(c, { ...access, eventType }),
          error:
            moved.reason === 'slot_taken'
              ? 'That time was just taken. Pick another one.'
              : 'This booking was already updated elsewhere. Reload and try again.',
        }),
        409,
      )
    }
    await advanceBookmark(c)
    return c.redirect(`/dashboard/bookings/${encodeURIComponent(moved.booking.id)}?moved=1`, 302)
  })

  /**
   * Add or remove a co-host. The domain (core/domain/booking-hosts.ts)
   * decides whether this user may, whether the person is a member, whether
   * they are free — the route only carries the answer back to the page as
   * a sentence. `hostBookingAccess` above is the one gate the route keeps:
   * a stranger must not learn from the refusal wording that the booking
   * exists.
   */
  async function applyHostChange(
    c: Ctx,
    access: HostBookingAccess,
    input: { bookingId: string; add?: string[]; remove?: string[] },
  ): Promise<Response> {
    const result = await changeBookingHosts(ports, c.get('user'), input, c.get('repos'))
    if (!result.ok) {
      return c.html(
        hostBookingPage(await hostBookingPageData(c, access, { error: hostChangeFailureMessage(result.reason) })),
        400,
      )
    }
    // Integrations hear about it the way they hear about a create or a
    // move: every attending host's subscriptions — the one just added and,
    // still, the one just removed, whose systems need the exit as much as
    // the others need the entry. Best-effort, after the write.
    if (access.eventType) {
      const removedIds = result.removed.map((u) => u.id)
      await notifyWebhooks(
        ports,
        'booking.hosts_changed',
        { ...result.booking, hostUserIds: [...new Set([...result.booking.hostUserIds, ...removedIds])] },
        access.eventType,
        { hostUserIds: result.booking.hostUserIds, hostsAdded: result.added.map((u) => u.id), hostsRemoved: removedIds },
      ).catch((err) => console.error('[punctual] host-change webhook failed to queue', err))
    }
    await advanceBookmark(c)
    return c.redirect(`/dashboard/bookings/${encodeURIComponent(access.booking.id)}?hosts=1`, 302)
  }

  app.post('/dashboard/bookings/:id/hosts/add', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const access = await hostBookingAccess(c)
    if (!access) return notFound(c)
    const userId = String(form.get('userId') ?? '').trim()
    if (userId === '') {
      return c.html(hostBookingPage(await hostBookingPageData(c, access, { error: 'Choose a team member to add.' })), 400)
    }
    return applyHostChange(c, access, { bookingId: access.booking.id, add: [userId] })
  })

  app.post('/dashboard/bookings/:id/hosts/:userId/remove', requireSession, async (c) => {
    const form = await c.req.formData()
    if (!(await csrfOk(c, form))) return csrfRejected(c)
    const access = await hostBookingAccess(c)
    if (!access) return notFound(c)
    return applyHostChange(c, access, { bookingId: access.booking.id, remove: [c.req.param('userId') ?? ''] })
  })

  // ===========================================================================
  // Cancel and reschedule — shared by the guest's link and the host's dashboard
  // ===========================================================================

  /**
   * Cancel a confirmed booking: the conditional status write with its lock
   * release, the manage-link rotation, both parties' mail, the calendar
   * delete. One function for both surfaces, so they cannot drift on which
   * of those steps happen — they differ only in who is credited and
   * whether there is a note.
   *
   * @returns false when the booking was no longer confirmed: a concurrent
   *          cancel or reschedule won the race, and nothing here ran.
   */
  async function cancelBooking(
    repos: Repositories,
    booking: Booking,
    by: { cancelledBy: 'host' | 'guest'; actor?: User; reason?: string },
  ): Promise<boolean> {
    // The caller's status check is read-then-write: a concurrent request (a
    // second tab, a double-submitted reschedule) can change the booking
    // between that read and this write. The conditional UPDATE is the real
    // guard — if it reports no row changed, someone else already moved this
    // booking, so treat it the same as the pre-check rather than sending a
    // cancellation for a booking that is actually rescheduled.
    const cancelledAt = ports.clock.now()
    const cancelled = await repos.bookings.cancelWithLockRelease(booking.id, cancelledAt)
    if (!cancelled) return false

    // Rotate the hash so the link in the guest's inbox stops working. ADR-0005
    // §4 names rotation-on-state-change as THE invalidation mechanism.
    await repos.bookings.rotateManageToken(booking.id, await ports.crypto.hash(ports.crypto.randomToken(32)))

    const eventType = await repos.eventTypes.byId(booking.eventTypeId)
    const host = await repos.users.byId(booking.hostUserId)
    if (eventType && host) {
      const hosts = (await Promise.all([...attendingIds(booking)].map((id) => repos.users.byId(id)))).filter(
        (u): u is User => u !== null,
      )
      await notifyBookingCancelled({
        ports,
        // Patched, not the pre-write booking: notifyWebhooks serializes
        // `booking.status` straight into the payload, which would otherwise
        // report "confirmed" on a `booking.cancelled` event.
        booking: { ...booking, status: 'cancelled', cancelledAt },
        eventType,
        host,
        ...(hosts.length > 0 ? { hosts } : {}),
        cancelledBy: by.cancelledBy,
        ...(by.actor ? { actor: by.actor } : {}),
        ...(by.reason ? { reason: by.reason } : {}),
      }).catch((err) => console.error('[punctual] cancellation emails failed', err))
    }
    // After the commit, deliberately: a calendar or mail failure must not
    // leave a booking the guest believes is cancelled still holding the slot.
    await ports.queue.send({ kind: 'calendar.sync', bookingId: booking.id, action: 'delete' }).catch(() => {})
    return true
  }

  type RescheduleResult =
    | { ok: true; booking: Booking; manageToken?: string }
    | { ok: false; reason: 'slot_taken' | 'superseded' }

  /**
   * Move a confirmed booking to `start`: book the replacement through the
   * coordinator, mark the original moved, kill its manage link, and enqueue
   * the replacement's calendar sync — which is what dispatches the
   * "Rescheduled" mail — plus the original's calendar delete. Shared by
   * the guest's link and the host's dashboard. `hosts` is the event type's
   * resolved host set, the same one the slot listing the caller showed
   * was drawn from.
   */
  /**
   * The hosts a booking's replacement should carry: the booking's CURRENT
   * hosts, not the event type's. A booking whose co-hosts were changed
   * (A handed off to C) must not snap back to the event type's list on a
   * reschedule, sending A the moved-meeting mail and dropping C. When
   * nothing was changed the two lists agree and this is the resolver's
   * answer.
   */
  async function hostsForBooking(repos: Repositories, eventType: EventType, booking: Booking, fallback: User): Promise<User[]> {
    const resolved = await resolveHosts(repos, eventType, fallback)
    const same =
      resolved.length === booking.hostUserIds.length && resolved.every((u) => booking.hostUserIds.includes(u.id))
    if (same) return resolved
    const users: User[] = []
    for (const id of booking.hostUserIds) {
      const u = await repos.users.byId(id)
      if (u) users.push(u)
    }
    return users.length > 0 ? users : resolved
  }

  async function rescheduleBooking(
    repos: Repositories,
    old: Booking,
    eventType: EventType,
    host: User,
    hosts: User[],
    start: number,
  ): Promise<RescheduleResult> {
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
    if (!outcome.ok) return { ok: false, reason: 'slot_taken' }

    // Only after the new booking exists: `markRescheduled` releases the old
    // slot locks, and releasing them before the replacement is committed would
    // open a window where neither time is held.
    //
    // The caller's `old.status !== 'confirmed'` check is read-then-write, so a
    // second concurrent reschedule (or a cancel) of the same booking can land
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
      return { ok: false, reason: 'superseded' }
    }

    // Kill the old link. The new booking carries its own freshly signed token,
    // so the guest's superseded email stops working (ADR-0005 §4).
    await repos.bookings.rotateManageToken(old.id, await ports.crypto.hash(ports.crypto.randomToken(32)))

    // notifyBookingCreated deliberately skips a booking with rescheduleOf set,
    // expecting the moving route to send the "Rescheduled" mail instead.
    //
    // The replacement's calendar sync is enqueued HERE, not by the
    // coordinator, so it runs after `markRescheduled` has landed: dispatch
    // requires `previous.rescheduledTo` to point back at this booking, which
    // is only true once the line above has run. One message rather than two:
    // Cloudflare Queues guarantees no ordering between independent messages,
    // so a separate notify could claim and send before the calendar write
    // recorded the new Meet link — permanently omitting it from the very
    // email this work exists to put it in. Exactly one create-sync per
    // replacement booking, so nothing races the read-then-act guard on
    // `externalEventIds`.
    await ports.queue
      .send({
        kind: 'calendar.sync',
        bookingId: outcome.booking.id,
        action: 'create',
        ...(outcome.manageToken ? { manageToken: outcome.manageToken } : {}),
      })
      .catch(async (err) => {
        // This is the ONLY message for a replacement booking, so losing it
        // costs the guest both the calendar event and the "Rescheduled"
        // email. Notify directly instead — without a conference link, since
        // no calendar work will run, which is the honest outcome. The claim
        // inside makes this and any later redelivery mutually exclusive.
        console.error('[punctual] reschedule sync enqueue failed', err)
        await dispatchConfirmation(outcome.booking.id, ports, outcome.manageToken).catch((e) =>
          console.error('[punctual] reschedule fallback failed', e),
        )
      })

    // The "Rescheduled" mail for the NEW leg is dispatched by the
    // calendar-sync handler, not here: the new booking's Meet link does not
    // exist until its calendar event does, and the email body is rendered
    // at enqueue time. The handler branches on `rescheduleOf` to send the
    // rescheduled copy rather than a fresh confirmation.
    await ports.queue.send({ kind: 'calendar.sync', bookingId: old.id, action: 'delete' }).catch(() => {})

    return { ok: true, booking: outcome.booking, ...(outcome.manageToken ? { manageToken: outcome.manageToken } : {}) }
  }

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
        hostUsers: await hostsForBooking(repos, eventType, booking, host),
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

    const cancelled = await cancelBooking(repos, verified.booking, { cancelledBy: 'guest' })
    if (!cancelled) return manageError(c, 'This booking is no longer active.')

    return c.html(
      shellHead({ title: `Cancelled · ${brandName}`, brandName }) +
        errorPage('Booking cancelled', 'The time has been released and the host has been notified.') +
        shellFoot(),
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

    const hosts = await hostsForBooking(repos, eventType, old, host)
    const moved = await rescheduleBooking(repos, old, eventType, host, hosts, start)
    if (!moved.ok) {
      return c.html(
        bookingDetailPage({
          brandName,
          booking: old,
          eventType,
          host,
          token,
          purpose: 'reschedule',
          error:
            moved.reason === 'slot_taken'
              ? 'That time was just taken. Pick another one.'
              : 'This booking was already updated elsewhere. Refresh and try again.',
        }),
        409,
      )
    }

    // Carry the new booking's token: /booking/:id without one is a 400, so
    // a guest who successfully rescheduled landed on an error page.
    const nextToken = moved.manageToken
    return c.redirect(
      `/booking/${encodeURIComponent(moved.booking.id)}` +
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
        shellFoot(),
      404,
    )
  }

  function oauthError(c: Ctx, message: string): Response | Promise<Response> {
    return c.html(
      shellHead({ title: 'Sign-in failed', brandName }) + errorPage('Sign-in failed', message) + shellFoot(),
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

function bookingView(value: string | undefined): BookingListView {
  return value === 'past' || value === 'cancelled' ? value : 'upcoming'
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

/**
 * The weekly-hours editor's fields, read into the same shape
 * `scheduleForm`/`parseWeeklyDraft` in pages/dashboard.ts already share —
 * `day-N-enabled` plus `day-N-start-I`/`day-N-end-I` pairs, I from 0 up to
 * whichever of `MAX_RANGES_PER_DAY` or the first missing pair comes first.
 * Capped regardless of what a crafted POST claims to have, same reasoning
 * as every other bound-the-input guard in this file.
 */
function readWeeklyDraftFromForm(form: FormData): WeeklyDayDraft[] {
  const days: WeeklyDayDraft[] = []
  for (let day = 0; day < 7; day++) {
    const ranges: WeeklyDayDraft['ranges'] = []
    for (let i = 0; i < MAX_RANGES_PER_DAY; i++) {
      const start = form.get(`day-${day}-start-${i}`)
      const end = form.get(`day-${day}-end-${i}`)
      if (start === null && end === null) break
      ranges.push({ start: String(start ?? ''), end: String(end ?? '') })
    }
    days.push({ enabled: form.get(`day-${day}-enabled`) !== null, ranges })
  }
  return days
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
  // Exactly one owner is ever set. The scheduling select is always rendered
  // (no JS hides it), so its value is IGNORED for a personal event — the
  // server forces 'personal', and a crafted round_robin on owner=me cannot
  // land. Whether the user may act for the named team is validateEventType's
  // job, not this reader's.
  const ownerTeamId = text('owner') || null
  const schedulingType: EventType['schedulingType'] =
    ownerTeamId === null ? 'personal' : text('schedulingType') === 'collective' ? 'collective' : 'round_robin'
  const draft: EventType = {
    id: '',
    ownerUserId: ownerTeamId === null ? ownerUserId : null,
    ownerTeamId,
    schedulingType,
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
    // Same reasoning as `schedulingType` above: the select always renders,
    // but a team-owned draft has no single host to resolve it against, so
    // its value is ignored here regardless of what was submitted.
    scheduleId: ownerTeamId === null ? text('scheduleId') || null : null,
  }
  return { draft, questionsText }
}

/** Absolute http(s) only — the one place this is checked before a value can reach a public page's href. */
/** A `SignupPolicy` back into `SIGNUPS` env syntax, for read-only display of an env-pinned policy. */
function policyToValue(policy: SignupPolicy): string {
  if (policy.mode === 'open') return 'open'
  if (policy.mode === 'closed') return 'closed'
  return policy.entries.join(', ')
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
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

  // Team ownership requires the submitter to be one of the team's ADMINS —
  // the owner id arrives from a form field, and without this check any
  // signed-in user could publish event types under any team's slug. A
  // member who is not an admin gets the same refusal as an outsider: the
  // form only offers the teams they can put an event under.
  if (draft.ownerTeamId !== null) {
    const memberships = await repos.teams.memberships(user.id)
    const membership = memberships.find((m) => m.teamId === draft.ownerTeamId)
    if (!canManageTeam(user, membership)) {
      errors['owner'] = membership ? 'Only an admin of that team can put an event type under it' : 'You are not a member of that team'
    }
  }

  if (!/^[a-z0-9-]{1,60}$/.test(draft.slug)) {
    errors['slug'] = 'Lowercase letters, numbers and hyphens only'
  } else if (RESERVED_SLUGS.has(draft.slug)) {
    errors['slug'] = 'That word is reserved'
  } else {
    // Checked against every event type, not just the visible ones: the unique
    // index does not care whether a row is active, and a duplicate would
    // otherwise surface as a database error instead of a form message.
    // Uniqueness is per OWNER (the schema's two unique indexes), so the check
    // runs in whichever namespace the draft is headed for.
    const siblings =
      draft.ownerTeamId !== null && !errors['owner']
        ? await repos.eventTypes.listForTeam(draft.ownerTeamId)
        : await repos.eventTypes.listForUser(user.id)
    if (siblings.some((et) => et.slug === draft.slug && et.id !== currentId)) {
      errors['slug'] =
        draft.ownerTeamId !== null
          ? 'That team already has an event type with this slug'
          : 'You already have an event type with this slug'
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
  const questionsError = questionsParseError(questionsText)
  if (questionsError !== null) errors['questions'] = questionsError

  // `readEventTypeForm` already forces this null for a team-owned draft, but
  // a raw POST bypasses the reader — re-checked here rather than trusted, the
  // same discipline as the scheduling-type/owner pair above.
  if (draft.scheduleId !== null) {
    if (draft.ownerTeamId !== null) {
      errors['scheduleId'] = 'A team event type cannot use a specific schedule'
    } else if (!(await repos.availability.byId(user.id, draft.scheduleId))) {
      errors['scheduleId'] = 'Pick one of your own schedules'
    }
  }

  return errors
}

/** Every host who takes part. Mirrors the public router's resolution. */
/** Hosts for an event type — the shared resolver, as users (core/domain/hosts.ts). */
async function resolveHosts(repos: Repositories, eventType: EventType, owner: User): Promise<User[]> {
  return hostUsers(await resolveEventTypeHosts(repos, eventType, owner))
}
