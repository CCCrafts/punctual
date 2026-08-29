/**
 * OAuth client credentials, scopes, and the token lifecycle both calendar
 * adapters share (ADR-0005 §1, §6).
 *
 * Identity and calendar are two separate authorisation acts against the same
 * OAuth client. Signing in asks for nothing sensitive; connecting a calendar
 * asks for the scopes that drive Google/Microsoft app verification. Bundling
 * them would drag every visitor who merely signs in through the unverified-app
 * screen during beta, which is precisely what ADR-0005 §1 refuses — hence the
 * two scope sets and the `purpose` on every redirect URI.
 *
 * Refresh lives here rather than in each provider because the failure that
 * matters is identical on both: a user who revoked access must surface as
 * `needs_reconnect`, never as a silently failed booking (ADR-0005 §6).
 */

import type { CalendarConnection, OAuthTokens } from '../core/domain/types.js'
import type {
  CalendarProviderName,
  Clock,
  Crypto as CryptoPort,
  OAuthCredentials,
} from '../ports.js'

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Identity only. No `access_type=offline`, no calendar scope — a login needs
 * one id_token and nothing else, and anything more here is what makes the
 * consent screen scary (ADR-0005 §1).
 */
export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const

/**
 * Requested at connect time only. These are the granular scopes rather than
 * the blanket `auth/calendar`: freeBusy for reading busy-ness, events for the
 * bookings we write, calendarlist.readonly so the host can pick a calendar.
 * Google's verification review is scoped to what you ask for, so asking for
 * read access to event *contents* we never look at costs review time and buys
 * nothing.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const

export const MICROSOFT_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const

/**
 * `offline_access` is what makes Microsoft issue a refresh token at all, so it
 * belongs to the calendar flow and not to login — the identity flow is
 * one-shot by design.
 */
export const MICROSOFT_CALENDAR_SCOPES = [
  'offline_access',
  'Calendars.ReadWrite',
] as const

export type OAuthPurpose = 'identity' | 'calendar'

export function scopesFor(name: CalendarProviderName, purpose: OAuthPurpose): string[] {
  if (name === 'google') {
    return purpose === 'identity' ? [...GOOGLE_IDENTITY_SCOPES] : [...GOOGLE_CALENDAR_SCOPES]
  }
  return purpose === 'identity' ? [...MICROSOFT_IDENTITY_SCOPES] : [...MICROSOFT_CALENDAR_SCOPES]
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const OAUTH_ENDPOINTS: Record<CalendarProviderName, { authorize: string; token: string }> = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
  },
  microsoft: {
    // `common` so both work/school and personal accounts can connect; a
    // single-tenant self-hoster overrides nothing here because the tenant is
    // decided by the app registration, not by us.
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  },
}

// ---------------------------------------------------------------------------
// Credentials from the environment
// ---------------------------------------------------------------------------

/** Only the vars this adapter reads. Workers `env` is structurally compatible. */
export interface OAuthEnv {
  GOOGLE_CLIENT_ID?: string | undefined
  GOOGLE_CLIENT_SECRET?: string | undefined
  MICROSOFT_CLIENT_ID?: string | undefined
  MICROSOFT_CLIENT_SECRET?: string | undefined
}

/**
 * The OSS implementation: the self-hoster brings their own OAuth app.
 *
 * A provider with no credentials returns null rather than throwing, because
 * configuring only Google (or only Microsoft) is a normal deployment, not an
 * error. The registry in `providers.ts` turns that null into "this provider is
 * not available" instead of a runtime crash on the connect page.
 */
export function createEnvOAuthCredentials(env: OAuthEnv, baseUrl: string): OAuthCredentials {
  // Trailing slash on baseUrl is the classic .dev.vars footgun; it would
  // produce `//auth/...` and a redirect_uri_mismatch that reads as nonsense.
  const origin = baseUrl.replace(/\/+$/, '')

  const pairs: Record<CalendarProviderName, { clientId: string; clientSecret: string } | null> = {
    google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    microsoft: pair(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET),
  }

  return {
    forProvider(name) {
      return pairs[name]
    },
    redirectUri(name, purpose) {
      // `purpose` is part of the registered URI, not just state: the two flows
      // land on different handlers (session vs. connection) and must not be
      // interchangeable even if an authorization code leaks between them.
      //
      // Google accepts a query string on a registered Web redirect URI.
      // Microsoft's Entra app registration rejects ANY redirect URI carrying
      // one — "URL may not contain a query string" — both at initial
      // registration and when adding one afterward from the Authentication
      // blade. So Microsoft gets `purpose` as a path segment instead. Both
      // shapes keep the same security property: each purpose is still its
      // own distinct, exactly-registered URI, so a code obtained for one
      // purpose can never be exchanged against the other's endpoint.
      return name === 'microsoft'
        ? `${origin}/auth/${name}/callback/${purpose}`
        : `${origin}/auth/${name}/callback?purpose=${purpose}`
    },
  }
}

function pair(id?: string, secret?: string): { clientId: string; clientSecret: string } | null {
  const clientId = id?.trim() ?? ''
  const clientSecret = secret?.trim() ?? ''
  // An empty string is what an unset Workers secret looks like in practice.
  if (clientId === '' || clientSecret === '') return null
  return { clientId, clientSecret }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The distinguishable one (ADR-0005 §6). The user revoked access, changed
 * their password, or the tenant expired the grant: no retry will fix it, and
 * the caller must set `sync_status = 'needs_reconnect'` and prompt rather than
 * let bookings fail silently.
 */
export class CalendarReconnectRequiredError extends Error {
  readonly provider: CalendarProviderName
  readonly connectionId: string
  /** Brand, so a cross-bundle `instanceof` miss cannot turn this into a 500. */
  readonly needsReconnect = true as const

  constructor(provider: CalendarProviderName, connectionId: string, detail: string) {
    super(`[${provider}] connection ${connectionId} needs reconnect: ${detail}`)
    this.name = 'CalendarReconnectRequiredError'
    this.provider = provider
    this.connectionId = connectionId
  }
}

/** Everything else. Carries status and body because "calendar sync failed" is not a bug report. */
export class CalendarApiError extends Error {
  readonly provider: CalendarProviderName
  readonly status: number | undefined
  readonly body: string | undefined

  constructor(
    provider: CalendarProviderName,
    message: string,
    opts: { status?: number; body?: string } = {},
  ) {
    const status = opts.status === undefined ? '' : ` (HTTP ${opts.status})`
    const body = opts.body ? `: ${opts.body}` : ''
    super(`[${provider}] ${message}${status}${body}`)
    this.name = 'CalendarApiError'
    this.provider = provider
    this.status = opts.status
    this.body = opts.body
  }
}

export function needsReconnect(err: unknown): err is CalendarReconnectRequiredError {
  return (
    err instanceof CalendarReconnectRequiredError ||
    (typeof err === 'object' && err !== null && (err as { needsReconnect?: unknown }).needsReconnect === true)
  )
}

// ---------------------------------------------------------------------------
// Provider dependencies
// ---------------------------------------------------------------------------

export interface CalendarProviderDeps {
  oauth: OAuthCredentials
  /** Decrypt for tokens at rest, randomToken for conference/transaction ids. */
  crypto: Pick<CryptoPort, 'decrypt' | 'randomToken'>
  clock: Clock
  /**
   * Persist a refreshed token set. Plaintext crosses this boundary on purpose:
   * the repository layer owns `key_version` and the AAD binding, so it — not
   * the adapter — decides how the ciphertext is written (ADR-0005 §6).
   */
  onTokensRefreshed(connectionId: string, tokens: OAuthTokens): Promise<void>
  /** Injectable for tests and for the cloud control-plane's instrumented fetch. */
  fetch?: typeof globalThis.fetch
  /**
   * Injectable delay, so a provider that must wait for a provider-side
   * async job (Google provisioning a Meet room) can be tested without
   * spending the wall-clock time. Defaults to a real `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Refresh this far before the stated expiry. Two minutes covers clock skew
 * between us and the provider plus the flight time of the call we are about to
 * make; refreshing early costs one request, refreshing late costs a booking.
 */
const REFRESH_SKEW_MS = 120_000

const DEFAULT_TOKEN_TTL_MS = 3_600_000

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

/** AAD binds the ciphertext to its row, so a token moved between rows fails to authenticate (ADR-0005 §6). */
function tokenAad(conn: CalendarConnection): string {
  return `${conn.userId}|${conn.provider}|${conn.id}`
}

export async function loadTokens(
  deps: CalendarProviderDeps,
  conn: CalendarConnection,
): Promise<OAuthTokens> {
  const plaintext = await deps.crypto.decrypt(conn.encryptedTokens, tokenAad(conn), conn.keyVersion)
  const parsed: unknown = JSON.parse(plaintext)
  if (!isRecord(parsed) || typeof parsed['accessToken'] !== 'string') {
    throw new CalendarApiError(conn.provider, `stored tokens for connection ${conn.id} are malformed`)
  }
  return {
    accessToken: parsed['accessToken'],
    refreshToken: typeof parsed['refreshToken'] === 'string' ? parsed['refreshToken'] : '',
    expiresAt: typeof parsed['expiresAt'] === 'number' ? parsed['expiresAt'] : 0,
    scope: typeof parsed['scope'] === 'string' ? parsed['scope'] : '',
  }
}

/**
 * A usable access token, refreshing first when the stored one is at or near
 * expiry. `force` is for the 401-retry path, where the provider disagrees with
 * our clock.
 */
export async function ensureAccessToken(
  deps: CalendarProviderDeps,
  conn: CalendarConnection,
  opts: { force?: boolean } = {},
): Promise<string> {
  const tokens = await loadTokens(deps, conn)
  const stale = tokens.expiresAt - REFRESH_SKEW_MS <= deps.clock.now()
  if (!opts.force && !stale) return tokens.accessToken

  if (tokens.refreshToken === '') {
    // No refresh token and an expired access token is a dead end: the grant was
    // issued without offline access, so only the user can fix it.
    throw new CalendarReconnectRequiredError(conn.provider, conn.id, 'no refresh token stored')
  }

  const next = await refreshTokens(deps, conn, tokens)
  // Persist BEFORE use. Microsoft rotates refresh tokens on every refresh, so
  // using a token we failed to store would strand the connection on a refresh
  // token that no longer exists.
  await deps.onTokensRefreshed(conn.id, next)
  return next.accessToken
}

async function refreshTokens(
  deps: CalendarProviderDeps,
  conn: CalendarConnection,
  current: OAuthTokens,
): Promise<OAuthTokens> {
  const creds = deps.oauth.forProvider(conn.provider)
  if (!creds) {
    throw new CalendarApiError(
      conn.provider,
      `cannot refresh connection ${conn.id}: no OAuth client configured. ` +
        `Set ${conn.provider.toUpperCase()}_CLIENT_ID and ${conn.provider.toUpperCase()}_CLIENT_SECRET.`,
    )
  }

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  })
  // Microsoft re-evaluates scope on refresh; Google ignores the parameter.
  if (conn.provider === 'microsoft') form.set('scope', MICROSOFT_CALENDAR_SCOPES.join(' '))

  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const res = await doFetch(OAUTH_ENDPOINTS[conn.provider].token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })

  const text = await res.text()
  const json: unknown = safeJson(text)

  if (!res.ok) {
    const error = isRecord(json) && typeof json['error'] === 'string' ? json['error'] : ''
    const description =
      isRecord(json) && typeof json['error_description'] === 'string'
        ? json['error_description']
        : truncate(text)

    // Both providers spell a revoked/expired grant `invalid_grant`. This is the
    // signal ADR-0005 §6 asks us to distinguish.
    if (error === 'invalid_grant') {
      throw new CalendarReconnectRequiredError(conn.provider, conn.id, description)
    }
    // Deployment misconfiguration, not a user problem — say so, because the
    // provider's own message for this is famously unhelpful.
    if (error === 'invalid_client' || error === 'unauthorized_client') {
      throw new CalendarApiError(
        conn.provider,
        `OAuth client rejected (${error}) — check ${conn.provider.toUpperCase()}_CLIENT_ID/_SECRET`,
        { status: res.status, body: truncate(text) },
      )
    }
    throw new CalendarApiError(conn.provider, 'token refresh failed', {
      status: res.status,
      body: truncate(text),
    })
  }

  if (!isRecord(json) || typeof json['access_token'] !== 'string') {
    throw new CalendarApiError(conn.provider, 'token refresh returned no access_token', {
      status: res.status,
      body: truncate(text),
    })
  }

  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] * 1000 : DEFAULT_TOKEN_TTL_MS
  return {
    accessToken: json['access_token'],
    // Google omits refresh_token on refresh (the original stays valid);
    // Microsoft rotates it. Keeping the old one when none is returned is what
    // makes one code path correct for both.
    refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : current.refreshToken,
    expiresAt: deps.clock.now() + expiresIn,
    scope: typeof json['scope'] === 'string' ? json['scope'] : current.scope,
  }
}

// ---------------------------------------------------------------------------
// Authorised HTTP
// ---------------------------------------------------------------------------

/**
 * A provider API call with a fresh bearer token, retried once on 401.
 *
 * The retry exists because expiry is advisory: a provider can invalidate a
 * token before its stated `expires_in` (password change, admin session reset).
 * One forced refresh separates "the token died early" — recoverable — from
 * "the grant is gone", which surfaces as a reconnect at `expectOk`.
 */
export async function providerFetch(
  deps: CalendarProviderDeps,
  conn: CalendarConnection,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis)

  const send = async (token: string): Promise<Response> =>
    doFetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
    })

  let res = await send(await ensureAccessToken(deps, conn))
  if (res.status === 401) {
    res = await send(await ensureAccessToken(deps, conn, { force: true }))
  }
  return res
}

/** Throws with status and body when the response is not ok. `what` names the call. */
export async function expectOk(
  conn: CalendarConnection,
  res: Response,
  what: string,
): Promise<void> {
  if (res.ok) return
  const body = truncate(await res.text())

  // A 401 that survived the forced refresh means the credential itself is dead.
  if (res.status === 401) {
    throw new CalendarReconnectRequiredError(conn.provider, conn.id, `${what} returned 401: ${body}`)
  }
  // Scopes were revoked or narrowed after the fact — also only the user can fix it.
  if (res.status === 403 && /insufficientPermissions|insufficient_scope|ErrorAccessDenied/i.test(body)) {
    throw new CalendarReconnectRequiredError(conn.provider, conn.id, `${what} returned 403: ${body}`)
  }
  throw new CalendarApiError(conn.provider, `${what} failed`, { status: res.status, body })
}

export async function readJson<T>(conn: CalendarConnection, res: Response, what: string): Promise<T> {
  await expectOk(conn, res, what)
  const text = await res.text()
  const json = safeJson(text)
  if (json === undefined) {
    throw new CalendarApiError(conn.provider, `${what} returned non-JSON`, {
      status: res.status,
      body: truncate(text),
    })
  }
  return json as T
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Bodies go into error messages and logs; a 2 MB HTML error page must not. */
function truncate(text: string, max = 2000): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}… (${trimmed.length} bytes)`
}
