import { describe, expect, it } from 'vitest'
import {
  bookingFootprint,
  computeSlots,
  isSlotStillValid,
  type HostAvailabilityInput,
} from '../../src/core/slots/engine.js'
import {
  BUCKET_MS,
  bucketsToIntervals,
  intersectAll,
  intervalToBuckets,
  mergeIntervals,
  subtractIntervals,
} from '../../src/core/slots/intervals.js'
import type { Availability, EventType, WeeklySchedule } from '../../src/core/domain/types.js'
import { localTimeToInstant, toWallClock } from '../../src/core/time/zone.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function weekly(windows: Array<{ startMinute: number; endMinute: number }>): WeeklySchedule {
  return [windows, windows, windows, windows, windows, windows, windows] as WeeklySchedule
}

/** 09:00–17:00 every day, in the given zone. */
function nineToFive(tz: string, userId = 'h1'): Availability {
  return {
    userId,
    timezone: tz,
    weekly: weekly([{ startMinute: 9 * 60, endMinute: 17 * 60 }]),
    overrides: [],
  }
}

function eventType(over: Partial<EventType> = {}): EventType {
  return {
    id: 'et1',
    ownerUserId: 'h1',
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: '30min',
    title: '30 min intro',
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
    ...over,
  }
}

function host(tz: string, busy: Array<{ start: number; end: number }> = [], id = 'h1'): HostAvailabilityInput {
  return { hostUserId: id, availability: nineToFive(tz, id), busy }
}

/**
 * One local calendar day, midnight to midnight.
 *
 * NOT `start + 24h`. On a spring-forward date a local day is 23 hours, so
 * adding 24 lands at 01:00 the following day and silently pulls in slots from
 * it; on a fall-back date it is 25 hours and truncates the day. Every
 * day-scoped assertion below depends on getting this right, and getting it
 * wrong is precisely the bug this suite exists to catch.
 */
function localDay(date: string, tz: string): { start: number; end: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
    next.getUTCDate(),
  ).padStart(2, '0')}`
  return { start: localTimeToInstant(date, 0, tz), end: localTimeToInstant(nextDate, 0, tz) }
}

// ===========================================================================
// Interval algebra
// ===========================================================================

describe('interval algebra', () => {
  it('merges overlapping and touching intervals', () => {
    expect(mergeIntervals([{ start: 0, end: 10 }, { start: 10, end: 20 }])).toEqual([{ start: 0, end: 20 }])
    expect(mergeIntervals([{ start: 0, end: 10 }, { start: 5, end: 20 }])).toEqual([{ start: 0, end: 20 }])
    expect(mergeIntervals([{ start: 0, end: 10 }, { start: 11, end: 20 }])).toHaveLength(2)
  })

  it('subtracts busy time from free windows', () => {
    const free = subtractIntervals([{ start: 0, end: 100 }], [{ start: 30, end: 50 }])
    expect(free).toEqual([{ start: 0, end: 30 }, { start: 50, end: 100 }])
  })

  it('subtracting a superset leaves nothing', () => {
    expect(subtractIntervals([{ start: 10, end: 20 }], [{ start: 0, end: 100 }])).toEqual([])
  })

  it('intersects across sets; empty input is empty, not everything', () => {
    expect(
      intersectAll([
        [{ start: 0, end: 100 }],
        [{ start: 50, end: 150 }],
        [{ start: 60, end: 80 }],
      ]),
    ).toEqual([{ start: 60, end: 80 }])
    expect(intersectAll([])).toEqual([])
  })

  it('bucket conversion claims every touched bucket', () => {
    // A 30-minute meeting on the grid is exactly 6 buckets.
    expect(intervalToBuckets({ start: 0, end: 30 * MINUTE })).toHaveLength(6)
    // An off-grid interval floors the start and ceils the end, so nothing leaks.
    const b = intervalToBuckets({ start: 2 * MINUTE, end: 8 * MINUTE })
    expect(b).toEqual([0, BUCKET_MS])
  })

  it('buckets round-trip to contiguous intervals', () => {
    const iv = { start: 0, end: 30 * MINUTE }
    expect(bucketsToIntervals(intervalToBuckets(iv))).toEqual([iv])
    // A gap in the middle produces two intervals.
    expect(bucketsToIntervals([0, BUCKET_MS, 3 * BUCKET_MS])).toEqual([
      { start: 0, end: 2 * BUCKET_MS },
      { start: 3 * BUCKET_MS, end: 4 * BUCKET_MS },
    ])
  })
})

// ===========================================================================
// Basic generation
// ===========================================================================

describe('slot generation', () => {
  const tz = 'Europe/Kyiv'

  it('generates back-to-back slots across a working day', () => {
    const dayStart = localTimeToInstant('2026-06-15', 0, tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [host(tz)],
      range: { start: dayStart, end: dayStart + DAY },
      now: dayStart - DAY,
    })
    // 09:00–17:00 is 8 hours = 16 half-hour slots.
    expect(slots).toHaveLength(16)
    expect(toWallClock(slots[0]!.start, tz).hour).toBe(9)
    expect(toWallClock(slots[15]!.start, tz).hour).toBe(16)
    expect(toWallClock(slots[15]!.start, tz).minute).toBe(30)
  })

  it('anchors the grid to the window start, not the hour', () => {
    // A window starting 09:15 must yield 09:15, 09:45 … never 09:30.
    const av: Availability = {
      userId: 'h1',
      timezone: tz,
      weekly: weekly([{ startMinute: 9 * 60 + 15, endMinute: 12 * 60 }]),
      overrides: [],
    }
    const dayStart = localTimeToInstant('2026-06-15', 0, tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [{ hostUserId: 'h1', availability: av, busy: [] }],
      range: { start: dayStart, end: dayStart + DAY },
      now: dayStart - DAY,
    })
    expect(toWallClock(slots[0]!.start, tz).minute).toBe(15)
    expect(toWallClock(slots[1]!.start, tz).minute).toBe(45)
  })

  it('removes slots that collide with busy time', () => {
    const dayStart = localTimeToInstant('2026-06-15', 0, tz)
    const busyStart = localTimeToInstant('2026-06-15', 10 * 60, tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [host(tz, [{ start: busyStart, end: busyStart + HOUR }])],
      range: { start: dayStart, end: dayStart + DAY },
      now: dayStart - DAY,
    })
    expect(slots).toHaveLength(14) // 16 minus the two half-hours 10:00–11:00
    expect(slots.some((s) => s.start >= busyStart && s.start < busyStart + HOUR)).toBe(false)
  })

  it('date overrides replace the whole day, including with nothing', () => {
    const av = nineToFive(tz)
    av.overrides = [{ date: '2026-06-15', windows: [] }]
    const dayStart = localTimeToInstant('2026-06-15', 0, tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [{ hostUserId: 'h1', availability: av, busy: [] }],
      range: { start: dayStart, end: dayStart + DAY },
      now: dayStart - DAY,
    })
    expect(slots).toHaveLength(0)
  })

  it('honours min notice and max horizon', () => {
    const dayStart = localTimeToInstant('2026-06-15', 0, tz)
    const noon = localTimeToInstant('2026-06-15', 12 * 60, tz)
    const slots = computeSlots({
      eventType: eventType({ minNoticeMinutes: 24 * 60 }),
      hosts: [host(tz)],
      range: { start: dayStart, end: dayStart + DAY },
      now: noon,
    })
    expect(slots).toHaveLength(0) // everything today is inside 24h notice

    const horizonLimited = computeSlots({
      eventType: eventType({ maxHorizonDays: 0 }),
      hosts: [host(tz)],
      range: { start: dayStart, end: dayStart + 7 * DAY },
      now: dayStart - DAY,
    })
    expect(horizonLimited).toHaveLength(0)
  })

  it('applies the per-day cap on host-local dates', () => {
    const dayStart = localTimeToInstant('2026-06-15', 0, tz)
    const h = host(tz)
    h.bookingsPerLocalDate = new Map([['2026-06-15', 2]])
    const slots = computeSlots({
      eventType: eventType({ maxPerDay: 2 }),
      hosts: [h],
      range: { start: dayStart, end: dayStart + 2 * DAY },
      now: dayStart - DAY,
    })
    // The 15th is full; the 16th is untouched.
    expect(slots.every((s) => s.start >= localTimeToInstant('2026-06-16', 0, tz))).toBe(true)
  })
})

// ===========================================================================
// Buffers (ADR-0004 §4)
// ===========================================================================

describe('buffers are additive', () => {
  const tz = 'Europe/Kyiv'

  it('reserves room for buffers inside the window', () => {
    const dayStart = localTimeToInstant('2026-06-15', 0, tz)
    const slots = computeSlots({
      eventType: eventType({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }),
      hosts: [host(tz)],
      range: { start: dayStart, end: dayStart + DAY },
      now: dayStart - DAY,
    })
    // First slot starts at 09:15 — 09:00 plus the leading buffer.
    expect(toWallClock(slots[0]!.start, tz).hour).toBe(9)
    expect(toWallClock(slots[0]!.start, tz).minute).toBe(15)
    // Last slot must end by 16:45 so its trailing buffer fits before 17:00.
    const last = slots[slots.length - 1]!
    expect(last.end + 15 * MINUTE).toBeLessThanOrEqual(localTimeToInstant('2026-06-15', 17 * 60, tz))
  })

  it('the footprint is what the atomicity layer locks', () => {
    const et = eventType({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 })
    const fp = bookingFootprint(HOUR, HOUR + 30 * MINUTE, et)
    expect(fp.start).toBe(HOUR - 15 * MINUTE)
    expect(fp.end).toBe(HOUR + 45 * MINUTE)
    // Generator and arbiter agree by construction — this is what stops a slot
    // being offered that would 409 on submit.
    expect(intervalToBuckets(fp)).toHaveLength(12)
  })
})

// ===========================================================================
// The DST matrix — M1 exit criterion (ADR-0004)
// ===========================================================================

describe('DST: Europe/Kyiv', () => {
  const tz = 'Europe/Kyiv'

  it('spring-forward day loses the missing hour of slots', () => {
    // 2026-03-29: 03:00 → 04:00. A 00:00–12:00 window loses one hour.
    const av: Availability = {
      userId: 'h1',
      timezone: tz,
      weekly: weekly([{ startMinute: 0, endMinute: 12 * 60 }]),
      overrides: [],
    }
    const day = localDay('2026-03-29', tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [{ hostUserId: 'h1', availability: av, busy: [] }],
      range: day,
      now: day.start - DAY,
    })
    // 12 local hours minus the vanished hour = 11 real hours = 22 slots.
    expect(slots).toHaveLength(22)
    // No slot can render as 03:xx — that hour does not exist.
    expect(slots.some((s) => toWallClock(s.start, tz).hour === 3)).toBe(false)
  })

  it('a window starting inside the gap clamps forward', () => {
    const av: Availability = {
      userId: 'h1',
      timezone: tz,
      weekly: weekly([{ startMinute: 3 * 60 + 30, endMinute: 6 * 60 }]),
      overrides: [],
    }
    const day = localDay('2026-03-29', tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [{ hostUserId: 'h1', availability: av, busy: [] }],
      range: day,
      now: day.start - DAY,
    })
    // 03:30 clamps to 04:00, so the day runs 04:00–06:00 = 4 slots.
    expect(slots).toHaveLength(4)
    expect(toWallClock(slots[0]!.start, tz).hour).toBe(4)
  })

  it('fall-back day gains an hour of slots', () => {
    // 2026-10-25: 04:00 → 03:00, so 00:00–12:00 local is 13 real hours.
    const av: Availability = {
      userId: 'h1',
      timezone: tz,
      weekly: weekly([{ startMinute: 0, endMinute: 12 * 60 }]),
      overrides: [],
    }
    const day = localDay('2026-10-25', tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [{ hostUserId: 'h1', availability: av, busy: [] }],
      range: day,
      now: day.start - DAY,
    })
    expect(slots).toHaveLength(26)
    // The repeated hour appears twice, and both are genuinely bookable.
    const threes = slots.filter((s) => toWallClock(s.start, tz).hour === 3)
    expect(threes).toHaveLength(4) // 03:00, 03:30, then again 03:00, 03:30
    // …and they are distinct instants, an hour apart.
    expect(threes[2]!.start - threes[0]!.start).toBe(HOUR)
  })

  it('a booking made before a transition still renders correctly after it', () => {
    const before = localTimeToInstant('2026-03-28', 10 * 60, tz)
    const after = localTimeToInstant('2026-03-30', 10 * 60, tz)
    // Same local time, different offsets — so a different number of real hours.
    expect(after - before).toBe(2 * DAY - HOUR)
    expect(toWallClock(before, tz).hour).toBe(10)
    expect(toWallClock(after, tz).hour).toBe(10)
  })
})

describe('DST: America/New_York transitions on different dates than the EU', () => {
  it('US springs forward while Kyiv is still on standard time', () => {
    const usAv: Availability = {
      userId: 'h1',
      timezone: 'America/New_York',
      weekly: weekly([{ startMinute: 0, endMinute: 6 * 60 }]),
      overrides: [],
    }
    // 2026-03-08 is the US transition; the EU does not move until 03-29.
    const day = localDay('2026-03-08', 'America/New_York')
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [{ hostUserId: 'h1', availability: usAv, busy: [] }],
      range: day,
      now: day.start - DAY,
    })
    expect(slots).toHaveLength(10) // 6 local hours minus 1 vanished = 5 real
    expect(slots.some((s) => toWallClock(s.start, 'America/New_York').hour === 2)).toBe(false)
  })
})

describe('DST: Australia/Lord_Howe — the 30-minute shift', () => {
  const tz = 'Australia/Lord_Howe'

  it('loses only half an hour on spring-forward', () => {
    // 2026-10-04: 02:00 → 02:30. A 00:00–06:00 window loses 30 minutes.
    const av: Availability = {
      userId: 'h1',
      timezone: tz,
      weekly: weekly([{ startMinute: 0, endMinute: 6 * 60 }]),
      overrides: [],
    }
    const day = localDay('2026-10-04', tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [{ hostUserId: 'h1', availability: av, busy: [] }],
      range: day,
      now: day.start - DAY,
    })
    // 6 local hours minus 30 minutes = 5.5 real hours = 11 slots.
    // A whole-hour assumption would produce 10 here.
    expect(slots).toHaveLength(11)
  })
})

describe('DST: Pacific/Chatham — +12:45 offsets', () => {
  const tz = 'Pacific/Chatham'

  it('generates correct slots at a 45-minute offset', () => {
    const day = localDay('2026-06-15', tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [host(tz)],
      range: day,
      now: day.start - DAY,
    })
    expect(slots).toHaveLength(16)
    const wc = toWallClock(slots[0]!.start, tz)
    expect([wc.hour, wc.minute]).toEqual([9, 0])
    // The instant itself carries the :45 offset, which is the real test.
    expect(slots[0]!.start % HOUR).toBe(15 * MINUTE)
  })
})

describe('DST: Asia/Kolkata — no DST, half-hour offset', () => {
  it('never shifts across the year', () => {
    const tz = 'Asia/Kolkata'
    for (const date of ['2026-01-15', '2026-03-29', '2026-06-15', '2026-10-25']) {
      const day = localDay(date, tz)
      const slots = computeSlots({
        eventType: eventType(),
        hosts: [host(tz)],
        range: day,
        now: day.start - DAY,
      })
      expect({ date, n: slots.length }).toEqual({ date, n: 16 })
    }
  })
})

describe('DST: southern hemisphere ordering', () => {
  it('Sydney falls back in April and springs forward in October', () => {
    const tz = 'Australia/Sydney'
    const av: Availability = {
      userId: 'h1',
      timezone: tz,
      weekly: weekly([{ startMinute: 0, endMinute: 6 * 60 }]),
      overrides: [],
    }
    const mk = (date: string) => {
      const day = localDay(date, tz)
      return computeSlots({
        eventType: eventType(),
        hosts: [{ hostUserId: 'h1', availability: av, busy: [] }],
        range: day,
        now: day.start - DAY,
      }).length
    }
    expect(mk('2026-04-05')).toBe(14) // gains an hour
    expect(mk('2026-10-04')).toBe(10) // loses an hour
  })
})

// ===========================================================================
// Teams
// ===========================================================================

describe('team scheduling', () => {
  const tz = 'Europe/Kyiv'
  const dayStart = localTimeToInstant('2026-06-15', 0, tz)

  it('collective requires every member to be free', () => {
    const busyA = localTimeToInstant('2026-06-15', 10 * 60, tz)
    const slots = computeSlots({
      eventType: eventType({ schedulingType: 'collective', ownerTeamId: 't1', ownerUserId: null }),
      hosts: [
        host(tz, [{ start: busyA, end: busyA + HOUR }], 'h1'),
        host(tz, [], 'h2'),
      ],
      range: { start: dayStart, end: dayStart + DAY },
      now: dayStart - DAY,
    })
    expect(slots).toHaveLength(14) // h1's busy hour removes it for everyone
    expect(slots.every((s) => s.eligibleHostIds.length === 2)).toBe(true)
  })

  it('collective across different timezones intersects correctly', () => {
    // Kyiv 09:00–17:00 (UTC+3) vs New York 09:00–17:00 (UTC-4) overlap
    // only 16:00–17:00 Kyiv = 09:00–10:00 New York.
    const slots = computeSlots({
      eventType: eventType({ schedulingType: 'collective', ownerTeamId: 't1', ownerUserId: null }),
      hosts: [host('Europe/Kyiv', [], 'h1'), host('America/New_York', [], 'h2')],
      range: { start: dayStart - DAY, end: dayStart + 2 * DAY },
      now: dayStart - 2 * DAY,
    })
    for (const s of slots) {
      expect(toWallClock(s.start, 'Europe/Kyiv').hour).toBe(16)
      expect(toWallClock(s.start, 'America/New_York').hour).toBe(9)
    }
  })

  it('round-robin offers a slot if any member is free, carrying eligibility', () => {
    const busyA = localTimeToInstant('2026-06-15', 10 * 60, tz)
    const slots = computeSlots({
      eventType: eventType({ schedulingType: 'round_robin', ownerTeamId: 't1', ownerUserId: null }),
      hosts: [
        host(tz, [{ start: busyA, end: busyA + HOUR }], 'h1'),
        host(tz, [], 'h2'),
      ],
      range: { start: dayStart, end: dayStart + DAY },
      now: dayStart - DAY,
    })
    expect(slots).toHaveLength(16) // h2 covers h1's busy hour
    const during = slots.find((s) => s.start === busyA)!
    expect(during.eligibleHostIds).toEqual(['h2'])
    const free = slots.find((s) => s.start === localTimeToInstant('2026-06-15', 9 * 60, tz))!
    expect(free.eligibleHostIds.sort()).toEqual(['h1', 'h2'])
  })
})

// ===========================================================================
// Re-validation at commit
// ===========================================================================

describe('isSlotStillValid', () => {
  const tz = 'Europe/Kyiv'

  it('accepts a slot inside availability', () => {
    const start = localTimeToInstant('2026-06-15', 10 * 60, tz)
    expect(isSlotStillValid(host(tz), eventType(), start, start - DAY)).toBe(true)
  })

  it('rejects a slot that became busy', () => {
    const start = localTimeToInstant('2026-06-15', 10 * 60, tz)
    const h = host(tz, [{ start, end: start + HOUR }])
    expect(isSlotStillValid(h, eventType(), start, start - DAY)).toBe(false)
  })

  it('rejects a slot outside availability', () => {
    const start = localTimeToInstant('2026-06-15', 20 * 60, tz)
    expect(isSlotStillValid(host(tz), eventType(), start, start - DAY)).toBe(false)
  })

  it('rejects a slot that fell inside min notice while the guest filled the form', () => {
    const start = localTimeToInstant('2026-06-15', 10 * 60, tz)
    const et = eventType({ minNoticeMinutes: 120 })
    expect(isSlotStillValid(host(tz), et, start, start - HOUR)).toBe(false)
  })

  it('rejects when the buffered footprint would spill past the window', () => {
    // A 16:45 start fits the meeting inside 17:00, but not its trailing buffer.
    const start = localTimeToInstant('2026-06-15', 16 * 60 + 45, tz)
    const et = eventType({ durationMinutes: 15, bufferAfterMinutes: 15 })
    expect(isSlotStillValid(host(tz), et, start, start - DAY)).toBe(false)
  })
})
