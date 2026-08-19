/**
 * D1 schema (spec §9, ADR-0002, ADR-0005).
 *
 * Conventions:
 *  - timestamps are UTC epoch milliseconds in INTEGER columns
 *  - JSON-shaped values are TEXT holding JSON, parsed at the repository edge
 *  - no ORM-level cascades; deletion order is explicit in the repositories
 */

import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull().default(''),
    tz: text('tz').notNull().default('UTC'),
    slug: text('slug').notNull(),
    // Resized avatar thumbnail's R2 key (CCC-543); null until a photo is
    // uploaded. See `core/domain/media.ts` for the key convention.
    avatarKey: text('avatar_key'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email), uniqueIndex('users_slug_idx').on(t.slug)],
)

export const teams = sqliteTable(
  'teams',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // Resized logo thumbnail's R2 key (CCC-543); same convention as `users.avatarKey`.
    logoKey: text('logo_key'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('teams_slug_idx').on(t.slug)],
)

export const teamMembers = sqliteTable(
  'team_members',
  {
    teamId: text('team_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull().default('member'),
    rrWeight: integer('rr_weight').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index('team_members_user_idx').on(t.userId),
  ],
)

export const eventTypes = sqliteTable(
  'event_types',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id'),
    ownerTeamId: text('owner_team_id'),
    schedulingType: text('scheduling_type').notNull().default('personal'),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    durationMinutes: integer('duration_minutes').notNull(),
    slotIntervalMinutes: integer('slot_interval_minutes'),
    bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
    bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),
    minNoticeMinutes: integer('min_notice_minutes').notNull().default(0),
    maxHorizonDays: integer('max_horizon_days').notNull().default(60),
    maxPerDay: integer('max_per_day'),
    locationType: text('location_type').notNull().default('google_meet'),
    locationValue: text('location_value'),
    questionsJson: text('questions_json').notNull().default('[]'),
    active: integer('active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('event_types_owner_user_idx').on(t.ownerUserId),
    index('event_types_owner_team_idx').on(t.ownerTeamId),
    // A slug is unique per owner, not globally: two hosts may both have /30min.
    uniqueIndex('event_types_user_slug_idx').on(t.ownerUserId, t.slug),
    uniqueIndex('event_types_team_slug_idx').on(t.ownerTeamId, t.slug),
  ],
)

export const availabilitySchedules = sqliteTable('availability_schedules', {
  userId: text('user_id').primaryKey(),
  timezone: text('timezone').notNull(),
  weeklyJson: text('weekly_json').notNull(),
  overridesJson: text('overrides_json').notNull().default('[]'),
  updatedAt: integer('updated_at').notNull(),
})

export const calendarConnections = sqliteTable(
  'calendar_connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    provider: text('provider').notNull(),
    providerAccountEmail: text('provider_account_email').notNull().default(''),
    encryptedTokens: text('encrypted_tokens').notNull(),
    // Present from day one so keys can rotate without downtime (ADR-0005 §6).
    keyVersion: integer('key_version').notNull().default(1),
    calendarIdsReadJson: text('calendar_ids_read_json').notNull().default('[]'),
    calendarIdWrite: text('calendar_id_write'),
    syncStatus: text('sync_status').notNull().default('ok'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('calendar_connections_user_idx').on(t.userId)],
)

export const bookings = sqliteTable(
  'bookings',
  {
    id: text('id').primaryKey(),
    eventTypeId: text('event_type_id').notNull(),
    hostUserId: text('host_user_id').notNull(),
    hostUserIdsJson: text('host_user_ids_json').notNull(),
    guestName: text('guest_name').notNull(),
    guestEmail: text('guest_email').notNull(),
    guestTimezone: text('guest_timezone').notNull().default('UTC'),
    startUtc: integer('start_utc').notNull(),
    endUtc: integer('end_utc').notNull(),
    /**
     * The host-local calendar date of the start, `YYYY-MM-DD`, stamped at
     * insert. Denormalised on purpose: the per-day cap is defined on host-local
     * dates (ADR-0004 §3.7), and deriving that in SQL would need timezone data
     * SQLite does not have. Stamping it makes the cap an indexed equality, and
     * pins the date to the timezone in force when the booking was made.
     */
    localDate: text('local_date').notNull().default(''),
    status: text('status').notNull().default('confirmed'),
    answersJson: text('answers_json').notNull().default('{}'),
    externalEventIdsJson: text('external_event_ids_json').notNull().default('{}'),
    rescheduleOf: text('reschedule_of'),
    rescheduledTo: text('rescheduled_to'),
    // Rotated on reschedule so links in superseded emails stop working.
    manageTokenHash: text('manage_token_hash').notNull(),
    cancelledAt: integer('cancelled_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('bookings_host_start_idx').on(t.hostUserId, t.startUtc),
    index('bookings_host_local_date_idx').on(t.hostUserId, t.localDate),
    index('bookings_event_type_idx').on(t.eventTypeId),
    uniqueIndex('bookings_manage_token_idx').on(t.manageTokenHash),
    index('bookings_guest_email_idx').on(t.guestEmail),
  ],
)

/**
 * THE anti-double-booking invariant (ADR-0002 §1).
 *
 * One row per 5-minute bucket per host, covering the booking's BUFFERED
 * footprint. The composite primary key is what makes a double-booking
 * impossible: a conflicting bucket violates it, the enclosing batch() fails,
 * and no partial booking can exist.
 *
 * Range overlap cannot be expressed as a SQL constraint; discretised buckets
 * can. That substitution is the whole design.
 *
 * Verified on production D1, 2026-08-14: a mid-batch constraint
 * violation rolls back every prior statement in the batch.
 */
export const slotLocks = sqliteTable(
  'slot_locks',
  {
    hostUserId: text('host_user_id').notNull(),
    bucketStart: integer('bucket_start').notNull(),
    bookingId: text('booking_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.hostUserId, t.bucketStart] }),
    index('slot_locks_booking_idx').on(t.bookingId),
  ],
)

/**
 * Advisory holds (ADR-0002 §2).
 *
 * `hold_id` is IN the primary key, which is what keeps holds advisory: two
 * holds may cover the same bucket, and a hold can never collide with a
 * slot_locks row, so it suppresses a slot in listings but never blocks a real
 * booking that wins the race.
 *
 * Rows live in D1 rather than DO storage because the slot engine runs in the
 * Worker across many hosts at once and cannot afford a DO round-trip per host
 * merely to learn about holds.
 */
export const slotHolds = sqliteTable(
  'slot_holds',
  {
    hostUserId: text('host_user_id').notNull(),
    bucketStart: integer('bucket_start').notNull(),
    holdId: text('hold_id').notNull(),
    eventTypeId: text('event_type_id').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.hostUserId, t.bucketStart, t.holdId] }),
    index('slot_holds_expiry_idx').on(t.expiresAt),
    index('slot_holds_hold_idx').on(t.holdId),
  ],
)

export const sessions = sqliteTable(
  'sessions',
  {
    // SHA-256 of the cookie value; the raw value is never stored.
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id').notNull(),
    expiresAt: integer('expires_at').notNull(),
    absoluteExpiresAt: integer('absolute_expires_at').notNull(),
    // Last D1 write bookmark, so a host never reads a replica older than their
    // own last edit (ADR-0007 §2).
    bookmark: text('bookmark'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)],
)

export const magicLinkTokens = sqliteTable(
  'magic_link_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    email: text('email').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('magic_link_expiry_idx').on(t.expiresAt)],
)

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    // Stored in the clear so lookup is an indexed hit rather than a table scan.
    prefix: text('prefix').notNull(),
    hashSha256: text('hash_sha256').notNull(),
    name: text('name').notNull().default(''),
    scopesJson: text('scopes_json').notNull().default('[]'),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('api_keys_prefix_idx').on(t.prefix), index('api_keys_user_idx').on(t.userId)],
)

export const webhooks = sqliteTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    eventsJson: text('events_json').notNull().default('[]'),
    active: integer('active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('webhooks_user_idx').on(t.userId)],
)

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    scope: text('scope').notNull(),
    requestHash: text('request_hash').notNull(),
    responseJson: text('response_json').notNull(),
    status: integer('status').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.scope] }),
    index('idempotency_expiry_idx').on(t.expiresAt),
  ],
)

/** Round-robin fairness: when each member was last assigned (ADR-0004 §5). */
export const rrAssignments = sqliteTable(
  'rr_assignments',
  {
    teamId: text('team_id').notNull(),
    userId: text('user_id').notNull(),
    lastAssignedAt: integer('last_assigned_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
)

export const schema = {
  users,
  teams,
  teamMembers,
  eventTypes,
  availabilitySchedules,
  calendarConnections,
  bookings,
  slotLocks,
  slotHolds,
  sessions,
  magicLinkTokens,
  apiKeys,
  webhooks,
  idempotencyKeys,
  rrAssignments,
}

export const CURRENT_TIMESTAMP = sql`(unixepoch() * 1000)`
