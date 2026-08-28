/**
 * The conference link reaching the guest (CCC-647).
 *
 * The bug this guards was found by booking a real meeting and opening the
 * attachment: the email said `Where: Google Meet (link in the calendar
 * invite)` and the `.ics` said `LOCATION:Google Meet (link in the calendar
 * invite)` — pointing at each other, with the link in neither. Google minted
 * one and the adapter read only the event id; `sendUpdates=none` meant Google
 * sent no invite of its own. A guest on a non-Google mailbox could not join
 * at all.
 *
 * `describeLocation` feeds BOTH the `.ics` LOCATION and the email's "Where"
 * row, so both surfaces are asserted here — neither had any LOCATION coverage
 * before.
 */

import { describe, expect, it } from 'vitest'
import type { Booking, EventType, User } from '../../src/core/domain/types.js'
import { buildIcs, describeLocation } from '../../src/core/ics.js'
import { bookingConfirmationForGuest, type BookingEmailContext } from '../../src/core/email-templates.js'
import { googleConferenceUrl } from '../../src/adapters/google/provider.js'
import { graphConferenceUrl } from '../../src/adapters/microsoft/provider.js'

const MEET = 'https://meet.google.com/abc-defg-hij'
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc'

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

function eventType(patch: Partial<EventType> = {}): EventType {
  return {
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
    ...patch,
  }
}

function booking(patch: Partial<Booking> = {}): Booking {
  return {
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
    ...patch,
  }
}

describe('describeLocation', () => {
  it('renders the real link when the provider minted one', () => {
    expect(describeLocation(eventType(), MEET)).toBe(MEET)
  })

  it('never claims the link is "in the calendar invite" when it is not', () => {
    // The exact string that made the old copy circular — the .ics said the
    // link was in the invite while BEING the invite.
    for (const value of [describeLocation(eventType()), describeLocation(eventType(), null)]) {
      expect(value).not.toContain('link in the calendar invite')
    }
  })

  it('leaves the non-conference location types alone', () => {
    expect(describeLocation(eventType({ locationType: 'phone', locationValue: '+1 555' }), MEET)).toContain('+1 555')
    expect(describeLocation(eventType({ locationType: 'in_person', locationValue: 'Room 4' }), MEET)).toBe('Room 4')
  })
})

describe('the guest actually receives the link', () => {
  it('puts it in the .ics LOCATION', () => {
    const ics = buildIcs({
      uid: 'bk_1@punctual',
      sequence: 0,
      method: 'REQUEST',
      booking: booking({ conferenceUrl: MEET }),
      eventType: eventType(),
      organizer: { name: host.name, email: host.email },
      attendees: [{ name: 'Ada', email: 'ada@example.com' }],
    })
    expect(ics).toContain(`LOCATION:${MEET}`)
  })

  it('puts it in the confirmation email', () => {
    const ctx: BookingEmailContext = {
      booking: booking({ conferenceUrl: MEET }),
      eventType: eventType(),
      host,
    }
    const mail = bookingConfirmationForGuest(ctx)
    expect(mail.html).toContain(MEET)
    expect(mail.text).toContain(MEET)
  })

  it('degrades honestly when no link was minted', () => {
    const ctx: BookingEmailContext = { booking: booking(), eventType: eventType(), host }
    const mail = bookingConfirmationForGuest(ctx)
    expect(mail.text).not.toContain('link in the calendar invite')
  })
})

/**
 * Both adapters already received the link in their create response and threw
 * it away. These pin the extraction, including the shapes each provider
 * documents as alternatives.
 */
describe('extracting the link from a provider response', () => {
  it('reads Google hangoutLink', () => {
    expect(googleConferenceUrl({ id: 'e', hangoutLink: MEET })).toEqual({ conferenceUrl: MEET })
  })

  it('falls back to the VIDEO entry point, ignoring dial-in and info entries', () => {
    const created = {
      id: 'e',
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+15550000' },
          { entryPointType: 'more', uri: 'https://meet.google.com/tel/abc' },
          { entryPointType: 'video', uri: MEET },
        ],
      },
    }
    // A phone URI here would be actively harmful: the guest would be shown a
    // dial-in string where a join link belongs.
    expect(googleConferenceUrl(created)).toEqual({ conferenceUrl: MEET })
  })

  it('returns null for a Google event with no conference at all', () => {
    expect(googleConferenceUrl({ id: 'e' })).toBeNull()
    expect(googleConferenceUrl({ id: 'e', hangoutLink: '' })).toBeNull()
  })

  it('reads Graph onlineMeeting.joinUrl, with the legacy field as fallback', () => {
    expect(graphConferenceUrl({ id: 'e', onlineMeeting: { joinUrl: TEAMS } })).toEqual({ conferenceUrl: TEAMS })
    expect(graphConferenceUrl({ id: 'e', onlineMeetingUrl: TEAMS })).toEqual({ conferenceUrl: TEAMS })
    expect(graphConferenceUrl({ id: 'e' })).toBeNull()
  })
})
