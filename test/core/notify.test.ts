import { describe, expect, it } from 'vitest'
import type { Booking, EventType, User } from '../../src/core/domain/types.js'
import { notifyBookingCancelled } from '../../src/adapters/notify.js'
import type { EnginePorts, QueueMessage } from '../../src/ports.js'

/**
 * Regression coverage for the reschedule/cancel .ics collision: a booking
 * that a reschedule has SUPERSEDED (`rescheduledTo` set) must never get a
 * CANCEL .ics attached to its cancellation email, because that CANCEL would
 * share a UID with the replacement's REQUEST and the two SEQUENCE numbers
 * cannot be made to reliably agree on which one is stale — see the design
 * note on `icsCancelSuppressed` in src/core/ics.ts.
 *
 * These tests exercise `notifyBookingCancelled` itself (not just the pure
 * `ics.ts` helpers) so a future call site that starts invoking it on a
 * superseded booking is caught here, not just in the primitives.
 */

const START = Date.UTC(2026, 7, 14, 9, 0, 0)

const host: User = {
  id: 'u_host',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  tz: 'America/New_York',
  slug: 'grace',
  createdAt: 0,
}

function eventType(patch: Partial<EventType> = {}): EventType {
  return {
    id: 'et_1',
    ownerUserId: 'u_host',
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: 'intro',
    title: 'Intro call',
    description: 'A short chat.',
    durationMinutes: 30,
    slotIntervalMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 60,
    maxHorizonDays: 60,
    maxPerDay: null,
    locationType: 'google_meet',
    locationValue: null,
    questions: [],
    active: true,
    createdAt: 0,
    ...patch,
  }
}

function booking(patch: Partial<Booking> = {}): Booking {
  return {
    id: 'bk_1',
    eventTypeId: 'et_1',
    hostUserId: 'u_host',
    hostUserIds: ['u_host'],
    guestName: 'Ada Lovelace',
    guestEmail: 'ada@example.com',
    guestTimezone: 'Europe/Kyiv',
    startUtc: START,
    endUtc: START + 30 * 60_000,
    localDate: '2026-08-14',
    status: 'confirmed',
    answers: {},
    externalEventIds: {},
    rescheduleOf: null,
    rescheduledTo: null,
    manageTokenHash: 'hash',
    cancelledAt: null,
    createdAt: Date.UTC(2026, 7, 10, 12, 0, 0),
    ...patch,
  }
}

/** Only what `notifyBookingCancelled` actually touches. */
function fakePorts(sent: QueueMessage[]): EnginePorts {
  return {
    repositories: () =>
      ({
        webhooks: { listForUser: async () => [] },
        bookings: { byId: async () => null },
      }) as unknown as ReturnType<EnginePorts['repositories']>,
    queue: {
      send: async (message: QueueMessage) => {
        sent.push(message)
      },
      sendBatch: async (messages: QueueMessage[]) => {
        sent.push(...messages)
      },
    },
    config: {
      baseUrl: 'https://punctual.example',
      brandName: 'Punctual',
      supportEmail: 'help@punctual.example',
      fromEmail: 'noreply@punctual.example',
      fromName: 'Punctual',
      telemetryEnabled: false,
    },
  } as unknown as EnginePorts
}

function emailAttachments(sent: QueueMessage[]): Array<
  Array<{ filename: string; content: string; contentType: string }> | undefined
> {
  return sent
    .filter((m): m is Extract<QueueMessage, { kind: 'email' }> => m.kind === 'email')
    .map((m) => m.message.attachments)
}

describe('notifyBookingCancelled — CANCEL suppressed for a superseded leg', () => {
  it('attaches no .ics when the cancelled booking has been superseded by a reschedule', async () => {
    const sent: QueueMessage[] = []
    const superseded = booking({
      status: 'cancelled',
      rescheduledTo: 'bk_2',
      cancelledAt: START,
    })

    await notifyBookingCancelled({
      ports: fakePorts(sent),
      booking: superseded,
      eventType: eventType(),
      host,
      cancelledBy: 'guest',
    })

    const attachments = emailAttachments(sent)
    expect(attachments).toHaveLength(2) // guest + host
    for (const a of attachments) expect(a).toBeUndefined()
  })

  it('still attaches a .ics CANCEL for a genuine, terminal cancellation', async () => {
    const sent: QueueMessage[] = []
    const trulyCancelled = booking({
      status: 'cancelled',
      rescheduledTo: null,
      cancelledAt: START,
    })

    await notifyBookingCancelled({
      ports: fakePorts(sent),
      booking: trulyCancelled,
      eventType: eventType(),
      host,
      cancelledBy: 'guest',
    })

    const attachments = emailAttachments(sent)
    expect(attachments).toHaveLength(2)
    for (const a of attachments) {
      expect(a).toBeDefined()
      expect(a?.[0]?.contentType).toContain('method=CANCEL')
    }
  })
})
