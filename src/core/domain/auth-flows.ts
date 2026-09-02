/**
 * The authentication flows (ADR-0005).
 *
 * Ports arrive as arguments; nothing here reaches for a binding, imports from
 * `cloudflare:workers`, or reads a global. That is what lets the whole login
 * path be tested in plain Node against in-memory fakes, and what lets the
 * cloud control-plane inject tenant-scoped repositories (ADR-0003).
 *
 * Two properties in this file are security-load-bearing and easy to break by
 * refactor:
 *  - `requestMagicLink` returns the SAME thing for an address with an account
 *    and one without (ADR-0005 §3). Any new branch on user existence is an
 *    enumeration oracle.
 *  - secrets are compared with `constantTimeEqual`, never `===`.
 */

import { suggestSlug, validateSlug } from './slugs.js'
import type { ApiKey, Availability, Booking, MagicLinkToken, Schedule, Session, User, WeeklySchedule } from './types.js'
import type {
  Crypto,
  EmailSender,
  EngineConfig,
  RateLimiter,
  Repositories,
  SignupPolicy,
} from '../../ports.js'
import {
  MAGIC_LINK_TTL_MS,
  MANAGE_TOKEN_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_TTL_MS,
  apiKeyHashInput,
  constantTimeEqual,
  formatManageToken,
  generateApiKey,
  isSessionValid,
  manageTokenPayload,
  nextSessionExpiry,
  parseApiKey,
  parseManageToken,
  shouldSlideSession,
  type ManageTokenPurpose,
} from './auth-service.js'

// ---------------------------------------------------------------------------
// Magic link — request
// ---------------------------------------------------------------------------

export interface MagicLinkDeps {
  repos: Repositories
  crypto: Crypto
  email: EmailSender
  rateLimiter: RateLimiter
  config: EngineConfig
}

// ---------------------------------------------------------------------------
// Signup policy
// ---------------------------------------------------------------------------

/**
 * `SIGNUPS` env var → policy. Unset, empty or "open" → open; "closed" →
 * closed; anything else is a comma-separated allowlist of exact emails and
 * `@domain` suffixes ("serge@acme.com, @cccrafts.ai"). A list that trims to
 * nothing falls back to open rather than silently locking the operator out
 * of a fresh deployment over a typo.
 */
export function parseSignupPolicy(raw: string | undefined): SignupPolicy {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'open') return { mode: 'open' }
  if (value === 'closed') return { mode: 'closed' }
  const entries = value
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '')
  return entries.length > 0 ? { mode: 'allowlist', entries } : { mode: 'open' }
}

/** Whether `email` may CREATE an account. Callers gate creation only — an existing user always signs in. */
export function signupAllowed(email: string, policy: SignupPolicy | undefined): boolean {
  if (!policy || policy.mode === 'open') return true
  if (policy.mode === 'closed') return false
  const normalised = normaliseEmail(email)
  const domain = normalised.slice(normalised.lastIndexOf('@'))
  return policy.entries.some((entry) => (entry.startsWith('@') ? entry === domain : entry === normalised))
}

export interface MagicLinkRequest {
  email: string
  /** Stated in the email so the recipient can recognise a login they did not start (ADR-0005 §3). */
  ip: string
  userAgent: string
  now: number
}

/**
 * Deliberately coarse.
 *
 * `accepted` says only "we will act on this if there is anything to do" — it
 * is returned identically for a known address, an unknown one, and one that is
 * mid-signup. `malformed` is safe to distinguish because address *syntax* is
 * something the caller can compute themselves; account *existence* is not.
 */
export type MagicLinkResult =
  | { status: 'accepted' }
  | { status: 'malformed' }
  | { status: 'rate_limited'; retryAfterSeconds: number }

/** ADR-0006 §3 defaults. Operator-tunable through `config.rateLimits`. */
const MAGIC_LINK_EMAIL_LIMIT = { limit: 5, windowSeconds: 3600 }
const MAGIC_LINK_IP_LIMIT = { limit: 20, windowSeconds: 3600 }

export async function requestMagicLink(
  deps: MagicLinkDeps,
  req: MagicLinkRequest,
): Promise<MagicLinkResult> {
  const email = normaliseEmail(req.email)
  if (!isPlausibleEmail(email)) return { status: 'malformed' }

  // Per email AND per IP: the email limit stops one mailbox being flooded, the
  // IP limit stops one host walking a list of addresses. Either alone is a gap.
  const perEmail = limitFor(deps.config, 'magic_link_email', MAGIC_LINK_EMAIL_LIMIT)
  const emailCheck = await deps.rateLimiter.check('magic_link_email', email, perEmail.limit, perEmail.windowSeconds)
  if (!emailCheck.allowed) return rateLimited(emailCheck.resetAt, req.now)

  const perIp = limitFor(deps.config, 'magic_link_ip', MAGIC_LINK_IP_LIMIT)
  const ipCheck = await deps.rateLimiter.check('magic_link_ip', req.ip, perIp.limit, perIp.windowSeconds)
  if (!ipCheck.allowed) return rateLimited(ipCheck.resetAt, req.now)

  // No existence check, on purpose — INCLUDING under a restrictive signup
  // policy. A first version of the policy suppressed the email for unknown
  // non-allowed addresses here; the response body was identical, but the
  // refused path skipped the D1 insert and the awaited HTTPS send to the
  // email provider, a 100–500 ms difference a stopwatch client reads as an
  // account-existence oracle. So every plausible address takes exactly this
  // same path, and the signup policy lives ONLY in `consumeMagicLink`'s
  // create branch: a non-allowed stranger gets a real email whose link
  // lands on "sign-ups are closed" — honest, and timing-silent.
  const token = deps.crypto.randomToken(32)
  const record: MagicLinkToken = {
    tokenHash: await deps.crypto.hash(token),
    email,
    expiresAt: req.now + MAGIC_LINK_TTL_MS,
    createdAt: req.now,
  }
  await deps.repos.sessions.createMagicLink(record)

  const link = `${trimTrailingSlash(deps.config.baseUrl)}/auth/callback?token=${encodeURIComponent(token)}`
  await deps.email.send({
    to: email,
    subject: `Sign in to ${deps.config.brandName}`,
    text: magicLinkText(deps.config, link, req),
    html: magicLinkHtml(deps.config, link, req),
  })

  return { status: 'accepted' }
}

// ---------------------------------------------------------------------------
// Magic link — consumption
// ---------------------------------------------------------------------------

export interface SessionDeps {
  repos: Repositories
  crypto: Crypto
  /** Gates the create branch of `consumeMagicLink` only. Unset = open. */
  signupPolicy?: SignupPolicy
}

export type ConsumeMagicLinkResult =
  | { ok: true; sessionToken: string; session: Session; user: User; createdUser: boolean }
  | { ok: false; reason: 'invalid_or_expired' | 'signups_closed' }

/**
 * Redeem a link: single-use, then find-or-create the user, then a session.
 *
 * Single-use is the repository's atomic conditional delete, not a read
 * followed by a delete here — two concurrent redemptions of the same link must
 * not both win, and only the database can arbitrate that. A replay finds
 * nothing and fails closed (ADR-0005 §3).
 */
export async function consumeMagicLink(
  deps: SessionDeps,
  input: { token: string; now: number; timezone?: string },
): Promise<ConsumeMagicLinkResult> {
  if (!input.token) return { ok: false, reason: 'invalid_or_expired' }
  const tokenHash = await deps.crypto.hash(input.token)
  const record = await deps.repos.sessions.consumeMagicLink(tokenHash, input.now)
  // Expiry is enforced inside the same statement, so an expired link is
  // indistinguishable from a replayed one — both are simply "no row".
  if (!record) return { ok: false, reason: 'invalid_or_expired' }

  const email = normaliseEmail(record.email)
  const existing = await deps.repos.users.byEmail(email)
  let user = existing
  if (!user) {
    // The single authoritative signup gate: every account-creating flow
    // (magic link AND OAuth identity, which redeems a synthetic link) funnels
    // through this branch, so a policy check anywhere else is only UX.
    if (!signupAllowed(email, deps.signupPolicy)) return { ok: false, reason: 'signups_closed' }
    // The instance's very first user bootstraps as admin — someone has to be
    // able to close signups and manage the rest, and on a fresh deployment
    // that is its operator by definition. Read-then-create, so two truly
    // simultaneous first signups could both win admin; on a fresh instance
    // both are the operator's own attempts, and an admin can demote the
    // duplicate — a lockout (no admin at all) is the failure this avoids.
    const isFirstUser = (await deps.repos.users.count()) === 0
    // `create` returns null on ANY constraint loss, not only `slug` losing
    // a race against a concurrent claim — the same batch also
    // carries the `users_email_idx` insert, so two concurrent redemptions
    // for the SAME email (two tabs, two links both clicked) hit this too,
    // and that case must NOT retry `uniqueSlug`: the right recovery is
    // "sign in to the account the other request just created", not another
    // attempt at an account that would violate `users_email_idx` again. The
    // guest's single-use link is ALREADY burned by this point (the atomic
    // delete above), so failing outright here would strand them on a dead
    // link instead of a working account.
    for (let attempt = 0; attempt < 3 && !user; attempt++) {
      user = await deps.repos.users.create({
        id: `usr_${deps.crypto.randomToken(12)}`,
        email,
        name: defaultNameFrom(email),
        tz: input.timezone && input.timezone.length > 0 ? input.timezone : 'UTC',
        slug: await uniqueSlug(deps, email),
        avatarKey: null,
        company: null,
        jobTitle: null,
        companyUrl: null,
        role: isFirstUser ? 'admin' : 'member',
      })
      // A concurrent request for this exact email won in between — use the
      // account it created rather than looping on a slug retry that could
      // never succeed (the email, not the slug, is what's now taken).
      if (!user) user = await deps.repos.users.byEmail(email)
    }
    // Effectively unreachable (three consecutive losses against three fresh,
    // independently-checked slug candidates, with the concurrent-email case
    // resolved above on the first iteration), but the link is already
    // burned, so failing closed and honestly is the only option left.
    if (!user) return { ok: false, reason: 'invalid_or_expired' }
  }

  // Without a persisted schedule, `createSlotService` treats this host as
  // having zero availability (engine.ts skips a host `forUser` returns null
  // for) — not "unconfigured", indistinguishable from "never bookable". The
  // dashboard's availability form shows this same default as a preview
  // before the first save, which made connecting a calendar look like it
  // had "activated" nothing until the host separately discovered and
  // submitted that form — and made the gap invisible once they did, since
  // the preview and a real saved schedule render identically.
  //
  // Run on EVERY login, not only at creation: a transient failure right
  // after `users.create` would otherwise strand the account in this state
  // forever (the create branch only ever runs once), and every account that
  // predates this fix is in exactly that state already.
  //
  // `saveIfAbsent`, not a `forUser`-then-`save` check here: a host who
  // deliberately cleared their week to all-empty has a real saved schedule,
  // not a missing one, and a check-then-write has a window where their save
  // from another device lands between this login's read and write — the
  // backfill's default would silently win. Only the database can arbitrate
  // that, the same reasoning as every other race closed with a constraint
  // rather than an application-level check (`slot_locks`, `demoteAdmin`).
  await deps.repos.availability.saveIfAbsent(
    user.id,
    defaultSchedule(user, `sch_${deps.crypto.randomToken(12)}`),
  )

  const created = await createSession(deps, user.id, input.now)
  return { ok: true, sessionToken: created.token, session: created.session, user, createdUser: !existing }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * 256 bits of CSPRNG randomness to the client; only its SHA-256 to the
 * database (ADR-0005 §2), so a database dump does not yield usable cookies.
 */
export async function createSession(
  deps: SessionDeps,
  userId: string,
  now: number,
): Promise<{ token: string; session: Session }> {
  const token = deps.crypto.randomToken(32)
  const session: Session = {
    idHash: await deps.crypto.hash(token),
    userId,
    expiresAt: now + SESSION_TTL_MS,
    absoluteExpiresAt: now + SESSION_ABSOLUTE_TTL_MS,
    // Carrying the write bookmark from the moment of login means the very next
    // dashboard read already sees this session's own writes (ADR-0007 §2).
    bookmark: deps.repos.bookmark(),
    createdAt: now,
  }
  await deps.repos.sessions.create(session)
  return { token, session }
}

export interface AuthenticatedSession {
  session: Session
  user: User
}

/**
 * Cookie value → session + user, or null.
 *
 * Takes `crypto` as well as `repos` because the cookie is only ever compared
 * by hash — the raw value is never stored, so validation cannot avoid hashing.
 * Fails closed at every step, including a session row whose user has since
 * been deleted.
 */
export async function validateSession(
  deps: SessionDeps,
  cookieValue: string | null | undefined,
  now: number,
): Promise<AuthenticatedSession | null> {
  if (!cookieValue) return null
  const idHash = await deps.crypto.hash(cookieValue)
  const session = await deps.repos.sessions.byIdHash(idHash)
  if (!session) return null
  if (!isSessionValid(session, now)) {
    // Expired rows are swept by a cron; deleting on sight keeps a stolen
    // cookie from being repeatedly probed against a row that still exists.
    await deps.repos.sessions.delete(idHash)
    return null
  }

  const user = await deps.repos.users.byId(session.userId)
  if (!user) return null

  if (shouldSlideSession(session, now)) {
    const expiresAt = nextSessionExpiry(session, now)
    await deps.repos.sessions.touch(idHash, expiresAt, deps.repos.bookmark())
    return { session: { ...session, expiresAt }, user }
  }

  return { session, user }
}

/** Logout. Immediate, which is the whole reason sessions are rows and not JWTs. */
export async function revokeSession(deps: SessionDeps, cookieValue: string): Promise<void> {
  if (!cookieValue) return
  await deps.repos.sessions.delete(await deps.crypto.hash(cookieValue))
}

/** "Sign out everywhere" — including the device that asked. */
export async function revokeAllSessions(
  deps: { repos: Repositories },
  userId: string,
): Promise<void> {
  await deps.repos.sessions.deleteAllForUser(userId)
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface CreateApiKeyInput {
  userId: string
  name: string
  scopes: string[]
  now: number
}

/** The raw key is returned once and never again — only its hash is stored. */
export async function createApiKey(
  deps: SessionDeps,
  input: CreateApiKeyInput,
): Promise<{ raw: string; key: ApiKey }> {
  // Wrapped rather than passed as a bare method reference: an adapter is free
  // to implement the port as a class, and an unbound method would lose `this`.
  const generated = generateApiKey((bytes) => deps.crypto.randomToken(bytes))
  const key: ApiKey = {
    id: `key_${deps.crypto.randomToken(12)}`,
    userId: input.userId,
    prefix: generated.prefix,
    hashSha256: await deps.crypto.hash(apiKeyHashInput(generated.prefix, generated.secret)),
    name: input.name,
    scopes: input.scopes,
    lastUsedAt: null,
    createdAt: input.now,
  }
  await deps.repos.apiKeys.create(key)
  return { raw: generated.raw, key }
}

/** How stale `last_used_at` may get. Same reasoning as the session slide. */
const API_KEY_TOUCH_INTERVAL_MS = 60 * 60 * 1000

/**
 * Authenticate `Authorization: Bearer pk_…`.
 *
 * The clear-text prefix makes this one indexed read rather than a scan over
 * every key (ADR-0005 §7), and the secret is then compared by digest, in
 * constant time. `===` here would leak the correct digest one character at a
 * time to anyone who can measure a response.
 */
export async function authenticateApiKey(
  deps: SessionDeps,
  rawKey: string,
  now: number,
): Promise<{ key: ApiKey; user: User } | null> {
  const parsed = parseApiKey(rawKey)
  if (!parsed) return null

  const stored = await deps.repos.apiKeys.byPrefix(parsed.prefix)
  if (!stored) return null

  const presented = await deps.crypto.hash(apiKeyHashInput(parsed.prefix, parsed.secret))
  if (!constantTimeEqual(stored.hashSha256, presented)) return null

  const user = await deps.repos.users.byId(stored.userId)
  if (!user) return null

  if (stored.lastUsedAt === null || now - stored.lastUsedAt >= API_KEY_TOUCH_INTERVAL_MS) {
    await deps.repos.apiKeys.touchLastUsed(stored.id, now)
  }

  return { key: stored, user }
}

// ---------------------------------------------------------------------------
// Guest manage tokens
// ---------------------------------------------------------------------------

export interface IssuedManageToken {
  token: string
  /** Stored on the booking; rotating it kills links in superseded emails (ADR-0005 §4). */
  tokenHash: string
  expiresAt: number
}

/**
 * Mint a reschedule or cancel link for a guest who has no account.
 *
 * The token IS the credential, so it is signed rather than merely random: the
 * signature is what makes `booking_id`, `purpose` and `exp` unforgeable
 * together. TTL runs from the booking's start, not from issuance — guests act
 * on old email, so what bounds exposure is rotation on state change, not a
 * short clock (ADR-0005 §4). The nonce is what lets that rotation actually
 * change the token; see `manageTokenPayload`.
 */
export async function issueManageToken(
  deps: { crypto: Crypto },
  booking: Pick<Booking, 'id' | 'startUtc'>,
  purpose: ManageTokenPurpose,
  ttlMs: number = MANAGE_TOKEN_TTL_MS,
): Promise<IssuedManageToken> {
  const exp = booking.startUtc + ttlMs
  const nonce = deps.crypto.randomToken(9)
  const signature = await deps.crypto.sign(manageTokenPayload(booking.id, purpose, exp, nonce))
  const token = formatManageToken(booking.id, purpose, exp, nonce, signature)
  return { token, tokenHash: await deps.crypto.hash(token), expiresAt: exp }
}

export type ManageTokenFailure =
  | 'malformed'
  | 'wrong_purpose'
  | 'expired'
  | 'bad_signature'
  | 'superseded'

export type VerifyManageTokenResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: ManageTokenFailure }

/**
 * Verify a guest link for a SPECIFIC purpose.
 *
 * The purpose check is not a formality: the payload binds it, so a cancel link
 * presented at the reschedule endpoint fails the signature test as well — but
 * we reject it explicitly first so the failure reads as intent, not as a
 * crypto accident.
 *
 * The final lookup by token hash is the invalidation mechanism. Rescheduling
 * rotates `manage_token_hash`, so every link from a superseded confirmation
 * email still carries a perfectly valid signature and still finds no row.
 */
export async function verifyManageToken(
  deps: { crypto: Crypto; repos: Repositories },
  token: string,
  purpose: ManageTokenPurpose,
  now: number,
): Promise<VerifyManageTokenResult> {
  const parsed = parseManageToken(token)
  if (!parsed) return { ok: false, reason: 'malformed' }
  if (parsed.purpose !== purpose) return { ok: false, reason: 'wrong_purpose' }
  if (parsed.exp <= now) return { ok: false, reason: 'expired' }

  // Constant-time inside the adapter (crypto.subtle.verify).
  if (!(await deps.crypto.verify(parsed.payload, parsed.signature))) {
    return { ok: false, reason: 'bad_signature' }
  }

  const booking = await deps.repos.bookings.byManageToken(await deps.crypto.hash(token))
  if (!booking || booking.id !== parsed.bookingId) return { ok: false, reason: 'superseded' }
  return { ok: true, booking }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseEmail(email: string): string {
  return (email ?? '').trim().toLowerCase()
}

/** Permissive on purpose: rejecting a valid address loses an account. */
function isPlausibleEmail(email: string): boolean {
  if (email.length === 0 || email.length > 254) return false
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)
}

function limitFor(
  config: EngineConfig,
  scope: string,
  fallback: { limit: number; windowSeconds: number },
): { limit: number; windowSeconds: number } {
  const override = config.rateLimits?.[scope]
  return {
    limit: override?.limit ?? fallback.limit,
    windowSeconds: override?.windowSeconds ?? fallback.windowSeconds,
  }
}

function rateLimited(resetAt: number, now: number): MagicLinkResult {
  return { status: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)) }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function defaultNameFrom(email: string): string {
  const local = email.split('@')[0] ?? ''
  return local.replace(/[._-]+/g, ' ').trim() || 'There'
}

/** Weekdays 09:00–17:00 in the host's own timezone — a schedule that works before anyone edits anything. */
export function defaultAvailability(user: User): Availability {
  const weekly: WeeklySchedule = [[], [], [], [], [], [], []]
  for (let day = 1; day <= 5; day++) weekly[day] = [{ startMinute: 9 * 60, endMinute: 17 * 60 }]
  return { userId: user.id, timezone: user.tz, weekly, overrides: [] }
}

/** The backfilled default schedule a fresh or legacy (pre-named-schedules) user gets — see the login backfill above. */
export function defaultSchedule(user: User, id: string): Schedule {
  return { ...defaultAvailability(user), id, name: 'Working hours', isDefault: true }
}

/**
 * A public booking URL is `/{slug}/{event}`, so the slug is guessable by
 * design — it carries no authority and collisions only need to be resolved,
 * not hidden.
 */
async function uniqueSlug(deps: SessionDeps, email: string): Promise<string> {
  const base = suggestSlug(email)
  // A slug is the first path segment of the booking page, so it shares ONE
  // namespace with every system route, every other user AND every team —
  // `bookingPageContext` resolves an owner slug against either table with a
  // LIMIT 1 and no precedence, so a user claiming an existing team's slug
  // (someone signing up as sales@ where a "sales" team exists) makes both
  // parties' public pages ambiguous, with no way to reclaim either side.
  // This precheck is the fast path, not the guarantee — `users.create`
  // writes into the shared `slug_claims` table in the same batch as the
  // user row, which is what actually arbitrates a concurrent team creation
  // (or another signup) claiming the identical slug in the round trip
  // between this check and that write.
  const taken = async (slug: string) =>
    (await deps.repos.users.bySlug(slug)) !== null || (await deps.repos.teams.bySlug(slug)) !== null
  const candidate = validateSlug(base).ok ? base : `${base}-1`
  if (!(await taken(candidate))) return candidate
  for (let i = 0; i < 5; i++) {
    const suffixed = `${candidate}-${deps.crypto.randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`
    if (!(await taken(suffixed))) return suffixed
  }
  // Effectively unreachable, but a login must not fail on a slug collision.
  return `${candidate}-${deps.crypto.randomToken(8).toLowerCase().replace(/[^a-z0-9]/g, '')}`
}

/**
 * The email states the requesting IP and user agent (ADR-0005 §3) — that is
 * what turns "I did not ask for this" from a suspicion into a report.
 */
function magicLinkText(config: EngineConfig, link: string, req: MagicLinkRequest): string {
  return [
    `Sign in to ${config.brandName}:`,
    '',
    link,
    '',
    'This link works once and expires in 15 minutes.',
    '',
    `Requested from ${req.ip || 'an unknown address'} using ${req.userAgent || 'an unknown browser'}.`,
    `If that was not you, ignore this email — nothing has changed. Questions: ${config.supportEmail}`,
  ].join('\n')
}

function magicLinkHtml(config: EngineConfig, link: string, req: MagicLinkRequest): string {
  return [
    `<p>Sign in to ${escapeHtml(config.brandName)}:</p>`,
    `<p><a href="${escapeHtml(link)}">Sign in</a></p>`,
    '<p>This link works once and expires in 15 minutes.</p>',
    `<p>Requested from ${escapeHtml(req.ip || 'an unknown address')} using ${escapeHtml(req.userAgent || 'an unknown browser')}.`,
    ` If that was not you, ignore this email — nothing has changed.</p>`,
    `<p>Questions: ${escapeHtml(config.supportEmail)}</p>`,
  ].join('')
}

/** The user agent is attacker-controlled and lands in an HTML email. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
