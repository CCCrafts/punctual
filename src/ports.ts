/**
 * The engine's ports (ADR-0003).
 *
 * Every capability the engine needs arrives through this interface. Nothing in
 * the engine reaches for a global binding — a direct `env.DB` reference in core
 * or the services is a review-blocking defect, because it is exactly what makes
 * the cloud control-plane unable to inject its own tenant-scoped implementation.
 *
 * Note what is deliberately absent: there is no `Limits` or `PolicyGate` port.
 * Putting the mechanism of gating into publicly readable MIT code would make
 * the pledge read as conditional no matter how the default is set. The
 * control-plane enforces its limits in its own layer, before calling the
 * engine. See ADR-0003 §4.
 */

import type {
  ApiKey,
  Availability,
  Booking,
  BookingStatus,
  CalendarConnection,
  EventType,
  Interval,
  MagicLinkToken,
  Session,
  SlotHold,
  Team,
  TeamMember,
  User,
  Webhook,
} from './core/domain/types.js'

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/**
 * Persistence. Methods take NO tenant_id: the engine is single-tenant by
 * construction, because for self-hosters it is. The cloud control-plane
 * supplies an implementation that closes over the tenant resolved from the
 * request host, so the engine has no vocabulary for a cross-tenant query.
 *
 * Constructed per request and closing over a D1 session (ADR-0007 §1), which
 * is why read locality is a property of the adapter rather than of call sites.
 */
export interface Repositories {
  users: UserRepository
  eventTypes: EventTypeRepository
  availability: AvailabilityRepository
  bookings: BookingRepository
  slotLocks: SlotLockRepository
  teams: TeamRepository
  connections: CalendarConnectionRepository
  sessions: SessionRepository
  apiKeys: ApiKeyRepository
  webhooks: WebhookRepository
  idempotency: IdempotencyRepository

  /**
   * The bookmark for this session's most recent write (ADR-0007 §2).
   * Persisted on the host's session row so a host never reads a replica older
   * than their own last edit. Null when nothing was written.
   */
  bookmark(): string | null
}

export interface UserRepository {
  byId(id: string): Promise<User | null>
  byEmail(email: string): Promise<User | null>
  bySlug(slug: string): Promise<User | null>
  create(user: Omit<User, 'createdAt'>): Promise<User>
  update(id: string, patch: Partial<Pick<User, 'name' | 'tz' | 'slug'>>): Promise<void>
}

export interface EventTypeRepository {
  byId(id: string): Promise<EventType | null>
  bySlug(ownerSlug: string, eventSlug: string): Promise<EventType | null>
  listForUser(userId: string): Promise<EventType[]>
  listForTeam(teamId: string): Promise<EventType[]>
  create(et: Omit<EventType, 'createdAt'>): Promise<EventType>
  update(id: string, patch: Partial<EventType>): Promise<void>
  delete(id: string): Promise<void>
}

export interface AvailabilityRepository {
  forUser(userId: string): Promise<Availability | null>
  save(userId: string, availability: Availability): Promise<void>
}

export interface BookingRepository {
  byId(id: string): Promise<Booking | null>
  byManageToken(tokenHash: string): Promise<Booking | null>
  listForHost(hostUserId: string, range: Interval): Promise<Booking[]>
  countForHostOnDate(hostUserId: string, localDate: string): Promise<number>

  /**
   * The atomic write (ADR-0002 §1). The booking row and one `slot_locks` row
   * per 5-minute bucket per host go into a single `D1Database::batch()`. A
   * conflicting bucket violates the primary key and the whole batch fails, so
   * a partial booking cannot exist.
   *
   * Verified against production D1 on 2026-08-14 (CCC-469): a constraint
   * violation mid-batch rolls back every prior statement.
   *
   * @returns the booking on success; `null` when a bucket was already taken —
   *          the caller turns that into a 409, never a retry loop.
   */
  createWithLocks(booking: Booking, buckets: BucketClaim[]): Promise<Booking | null>

  cancelWithLockRelease(bookingId: string, at: number): Promise<void>
  markRescheduled(bookingId: string, newBookingId: string): Promise<void>
  rotateManageToken(bookingId: string, tokenHash: string): Promise<void>
}

/** One 5-minute bucket claimed by a booking, for one host. */
export interface BucketClaim {
  hostUserId: string
  bucketStart: number
}

export interface SlotLockRepository {
  /** Buffered busy intervals from confirmed bookings. Pre-expanded by construction. */
  busyBuckets(hostUserIds: string[], range: Interval): Promise<Map<string, number[]>>
  /** Active advisory holds (`expires_at > now`), which suppress but never block. */
  activeHolds(hostUserIds: string[], range: Interval, now: number): Promise<Map<string, number[]>>
  createHold(hold: SlotHold, buckets: BucketClaim[]): Promise<boolean>
  releaseHold(holdId: string): Promise<void>
  expireHolds(before: number): Promise<number>
  pruneLocksBefore(cutoff: number): Promise<number>
}

export interface TeamRepository {
  byId(id: string): Promise<Team | null>
  bySlug(slug: string): Promise<Team | null>
  members(teamId: string): Promise<TeamMember[]>
  memberships(userId: string): Promise<TeamMember[]>
  create(team: Omit<Team, 'createdAt'>): Promise<Team>
  addMember(member: TeamMember): Promise<void>
  removeMember(teamId: string, userId: string): Promise<void>
  /** Round-robin tie-break: last booking time per member (ADR-0004 §5). */
  lastAssignedAt(teamId: string, userIds: string[]): Promise<Map<string, number>>
}

export interface CalendarConnectionRepository {
  byId(id: string): Promise<CalendarConnection | null>
  listForUser(userId: string): Promise<CalendarConnection[]>
  create(conn: CalendarConnection): Promise<CalendarConnection>
  updateTokens(id: string, encryptedTokens: string, keyVersion: number): Promise<void>
  updateSyncStatus(id: string, status: CalendarConnection['syncStatus']): Promise<void>
  delete(id: string): Promise<void>
}

export interface SessionRepository {
  byIdHash(idHash: string): Promise<Session | null>
  create(session: Session): Promise<void>
  touch(idHash: string, expiresAt: number, bookmark: string | null): Promise<void>
  delete(idHash: string): Promise<void>
  deleteAllForUser(userId: string): Promise<void>
  createMagicLink(token: MagicLinkToken): Promise<void>
  /** Single-use by construction: an atomic conditional delete. A replay finds nothing. */
  consumeMagicLink(tokenHash: string, now: number): Promise<MagicLinkToken | null>
}

export interface ApiKeyRepository {
  byPrefix(prefix: string): Promise<ApiKey | null>
  listForUser(userId: string): Promise<ApiKey[]>
  create(key: ApiKey): Promise<void>
  delete(id: string): Promise<void>
  touchLastUsed(id: string, at: number): Promise<void>
}

export interface WebhookRepository {
  listForUser(userId: string): Promise<Webhook[]>
  byId(id: string): Promise<Webhook | null>
  create(webhook: Webhook): Promise<void>
  delete(id: string): Promise<void>
}

export interface IdempotencyRepository {
  get(key: string, scope: string): Promise<StoredIdempotentResponse | null>
  put(record: StoredIdempotentResponse): Promise<void>
}

export interface StoredIdempotentResponse {
  key: string
  scope: string
  requestHash: string
  responseJson: string
  status: number
  expiresAt: number
}

// ---------------------------------------------------------------------------
// Calendar providers
// ---------------------------------------------------------------------------

export type CalendarProviderName = 'google' | 'microsoft'

export interface CalendarProvider {
  readonly name: CalendarProviderName
  /** Raw busy intervals, never buffer-expanded — buffers belong to the slot engine. */
  getBusy(conn: CalendarConnection, range: Interval): Promise<Interval[]>
  createEvent(conn: CalendarConnection, event: ExternalEvent): Promise<string>
  updateEvent(conn: CalendarConnection, externalId: string, event: ExternalEvent): Promise<void>
  deleteEvent(conn: CalendarConnection, externalId: string): Promise<void>
  listCalendars(conn: CalendarConnection): Promise<Array<{ id: string; name: string; primary: boolean }>>
}

export interface ExternalEvent {
  title: string
  description: string
  start: number
  end: number
  attendees: Array<{ email: string; name?: string }>
  location?: string
  /** Ask the provider to mint a conference link (Google Meet). */
  createConference?: boolean
  timezone: string
}

export interface CalendarProviders {
  get(name: CalendarProviderName): CalendarProvider
  available(): CalendarProviderName[]
}

// ---------------------------------------------------------------------------
// OAuth credentials
// ---------------------------------------------------------------------------

/**
 * Where OAuth client credentials come from. In OSS, environment variables —
 * the self-hoster brings their own app. In cloud, our verified applications.
 * Identity and calendar are separate scopes for the same client (ADR-0005 §1).
 */
export interface OAuthCredentials {
  forProvider(name: CalendarProviderName): { clientId: string; clientSecret: string } | null
  redirectUri(name: CalendarProviderName, purpose: 'identity' | 'calendar'): string
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

export interface EmailMessage {
  to: string
  toName?: string
  subject: string
  html: string
  text: string
  attachments?: Array<{ filename: string; content: string; contentType: string }>
  replyTo?: string
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

/**
 * AES-GCM for refresh tokens at rest, HMAC for signed links (ADR-0005 §4, §6).
 * `keyVersion` travels with every ciphertext so keys rotate by
 * decrypt-with-old/encrypt-with-new without downtime — which only works
 * because the column exists from day one.
 */
export interface Crypto {
  encrypt(plaintext: string, aad: string): Promise<{ ciphertext: string; keyVersion: number }>
  decrypt(ciphertext: string, aad: string, keyVersion: number): Promise<string>
  sign(payload: string): Promise<string>
  verify(payload: string, signature: string): Promise<boolean>
  randomToken(bytes?: number): string
  hash(value: string): Promise<string>
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * External-calendar freeBusy only (ADR-0006 §1). Own bookings and holds are
 * always read from D1, because those are the writes users notice immediately.
 * KV propagates in "up to 60 seconds or more", so it can never be authoritative.
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>
  put<T>(key: string, value: T, ttlSeconds: number): Promise<void>
  delete(key: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** A port purely so the ADR-0004 DST matrix can freeze time without globals. */
export interface Clock {
  now(): number
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface QueuePort {
  send(message: QueueMessage): Promise<void>
  sendBatch(messages: QueueMessage[]): Promise<void>
}

export type QueueMessage =
  | { kind: 'email'; message: EmailMessage }
  | { kind: 'webhook'; webhookId: string; event: string; payload: unknown; attempt: number }
  | { kind: 'calendar.sync'; bookingId: string; action: 'create' | 'update' | 'delete' }

// ---------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------

/**
 * The per-host serialisation point (ADR-0002 §2). This is the FAST path, not
 * the guarantee: if it misbehaves the worst outcome is a wasted API call or a
 * 409, because `slot_locks` is what actually protects the calendar.
 */
export interface HostCoordinator {
  book(hostUserId: string, request: BookingAttempt): Promise<BookingOutcome>
  hold(hostUserId: string, request: HoldRequest): Promise<{ holdId: string; expiresAt: number } | null>
  releaseHold(hostUserId: string, holdId: string): Promise<void>
  /** Collective bookings acquire in ascending host id order — ordering is what makes deadlock impossible. */
  lease(hostUserIds: string[], ttlMs: number): Promise<{ leaseId: string } | null>
  releaseLease(hostUserIds: string[], leaseId: string): Promise<void>
}

export interface HoldRequest {
  eventTypeId: string
  /**
   * For round-robin this is the provisional pick, not a commitment: an
   * abandoned form must not skew the rotation, so assignment still re-runs at
   * commit (ADR-0004 §5).
   */
  hostUserIds: string[]
  start: number
  end: number
  ttlMs: number
}

export interface BookingAttempt {
  eventTypeId: string
  hostUserIds: string[]
  start: number
  end: number
  guestName: string
  guestEmail: string
  guestTimezone: string
  answers: Record<string, string>
  idempotencyKey?: string
  holdId?: string
  rescheduleOf?: string
}

export type BookingOutcome =
  | { ok: true; booking: Booking }
  | { ok: false; reason: 'slot_taken' | 'outside_availability' | 'policy' | 'lease_failed'; detail?: string }

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Abuse limits, not plan quotas (ADR-0006 §3). Uniform for every deployment,
 * generous enough that no legitimate team meets them, and raisable by the
 * operator who owns the deployment. That is what keeps this from being the
 * gating port ADR-0003 §4 refuses.
 */
export interface RateLimiter {
  check(scope: string, identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult>
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EngineConfig {
  /** Public origin, e.g. https://punctual.io — used in links and .ics URLs. */
  baseUrl: string
  brandName: string
  supportEmail: string
  fromEmail: string
  fromName: string
  /** Off unless explicitly enabled (ADR-0006 §5). */
  telemetryEnabled: boolean
  /** Abuse-limit overrides; operator-tunable. */
  rateLimits?: Partial<Record<string, { limit: number; windowSeconds: number }>>
}

// ---------------------------------------------------------------------------
// The composition root's input
// ---------------------------------------------------------------------------

export interface EnginePorts {
  /** Per-request, because the D1 session is per-request (ADR-0007 §1). */
  repositories: (ctx: RequestScope) => Repositories
  calendars: CalendarProviders
  oauth: OAuthCredentials
  email: EmailSender
  crypto: Crypto
  cache: Cache
  clock: Clock
  queue: QueuePort
  coordinator: HostCoordinator
  rateLimiter: RateLimiter
  config: EngineConfig
}

/**
 * What the adapter needs to pick a consistency mode (ADR-0007 §2).
 *
 * `unconstrained` — the public booking page. Reads the nearest replica and
 * accepts its freshness, because `slot_locks` plus the DO re-check arbitrate at
 * commit, so staleness degrades to a 409 rather than a wrong calendar. This is
 * the surface whose latency IS the product claim.
 *
 * `bookmark` — the host dashboard and the commit path. A host must never read
 * a replica older than their own last write.
 */
export interface RequestScope {
  consistency: 'unconstrained' | 'bookmark'
  bookmark?: string | null
}
