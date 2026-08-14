/**
 * Domain types. Pure data — no I/O, no Cloudflare imports (ADR-0003 §5).
 *
 * Time is UTC epoch milliseconds everywhere. Wall-clock time exists only at
 * two edges: interpreting a host's availability schedule, and rendering slots
 * to a guest. Everything between is instants (ADR-0004 §1).
 */

/** Half-open `[start, end)`. Without exception — it is what makes 09:00–09:30 and 09:30–10:00 non-overlapping. */
export interface Interval {
  start: number
  end: number
}

// ---------------------------------------------------------------------------
// Users, teams
// ---------------------------------------------------------------------------

export interface User {
  id: string
  email: string
  name: string
  /** IANA zone. The schedule below is interpreted in it. */
  tz: string
  slug: string
  createdAt: number
}

export interface Team {
  id: string
  name: string
  slug: string
  createdAt: number
}

export type TeamRole = 'owner' | 'admin' | 'member'

export interface TeamMember {
  teamId: string
  userId: string
  role: TeamRole
  /** Round-robin weight; higher gets proportionally more bookings. */
  rrWeight: number
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type LocationType = 'google_meet' | 'custom_link' | 'phone' | 'in_person'
export type SchedulingType = 'personal' | 'round_robin' | 'collective'

export interface EventTypeQuestion {
  id: string
  label: string
  type: 'text' | 'textarea' | 'select'
  required: boolean
  options?: string[]
}

export interface EventType {
  id: string
  ownerUserId: string | null
  ownerTeamId: string | null
  schedulingType: SchedulingType
  slug: string
  title: string
  description: string
  /** Minutes. Must be a multiple of 5 — the bucket grid (ADR-0002 §1). */
  durationMinutes: number
  /** Slot grid step. Defaults to duration when null (ADR-0004 §3.4). */
  slotIntervalMinutes: number | null
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minNoticeMinutes: number
  maxHorizonDays: number
  /** Per host-local calendar date; null means unlimited. */
  maxPerDay: number | null
  locationType: LocationType
  locationValue: string | null
  questions: EventTypeQuestion[]
  active: boolean
  createdAt: number
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Minutes from local midnight. 540 = 09:00. Half-open, like every interval. */
export interface DayWindow {
  startMinute: number
  endMinute: number
}

/** Index 0 = Sunday, matching `Date.getUTCDay()`. */
export type WeeklySchedule = [
  DayWindow[], DayWindow[], DayWindow[], DayWindow[], DayWindow[], DayWindow[], DayWindow[],
]

/** Replaces the whole day's windows, including with none (a day off). */
export interface DateOverride {
  /** `YYYY-MM-DD` in the host's timezone. */
  date: string
  windows: DayWindow[]
}

export interface Availability {
  userId: string
  timezone: string
  weekly: WeeklySchedule
  overrides: DateOverride[]
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export type BookingStatus = 'confirmed' | 'cancelled' | 'rescheduled'

export interface Booking {
  id: string
  eventTypeId: string
  /** The assigned host. For collective, the first of `hostUserIds`. */
  hostUserId: string
  /** Every participating host. One entry unless collective. */
  hostUserIds: string[]
  guestName: string
  guestEmail: string
  guestTimezone: string
  startUtc: number
  endUtc: number
  /**
   * Host-local calendar date of the start, `YYYY-MM-DD`, stamped at creation.
   * The per-day cap is defined on host-local dates (ADR-0004 §3.7), and SQLite
   * has no timezone data to derive it, so it is stored rather than computed.
   */
  localDate: string
  status: BookingStatus
  answers: Record<string, string>
  /** Provider event ids, keyed by connection id, for later update/delete. */
  externalEventIds: Record<string, string>
  rescheduleOf: string | null
  rescheduledTo: string | null
  /** Rotated on reschedule so links in superseded emails die (ADR-0005 §4). */
  manageTokenHash: string
  cancelledAt: number | null
  createdAt: number
}

export interface SlotHold {
  id: string
  eventTypeId: string
  expiresAt: number
  createdAt: number
}

// ---------------------------------------------------------------------------
// Calendar connections
// ---------------------------------------------------------------------------

export type SyncStatus = 'ok' | 'needs_reconnect' | 'error'

export interface CalendarConnection {
  id: string
  userId: string
  provider: 'google' | 'microsoft'
  providerAccountEmail: string
  /** AES-GCM ciphertext; AAD binds userId|provider|connectionId (ADR-0005 §6). */
  encryptedTokens: string
  keyVersion: number
  /** Which calendars count toward busy-ness. */
  calendarIdsRead: string[]
  /** Which calendar bookings are written to; null means do not write. */
  calendarIdWrite: string | null
  syncStatus: SyncStatus
  createdAt: number
}

/** Shape inside `encryptedTokens` once decrypted. Never persisted in the clear. */
export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface Session {
  /** SHA-256 of the cookie value. The raw value is never stored. */
  idHash: string
  userId: string
  expiresAt: number
  absoluteExpiresAt: number
  /** Last D1 write bookmark, so hosts never read a stale replica (ADR-0007 §2). */
  bookmark: string | null
  createdAt: number
}

export interface MagicLinkToken {
  tokenHash: string
  email: string
  expiresAt: number
  createdAt: number
}

export interface ApiKey {
  id: string
  userId: string
  /** Stored in the clear so lookup is indexed rather than a table scan. */
  prefix: string
  hashSha256: string
  name: string
  scopes: string[]
  lastUsedAt: number | null
  createdAt: number
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export type WebhookEvent = 'booking.created' | 'booking.rescheduled' | 'booking.cancelled'

export interface Webhook {
  id: string
  userId: string
  url: string
  secret: string
  events: WebhookEvent[]
  active: boolean
  createdAt: number
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export interface Slot {
  start: number
  end: number
  /**
   * Hosts who can take this slot. One entry for personal and collective
   * (collective requires all, so eligibility is all-or-nothing); for
   * round-robin, everyone eligible — assignment happens at booking time, so
   * listing a slot never reserves a host (ADR-0004 §5).
   */
  eligibleHostIds: string[]
}
