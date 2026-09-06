/**
 * Pure rendering of the host's bookings pages: the list's tabs and empty
 * states, the sentence each `changeBookingHosts` refusal becomes, and the
 * parts of the booking page that depend on who is looking — the edit link,
 * the co-host forms, the last-host guard on Remove.
 */

import { describe, expect, it } from 'vitest'
import type { Booking, EventType, User } from '../../src/core/domain/types.js'
import type { HostChangeFailure } from '../../src/core/domain/booking-hosts.js'
import {
  bookingsPage,
  hostBookingPage,
  hostChangeFailureMessage,
  hostReschedulePage,
} from '../../src/http/pages/dashboard.js'

const START = Date.UTC(2026, 8, 9, 20, 40, 0)

function user(patch: Partial<User> = {}): User {
  return {
    id: 'u_alice',
    email: 'alice@example.com',
    name: 'Alice Host',
    tz: 'Europe/Kyiv',
    slug: 'alice',
    avatarKey: null,
    company: null,
    jobTitle: null,
    companyUrl: null,
    role: 'member',
    createdAt: 0,
    ...patch,
  }
}

const alice = user()
const bob = user({ id: 'u_bob', email: 'bob@example.com', name: 'Bob Host', slug: 'bob' })
const carol = user({ id: 'u_carol', email: 'carol@example.com', name: 'Carol Admin', slug: 'carol' })

function eventType(patch: Partial<EventType> = {}): EventType {
  return {
    id: 'et_1',
    ownerUserId: null,
    ownerTeamId: 'team_1',
    schedulingType: 'collective',
    slug: 'support',
    title: 'Support call',
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
    hostUserId: 'u_alice',
    hostUserIds: ['u_alice', 'u_bob'],
    guestName: 'Grace Hopper',
    guestEmail: 'grace@example.test',
    guestTimezone: 'America/New_York',
    startUtc: START,
    endUtc: START + 30 * 60_000,
    localDate: '2026-09-09',
    status: 'confirmed',
    answers: {},
    externalEventIds: {},
    conferenceUrl: null,
    rescheduleOf: null,
    rescheduledTo: null,
    manageTokenHash: 'h',
    cancelledAt: null,
    createdAt: 0,
    ...patch,
  }
}

const chrome = { brandName: 'Punctual', user: alice, csrf: 'tok', emailDelivery: 'resend' as const }

const page = (patch: Partial<Parameters<typeof hostBookingPage>[0]> = {}) =>
  hostBookingPage({
    ...chrome,
    booking: booking(),
    eventType: eventType(),
    canEditEventType: false,
    teamName: 'Support Crew',
    participants: [
      { user: alice, required: true, attends: true },
      { user: bob, required: false, attends: true },
      { user: carol, required: true, attends: false },
    ],
    canChangeHosts: true,
    addable: [carol],
    now: START - 24 * 3600_000,
    ...patch,
  })

describe('bookings list', () => {
  it('marks the current tab and shows that tab\'s empty state', () => {
    const upcoming = bookingsPage({ ...chrome, view: 'upcoming', rows: [], truncated: false })
    expect(upcoming).toContain('href="/dashboard/bookings?view=upcoming" aria-current="page"')
    expect(upcoming).toContain('Nothing booked yet')
    expect(upcoming).toContain('<a class="pu-nav-link" href="/dashboard/bookings" aria-current="page">Bookings</a>')

    const past = bookingsPage({ ...chrome, view: 'past', rows: [], truncated: false })
    expect(past).toContain('href="/dashboard/bookings?view=past" aria-current="page"')
    expect(past).toContain('No meetings have happened yet.')

    const cancelled = bookingsPage({ ...chrome, view: 'cancelled', rows: [], truncated: false })
    expect(cancelled).toContain('Nothing has been cancelled.')
  })

  it('renders a row in the host\'s zone with the co-hosts and a status badge, and says when the list was cut', () => {
    const html = bookingsPage({
      ...chrome,
      view: 'upcoming',
      rows: [{ booking: booking(), eventTitle: 'Support call', coHostNames: ['Bob Host', 'Dana Host'] }],
      truncated: true,
    })
    expect(html).toContain('href="/dashboard/bookings/bk_1"')
    // 20:40 UTC is 23:40 in Kyiv — the host's zone, never the guest's.
    expect(html).toContain('11:40 PM')
    expect(html).toContain('with Bob Host and Dana Host')
    expect(html).toContain('pu-badge pu-badge-dot">Confirmed</span>')
    expect(html).toContain('Showing the first 1.')
  })
})

describe('host change refusals', () => {
  it('has a sentence for every reason', () => {
    const reasons: HostChangeFailure[] = [
      'not_found', 'not_allowed', 'not_a_team_booking', 'not_a_member',
      'already_host', 'not_host', 'last_host', 'slot_taken', 'past',
    ]
    const sentences = new Set(reasons.map(hostChangeFailureMessage))
    expect(sentences.size).toBe(reasons.length)
    for (const s of sentences) expect(s).toMatch(/^[A-Z].*\.$/)
    expect(hostChangeFailureMessage('last_host')).toContain('at least one host')
    expect(hostChangeFailureMessage('slot_taken')).toContain('not free')
  })
})

describe('booking page', () => {
  it('shows both zones, every participant with their mode, and the co-host forms', () => {
    const html = page()
    expect(html).toContain('Europe/Kyiv')
    expect(html).toContain('For the guest')
    expect(html).toContain('America/New_York')
    expect(html).toContain('Not yet on a calendar')
    expect(html).toContain('Alice Host')
    expect(html).toContain('(you)')
    expect(html).toContain('Optional')
    expect(html).toContain('Required')
    expect(html).toContain('Not on this one')
    expect(html).toContain('action="/dashboard/bookings/bk_1/hosts/add"')
    expect(html).toContain('<option value="u_carol">Carol Admin</option>')
    expect(html).toContain('action="/dashboard/bookings/bk_1/hosts/u_bob/remove"')
    expect(html).toContain('action="/dashboard/bookings/bk_1/hosts/u_alice/remove"')
    // Team badge, no edit link for a plain member.
    expect(html).toContain('Support Crew')
    expect(html).not.toContain('href="/dashboard/event-types/et_1"')
  })

  it('links the title to the editor when the user may edit, and counts the calendars', () => {
    const html = page({ canEditEventType: true, booking: booking({ externalEventIds: { a: '1', b: '2' } }) })
    expect(html).toContain('href="/dashboard/event-types/et_1">Support call</a>')
    expect(html).toContain('On 2 calendars')
  })

  it('draws no Remove for the last attending host, and no forms without the right', () => {
    const solo = page({
      participants: [{ user: alice, required: true, attends: true }, { user: bob, required: true, attends: false }],
      addable: [bob],
    })
    expect(solo).not.toContain('/hosts/u_alice/remove')
    expect(solo).toContain('action="/dashboard/bookings/bk_1/hosts/add"')

    const readOnly = page({ canChangeHosts: false, addable: [] })
    expect(readOnly).not.toContain('/hosts/')
  })

  it('hides the guest zone when it matches the host\'s, and drops the mode badge on a personal booking', () => {
    const html = page({
      booking: booking({ guestTimezone: 'Europe/Kyiv', hostUserIds: ['u_alice'] }),
      eventType: eventType({ ownerTeamId: null, ownerUserId: 'u_alice', schedulingType: 'personal' }),
      teamName: null,
      participants: [{ user: alice, required: null, attends: true }],
      canChangeHosts: false,
      addable: [],
    })
    expect(html).not.toContain('For the guest')
    expect(html).not.toContain('Required')
    expect(html).not.toContain('pu-badge-neutral">Support Crew')
  })

  it('offers nothing to change on a cancelled, moved or past booking', () => {
    const cancelled = page({ booking: booking({ status: 'cancelled' }) })
    expect(cancelled).toContain('This booking is cancelled, so there is nothing left to change.')
    expect(cancelled).not.toContain('/cancel"')

    const moved = page({ booking: booking({ status: 'rescheduled', rescheduledTo: 'bk_2' }) })
    expect(moved).toContain('href="/dashboard/bookings/bk_2">See the new time.</a>')

    const past = page({ now: START + 3600_000 })
    expect(past).toContain('already happened')
    expect(past).not.toContain('/reschedule"')
  })
})

describe('reschedule page', () => {
  it('groups slots by day in the host\'s zone and links each to the confirm step', () => {
    const html = hostReschedulePage({
      ...chrome,
      booking: booking(),
      eventType: eventType(),
      days: [
        { date: '2026-09-10', slots: [{ start: START + 86_400_000, end: START + 86_400_000 + 1_800_000, eligibleHostIds: ['u_alice'] }] },
      ],
    })
    expect(html).toContain('<h3 class="pu-day-heading">Thursday, September 10</h3>')
    expect(html).toContain(`href="/dashboard/bookings/bk_1/reschedule?start=${START + 86_400_000}"`)
    expect(html).toContain('11:40 PM')
  })

  it('confirms in both zones and strikes the old time', () => {
    const html = hostReschedulePage({ ...chrome, booking: booking(), eventType: eventType(), newStart: START + 86_400_000 })
    expect(html).toContain('Move to this time?')
    expect(html).toContain('America/New_York')
    expect(html).toContain(`name="start" value="${START + 86_400_000}"`)
    expect(html).toContain('text-decoration:line-through')
    expect(html).toContain('Move booking')
  })

  it('says why when the booking cannot be moved', () => {
    const html = hostReschedulePage({ ...chrome, booking: booking(), eventType: eventType(), blocked: 'This meeting has already happened, so it cannot be moved.' })
    expect(html).toContain('already happened')
    expect(html).not.toContain('?start=')
  })
})
