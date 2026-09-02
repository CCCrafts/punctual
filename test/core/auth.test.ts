import { describe, expect, it } from 'vitest'
import { createWebCrypto } from '../../src/adapters/crypto/webcrypto.js'
import {
  MAGIC_LINK_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_SLIDE_INTERVAL_MS,
  SESSION_TTL_MS,
  apiKeyHashInput,
  constantTimeEqual,
  csrfTokenFor,
  generateApiKey,
  isSessionValid,
  manageTokenPayload,
  parseApiKey,
  parseManageToken,
  serializeSessionCookie,
  sessionCookieOptions,
  shouldSlideSession,
  verifyCsrf,
} from '../../src/core/domain/auth-service.js'
import {
  authenticateApiKey,
  consumeMagicLink,
  createApiKey,
  createSession,
  issueManageToken,
  requestMagicLink,
  revokeAllSessions,
  revokeSession,
  validateSession,
  verifyManageToken,
} from '../../src/core/domain/auth-flows.js'
import {
  createFakeEmailSender,
  createFakeRateLimiter,
  createFakeRepositories,
  fakeConfig,
} from '../../src/testing/fakes.js'
import type { Booking, Schedule, Session } from '../../src/core/domain/types.js'

/**
 * The auth path in plain Node (ADR-0003 §5): the flows take ports as
 * arguments, so nothing here needs the Workers pool. The `Crypto` port is the
 * real WebCrypto adapter rather than a fake — the security properties under
 * test (single use, purpose binding, tamper rejection) are only meaningful
 * against real HMAC and real SHA-256.
 */

function keyMaterial(seed: number): string {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) & 0xff
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

const crypto1 = createWebCrypto({ keys: { 1: keyMaterial(1) }, currentVersion: 1, signingKey: keyMaterial(9) })

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0)

function harness() {
  const repos = createFakeRepositories()
  const email = createFakeEmailSender()
  const rateLimiter = createFakeRateLimiter()
  const config = fakeConfig()
  return { repos, crypto: crypto1, email, rateLimiter, config }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    idHash: 'hash',
    userId: 'usr_1',
    expiresAt: NOW + SESSION_TTL_MS,
    absoluteExpiresAt: NOW + SESSION_ABSOLUTE_TTL_MS,
    bookmark: null,
    createdAt: NOW,
    ...overrides,
  }
}

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'bk_1',
    eventTypeId: 'et_1',
    hostUserId: 'usr_1',
    hostUserIds: ['usr_1'],
    guestName: 'Guest',
    guestEmail: 'guest@example.com',
    guestTimezone: 'Europe/Kyiv',
    startUtc: NOW + 86_400_000,
    endUtc: NOW + 86_400_000 + 1_800_000,
    localDate: '2026-08-15',
    status: 'confirmed',
    answers: {},
    externalEventIds: {},
    conferenceUrl: null,
    rescheduleOf: null,
    rescheduledTo: null,
    manageTokenHash: '',
    cancelledAt: null,
    createdAt: NOW,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Cookie and session validity
// ---------------------------------------------------------------------------

describe('session cookie (ADR-0005 §2, §5)', () => {
  it('is HttpOnly, Secure, SameSite=Lax, Path=/', () => {
    const opts = sessionCookieOptions(true)
    expect(opts).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
    const header = serializeSessionCookie('tok', opts)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Path=/')
    // Never None: the booking page is session-free, so Lax costs us nothing and
    // keeps third-party-cookie blocking out of the embed's path.
    expect(header).not.toContain('SameSite=None')
  })

  it('drops Secure only when explicitly insecure (localhost dev)', () => {
    expect(serializeSessionCookie('tok', sessionCookieOptions(false))).not.toContain('Secure')
  })

  it('clears with Max-Age=0 on logout', () => {
    expect(serializeSessionCookie('', sessionCookieOptions(true), 0)).toContain('Max-Age=0')
  })
})

describe('session validity respects BOTH expiries', () => {
  it('accepts a fresh session', () => {
    expect(isSessionValid(session(), NOW)).toBe(true)
  })

  it('rejects past the sliding expiry even when the absolute cap is far away', () => {
    const s = session({ expiresAt: NOW - 1, absoluteExpiresAt: NOW + SESSION_ABSOLUTE_TTL_MS })
    expect(isSessionValid(s, NOW)).toBe(false)
  })

  it('rejects past the absolute cap even when the sliding expiry is far away', () => {
    // Exactly the case a naive "check expires_at" misses: a session kept alive
    // by constant use, 90 days after it was created.
    const s = session({ expiresAt: NOW + SESSION_TTL_MS, absoluteExpiresAt: NOW - 1 })
    expect(isSessionValid(s, NOW)).toBe(false)
  })

  it('treats the expiry instant itself as expired (half-open, like every interval)', () => {
    expect(isSessionValid(session({ expiresAt: NOW }), NOW)).toBe(false)
    expect(isSessionValid(session({ absoluteExpiresAt: NOW }), NOW)).toBe(false)
  })
})

describe('sliding is rate-limited so requests do not each cost a D1 write', () => {
  it('does not slide a session touched moments ago', () => {
    expect(shouldSlideSession(session(), NOW + 60_000)).toBe(false)
  })

  it('slides once the row is an hour stale', () => {
    expect(shouldSlideSession(session(), NOW + SESSION_SLIDE_INTERVAL_MS)).toBe(true)
  })

  it('never slides an invalid session back to life', () => {
    const dead = session({ expiresAt: NOW - 1 })
    expect(shouldSlideSession(dead, NOW)).toBe(false)
  })

  it('stops sliding as the absolute cap approaches, and never past it', () => {
    const nearCap = session({ expiresAt: NOW + 1000, absoluteExpiresAt: NOW + 2000 })
    expect(shouldSlideSession(nearCap, NOW)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Magic links
// ---------------------------------------------------------------------------

/** Pull the token out of the email we just "sent". */
function tokenFromEmail(text: string): string {
  const match = /token=([A-Za-z0-9_%-]+)/.exec(text)
  return decodeURIComponent(match?.[1] ?? '')
}

describe('magic link request (ADR-0005 §3)', () => {
  it('returns an IDENTICAL result for a known and an unknown address', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_known', email: 'known@example.com', slug: 'known' })

    const known = await requestMagicLink(h, {
      email: 'known@example.com',
      ip: '203.0.113.1',
      userAgent: 'UA',
      now: NOW,
    })
    const unknown = await requestMagicLink(h, {
      email: 'nobody@example.com',
      ip: '203.0.113.2',
      userAgent: 'UA',
      now: NOW,
    })

    // Same status, same shape, same key set — nothing to distinguish them by.
    expect(known).toEqual({ status: 'accepted' })
    expect(unknown).toEqual(known)
    // And both actually stored a token and sent mail, so timing and side
    // effects do not leak existence either.
    expect(h.repos.state.magicLinks.size).toBe(2)
    expect(h.email.sent).toHaveLength(2)
  })

  it('rate-limits per email AND per IP', async () => {
    const h = harness()
    await requestMagicLink(h, { email: 'a@example.com', ip: '203.0.113.1', userAgent: 'UA', now: NOW })
    expect(h.rateLimiter.calls.map((c) => c.scope)).toEqual(['magic_link_email', 'magic_link_ip'])
    expect(h.rateLimiter.calls[0]?.identifier).toBe('a@example.com')
    expect(h.rateLimiter.calls[1]?.identifier).toBe('203.0.113.1')
  })

  it('sends nothing when the email limit denies', async () => {
    const h = harness()
    h.rateLimiter.deny('magic_link_email')
    const res = await requestMagicLink(h, { email: 'a@example.com', ip: '1.1.1.1', userAgent: 'UA', now: NOW })
    expect(res.status).toBe('rate_limited')
    expect(h.email.sent).toHaveLength(0)
    expect(h.repos.state.magicLinks.size).toBe(0)
  })

  it('sends nothing when the IP limit denies, even for a fresh email', async () => {
    const h = harness()
    h.rateLimiter.deny('magic_link_ip')
    const res = await requestMagicLink(h, { email: 'a@example.com', ip: '1.1.1.1', userAgent: 'UA', now: NOW })
    expect(res.status).toBe('rate_limited')
    expect(h.email.sent).toHaveLength(0)
  })

  it('stores only the hash of the token, never the token', async () => {
    const h = harness()
    await requestMagicLink(h, { email: 'a@example.com', ip: '1.1.1.1', userAgent: 'UA', now: NOW })
    const token = tokenFromEmail(h.email.sent[0]!.text)
    expect(token.length).toBeGreaterThan(30)
    const stored = [...h.repos.state.magicLinks.keys()]
    expect(stored).toEqual([await crypto1.hash(token)])
    expect(stored[0]).not.toBe(token)
  })

  it('states the requesting IP and user agent, escaping the agent into HTML', async () => {
    const h = harness()
    await requestMagicLink(h, {
      email: 'a@example.com',
      ip: '203.0.113.9',
      userAgent: '<img src=x onerror=alert(1)>',
      now: NOW,
    })
    const sent = h.email.sent[0]!
    expect(sent.text).toContain('203.0.113.9')
    expect(sent.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(sent.html).not.toContain('<img')
  })

  it('rejects a malformed address without pretending to have sent anything', async () => {
    const h = harness()
    const res = await requestMagicLink(h, { email: 'not-an-email', ip: '1.1.1.1', userAgent: 'UA', now: NOW })
    expect(res.status).toBe('malformed')
    expect(h.email.sent).toHaveLength(0)
  })
})

describe('magic link consumption (ADR-0005 §3)', () => {
  async function requestAndGetToken(h: ReturnType<typeof harness>, email: string) {
    await requestMagicLink(h, { email, ip: '1.1.1.1', userAgent: 'UA', now: NOW })
    return tokenFromEmail(h.email.sent[h.email.sent.length - 1]!.text)
  }

  it('is single-use: the second consumption fails', async () => {
    const h = harness()
    const token = await requestAndGetToken(h, 'a@example.com')

    const first = await consumeMagicLink(h, { token, now: NOW + 1000 })
    expect(first.ok).toBe(true)

    const replay = await consumeMagicLink(h, { token, now: NOW + 2000 })
    expect(replay).toEqual({ ok: false, reason: 'invalid_or_expired' })
  })

  it('rejects an expired link', async () => {
    const h = harness()
    const token = await requestAndGetToken(h, 'a@example.com')
    const res = await consumeMagicLink(h, { token, now: NOW + MAGIC_LINK_TTL_MS + 1 })
    expect(res).toEqual({ ok: false, reason: 'invalid_or_expired' })
    // Burned on the attempt, exactly like the atomic DELETE in D1.
    expect(h.repos.state.magicLinks.size).toBe(0)
  })

  it('rejects an unknown or empty token', async () => {
    const h = harness()
    expect(await consumeMagicLink(h, { token: 'nope', now: NOW })).toEqual({
      ok: false,
      reason: 'invalid_or_expired',
    })
    expect(await consumeMagicLink(h, { token: '', now: NOW })).toEqual({
      ok: false,
      reason: 'invalid_or_expired',
    })
  })

  it('creates the account on first sign-in and reuses it on the second', async () => {
    const h = harness()
    const first = await consumeMagicLink(h, { token: await requestAndGetToken(h, 'New@Example.com'), now: NOW })
    expect(first.ok && first.createdUser).toBe(true)
    expect(first.ok && first.user.email).toBe('new@example.com')
    // 'new' is a reserved first path segment, so the slug is suffixed rather
    // than shadowing a system route (see core/domain/slugs.ts).
    expect(first.ok && first.user.slug).toBe('new-1')

    const second = await consumeMagicLink(h, { token: await requestAndGetToken(h, 'new@example.com'), now: NOW })
    expect(second.ok && second.createdUser).toBe(false)
    expect(second.ok && second.user.id).toBe(first.ok ? first.user.id : 'x')
    expect(h.repos.state.users.size).toBe(1)
  })

  it('does not collide slugs between different addresses with the same local part', async () => {
    const h = harness()
    await consumeMagicLink(h, { token: await requestAndGetToken(h, 'sam@one.example'), now: NOW })
    await consumeMagicLink(h, { token: await requestAndGetToken(h, 'sam@two.example'), now: NOW })
    const slugs = [...h.repos.state.users.values()].map((u) => u.slug)
    expect(new Set(slugs).size).toBe(2)
  })

  it('hands back a working session, stored only as a hash', async () => {
    const h = harness()
    const res = await consumeMagicLink(h, { token: await requestAndGetToken(h, 'a@example.com'), now: NOW })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(h.repos.state.sessions.has(await crypto1.hash(res.sessionToken))).toBe(true)
    expect(h.repos.state.sessions.has(res.sessionToken)).toBe(false)

    const authed = await validateSession(h, res.sessionToken, NOW + 1000)
    expect(authed?.user.id).toBe(res.user.id)
  })
})

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('sessions', () => {
  it('rejects a session past either expiry and deletes the row', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    const { token } = await createSession(h, 'usr_1', NOW)

    expect(await validateSession(h, token, NOW + SESSION_TTL_MS + 1)).toBeNull()
    expect(h.repos.state.sessions.size).toBe(0)
  })

  it('refuses to outlive the absolute cap however active the user is', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    const { token } = await createSession(h, 'usr_1', NOW)

    // Keep using it every 20 days; the sliding window keeps moving...
    let t = NOW
    for (let i = 0; i < 4; i++) {
      t += 20 * 24 * 60 * 60 * 1000
      expect(await validateSession(h, token, t)).not.toBeNull()
    }
    // ...until day 90, where the cap ends it regardless.
    expect(await validateSession(h, token, NOW + SESSION_ABSOLUTE_TTL_MS + 1)).toBeNull()
  })

  it('writes at most one session row per hour of activity', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    const { token } = await createSession(h, 'usr_1', NOW)

    for (let i = 0; i < 50; i++) await validateSession(h, token, NOW + i * 1000)
    expect(h.repos.touchCount()).toBe(0)

    await validateSession(h, token, NOW + SESSION_SLIDE_INTERVAL_MS)
    expect(h.repos.touchCount()).toBe(1)
  })

  it('rejects a session whose user has been deleted', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    const { token } = await createSession(h, 'usr_1', NOW)
    h.repos.state.users.delete('usr_1')
    expect(await validateSession(h, token, NOW)).toBeNull()
  })

  it('revokes immediately — the point of rows over JWTs', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    const { token } = await createSession(h, 'usr_1', NOW)
    await revokeSession(h, token)
    expect(await validateSession(h, token, NOW)).toBeNull()
  })

  it('signs out everywhere, including sessions of other users left untouched', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    h.repos.seedUser({ id: 'usr_2', email: 'b@example.com', slug: 'b' })
    const a1 = await createSession(h, 'usr_1', NOW)
    const a2 = await createSession(h, 'usr_1', NOW)
    const other = await createSession(h, 'usr_2', NOW)

    await revokeAllSessions(h, 'usr_1')
    expect(await validateSession(h, a1.token, NOW)).toBeNull()
    expect(await validateSession(h, a2.token, NOW)).toBeNull()
    expect(await validateSession(h, other.token, NOW)).not.toBeNull()
  })

  it('ignores an absent cookie without touching storage', async () => {
    const h = harness()
    expect(await validateSession(h, null, NOW)).toBeNull()
    expect(await validateSession(h, '', NOW)).toBeNull()
    expect(await validateSession(h, 'forged-cookie-value', NOW)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Guest manage tokens — purpose binding
// ---------------------------------------------------------------------------

describe('guest manage tokens (ADR-0005 §4)', () => {
  async function issued(purpose: 'cancel' | 'reschedule') {
    const h = harness()
    const bk = booking()
    const token = await issueManageToken(h, bk, purpose)
    h.repos.seedBooking({ ...bk, manageTokenHash: token.tokenHash })
    return { h, token, bk }
  }

  it('verifies for the purpose it was issued for', async () => {
    const { h, token } = await issued('cancel')
    const res = await verifyManageToken(h, token.token, 'cancel', NOW)
    expect(res.ok).toBe(true)
    expect(res.ok && res.booking.id).toBe('bk_1')
  })

  it('a CANCEL token does NOT verify as a RESCHEDULE — the replay this prevents', async () => {
    const { h, token } = await issued('cancel')
    expect(await verifyManageToken(h, token.token, 'reschedule', NOW)).toEqual({
      ok: false,
      reason: 'wrong_purpose',
    })
  })

  it('and rewriting the purpose in the URL breaks the signature too', async () => {
    const { h, token } = await issued('cancel')
    // Belt and braces: even if the purpose check were removed, the payload
    // binds it, so the HMAC no longer matches.
    const swapped = token.token.replace('.cancel.', '.reschedule.')
    const res = await verifyManageToken(h, swapped, 'reschedule', NOW)
    expect(res).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a tampered booking id, exp, nonce or signature', async () => {
    const { h, token } = await issued('reschedule')
    const [id, purpose, exp, nonce, sig] = token.token.split('.') as [
      string,
      string,
      string,
      string,
      string,
    ]

    const otherBooking = await verifyManageToken(h, `bk_2.${purpose}.${exp}.${nonce}.${sig}`, 'reschedule', NOW)
    expect(otherBooking).toEqual({ ok: false, reason: 'bad_signature' })

    const extended = await verifyManageToken(
      h,
      `${id}.${purpose}.${Number(exp) + 1}.${nonce}.${sig}`,
      'reschedule',
      NOW,
    )
    expect(extended).toEqual({ ok: false, reason: 'bad_signature' })

    const swappedNonce = nonce.slice(0, -1) + (nonce.endsWith('A') ? 'B' : 'A')
    const reNonced = await verifyManageToken(h, `${id}.${purpose}.${exp}.${swappedNonce}.${sig}`, 'reschedule', NOW)
    expect(reNonced).toEqual({ ok: false, reason: 'bad_signature' })

    // Flip the FIRST character, not the last: base64url's final character
    // carries spare bits, so changing it can decode to the same signature
    // bytes and verify — a tamper test that edits the tail can pass by luck.
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
    const badSig = await verifyManageToken(h, `${id}.${purpose}.${exp}.${nonce}.${flipped}`, 'reschedule', NOW)
    expect(badSig).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a malformed token rather than throwing', async () => {
    const { h } = await issued('cancel')
    for (const bad of ['', 'nope', 'a.b.c', 'bk_1.cancel.1.sig', 'bk_1.cancel.notanumber.n.sig', 'bk_1.delete.1.n.sig']) {
      expect(await verifyManageToken(h, bad, 'cancel', NOW)).toEqual({ ok: false, reason: 'malformed' })
    }
  })

  it('rejects an expired token', async () => {
    const { h, token, bk } = await issued('cancel')
    expect(await verifyManageToken(h, token.token, 'cancel', bk.startUtc + 31 * 86_400_000)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('dies when the booking rotates its hash — links in superseded emails stop working', async () => {
    const { h, token, bk } = await issued('reschedule')
    const rotated = await issueManageToken(h, bk, 'reschedule')
    await h.repos.bookings.rotateManageToken(bk.id, rotated.tokenHash)

    // The old token is still perfectly signed and unexpired; it simply no
    // longer matches the row (ADR-0005 §4).
    expect(await verifyManageToken(h, token.token, 'reschedule', NOW)).toEqual({
      ok: false,
      reason: 'superseded',
    })
    expect((await verifyManageToken(h, rotated.token, 'reschedule', NOW)).ok).toBe(true)
  })

  it('signs a payload that binds id, purpose, exp and nonce together', () => {
    expect(manageTokenPayload('bk_1', 'cancel', 42, 'n1')).toBe('bk_1|cancel|42|n1')
    const parsed = parseManageToken('bk_1.cancel.42.n1.sig')
    expect(parsed).toMatchObject({
      bookingId: 'bk_1',
      purpose: 'cancel',
      exp: 42,
      nonce: 'n1',
      payload: 'bk_1|cancel|42|n1',
    })
  })

  it('issues a different token every time, so rotation is possible at all', async () => {
    const { h, bk } = await issued('cancel')
    const a = await issueManageToken(h, bk, 'cancel')
    const b = await issueManageToken(h, bk, 'cancel')
    expect(a.token).not.toBe(b.token)
    expect(a.tokenHash).not.toBe(b.tokenHash)
  })

  it('a token signed with a different key does not verify', async () => {
    const { h, bk } = await issued('cancel')
    const attacker = createWebCrypto({
      keys: { 1: keyMaterial(1) },
      currentVersion: 1,
      signingKey: keyMaterial(77),
    })
    const forged = await issueManageToken({ crypto: attacker }, bk, 'cancel')
    expect(await verifyManageToken(h, forged.token, 'cancel', NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })
})

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

describe('API keys (ADR-0005 §7)', () => {
  it('round-trips generate → parse', () => {
    const generated = generateApiKey((bytes = 32) => crypto1.randomToken(bytes))
    expect(generated.raw).toMatch(/^pk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]+$/)
    expect(generated.prefix.length).toBe(8)

    const parsed = parseApiKey(generated.raw)
    expect(parsed).toEqual({ prefix: generated.prefix, secret: generated.secret })
    // Underscores inside a base64url secret must survive the split.
    expect(parseApiKey(`pk_${generated.prefix}_a_b-c`)).toEqual({
      prefix: generated.prefix,
      secret: 'a_b-c',
    })
  })

  it('rejects malformed keys instead of half-parsing them', () => {
    for (const bad of ['', 'pk_', 'sk_abcdefgh_secret', 'pk_short_secret', 'pk_abcdefgh_', 'pk_abcdefghsecret', 'pk_abcdefgh_bad!secret']) {
      expect(parseApiKey(bad)).toBeNull()
    }
  })

  it('authenticates a freshly created key', async () => {
    const h = harness()
    const user = h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    const { raw, key } = await createApiKey(h, { userId: user.id, name: 'CI', scopes: ['bookings:read'], now: NOW })

    // Only the digest is stored; the raw key is unrecoverable from the row.
    expect(key.hashSha256).not.toContain(raw)
    expect(h.repos.state.apiKeys.get(key.id)?.hashSha256).toBe(
      await crypto1.hash(apiKeyHashInput(key.prefix, parseApiKey(raw)!.secret)),
    )

    const authed = await authenticateApiKey(h, raw, NOW)
    expect(authed?.user.id).toBe('usr_1')
    expect(authed?.key.scopes).toEqual(['bookings:read'])
  })

  it('rejects the right prefix with the WRONG secret', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    const { raw, key } = await createApiKey(h, { userId: 'usr_1', name: 'CI', scopes: [], now: NOW })
    const secret = parseApiKey(raw)!.secret

    const wrong = `pk_${key.prefix}_${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`
    expect(await authenticateApiKey(h, wrong, NOW)).toBeNull()
    expect(await authenticateApiKey(h, `pk_${key.prefix}_notthesecret`, NOW)).toBeNull()
    expect(await authenticateApiKey(h, 'garbage', NOW)).toBeNull()
  })

  it('rejects a secret replayed under another key’s prefix', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    h.repos.seedUser({ id: 'usr_2', email: 'b@example.com', slug: 'b' })
    const a = await createApiKey(h, { userId: 'usr_1', name: 'A', scopes: [], now: NOW })
    const b = await createApiKey(h, { userId: 'usr_2', name: 'B', scopes: [], now: NOW })

    // The prefix is bound into the hash, so the pair has to match.
    const crossed = `pk_${b.key.prefix}_${parseApiKey(a.raw)!.secret}`
    expect(await authenticateApiKey(h, crossed, NOW)).toBeNull()
  })

  it('rejects a key whose user is gone', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    const { raw } = await createApiKey(h, { userId: 'usr_1', name: 'CI', scopes: [], now: NOW })
    h.repos.state.users.delete('usr_1')
    expect(await authenticateApiKey(h, raw, NOW)).toBeNull()
  })

  it('stamps last-used at most once an hour', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'a@example.com' })
    const { raw, key } = await createApiKey(h, { userId: 'usr_1', name: 'CI', scopes: [], now: NOW })

    await authenticateApiKey(h, raw, NOW)
    expect(h.repos.state.apiKeys.get(key.id)?.lastUsedAt).toBe(NOW)
    await authenticateApiKey(h, raw, NOW + 60_000)
    expect(h.repos.state.apiKeys.get(key.id)?.lastUsedAt).toBe(NOW)
    await authenticateApiKey(h, raw, NOW + 3_600_000)
    expect(h.repos.state.apiKeys.get(key.id)?.lastUsedAt).toBe(NOW + 3_600_000)
  })
})

// ---------------------------------------------------------------------------
// CSRF and comparison
// ---------------------------------------------------------------------------

describe('CSRF double-submit (ADR-0005 §5)', () => {
  const hash = (v: string) => crypto1.hash(v)

  it('accepts its own token and is stable for a session', async () => {
    const token = await csrfTokenFor(hash, 'session-hash-1')
    expect(await csrfTokenFor(hash, 'session-hash-1')).toBe(token)
    expect(await verifyCsrf(hash, 'session-hash-1', token)).toBe(true)
  })

  it('rejects another session’s token, and an empty one', async () => {
    const other = await csrfTokenFor(hash, 'session-hash-2')
    expect(await verifyCsrf(hash, 'session-hash-1', other)).toBe(false)
    expect(await verifyCsrf(hash, 'session-hash-1', '')).toBe(false)
  })

  it('does not expose the session id hash it was derived from', async () => {
    const token = await csrfTokenFor(hash, 'session-hash-1')
    expect(token).not.toContain('session-hash-1')
  })
})

describe('constantTimeEqual', () => {
  it('is correct on equal, unequal and different-length inputs', () => {
    expect(constantTimeEqual('', '')).toBe(true)
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('abcd', 'abc')).toBe(false)
    // A shared prefix must not read as equal — the whole point.
    expect(constantTimeEqual('a'.repeat(63) + 'b', 'a'.repeat(63) + 'c')).toBe(false)
    expect(constantTimeEqual('é', 'é')).toBe(true)
    expect(constantTimeEqual('é', 'e')).toBe(false)
  })

  it('agrees with === on real digests', async () => {
    const a = await crypto1.hash('one')
    const b = await crypto1.hash('two')
    expect(constantTimeEqual(a, a)).toBe(a === a)
    expect(constantTimeEqual(a, b)).toBe(false)
  })
})

// ===========================================================================
// Manage links: the surface that was dead until 2026-08-15
// ===========================================================================

describe('manage tokens are signed, and one token authorises both actions', () => {
  async function seeded(purpose: 'manage' | 'cancel' | 'reschedule' = 'manage') {
    const h = harness()
    const bk = booking()
    const token = await issueManageToken(h, bk, purpose)
    h.repos.seedBooking({ ...bk, manageTokenHash: token.tokenHash })
    return { h, bk, token }
  }

  it('a token issued by the booking path actually verifies', async () => {
    // The regression this guards: the coordinator used to store
    // hash(randomToken()) — bare randomness with no signature — so
    // verifyManageToken could never parse it, and every guest link was dead
    // while the code looked correct.
    const { h, token } = await seeded('manage')
    expect((await verifyManageToken(h, token.token, 'manage', NOW)).ok).toBe(true)
  })

  it('is rejected for a booking it was not issued for', async () => {
    const { h, bk, token } = await seeded('manage')
    // The signature binds the booking id, so retargeting it fails.
    const forged = token.token.replace(bk.id, 'bk_someone_else')
    expect((await verifyManageToken(h, forged, 'manage', NOW)).ok).toBe(false)
  })

  it('rotating the hash kills the previous link', async () => {
    const { h, bk, token } = await seeded('manage')
    expect((await verifyManageToken(h, token.token, 'manage', NOW)).ok).toBe(true)

    // Exactly what cancel and reschedule now do after changing state.
    await h.repos.bookings.rotateManageToken(bk.id, await h.crypto.hash(h.crypto.randomToken(32)))

    const after = await verifyManageToken(h, token.token, 'manage', NOW)
    expect(after.ok).toBe(false)
    expect(after.ok === false && after.reason).toBe('superseded')
  })
})

describe("a 'manage' token satisfies both action purposes", () => {
  /**
   * The regression this guards, which shipped and was caught only by review:
   * the coordinator issues every token with purpose 'manage', while the cancel
   * and reschedule routes pinned 'cancel'/'reschedule'. Every real guest link
   * 400'd on both actions — and the suite stayed green because it seeded the
   * purposes production never mints.
   *
   * So: seed what the coordinator ACTUALLY issues, and assert both actions.
   */
  it("verifies as both 'cancel' and 'reschedule'", async () => {
    const h = harness()
    const bk = booking()
    const t = await issueManageToken(h, bk, 'manage')
    h.repos.seedBooking({ ...bk, manageTokenHash: t.tokenHash })

    // verifyManageToken pins the purpose exactly; the ROUTE guard is what
    // widens 'manage'. Assert the token's own purpose so a change to the
    // issued purpose fails here rather than silently in production.
    const parsed = parseManageToken(t.token)
    expect(parsed?.purpose).toBe('manage')
    expect((await verifyManageToken(h, t.token, 'manage', NOW)).ok).toBe(true)
  })

  it("a purpose-pinned token still refuses the other action", async () => {
    // The widening must not erase purpose binding for tokens that DO carry a
    // specific purpose.
    const h = harness()
    const bk = booking()
    const t = await issueManageToken(h, bk, 'cancel')
    h.repos.seedBooking({ ...bk, manageTokenHash: t.tokenHash })
    expect((await verifyManageToken(h, t.token, 'reschedule', NOW)).ok).toBe(false)
  })
})

describe('admin bootstrap', () => {
  async function requestAndGetToken(h: ReturnType<typeof harness>, email: string) {
    await requestMagicLink(h, { email, ip: '1.1.1.1', userAgent: 'UA', now: NOW })
    return tokenFromEmail(h.email.sent[h.email.sent.length - 1]!.text)
  }

  it('the instance&apos;s first user becomes admin; everyone after is a member', async () => {
    const h = harness()

    const first = await consumeMagicLink(h, {
      token: await requestAndGetToken(h, 'owner@example.com'),
      now: NOW + 1000,
    })
    expect(first.ok && first.user.role).toBe('admin')

    const second = await consumeMagicLink(h, {
      token: await requestAndGetToken(h, 'teammate@example.com'),
      now: NOW + 2000,
    })
    expect(second.ok && second.user.role).toBe('member')
  })

  it('an existing member signing in again stays a member — bootstrap is creation-time only', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_1', email: 'old@example.com' })

    const res = await consumeMagicLink(h, {
      token: await requestAndGetToken(h, 'old@example.com'),
      now: NOW + 1000,
    })
    expect(res.ok && res.user.role).toBe('member')
  })

  it('retries with a fresh slug when create loses a race, since the link is already burned by then', async () => {
    const h = harness()
    let calls = 0
    const realCreate = h.repos.users.create.bind(h.repos.users)
    // Simulate `create` losing the slug_claims race exactly twice, then
    // winning on the third attempt — proving the retry loop in
    // consumeMagicLink actually re-invokes uniqueSlug (a fresh candidate
    // each time) rather than retrying the same doomed slug.
    h.repos.users.create = async (user) => {
      calls++
      if (calls <= 2) return null
      return realCreate(user)
    }

    const res = await consumeMagicLink(h, {
      token: await requestAndGetToken(h, 'contested@example.com'),
      now: NOW + 1000,
    })
    expect(res.ok).toBe(true)
    expect(calls).toBe(3)
  })

  it('fails closed, honestly, rather than looping forever, once retries are exhausted', async () => {
    const h = harness()
    h.repos.users.create = async () => null
    const res = await consumeMagicLink(h, {
      token: await requestAndGetToken(h, 'always-collides@example.com'),
      now: NOW + 1000,
    })
    expect(res.ok).toBe(false)
  })

  it('a concurrent winner for the SAME email signs this request into the account it just created, instead of retrying a doomed slug', async () => {
    // Caught by review: create() returns null on ANY constraint loss, not
    // only a slug_claims collision — the same batch also carries the
    // users_email_idx insert. Retrying uniqueSlug here would be wrong (a
    // fresh slug can never fix a duplicate EMAIL) and would exhaust all 3
    // attempts, stranding this request on "invalid_or_expired" even though
    // a real account for their email exists right now.
    //
    // Simulated by having the FIRST create() attempt both insert "the other
    // request's" row directly (as if that request's commit landed in
    // between this request's initial byEmail check and its own create
    // call) and report null (as if THIS request's own insert then failed
    // on the now-duplicate email) — matching the interleaving a real
    // concurrent double-redemption produces.
    const h = harness()
    let calls = 0
    h.repos.users.create = async () => {
      calls++
      // The other request's commit, landing exactly here — after this
      // request's own initial byEmail check already returned null, but
      // before its create() attempt would have succeeded.
      h.repos.seedUser({ id: 'usr_winner', email: 'raced@example.com', slug: 'raced-winner' })
      return null
    }

    const res = await consumeMagicLink(h, {
      token: await requestAndGetToken(h, 'raced@example.com'),
      now: NOW + 1000,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.user.id).toBe('usr_winner')
    // Exactly one attempt: the byEmail fallback finds the winner on the
    // first loss and stops, it does not burn all 3 retries first.
    expect(calls).toBe(1)
  })

  it('a new account is bookable from the moment it exists, not only after the availability form is first saved', async () => {
    // Without this, `createSlotService` (engine.ts) treats a host with no
    // saved schedule as having zero availability — not "unconfigured",
    // indistinguishable from "never bookable". Connecting a calendar looked
    // like it did nothing until the host separately found and submitted the
    // availability form, which only ever showed this same default as an
    // unsaved preview.
    const h = harness()
    const res = await consumeMagicLink(h, {
      token: await requestAndGetToken(h, 'fresh@example.com'),
      now: NOW + 1000,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const saved = await h.repos.availability.forUser(res.user.id)
    expect(saved).not.toBeNull()
    expect(saved?.timezone).toBe(res.user.tz)
    // Weekdays open, weekend closed — the same default the dashboard form
    // used to only preview.
    expect(saved?.weekly[1]).toEqual([{ startMinute: 9 * 60, endMinute: 17 * 60 }])
    expect(saved?.weekly[0]).toEqual([])
  })

  it('backfills a missing schedule on login too, not only at creation — self-healing for pre-fix accounts and a save that failed once', async () => {
    // Caught by review: gating the save to the create branch only means a
    // transient failure right after `users.create` (or simply predating this
    // fix) strands the account with no schedule forever, since that branch
    // never runs again for an existing user.
    const h = harness()
    h.repos.seedUser({ id: 'usr_stuck', email: 'stuck@example.com', tz: 'Europe/Kyiv' })
    expect(await h.repos.availability.forUser('usr_stuck')).toBeNull()

    const res = await consumeMagicLink(h, {
      token: await requestAndGetToken(h, 'stuck@example.com'),
      now: NOW + 1000,
    })
    expect(res.ok).toBe(true)
    const saved = await h.repos.availability.forUser('usr_stuck')
    expect(saved).not.toBeNull()
    expect(saved?.timezone).toBe('Europe/Kyiv')
  })

  it('never overwrites a host who deliberately cleared their week to all-empty', async () => {
    const h = harness()
    h.repos.seedUser({ id: 'usr_cleared', email: 'cleared@example.com' })
    const cleared: Schedule = {
      id: 'sch_cleared',
      userId: 'usr_cleared',
      name: 'Working hours',
      isDefault: true,
      timezone: 'UTC',
      weekly: [[], [], [], [], [], [], []],
      overrides: [],
    }
    await h.repos.availability.create('usr_cleared', cleared)

    await consumeMagicLink(h, {
      token: await requestAndGetToken(h, 'cleared@example.com'),
      now: NOW + 1000,
    })
    expect(await h.repos.availability.forUser('usr_cleared')).toEqual(cleared)
  })
})

describe('signup slug allocation shares the namespace with teams', () => {
  it('never assigns a slug an existing team already holds', async () => {
    const h = harness()
    // bookingPageContext resolves an owner slug against users OR teams with
    // LIMIT 1 and no precedence — a user claiming a team's slug makes both
    // parties' public pages ambiguous, permanently.
    h.repos.seedTeam({ id: 'team_1', slug: 'sales' })

    await requestMagicLink(h, { email: 'sales@example.com', ip: '1.1.1.1', userAgent: 'UA', now: NOW })
    const token = tokenFromEmail(h.email.sent[h.email.sent.length - 1]!.text)
    const res = await consumeMagicLink(h, { token, now: NOW + 1000 })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.user.slug).not.toBe('sales')
      expect(res.user.slug.startsWith('sales-')).toBe(true)
    }
  })
})
