/**
 * Collective bookings with required and optional hosts, at commit time
 * (prepareBooking, pure). The listing side is in slots.test.ts; the D1
 * guards on the host set itself are in test/workers/teams-ui.test.ts.
 */

import { describe, expect, it } from 'vitest'

import { prepareBooking } from '../../src/core/domain/booking-service.js'
import type { EventType } from '../../src/core/domain/types.js'
import type { HostAvailabilityInput } from '../../src/core/slots/engine.js'
import { localTimeToInstant } from '../../src/core/time/zone.js'

const TZ = 'UTC'
const DAY = 86_400_000
const HOUR = 3_600_000

function eventType(over: Partial<EventType> = {}): EventType {
  return {
    id: 'et_collective',
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
    maxHorizonDays: 365,
    maxPerDay: null,
    locationType: 'phone',
    locationValue: null,
    questions: [],
    active: true,
    createdAt: 0,
    scheduleId: null,
    ...over,
  }
}

function host(id: string, busy: Array<{ start: number; end: number }> = [], required?: boolean): HostAvailabilityInput {
  const workday = [{ startMinute: 9 * 60, endMinute: 17 * 60 }]
  return {
    hostUserId: id,
    ...(required === undefined ? {} : { required }),
    availability: { userId: id, timezone: TZ, weekly: [[], workday, workday, workday, workday, workday, []], overrides: [] },
    busy,
  }
}

// A Monday 10:00 UTC, on the 5-minute grid.
const START = localTimeToInstant('2026-06-15', 10 * 60, TZ)
const NOW = START - DAY

function attempt(hosts: HostAvailabilityInput[], expectedHostCount?: number) {
  return prepareBooking({
    eventType: eventType(),
    hosts,
    ...(expectedHostCount === undefined ? {} : { expectedHostCount }),
    start: START,
    guestName: 'Guest',
    guestEmail: 'guest@example.com',
    guestTimezone: TZ,
    answers: {},
    now: NOW,
    bookingId: 'bk_1',
    manageTokenHash: 'hash',
  })
}

describe('collective: required and optional hosts at commit', () => {
  it('commits with the required hosts plus the optional ones that are free, and locks only those', () => {
    const busy = [{ start: START, end: START + HOUR }]
    const result = attempt([host('alice'), host('bob', [], false), host('carol', busy, false)], 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.booking.hostUserId).toBe('alice')
    expect(result.booking.hostUserIds).toEqual(['alice', 'bob'])
    // 30 minutes = 6 buckets per participating host; Carol claims none.
    expect(result.buckets).toHaveLength(12)
    expect(result.buckets.some((b) => b.hostUserId === 'carol')).toBe(false)
  })

  it('fails when a required host is busy, however free the optional ones are', () => {
    const busy = [{ start: START, end: START + HOUR }]
    const result = attempt([host('alice', busy), host('bob', [], false)], 1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('slot_taken')
    expect(result.detail).toBe('alice')
  })

  it('a required host that failed to resolve fails the booking; an optional one may drop out', () => {
    // The coordinator asked for two required hosts; only one came back.
    expect(attempt([host('alice')], 2).ok).toBe(false)
    // One required asked for, one came back, the optional host vanished: fine.
    const result = attempt([host('alice')], 1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.booking.hostUserIds).toEqual(['alice'])
  })

  it('optional hosts alone are not a meeting', () => {
    const result = attempt([host('bob', [], false), host('carol', [], false)], 0)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no_eligible_host')
  })

  it('hosts with no flag are required — the pre-host-set behaviour', () => {
    const busy = [{ start: START, end: START + HOUR }]
    expect(attempt([host('alice'), host('bob', busy)], 2).ok).toBe(false)
    const result = attempt([host('alice'), host('bob')], 2)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.booking.hostUserIds).toEqual(['alice', 'bob'])
  })
})
