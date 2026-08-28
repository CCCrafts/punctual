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

  const store: { booking: Booking; previous: Booking | null } = { booking, previous: null }
  let claimed = false
  let rotated = false
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
          if (id === store.booking.id) return store.booking
          return store.previous && id === store.previous.id ? store.previous : null
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
        async rotateManageToken() { rotated = true },
        async releaseConfirmationClaim() { claimed = false },
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

  const sync = { kind: 'calendar.sync', bookingId: 'bk_1', action: 'create', manageToken: 'tok_from_coordinator' } as const
  return {
    ports,
    store,
    queued,
    createEvent,
    sync,
    wasRotated: () => rotated,
    setPrevious: (b: Booking) => {
      store.previous = b
    },
    emails: () => queued.filter((m) => m.kind === 'email'),
  }
}

/** A bare harness, only for borrowing its default booking shape. */
function h0() {
  return harness()
}

describe('calendar sync captures the conference link', () => {
  it('persists the link the provider minted', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)
    expect(h.store.booking.conferenceUrl).toBe(MEET)
    expect(h.store.booking.externalEventIds).toEqual({ conn_1: 'evt_1' })
  })

  it('mints ONE room for a booking, whatever number of calendars it is written to', async () => {
    // Caught by review. A collective booking with two writable calendars
    // minted two Meet links: the guest was confidently sent to the first
    // while the second host sat in the other room. Every connection after
    // the first must reuse the room, not create one.
    let minted = 0
    const h = harness({
      connections: [connection(), connection({ id: 'conn_2' })],
      createEvent: async () => {
        minted += 1
        return { id: `evt_${minted}`, conferenceUrl: `https://meet.google.com/room-${minted}` }
      },
    })
    await handleOne(h.sync, h.ports)

    expect(h.createEvent).toHaveBeenCalledTimes(2)
    // Only the FIRST call may ask for a conference.
    const args = h.createEvent.mock.calls.map(
      (c) => (c as unknown[])[1] as { createConference?: boolean; location?: string },
    )
    const asked = args.map((a) => a.createConference)
    expect(asked).toEqual([true, false])
    // And the second event points at the room the first one minted.
    expect(args[1]!.location).toBe('https://meet.google.com/room-1')
    expect(h.store.booking.conferenceUrl).toBe('https://meet.google.com/room-1')
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

  /**
   * Caught by review. The coordinator hands the SAME raw token to the
   * just-booked page, whose "Reschedule or cancel" button embeds it. Rotating
   * the stored hash here killed that button seconds after the guest was shown
   * it — a link dead on arrival in the browser they are still looking at.
   */
  it('does not rotate the manage token the guest is already holding', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)
    expect(h.wasRotated()).toBe(false)
  })

  it('uses the token the coordinator issued, so the emailed link matches the on-screen one', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)
    const body = JSON.stringify(h.emails())
    expect(body).toContain('tok_from_coordinator')
  })

  it('releases the claim when dispatch throws, so a retry can still send', async () => {
    // Claim-before-send is what makes redelivery safe, but without a release
    // any failure after the claim strands the booking as "queued" with
    // nothing ever sent — silent non-delivery, the exact shape this area is
    // meant to be rid of.
    //
    // The failure injected here is a D1 read, because that is what actually
    // propagates. Note the limit of this guard: `notifyBookingCreated`
    // swallows individual `queue.send` failures internally
    // (notify.ts's `.catch`), so a mail provider outage is invisible to the
    // claim and is NOT recovered by it — pre-existing behaviour, worth
    // knowing rather than assuming away.
    const h = harness()
    // `syncCalendar` reads the event type first, then `dispatchConfirmation`
    // reads it again — so failing the SECOND call targets dispatch
    // specifically, after the claim has been taken.
    let calls = 0
    const realRepos = h.ports.repositories
    h.ports.repositories = ((scope) => {
      const repos = realRepos(scope)
      return {
        ...repos,
        eventTypes: {
          async byId(id: string) {
            calls += 1
            if (calls === 2) throw new Error('D1 unavailable')
            return repos.eventTypes.byId(id)
          },
        },
      }
    }) as typeof h.ports.repositories

    // Rethrows, so `handleQueueBatch` retries the message rather than acking
    // it — releasing the claim without rethrowing would have left the
    // confirmation lost exactly as silently as before.
    await expect(handleOne(h.sync, h.ports)).rejects.toThrow('D1 unavailable')
    expect(h.emails()).toHaveLength(0)

    // The retry finds the claim released and sends for real.
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBeGreaterThan(0)
  })

  /**
   * The reschedule guard vs the inline (no-TASKS) queue path.
   *
   * Inline, `queue.send` runs the handler synchronously inside
   * `coordinator.book` — i.e. BEFORE the route calls `markRescheduled`. So
   * the first pass legitimately sees `rescheduledTo` unset and must decline
   * to mail, and the route's second pass (fired after the mark lands) is what
   * actually notifies. Getting only the first half of that shipped meant no
   * reschedule email at all on the free tier.
   */
  it('declines to mail a replacement until the reschedule has actually landed', async () => {
    const previous: Booking = { ...h0().store.booking, id: 'bk_old', rescheduledTo: null }
    const h = harness({ bookingPatch: { id: 'bk_1', rescheduleOf: 'bk_old' } })
    h.setPrevious(previous)

    await handleOne(h.sync, h.ports)
    expect(h.emails()).toHaveLength(0)

    // The route marks the move, then enqueues the replacement's create-sync
    // — one message, ordered after the mark, so it both writes the calendar
    // and mails with the link it just captured.
    h.setPrevious({ ...previous, rescheduledTo: 'bk_1' })
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBeGreaterThan(0)
  })

  it('a failure before the claim never clears someone else\'s claim', async () => {
    // Including the claim the migration backfilled for a booking the OLD code
    // path already confirmed — clearing that would send the guest a second
    // confirmation for a meeting they already know about.
    const h = harness()
    let alreadyClaimed = true
    const realRepos = h.ports.repositories
    let released = false
    h.ports.repositories = ((scope) => {
      const repos = realRepos(scope)
      return {
        ...repos,
        bookings: {
          ...repos.bookings,
          async byId() {
            throw new Error('D1 unavailable')
          },
          async claimConfirmation() {
            return !alreadyClaimed
          },
          async releaseConfirmationClaim() {
            released = true
          },
        },
      }
    }) as typeof h.ports.repositories

    await expect(
      handleOne(h.sync, h.ports),
    ).rejects.toThrow('D1 unavailable')
    expect(released).toBe(false)
    expect(alreadyClaimed).toBe(true)
  })

  it('does not dispatch for a booking that is no longer confirmed', async () => {
    const h = harness({ bookingPatch: { status: 'cancelled' } })
    await handleOne(h.sync, h.ports)
    expect(h.emails()).toHaveLength(0)
  })
})
