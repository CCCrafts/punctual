import { describe, expect, it } from 'vitest'
import { prepareBooking, validateAnswers } from '../../src/core/domain/booking-service.js'
import { intervalToBuckets } from '../../src/core/slots/intervals.js'
import type { EventType, Availability } from '../../src/core/domain/types.js'

const availability: Availability = {
  userId: 'u',
  timezone: 'UTC',
  weekly: [[], [{ startMinute: 0, endMinute: 1440 }], [{ startMinute: 0, endMinute: 1440 }],
    [{ startMinute: 0, endMinute: 1440 }], [{ startMinute: 0, endMinute: 1440 }],
    [{ startMinute: 0, endMinute: 1440 }], [{ startMinute: 0, endMinute: 1440 }]],
  overrides: [],
}

const et: EventType = {
  id: 'evt', ownerUserId: null, ownerTeamId: 'team', schedulingType: 'collective',
  slug: 's', title: 't', description: '', durationMinutes: 30, slotIntervalMinutes: 30,
  bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, maxHorizonDays: 60,
  maxPerDay: null, locationType: 'phone', locationValue: null, questions: [
    { id: 'why', label: 'Why', type: 'text', required: false },
  ], active: true, createdAt: 0,
}

// 2026-08-18T10:00:00Z is a Tuesday
const START = Date.UTC(2026, 7, 18, 10, 0, 0)

describe('collective drops hosts that buildHostInputs skipped', () => {
  it('locks only the hosts present in req.hosts', () => {
    // buildHostInputs `continue`s past a host with no availability row, so the
    // coordinator can hand prepareBooking a SUBSET of request.hostUserIds.
    const r = prepareBooking({
      eventType: et,
      hosts: [{ hostUserId: 'alice', availability, busy: [] }], // bob was dropped
      start: START,
      guestName: 'g', guestEmail: 'g@example.com', guestTimezone: 'UTC',
      answers: {}, now: START - 3_600_000, bookingId: 'b1', manageTokenHash: 'h',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.booking.hostUserIds).toEqual(['alice'])
    expect(new Set(r.buckets.map((b) => b.hostUserId))).toEqual(new Set(['alice']))
  })
})

describe('answers not declared on the event type are unvalidated', () => {
  it('accepts an arbitrary key of arbitrary length', () => {
    const answers: Record<string, string> = { junk: 'x'.repeat(100000) }
    expect(validateAnswers(et, answers)).toEqual({})
  })
})

describe('bucket boundaries', () => {
  it('is half-open and grid aligned', () => {
    const b = intervalToBuckets({ start: START, end: START + 30 * 60_000 })
    expect(b.length).toBe(6)
    expect(b[0]).toBe(START)
    expect(b[5]).toBe(START + 25 * 60_000)
  })
  it('returns no buckets for a zero-length footprint', () => {
    expect(intervalToBuckets({ start: START, end: START })).toEqual([])
  })
})
