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

  /** Counts for the opt-in telemetry ping (ADR-0006 §5). Nothing identifying. */
  telemetryCounts(): Promise<{ users: number; eventTypes: number; bookings: number }>

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
  /**
   * @returns false if `patch.slug` collided with another row's unique slug —
   * the caller's own read-then-write check (against users AND teams) closes
   * most of that window, but not a concurrent write racing the same check.
   * True for any other patch, including one that changes nothing.
   */
  update(
    id: string,
    patch: Partial<Pick<User, 'name' | 'tz' | 'slug' | 'avatarKey' | 'company' | 'jobTitle'>>,
  ): Promise<boolean>
}

export interface EventTypeRepository {
  byId(id: string): Promise<EventType | null>
  bySlug(ownerSlug: string, eventSlug: string): Promise<EventType | null>
  /**
   * Host and event type in ONE round trip.
   *
   * Measured on the deployed Worker (2026-08-14): the edge alone answers in
   * ~100 ms, while the booking page took ~380 ms because it made six
   * sequential D1 calls at ~40 ms each. Round-trip COUNT dominates replica
   * distance, so the page's first two lookups are collapsed here rather than
   * being two awaits that read nicely.
   */
  bookingPageContext(
    ownerSlug: string,
    eventSlug: string,
  ): Promise<{ host: User; eventType: EventType } | null>
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
  /**
   * Confirmed bookings whose `start_utc` falls in `range` — the caller
   * resolves a host-local calendar day to a UTC range (`dayRange`) before
   * calling this, because only the caller knows which host's timezone that
   * day is meant in. NOT a match against the stored `local_date` column:
   * that column is stamped once, in a collective booking's PRIMARY host's
   * timezone, so string-matching it for a non-primary host can miss rows
   * near a timezone boundary and undercount their cap.
   */
  countForHostOnDate(hostUserId: string, range: Interval): Promise<number>

  /**
   * The atomic write (ADR-0002 §1). The booking row and one `slot_locks` row
   * per 5-minute bucket per host go into a single `D1Database::batch()`. A
   * conflicting bucket violates the primary key and the whole batch fails, so
   * a partial booking cannot exist.
   *
   * Verified against production D1 on 2026-08-14: a constraint
   * violation mid-batch rolls back every prior statement.
   *
   * @returns the booking on success; `null` when a bucket was already taken —
   *          the caller turns that into a 409, never a retry loop.
   */
  createWithLocks(booking: Booking, buckets: BucketClaim[]): Promise<Booking | null>

  /**
   * Confirmed bookings starting in `[from, to)`, across ALL hosts.
   *
   * Reminders need a cross-host query, which is precisely why bookings live in
   * D1 rather than in per-host DO storage (ADR-0002 §2).
   */
  dueBetween(from: number, to: number): Promise<Booking[]>

  /** @returns false if the booking was no longer `confirmed` — a concurrent cancel/reschedule won the race. */
  cancelWithLockRelease(bookingId: string, at: number): Promise<boolean>
  /** @returns false if the booking was no longer `confirmed` — the caller must roll back the new booking it just created. */
  markRescheduled(bookingId: string, newBookingId: string): Promise<boolean>
  rotateManageToken(bookingId: string, tokenHash: string): Promise<void>

  /**
   * Record the provider event ids created for a booking.
   *
   * Without these, reschedule and cancel have nothing to update or delete, so
   * a cancelled meeting stays on the host's real calendar forever.
   */
  setExternalEventIds(bookingId: string, ids: Record<string, string>): Promise<void>
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
  /**
   * `excludeHoldId` omits the caller's own hold from the result — without it,
   * a guest who holds a slot and then confirms it sees their own advisory
   * hold reported back as busy, and the commit-time re-check rejects the
   * booking the hold was placed to protect.
   */
  activeHolds(
    hostUserIds: string[],
    range: Interval,
    now: number,
    excludeHoldId?: string,
  ): Promise<Map<string, number[]>>
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
  /**
   * Advance the rotation after a round-robin booking commits.
   *
   * Without this `lastAssignedAt` is always empty, every candidate scores the
   * same, and the lowest-sorted host id wins forever — a waterfall, which is
   * the opposite of what ADR-0004 §5 specifies.
   */
  recordAssignment(teamId: string, userId: string, at: number): Promise<void>
  /**
   * Rewrite only the logo key — never name or slug. No dashboard
   * route calls this yet: team self-service management (creating a team,
   * renaming it) has no UI at all today, so wiring a logo-upload page ahead
   * of it would have nowhere real to live. The method exists now, tested,
   * so the next team-settings ticket is schema-and-port-complete already.
   */
  updateLogo(teamId: string, logoKey: string | null): Promise<void>
}

export interface CalendarConnectionRepository {
  byId(id: string): Promise<CalendarConnection | null>
  listForUser(userId: string): Promise<CalendarConnection[]>
  create(conn: CalendarConnection): Promise<CalendarConnection>
  updateTokens(id: string, encryptedTokens: string, keyVersion: number): Promise<void>
  updateSyncStatus(id: string, status: CalendarConnection['syncStatus']): Promise<void>
  /**
   * Rewrite only the calendar selection — never tokens, key version, sync
   * status or provider account email. A single `UPDATE`, not delete+create,
   * so a failure mid-write cannot destroy the row (which would force a full
   * OAuth reconnect) or drop key-rotation continuity for the encrypted
   * tokens.
   */
  updateCalendars(id: string, patch: { read: string[]; write: string | null }): Promise<void>
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
  /**
   * Atomically claim a (key, scope) pair before doing the work it guards.
   *
   * `get`-then-work-then-`put` is a race: two requests with the same
   * idempotency key can both read "nothing yet" and both go on to create a
   * real booking. `reserve` is the compare-and-swap that closes that window —
   * only the caller that wins gets `reserved: true`; the loser gets back
   * whatever is already stored (a placeholder mid-flight, or a finished
   * response to replay) and must not do the work itself.
   */
  reserve(
    record: StoredIdempotentResponse,
  ): Promise<{ reserved: true } | { reserved: false; existing: StoredIdempotentResponse }>
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

/**
 * Non-authoritative BINARY derived content — currently only rendered OG card
 * PNGs (CCC-496). Same trust category as `Cache` above (advisory, staleness
 * of an hour is fine, never a source of truth) and the same physical KV
 * namespace in the default adapter, but a separate port because the values
 * are raw bytes, not JSON: round-tripping a PNG through `Cache.put` would
 * JSON-encode it byte-by-byte, several times the size for no reason.
 *
 * Still bound by ADR-0006 §1's actual rule: bookings and holds never go
 * through KV in any form. This port cannot be given booking data, but it
 * exists precisely because "freeBusy only" was never about banning KV from
 * holding a SECOND kind of disposable, re-derivable content.
 */
export interface BlobCache {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array, ttlSeconds: number): Promise<void>
}

/**
 * User-uploaded binary content: host avatars and team logos.
 * Deliberately a THIRD storage port, not a reuse of `Cache` or `BlobCache`
 * above, because the trust category is different from both:
 *
 *  - Not `Cache` — not JSON, and not re-derivable from anything else the
 *    engine has.
 *  - Not `BlobCache` — not ephemeral or advisory. A host's uploaded photo is
 *    authoritative content with no TTL; losing it is a real loss, the same
 *    way losing a booking row would be, even though (unlike a booking) it
 *    carries no freshness requirement and is fine to read from KV-speed
 *    storage.
 *
 * Backed by R2 in the default adapter — durable object storage, not the KV
 * namespace `Cache`/`BlobCache` share, and not gated behind a paid plan
 * (R2's free tier is part of the same "$0 to start" pledge as D1 and KV).
 * Keys are content-addressed (`core/domain/media.ts`), so `put` is naturally
 * idempotent and needs no separate existence check to avoid duplicate writes.
 */
export interface BlobStorage {
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
  put(key: string, value: Uint8Array, contentType: string): Promise<void>
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
  /**
   * `manageToken` is the RAW signed token, returned exactly once so the
   * confirmation page and email can link to it. Only its hash is stored.
   *
   * Absent on an idempotent replay: the original raw token was never kept, so
   * a retry can confirm the booking exists but cannot re-issue its link.
   */
  | { ok: true; booking: Booking; manageToken?: string }
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
  /**
   * The legal entity operating this deployment, named on /privacy and /terms
   * as the data controller. Defaults to `brandName` when unset — correct for
   * nobody in particular, which is the point: a self-hoster who deploys the
   * public engine without setting this gets an honest "we didn't ask you who
   * you are" default instead of another operator's company name.
   */
  legalOperator?: string
  /**
   * A real, live booking page on THIS deployment, e.g. `/serge/30min` —
   * shown on the landing page as "see a booking page" and embedded live in
   * the hero. Unset by default: a fresh deployment (self-hosted or a first
   * boot) has no host/event type seeded yet, and a hardcoded path here would
   * make every such deployment's own homepage embed a 404ing iframe.
   */
  demoBookingPath?: string
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
  blobCache: BlobCache
  blobStorage: BlobStorage
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
