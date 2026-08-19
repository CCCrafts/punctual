/**
 * In-memory ports, for tests that exercise a flow rather than an adapter.
 *
 * Only the repositories the auth flows touch are implemented; the rest throw
 * on first use. That is deliberate — a fake that silently returns `undefined`
 * for an unimplemented method turns a real bug into a passing test.
 *
 * Plain data structures, no Cloudflare imports, so these run in the `core`
 * Vitest project alongside the domain they support.
 */

import type {
  ApiKey,
  Booking,
  CalendarConnection,
  MagicLinkToken,
  Session,
  User,
} from '../core/domain/types.js'
import type {
  ApiKeyRepository,
  BlobStorage,
  BookingRepository,
  CalendarConnectionRepository,
  EmailMessage,
  EmailSender,
  EngineConfig,
  RateLimiter,
  RateLimitResult,
  Repositories,
  SessionRepository,
  UserRepository,
} from '../ports.js'

/**
 * A stand-in whose every method throws when called. `impl` supplies the ones a
 * test actually needs; anything else names itself loudly in the failure.
 */
function unimplemented<T extends object>(label: string, impl: Partial<T> = {}): T {
  return new Proxy(impl as T, {
    get(target, prop) {
      const existing = (target as Record<string | symbol, unknown>)[prop]
      if (existing !== undefined) return existing
      return () => {
        throw new Error(`fake: ${label}.${String(prop)} is not implemented`)
      }
    },
  })
}

export interface FakeRepositories extends Repositories {
  /** Direct access for arrange-steps; the flows never see these. */
  readonly state: {
    users: Map<string, User>
    sessions: Map<string, Session>
    magicLinks: Map<string, MagicLinkToken>
    apiKeys: Map<string, ApiKey>
    bookings: Map<string, Booking>
    connections: Map<string, CalendarConnection>
  }
  seedUser(user: Partial<User> & Pick<User, 'id' | 'email'>): User
  seedBooking(booking: Booking): Booking
  /** How many times the session row was rewritten — the sliding-window budget. */
  touchCount(): number
}

export function createFakeRepositories(): FakeRepositories {
  const users = new Map<string, User>()
  const sessions = new Map<string, Session>()
  const magicLinks = new Map<string, MagicLinkToken>()
  const apiKeys = new Map<string, ApiKey>()
  const bookings = new Map<string, Booking>()
  const connections = new Map<string, CalendarConnection>()
  let touches = 0
  let lastBookmark: string | null = null

  const userRepo: UserRepository = {
    async byId(id) {
      return users.get(id) ?? null
    },
    async byEmail(email) {
      const wanted = email.toLowerCase()
      for (const u of users.values()) if (u.email.toLowerCase() === wanted) return u
      return null
    },
    async bySlug(slug) {
      for (const u of users.values()) if (u.slug === slug) return u
      return null
    },
    async create(user) {
      const created: User = { ...user, createdAt: Date.now() }
      users.set(created.id, created)
      lastBookmark = `bm-${users.size}`
      return created
    },
    async update(id, patch) {
      const existing = users.get(id)
      if (!existing) return true
      if (patch.slug !== undefined) {
        for (const u of users.values()) {
          if (u.id !== id && u.slug === patch.slug) return false
        }
      }
      users.set(id, { ...existing, ...patch })
      return true
    },
  }

  const sessionRepo: SessionRepository = {
    async byIdHash(idHash) {
      return sessions.get(idHash) ?? null
    },
    async create(session) {
      sessions.set(session.idHash, session)
    },
    async touch(idHash, expiresAt, bookmark) {
      const existing = sessions.get(idHash)
      if (!existing) return
      touches++
      sessions.set(idHash, { ...existing, expiresAt, bookmark: bookmark ?? existing.bookmark })
    },
    async delete(idHash) {
      sessions.delete(idHash)
    },
    async deleteAllForUser(userId) {
      for (const [hash, s] of sessions) if (s.userId === userId) sessions.delete(hash)
    },
    async createMagicLink(token) {
      magicLinks.set(token.tokenHash, { ...token, email: token.email.toLowerCase() })
    },
    /** Delete-and-return in one step, mirroring `DELETE … RETURNING` in D1. */
    async consumeMagicLink(tokenHash, now) {
      const found = magicLinks.get(tokenHash)
      if (!found) return null
      magicLinks.delete(tokenHash)
      return found.expiresAt > now ? found : null
    },
  }

  const apiKeyRepo: ApiKeyRepository = {
    async byPrefix(prefix) {
      for (const k of apiKeys.values()) if (k.prefix === prefix) return k
      return null
    },
    async listForUser(userId) {
      return [...apiKeys.values()].filter((k) => k.userId === userId)
    },
    async create(key) {
      apiKeys.set(key.id, key)
    },
    async delete(id) {
      apiKeys.delete(id)
    },
    async touchLastUsed(id, at) {
      const existing = apiKeys.get(id)
      if (existing) apiKeys.set(id, { ...existing, lastUsedAt: at })
    },
  }

  const bookingRepo = unimplemented<BookingRepository>('bookings', {
    async byId(id: string) {
      return bookings.get(id) ?? null
    },
    async byManageToken(tokenHash: string) {
      for (const b of bookings.values()) if (b.manageTokenHash === tokenHash) return b
      return null
    },
    async setExternalEventIds(bookingId: string, ids: Record<string, string>) {
      const existing = bookings.get(bookingId)
      if (existing) bookings.set(bookingId, { ...existing, externalEventIds: ids })
    },
    async rotateManageToken(bookingId: string, tokenHash: string) {
      const existing = bookings.get(bookingId)
      if (existing) bookings.set(bookingId, { ...existing, manageTokenHash: tokenHash })
    },
  })

  const connectionRepo = unimplemented<CalendarConnectionRepository>('connections', {
    async byId(id: string) {
      return connections.get(id) ?? null
    },
    async listForUser(userId: string) {
      return [...connections.values()].filter((c) => c.userId === userId)
    },
    async create(conn: CalendarConnection) {
      connections.set(conn.id, conn)
      return conn
    },
    async updateCalendars(id: string, patch: { read: string[]; write: string | null }) {
      const existing = connections.get(id)
      if (existing) {
        connections.set(id, { ...existing, calendarIdsRead: patch.read, calendarIdWrite: patch.write })
      }
    },
    async delete(id: string) {
      connections.delete(id)
    },
  })

  return {
    users: userRepo,
    sessions: sessionRepo,
    apiKeys: apiKeyRepo,
    bookings: bookingRepo,
    async telemetryCounts() {
      return { users: users.size, eventTypes: 0, bookings: bookings.size }
    },
    eventTypes: unimplemented('eventTypes'),
    availability: unimplemented('availability'),
    slotLocks: unimplemented('slotLocks'),
    teams: unimplemented('teams'),
    connections: connectionRepo,
    webhooks: unimplemented('webhooks'),
    idempotency: unimplemented('idempotency'),
    bookmark() {
      return lastBookmark
    },
    state: { users, sessions, magicLinks, apiKeys, bookings, connections },
    seedUser(user) {
      const full: User = {
        name: 'Seed User',
        tz: 'UTC',
        slug: user.id,
        avatarKey: null,
        company: null,
        jobTitle: null,
        companyUrl: null,
        createdAt: 0,
        ...user,
      }
      users.set(full.id, full)
      return full
    },
    seedBooking(booking) {
      bookings.set(booking.id, booking)
      return booking
    },
    touchCount() {
      return touches
    },
  }
}

export interface FakeRateLimiter extends RateLimiter {
  /** Every call, in order, so a test can assert BOTH scopes were checked. */
  readonly calls: Array<{ scope: string; identifier: string; limit: number; windowSeconds: number }>
  /** Force the next and all later checks on a scope to deny. */
  deny(scope: string): void
}

/** A counter, not a token bucket — the DO owns the real algorithm. */
export function createFakeRateLimiter(): FakeRateLimiter {
  const calls: FakeRateLimiter['calls'] = []
  const counts = new Map<string, number>()
  const denied = new Set<string>()

  return {
    calls,
    deny(scope) {
      denied.add(scope)
    },
    async check(scope, identifier, limit, windowSeconds): Promise<RateLimitResult> {
      calls.push({ scope, identifier, limit, windowSeconds })
      const key = `${scope}:${identifier}`
      const used = (counts.get(key) ?? 0) + 1
      counts.set(key, used)
      const allowed = !denied.has(scope) && used <= limit
      return {
        allowed,
        remaining: Math.max(0, limit - used),
        resetAt: windowSeconds * 1000,
      }
    },
  }
}

export interface FakeEmailSender extends EmailSender {
  readonly sent: EmailMessage[]
}

export function createFakeEmailSender(): FakeEmailSender {
  const sent: EmailMessage[] = []
  return {
    sent,
    async send(message) {
      sent.push(message)
    },
  }
}

export interface FakeBlobStorage extends BlobStorage {
  /** Direct access for assertions — what got stored, and under which key. */
  readonly stored: Map<string, { bytes: Uint8Array; contentType: string }>
}

export function createFakeBlobStorage(): FakeBlobStorage {
  const stored = new Map<string, { bytes: Uint8Array; contentType: string }>()
  return {
    stored,
    async get(key) {
      return stored.get(key) ?? null
    },
    async put(key, bytes, contentType) {
      stored.set(key, { bytes, contentType })
    },
  }
}

export function fakeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    baseUrl: 'https://punctual.test',
    brandName: 'Punctual',
    supportEmail: 'help@punctual.test',
    fromEmail: 'no-reply@punctual.test',
    fromName: 'Punctual',
    telemetryEnabled: false,
    ...overrides,
  }
}
