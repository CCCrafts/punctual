/**
 * The calendar-sync handler, which now owns confirmation dispatch (CCC-647).
 *
 * `syncCalendar` had NO test coverage at all before this. That was tolerable
 * while it only wrote calendar events; it is not now that a guest's
 * confirmation email — and the meeting link inside it — depends on this code
 * path running and reaching its end.
 *
 * The properties worth pinning are the ones that were argued about while
 * designing the move:
 *   - the link the provider minted is captured and persisted
 *   - the confirmation is dispatched exactly once, even though Queues is
 *     at-least-once and redelivers this very handler
 *   - a calendar outage delays nothing: dispatch still happens when every
 *     connection throws, and when the host has no writable connection at all
 */

import { describe, expect, it, vi } from 'vitest'
import type { Booking, CalendarConnection, EventType, User } from '../../src/core/domain/types.js'
import type { EnginePorts, QueueMessage } from '../../src/ports.js'
import { handleOne } from '../../src/adapters/queue/consumer.js'

const MEET = 'https://meet.google.com/abc-defg-hij'

const host: User = {
  id: 'u_host',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  tz: 'UTC',
  slug: 'grace',
  avatarKey: null,
  company: null,
  jobTitle: null,
  companyUrl: null,
  role: 'member',
  createdAt: 0,
}

const eventType: EventType = {
  id: 'et_1',
  ownerUserId: 'u_host',
  ownerTeamId: null,
  schedulingType: 'personal',
  slug: 'intro',
  title: 'Intro call',
  description: '',
  durationMinutes: 30,
  slotIntervalMinutes: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxHorizonDays: 60,
  maxPerDay: null,
  locationType: 'google_meet',
  locationValue: null,
  questions: [],
  active: true,
  createdAt: 0,
  scheduleId: null,
}

function connection(over: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 'conn_1',
    userId: 'u_host',
    provider: 'google',
    providerAccountEmail: 'grace@example.com',
    encryptedTokens: 'x',
    keyVersion: 1,
    calendarIdsRead: ['primary'],
    calendarIdWrite: 'primary',
    syncStatus: 'ok',
    createdAt: 0,
    ...over,
  }
}

interface HarnessOptions {
  connections?: CalendarConnection[]
  createEvent?: () => Promise<{ id: string; conferenceUrl?: string }>
  bookingPatch?: Partial<Booking>
}

/**
 * Only the ports this handler touches. Anything else throws rather than
 * returning a plausible empty value, matching `testing/fakes.ts`'s rule that
 * a silently-succeeding stub turns a real bug into a passing test.
 */
function harness(opts: HarnessOptions = {}) {
  const booking: Booking = {
    id: 'bk_1',
    eventTypeId: 'et_1',
    hostUserId: 'u_host',
    hostUserIds: ['u_host'],
    guestName: 'Ada',
    guestEmail: 'ada@example.com',
    guestTimezone: 'UTC',
    startUtc: Date.UTC(2026, 8, 10, 9, 0),
    endUtc: Date.UTC(2026, 8, 10, 9, 30),
    localDate: '2026-09-10',
    status: 'confirmed',
    answers: {},
    externalEventIds: {},
    conferenceUrl: null,
    rescheduleOf: null,
    rescheduledTo: null,
    manageTokenHash: 'hash',
    cancelledAt: null,
    createdAt: Date.UTC(2026, 8, 1),
    ...opts.bookingPatch,
  }

  const store = { booking }
  let claimed = false
  const queued: QueueMessage[] = []

  const createEvent = vi.fn(opts.createEvent ?? (async () => ({ id: 'evt_1', conferenceUrl: MEET })))

  const ports = {
    clock: { now: () => Date.UTC(2026, 8, 1) },
    crypto: { randomToken: (n = 16) => 'r'.repeat(n), hash: async (v: string) => `h:${v}`, sign: async () => 'sig' },
    config: { baseUrl: 'https://punctual.test', brandName: 'Punctual', supportEmail: 'help@punctual.test' },
    calendars: { get: () => ({ createEvent, updateEvent: vi.fn(), deleteEvent: vi.fn() }) },
    queue: { send: async (m: QueueMessage) => void queued.push(m) },
    repositories: () => ({
      bookings: {
        async byId(id: string) {
          return id === store.booking.id ? store.booking : null
        },
        async setSyncResult(_id: string, ids: Record<string, string>, conferenceUrl: string | null) {
          store.booking = { ...store.booking, externalEventIds: ids, conferenceUrl }
        },
        async setExternalEventIds(_id: string, ids: Record<string, string>) {
          store.booking = { ...store.booking, externalEventIds: ids }
        },
        async claimConfirmation() {
          if (claimed) return false
          claimed = true
          return true
        },
        async rotateManageToken() {},
      },
      eventTypes: { async byId() { return eventType } },
      users: { async byId() { return host } },
      connections: {
        async listForUser() { return opts.connections ?? [connection()] },
        async updateSyncStatus() {},
      },
      webhooks: { async listForUser() { return [] } },
    }),
  } as unknown as EnginePorts

  const sync = { kind: 'calendar.sync', bookingId: 'bk_1', action: 'create' } as const
  return { ports, store, queued, createEvent, sync, emails: () => queued.filter((m) => m.kind === 'email') }
}

describe('calendar sync captures the conference link', () => {
  it('persists the link the provider minted', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)
    expect(h.store.booking.conferenceUrl).toBe(MEET)
    expect(h.store.booking.externalEventIds).toEqual({ conn_1: 'evt_1' })
  })

  it('leaves it null when the provider minted none', async () => {
    const h = harness({ createEvent: async () => ({ id: 'evt_1' }) })
    await handleOne(h.sync, h.ports)
    expect(h.store.booking.conferenceUrl).toBeNull()
  })
})

describe('confirmation dispatch', () => {
  it('sends the confirmation once the link is known', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBeGreaterThan(0)
  })

  it('sends exactly once across a redelivery of the same message', async () => {
    // Queues is at-least-once and retries THIS handler. Without the
    // claim, the guest gets a second confirmation for one booking.
    const h = harness()
    await handleOne(h.sync, h.ports)
    const afterFirst = h.emails().length
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBe(afterFirst)
  })

  it('still dispatches when the host has no writable connection', async () => {
    // Nothing to sync at all — the loop body never runs. The guest must
    // still be told their meeting is confirmed.
    const h = harness({ connections: [] })
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBeGreaterThan(0)
    expect(h.store.booking.conferenceUrl).toBeNull()
  })

  it('still dispatches when every calendar write throws', async () => {
    // A calendar outage must not become an email outage — the whole reason
    // dispatch sits after the per-connection catch rather than depending on
    // the sync succeeding.
    const h = harness({
      createEvent: async () => {
        throw new Error('google is down')
      },
    })
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBeGreaterThan(0)
  })

  it('does not dispatch for a booking that is no longer confirmed', async () => {
    const h = harness({ bookingPatch: { status: 'cancelled' } })
    await handleOne(h.sync, h.ports)
    expect(h.emails()).toHaveLength(0)
  })
})
