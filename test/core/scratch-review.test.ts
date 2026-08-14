import { describe, expect, it } from 'vitest'
import {
  bookingFootprint,
  computeSlots,
  isSlotStillValid,
  type HostAvailabilityInput,
} from '../../src/core/slots/engine.js'
import { intervalToBuckets, BUCKET_MS } from '../../src/core/slots/intervals.js'
import { prepareBooking, pickRoundRobinHost } from '../../src/core/domain/booking-service.js'
import type {
  Availability,
  EventType,
  TeamMember,
  WeeklySchedule,
} from '../../src/core/domain/types.js'
import {
  localTimeToInstant,
  resolveWallClock,
  toWallClock,
  wallClockToInstant,
  localDatesBetween,
} from '../../src/core/time/zone.js'
import { dayRange, monthRange } from '../../src/engine.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function weekly(w: Array<{ startMinute: number; endMinute: number }>): WeeklySchedule {
  return [w, w, w, w, w, w, w] as WeeklySchedule
}
function av(tz: string, windows = [{ startMinute: 540, endMinute: 1020 }], userId = 'h1'): Availability {
  return { userId, timezone: tz, weekly: weekly(windows), overrides: [] }
}
function eventType(over: Partial<EventType> = {}): EventType {
  return {
    id: 'et1', ownerUserId: 'h1', ownerTeamId: null, schedulingType: 'personal',
    slug: '30min', title: 't', description: '', durationMinutes: 30,
    slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
    minNoticeMinutes: 0, maxHorizonDays: 60, maxPerDay: null,
    locationType: 'google_meet', locationValue: null, questions: [], active: true, createdAt: 0,
    ...over,
  }
}
function host(tz: string, busy: Array<{ start: number; end: number }> = [], id = 'h1', windows?: Array<{ startMinute: number; endMinute: number }>): HostAvailabilityInput {
  return { hostUserId: id, availability: av(tz, windows, id), busy }
}
function localDay(date: string, tz: string) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const n = new Date(Date.UTC(y, m - 1, d + 1))
  const nd = `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-${String(n.getUTCDate()).padStart(2, '0')}`
  return { start: localTimeToInstant(date, 0, tz), end: localTimeToInstant(nd, 0, tz) }
}

// ===========================================================================
// 1. Round-robin weight direction
// ===========================================================================
describe('RR weights', () => {
  it('a weight-3 host should get ~3x the bookings of a weight-1 host', () => {
    const members: TeamMember[] = [
      { teamId: 't', userId: 'a', role: 'member', rrWeight: 1 },
      { teamId: 't', userId: 'b', role: 'member', rrWeight: 3 },
    ]
    const last = new Map<string, number>([['a', 0], ['b', 0]])
    const counts: Record<string, number> = { a: 0, b: 0 }
    let now = 1_000_000
    for (let i = 0; i < 40; i++) {
      const pick = pickRoundRobinHost(['a', 'b'], members, last, now)!
      counts[pick] = (counts[pick] ?? 0) + 1
      last.set(pick, now)
      now += HOUR
    }
    // eslint-disable-next-line no-console
    console.log('RR distribution (a w=1, b w=3):', counts)
    expect(counts.b).toBeGreaterThan(counts.a)
  })
})

// ===========================================================================
// 2. Generator/arbiter bucket contract
// ===========================================================================
describe('generator/arbiter bucket contract (ADR-0004 §4)', () => {
  const tz = 'UTC'

  it('adjacent offered slots must never claim the same bucket (off-grid free window)', () => {
    const day = localDay('2026-06-15', tz)
    // An external calendar event ending at 09:22 -> free window starts off-grid.
    const busyEnd = localTimeToInstant('2026-06-15', 9 * 60 + 22, tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [host(tz, [{ start: day.start, end: busyEnd }])],
      range: day,
      now: day.start - DAY,
    })
    const et = eventType()
    const b0 = new Set(intervalToBuckets(bookingFootprint(slots[0]!.start, slots[0]!.end, et)))
    const b1 = intervalToBuckets(bookingFootprint(slots[1]!.start, slots[1]!.end, et))
    const shared = b1.filter((b) => b0.has(b))
    // eslint-disable-next-line no-console
    console.log('slot0', new Date(slots[0]!.start).toISOString(), 'slot1', new Date(slots[1]!.start).toISOString(), 'shared buckets', shared.length)
    expect(shared).toEqual([])
  })

  it('adjacent offered slots must never claim the same bucket (non-multiple-of-5 buffer)', () => {
    const day = localDay('2026-06-15', tz)
    // rest.ts allows bufferBefore/After to be ANY integer 0..720 — no multipleOf(5).
    const et = eventType({ bufferBeforeMinutes: 7, bufferAfterMinutes: 0 })
    const slots = computeSlots({
      eventType: et,
      hosts: [host(tz)],
      range: day,
      now: day.start - DAY,
    })
    const b0 = new Set(intervalToBuckets(bookingFootprint(slots[0]!.start, slots[0]!.end, et)))
    const b1 = intervalToBuckets(bookingFootprint(slots[1]!.start, slots[1]!.end, et))
    // eslint-disable-next-line no-console
    console.log('buf7 slot0', new Date(slots[0]!.start).toISOString(), 'slot1', new Date(slots[1]!.start).toISOString())
    expect(b1.filter((b) => b0.has(b))).toEqual([])
  })

  it('off-grid availability minutes (API allows them) keep slots on the bucket grid', () => {
    const day = localDay('2026-06-15', tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [host(tz, [], 'h1', [{ startMinute: 9 * 60 + 7, endMinute: 17 * 60 }])],
      range: day,
      now: day.start - DAY,
    })
    for (const s of slots) expect(s.start % BUCKET_MS).toBe(0)
  })

  it('ADR §3.4: the grid is anchored at the WINDOW start, buffers only filter', () => {
    const day = localDay('2026-06-15', tz)
    const et = eventType({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 })
    const slots = computeSlots({ eventType: et, hosts: [host(tz)], range: day, now: day.start - DAY })
    // Window 09:00-17:00, grid anchored at 09:00 -> 09:00,09:30,10:00...
    // 09:00 fails the buffer test, so the first eligible candidate is 09:30.
    const wc = toWallClock(slots[0]!.start, tz)
    // eslint-disable-next-line no-console
    console.log('first slot with 15/15 buffers:', wc.hour + ':' + wc.minute)
    expect([wc.hour, wc.minute]).toEqual([9, 30])
  })
})

// ===========================================================================
// 3. Off-grid / arbitrary start accepted at commit
// ===========================================================================
describe('commit path accepts starts that were never offered', () => {
  const tz = 'UTC'
  it('rejects a start that is not on the offered grid', () => {
    const start = localTimeToInstant('2026-06-15', 9 * 60 + 7, tz)
    const et = eventType()
    const res = prepareBooking({
      eventType: et,
      hosts: [host(tz)],
      start,
      guestName: 'g', guestEmail: 'g@example.com', guestTimezone: tz,
      answers: {}, now: start - DAY, bookingId: 'b1', manageTokenHash: 'h',
    })
    // eslint-disable-next-line no-console
    if (res.ok) console.log('off-grid booking accepted, buckets:', res.buckets.map((b) => new Date(b.bucketStart).toISOString()))
    expect(res.ok).toBe(false)
  })
})

// ===========================================================================
// 4. Daily cap at commit
// ===========================================================================
describe('per-day cap', () => {
  const tz = 'UTC'
  it('is enforced at commit even when the caller passes no counts (coordinator does)', () => {
    const start = localTimeToInstant('2026-06-15', 10 * 60, tz)
    const et = eventType({ maxPerDay: 1 })
    const h = host(tz)
    h.bookingsPerLocalDate = undefined // exactly what coordinator.ts:257 passes
    expect(isSlotStillValid(h, et, start, start - DAY)).toBe(false)
  })

  it('counts on the host-local date across a DST fall-back boundary', () => {
    const tzk = 'Europe/Kyiv'
    // 2026-10-25 fall-back day; a slot at 00:30 local is on the 25th.
    const day = localDay('2026-10-25', tzk)
    const h = host(tzk, [], 'h1', [{ startMinute: 0, endMinute: 6 * 60 }])
    h.bookingsPerLocalDate = new Map([['2026-10-25', 5]])
    const slots = computeSlots({
      eventType: eventType({ maxPerDay: 5 }),
      hosts: [h],
      range: day,
      now: day.start - DAY,
    })
    expect(slots).toHaveLength(0)
  })
})

// ===========================================================================
// 5. Boundary arithmetic
// ===========================================================================
describe('boundaries', () => {
  const tz = 'UTC'
  it('a busy interval that merely touches the slot boundary does not remove it', () => {
    const day = localDay('2026-06-15', tz)
    const ten = localTimeToInstant('2026-06-15', 10 * 60, tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [host(tz, [{ start: ten - HOUR, end: ten }])],
      range: day,
      now: day.start - DAY,
    })
    expect(slots.some((s) => s.start === ten)).toBe(true)
  })

  it('a slot ending exactly at the window end is offered', () => {
    const day = localDay('2026-06-15', tz)
    const slots = computeSlots({ eventType: eventType(), hosts: [host(tz)], range: day, now: day.start - DAY })
    expect(slots[slots.length - 1]!.end).toBe(localTimeToInstant('2026-06-15', 17 * 60, tz))
  })

  it('a buffered footprint that exactly fits is offered; one minute more is not', () => {
    const tzk = 'UTC'
    const start = localTimeToInstant('2026-06-15', 16 * 60 + 45, tzk)
    // 16:45 + 15min meeting + 0 buffer = 17:00 exactly.
    expect(isSlotStillValid(host(tzk), eventType({ durationMinutes: 15 }), start, start - DAY)).toBe(true)
    // with a 15-minute trailing buffer it spills to 17:15
    expect(isSlotStillValid(host(tzk), eventType({ durationMinutes: 15, bufferAfterMinutes: 15 }), start, start - DAY)).toBe(false)
  })

  it('intervalToBuckets on exact bucket boundaries claims no extra bucket', () => {
    expect(intervalToBuckets({ start: 0, end: BUCKET_MS })).toEqual([0])
    expect(intervalToBuckets({ start: BUCKET_MS, end: 2 * BUCKET_MS })).toEqual([BUCKET_MS])
    expect(intervalToBuckets({ start: 0, end: 0 })).toEqual([])
  })

  it('min-notice edge: start exactly at now+minNotice is allowed', () => {
    const start = localTimeToInstant('2026-06-15', 10 * 60, 'UTC')
    const et = eventType({ minNoticeMinutes: 60 })
    expect(isSlotStillValid(host('UTC'), et, start, start - HOUR)).toBe(true)
  })

  it('horizon edge: start exactly at now+horizon is allowed', () => {
    const start = localTimeToInstant('2026-06-15', 10 * 60, 'UTC')
    const et = eventType({ maxHorizonDays: 1 })
    expect(isSlotStillValid(host('UTC'), et, start, start - DAY)).toBe(true)
  })
})

// ===========================================================================
// 6. Uncovered DST zones
// ===========================================================================
describe('DST zones the suite does not cover', () => {
  it('Antarctica/Troll: 2-hour spring-forward gap', () => {
    const r = resolveWallClock({ year: 2026, month: 3, day: 29, hour: 2, minute: 0, second: 0 }, 'Antarctica/Troll')
    expect(r.kind).toBe('gap')
    if (r.kind === 'gap') expect(r.instant).toBe(Date.UTC(2026, 2, 29, 1))
    // clamps forward to 03:00 local
    const ts = wallClockToInstant({ year: 2026, month: 3, day: 29, hour: 2, minute: 0, second: 0 }, 'Antarctica/Troll')
    expect(toWallClock(ts, 'Antarctica/Troll').hour).toBe(3)
  })

  it('Antarctica/Troll: 2-hour fall-back repeats two whole hours', () => {
    const r = resolveWallClock({ year: 2026, month: 10, day: 25, hour: 1, minute: 30, second: 0 }, 'Antarctica/Troll')
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.second - r.first).toBe(2 * HOUR)
  })

  it('Antarctica/Troll: a 00:00-06:00 window loses 2 hours on spring-forward', () => {
    const tz = 'Antarctica/Troll'
    const day = localDay('2026-03-29', tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [host(tz, [], 'h1', [{ startMinute: 0, endMinute: 6 * 60 }])],
      range: day,
      now: day.start - DAY,
    })
    expect(slots).toHaveLength(8) // 6 local hours - 2 vanished = 4 real hours
  })

  it('Antarctica/Troll: a 00:00-06:00 window gains 2 hours on fall-back', () => {
    const tz = 'Antarctica/Troll'
    const day = localDay('2026-10-25', tz)
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [host(tz, [], 'h1', [{ startMinute: 0, endMinute: 6 * 60 }])],
      range: day,
      now: day.start - DAY,
    })
    expect(slots).toHaveLength(16) // 8 real hours
  })

  it('Pacific/Apia: the skipped calendar day 2011-12-30 yields no slots', () => {
    const tz = 'Pacific/Apia'
    const range = { start: Date.UTC(2011, 11, 29, 10), end: Date.UTC(2011, 11, 31, 11) }
    const slots = computeSlots({
      eventType: eventType(),
      hosts: [host(tz)],
      range,
      now: Date.UTC(2011, 11, 1),
    })
    const dates = new Set(slots.map((s) => {
      const wc = toWallClock(s.start, tz)
      return `${wc.year}-${String(wc.month).padStart(2, '0')}-${String(wc.day).padStart(2, '0')}`
    }))
    // eslint-disable-next-line no-console
    console.log('Apia dates with slots:', [...dates], 'n=', slots.length)
    expect(dates.has('2011-12-30')).toBe(false)
    // 12-29 and 12-31 each get a full 09:00-17:00 -> 16 slots, no duplicates.
    expect(slots.length).toBe(32)
  })

  it('Africa/Casablanca: the Ramadan negative shift', () => {
    const tz = 'Africa/Casablanca'
    // 2026-02-15 02:00 -> 01:00 local (fall back)
    const r = resolveWallClock({ year: 2026, month: 2, day: 15, hour: 2, minute: 30, second: 0 }, tz)
    expect(r.kind).toBe('ambiguous')
    // 2026-03-22 02:00 -> 03:00 local (spring forward)
    const g = resolveWallClock({ year: 2026, month: 3, day: 22, hour: 2, minute: 30, second: 0 }, tz)
    expect(g.kind).toBe('gap')
  })

  it('Europe/Dublin: negative DST is still resolved as a normal transition', () => {
    const tz = 'Europe/Dublin'
    const g = resolveWallClock({ year: 2026, month: 3, day: 29, hour: 1, minute: 30, second: 0 }, tz)
    expect(g.kind).toBe('gap')
    const a = resolveWallClock({ year: 2026, month: 10, day: 25, hour: 1, minute: 30, second: 0 }, tz)
    expect(a.kind).toBe('ambiguous')
  })

  it('America/Santiago: local midnight does not exist on 2026-09-06', () => {
    const tz = 'America/Santiago'
    const r = resolveWallClock({ year: 2026, month: 9, day: 6, hour: 0, minute: 0, second: 0 }, tz)
    expect(r.kind).toBe('gap')
    const range = dayRange('2026-09-06', tz)
    // The day must still be 23 real hours, starting at 01:00 local.
    expect(toWallClock(range.start, tz).hour).toBe(1)
    expect(range.end - range.start).toBe(23 * HOUR)
  })

  it('America/Havana: local midnight happens twice on 2026-11-01', () => {
    const tz = 'America/Havana'
    const r = resolveWallClock({ year: 2026, month: 11, day: 1, hour: 0, minute: 0, second: 0 }, tz)
    expect(r.kind).toBe('ambiguous')
    const range = dayRange('2026-11-01', tz)
    expect(range.end - range.start).toBe(25 * HOUR)
  })

  it('monthRange covers a month whose first local midnight is in a gap', () => {
    // Asia/Gaza has historically transitioned at midnight on the 1st.
    const r = monthRange('2026-09', 'America/Santiago')
    expect(r.end).toBeGreaterThan(r.start)
    expect(toWallClock(r.start, 'America/Santiago').day).toBe(1)
  })

  it('Australia/Eucla +8:45 generates on-grid slots', () => {
    const tz = 'Australia/Eucla'
    const day = localDay('2026-06-15', tz)
    const slots = computeSlots({ eventType: eventType(), hosts: [host(tz)], range: day, now: day.start - DAY })
    expect(slots).toHaveLength(16)
    for (const s of slots) expect(s.start % BUCKET_MS).toBe(0)
  })

  it('localDatesBetween does not silently truncate a long range', () => {
    const from = localTimeToInstant('2026-01-01', 0, 'UTC')
    const to = localTimeToInstant('2029-01-01', 0, 'UTC')
    const dates = localDatesBetween(from, to, 'UTC')
    expect(dates[dates.length - 1]).toBe('2029-01-01')
  })
})

// ===========================================================================
// 7. Team logic
// ===========================================================================
describe('team logic across differing DST dates', () => {
  it('collective intersects correctly when only one zone has shifted', () => {
    // 2026-03-15: US already on DST, EU not yet.
    const tzk = 'Europe/Kyiv'
    const tzn = 'America/New_York'
    const range = { start: Date.UTC(2026, 2, 15), end: Date.UTC(2026, 2, 17) }
    const slots = computeSlots({
      eventType: eventType({ schedulingType: 'collective', ownerTeamId: 't', ownerUserId: null }),
      hosts: [host(tzk, [], 'h1'), host(tzn, [], 'h2')],
      range,
      now: Date.UTC(2026, 2, 1),
    })
    for (const s of slots) {
      const k = toWallClock(s.start, tzk)
      const n = toWallClock(s.start, tzn)
      expect(k.hour).toBeGreaterThanOrEqual(9)
      expect(n.hour).toBeGreaterThanOrEqual(9)
      expect(s.end).toBeLessThanOrEqual(localTimeToInstant(`2026-03-${String(k.day).padStart(2, '0')}`, 17 * 60, tzk))
    }
    expect(slots.length).toBeGreaterThan(0)
  })

  it('pickRoundRobinHost is deterministic', () => {
    const members: TeamMember[] = [
      { teamId: 't', userId: 'a', role: 'member', rrWeight: 1 },
      { teamId: 't', userId: 'b', role: 'member', rrWeight: 1 },
    ]
    const last = new Map<string, number>([['a', 100], ['b', 100]])
    const first = pickRoundRobinHost(['a', 'b'], members, last, 1000)
    for (let i = 0; i < 20; i++) {
      expect(pickRoundRobinHost(['b', 'a'], members, last, 1000)).toBe(first)
    }
  })
})
