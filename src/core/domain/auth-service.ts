/**
 * Auth primitives (ADR-0005). Pure: no I/O, no Cloudflare imports, no globals.
 *
 * Everything here is a format, a constant or a comparison — the decisions that
 * must be identical on every surface that touches a credential. The flows that
 * read and write are in `auth-flows.ts`; keeping them apart is what lets the
 * token formats be exhaustively tested without a database.
 */

import type { Session } from './types.js'

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

/** Sliding window: every ~active hour pushes expiry out another 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Hard cap. A session that has lived 90 days re-authenticates, however active. */
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Don't rewrite the row on every request.
 *
 * Sliding expiry naively implemented means one D1 write per authenticated
 * request, which is both a needless cost and a needless serialisation point.
 * An hour of granularity is invisible against a 30-day window.
 */
export const SESSION_SLIDE_INTERVAL_MS = 60 * 60 * 1000

export const SESSION_COOKIE_NAME = 'punctual_session'

export interface SessionCookieOptions {
  name: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'Lax'
  path: string
  maxAgeSeconds: number
}

/**
 * Cookie attributes for the session (ADR-0005 §2).
 *
 * `SameSite=Lax`, deliberately, not `None`. The public booking page carries no
 * session and no ambient authority by design (ADR-0005 §5), so the only
 * cross-site context the engine has — the embedded iframe — never needs the
 * cookie. The day a *guest* gets a session on the booking page, this has to
 * become `None`, which drags third-party-cookie blocking into the critical
 * path and makes the embed depend on browser policy we do not control. That is
 * why guest sessions are out of scope rather than merely unbuilt.
 *
 * `secure` is a parameter only so `http://localhost` development works; every
 * deployment passes true.
 */
export function sessionCookieOptions(secure: boolean): SessionCookieOptions {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
  }
}

/** `Set-Cookie` value. Pass maxAgeSeconds 0 to clear (logout). */
export function serializeSessionCookie(
  value: string,
  opts: SessionCookieOptions,
  maxAgeSeconds = opts.maxAgeSeconds,
): string {
  const parts = [`${opts.name}=${value}`, `Path=${opts.path}`, `SameSite=${opts.sameSite}`, `Max-Age=${maxAgeSeconds}`]
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * Both expiries, always. Checking only the sliding one would make the absolute
 * cap decorative, and the cap is the reason a stolen cookie has a horizon.
 */
export function isSessionValid(session: Session, now: number): boolean {
  return now < session.expiresAt && now < session.absoluteExpiresAt
}

/** What the sliding window moves expiry to — never past the absolute cap. */
export function nextSessionExpiry(session: Session, now: number): number {
  return Math.min(now + SESSION_TTL_MS, session.absoluteExpiresAt)
}

/**
 * True only when the row is meaningfully stale, so a burst of dashboard
 * requests costs one write rather than one per request.
 */
export function shouldSlideSession(session: Session, now: number): boolean {
  if (!isSessionValid(session, now)) return false
  const next = nextSessionExpiry(session, now)
  return next - session.expiresAt >= SESSION_SLIDE_INTERVAL_MS
}

// ---------------------------------------------------------------------------
// Magic links
// ---------------------------------------------------------------------------

/**
 * Short by design (ADR-0005 §3): the link is a bearer credential sitting in an
 * inbox, and 15 minutes is long enough for a slow mail hop but short enough
 * that a leaked mailbox archive is not a standing key.
 */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000

// ---------------------------------------------------------------------------
// Guest manage tokens
// ---------------------------------------------------------------------------

/**
 * `manage` authorises both actions from one link.
 *
 * The schema has a single `manage_token_hash` column, and the confirmation
 * email sends the reschedule and cancel links to the SAME person in the SAME
 * message — so splitting them protects against nothing, while making one of
 * the two impossible to keep valid. Purpose stays in the signed payload so a
 * token minted for one booking cannot be replayed against another.
 */
/**
 * The runtime list IS the source of truth, and the type is derived from it.
 *
 * These were two independent declarations, so adding 'manage' to the union
 * left the parser rejecting it — a type-level change with no compile error and
 * a silent runtime failure. Deriving one from the other makes that impossible.
 */
const MANAGE_PURPOSES = ['manage', 'cancel', 'reschedule'] as const

export type ManageTokenPurpose = (typeof MANAGE_PURPOSES)[number]


/** Booking time + 30 days (ADR-0005 §4): guests act on old email. */
export const MANAGE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface ParsedManageToken {
  bookingId: string
  purpose: ManageTokenPurpose
  exp: number
  nonce: string
  /** Exactly the bytes that were signed. */
  payload: string
  signature: string
}

/**
 * What the HMAC covers (ADR-0005 §4).
 *
 * `purpose` is inside the signature, not beside it: without that binding a
 * cancel link — which we hand to every guest in every confirmation email —
 * could be replayed as a reschedule by editing the URL, and the signature
 * would still check out.
 *
 * `nonce` is what makes rotation possible at all. An HMAC over `id|purpose|exp`
 * alone is deterministic, so re-issuing for an unchanged booking reproduces the
 * identical token — and "rotate `manage_token_hash` on state change" would
 * silently do nothing. Fresh randomness per issuance means the new link
 * displaces the old one.
 */
export function manageTokenPayload(
  bookingId: string,
  purpose: ManageTokenPurpose,
  exp: number,
  nonce: string,
): string {
  return `${bookingId}|${purpose}|${exp}|${nonce}`
}

/** `<bookingId>.<purpose>.<exp>.<nonce>.<signature>` — url-safe, no encoding step. */
export function formatManageToken(
  bookingId: string,
  purpose: ManageTokenPurpose,
  exp: number,
  nonce: string,
  signature: string,
): string {
  return `${bookingId}.${purpose}.${exp}.${nonce}.${signature}`
}

/**
 * Structural parse only — it says nothing about authenticity. The caller must
 * still verify the signature, and it is `payload` (rebuilt here, never taken
 * from the wire) that gets verified.
 */
export function parseManageToken(raw: string): ParsedManageToken | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null
  const parts = raw.split('.')
  if (parts.length !== 5) return null
  const [bookingId, purpose, expRaw, nonce, signature] = parts as [string, string, string, string, string]
  if (bookingId.length === 0 || nonce.length === 0 || signature.length === 0) return null
  if (!(MANAGE_PURPOSES as readonly string[]).includes(purpose)) return null
  if (!/^\d{1,15}$/.test(expRaw)) return null
  const exp = Number(expRaw)
  const typedPurpose = purpose as ManageTokenPurpose
  return {
    bookingId,
    purpose: typedPurpose,
    exp,
    nonce,
    payload: manageTokenPayload(bookingId, typedPurpose, exp, nonce),
    signature,
  }
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/** `pk_` so a leaked key is greppable in logs and by secret scanners. */
export const API_KEY_PREFIX_MARKER = 'pk_'
export const API_KEY_PREFIX_LENGTH = 8

export interface GeneratedApiKey {
  /** Shown once, at creation. Never stored. */
  raw: string
  /** Stored in the clear: lookup is an indexed hit, not a table scan (ADR-0005 §7). */
  prefix: string
  secret: string
}

/**
 * `pk_<8-char prefix>_<secret>`.
 *
 * `randomToken` is a parameter rather than an import so this stays pure and the
 * format is testable with deterministic material. 32 secret bytes per
 * ADR-0005 §7; the prefix is separate randomness, so publishing it in a key
 * list reveals nothing about the secret.
 */
export function generateApiKey(randomToken: (bytes?: number) => string): GeneratedApiKey {
  const prefix = randomToken(6).slice(0, API_KEY_PREFIX_LENGTH)
  const secret = randomToken(32)
  return { raw: `${API_KEY_PREFIX_MARKER}${prefix}_${secret}`, prefix, secret }
}

/**
 * Split on fixed offsets, not on `_`: a base64url secret contains underscores,
 * so `split('_')` would mangle roughly every key.
 */
export function parseApiKey(raw: string): { prefix: string; secret: string } | null {
  if (typeof raw !== 'string' || raw.length > 256) return null
  if (!raw.startsWith(API_KEY_PREFIX_MARKER)) return null
  const rest = raw.slice(API_KEY_PREFIX_MARKER.length)
  if (rest.length <= API_KEY_PREFIX_LENGTH + 1) return null
  const prefix = rest.slice(0, API_KEY_PREFIX_LENGTH)
  if (rest[API_KEY_PREFIX_LENGTH] !== '_') return null
  const secret = rest.slice(API_KEY_PREFIX_LENGTH + 1)
  if (!/^[A-Za-z0-9_-]{8}$/.test(prefix)) return null
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) return null
  return { prefix, secret }
}

/**
 * What gets hashed into `api_keys.hash_sha256`.
 *
 * The prefix is bound in for the same reason AES-GCM binds AAD (ADR-0005 §6):
 * a stored hash lifted into another row is then useless, because it only
 * validates under the prefix it was issued with.
 */
export function apiKeyHashInput(prefix: string, secret: string): string {
  return `${prefix}|${secret}`
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * Double-submit token for state-changing dashboard requests (ADR-0005 §5).
 *
 * Derived from the session id hash rather than stored: it needs no row of its
 * own, it dies exactly when the session dies, and it cannot be transplanted
 * between sessions. One-way, so the value embedded in a page never yields the
 * server-side session key. `hash` is a parameter to keep this module free of
 * I/O and of WebCrypto.
 */
export async function csrfTokenFor(
  hash: (value: string) => Promise<string>,
  sessionIdHash: string,
): Promise<string> {
  return hash(`csrf|${sessionIdHash}`)
}

/** Constant-time by construction — see `constantTimeEqual`. */
export async function verifyCsrf(
  hash: (value: string) => Promise<string>,
  sessionIdHash: string,
  presented: string,
): Promise<boolean> {
  if (typeof presented !== 'string' || presented.length === 0) return false
  return constantTimeEqual(await csrfTokenFor(hash, sessionIdHash), presented)
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare two secrets without leaking how far they matched.
 *
 * `===` on strings short-circuits at the first differing character, which
 * turns a stolen prefix into an oracle for the rest. Everything compared here
 * is a fixed-width hex digest, so the length check leaks nothing an attacker
 * did not already know; the loop then runs to the end regardless of where the
 * mismatch is.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
