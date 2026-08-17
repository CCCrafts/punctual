import { describe, expect, it } from 'vitest'
import {
  dayOfWeek,
  localDateString,
  localDatesBetween,
  localTimeToInstant,
  offsetAt,
  offsetLabel,
  parseLocalDate,
  resolveWallClock,
  toWallClock,
  wallClockToInstant,
} from '../../src/core/time/zone.js'

const HOUR = 3_600_000
const MINUTE = 60_000

/**
 * These zones are chosen to cover structurally different failure modes rather
 * than to be numerous (ADR-0004 test matrix). Lord Howe and Chatham exist here
 * specifically because a partial-ICU build or whole-hour-offset assumption
 * fails silently on them rather than throwing.
 */
describe('offsetAt', () => {
  it('handles whole-hour offsets', () => {
    // 2026-01-15T12:00Z — New York on standard time, UTC-5
    expect(offsetAt(Date.UTC(2026, 0, 15, 12), 'America/New_York')).toBe(-5 * HOUR)
    // July — daylight time, UTC-4
    expect(offsetAt(Date.UTC(2026, 6, 15, 12), 'America/New_York')).toBe(-4 * HOUR)
  })

  it('handles half-hour offsets (Kolkata, no DST)', () => {
    expect(offsetAt(Date.UTC(2026, 0, 15, 12), 'Asia/Kolkata')).toBe(5 * HOUR + 30 * MINUTE)
    expect(offsetAt(Date.UTC(2026, 6, 15, 12), 'Asia/Kolkata')).toBe(5 * HOUR + 30 * MINUTE)
  })

  it('handles 45-minute offsets (Chatham) — breaks whole/half-hour assumptions', () => {
    const jan = offsetAt(Date.UTC(2026, 0, 15, 12), 'Pacific/Chatham')
    const jul = offsetAt(Date.UTC(2026, 6, 15, 12), 'Pacific/Chatham')
    expect(jan).toBe(13 * HOUR + 45 * MINUTE) // NZDT +13:45
    expect(jul).toBe(12 * HOUR + 45 * MINUTE) // NZST +12:45
  })

  it('handles the 30-minute DST shift (Lord Howe)', () => {
    const jan = offsetAt(Date.UTC(2026, 0, 15, 12), 'Australia/Lord_Howe')
    const jul = offsetAt(Date.UTC(2026, 6, 15, 12), 'Australia/Lord_Howe')
    expect(jan).toBe(11 * HOUR) // +11:00 in DST
    expect(jul).toBe(10 * HOUR + 30 * MINUTE) // +10:30 standard
    expect(jan - jul).toBe(30 * MINUTE) // the shift itself is 30 minutes, not 60
  })

  it('is exact on non-integral-second instants', () => {
    const ts = Date.UTC(2026, 0, 15, 12, 0, 0) + 500
    expect(offsetAt(ts, 'Europe/Kyiv')).toBe(2 * HOUR)
  })
})

describe('resolveWallClock — the two days a year that matter', () => {
  it('normal times resolve to exactly one instant', () => {
    const r = resolveWallClock(
      { year: 2026, month: 6, day: 15, hour: 9, minute: 0, second: 0 },
      'Europe/Kyiv',
    )
    expect(r.kind).toBe('normal')
  })

  it('detects the spring-forward gap (Kyiv 2026-03-29 03:00→04:00)', () => {
    const r = resolveWallClock(
      { year: 2026, month: 3, day: 29, hour: 3, minute: 30, second: 0 },
      'Europe/Kyiv',
    )
    expect(r.kind).toBe('gap')
    if (r.kind === 'gap') {
      // The transition instant is 01:00 UTC; local jumps 03:00 → 04:00.
      expect(r.instant).toBe(Date.UTC(2026, 2, 29, 1, 0, 0))
      expect(toWallClock(r.instant, 'Europe/Kyiv').hour).toBe(4)
    }
  })

  it('detects the fall-back repeated hour (Kyiv 2026-10-25 04:00→03:00)', () => {
    // Verified empirically: the EU transition fires at 01:00 UTC, and Kyiv
    // (EEST +3 → EET +2) repeats 03:00–04:00 local — NOT 02:00–03:00, which is
    // the intuitive-but-wrong guess.
    const r = resolveWallClock(
      { year: 2026, month: 10, day: 25, hour: 3, minute: 30, second: 0 },
      'Europe/Kyiv',
    )
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') {
      expect(r.second - r.first).toBe(HOUR)
      expect(r.first).toBe(Date.UTC(2026, 9, 25, 0, 30))
      expect(r.second).toBe(Date.UTC(2026, 9, 25, 1, 30))
      // Both really do read as 03:30 locally — that is what ambiguity means.
      expect(toWallClock(r.first, 'Europe/Kyiv').hour).toBe(3)
      expect(toWallClock(r.second, 'Europe/Kyiv').hour).toBe(3)
    }
    // 02:30 that morning is perfectly ordinary — the hour before the repeat.
    expect(
      resolveWallClock({ year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 }, 'Europe/Kyiv').kind,
    ).toBe('normal')
  })

  it('detects the US gap on a different date than the EU one', () => {
    // US springs forward 2026-03-08, three weeks before the EU.
    const us = resolveWallClock(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      'America/New_York',
    )
    expect(us.kind).toBe('gap')
    // The same wall clock in Kyiv that day is perfectly ordinary.
    const eu = resolveWallClock(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      'Europe/Kyiv',
    )
    expect(eu.kind).toBe('normal')
  })

  it('detects the 30-minute gap on Lord Howe', () => {
    // Lord Howe springs forward by 30 minutes: 02:00 → 02:30 on 2026-10-04.
    const r = resolveWallClock(
      { year: 2026, month: 10, day: 4, hour: 2, minute: 15, second: 0 },
      'Australia/Lord_Howe',
    )
    expect(r.kind).toBe('gap')
  })

  it('southern hemisphere: transitions run the other way within the year', () => {
    // April is the fall-back direction in Sydney.
    const r = resolveWallClock(
      { year: 2026, month: 4, day: 5, hour: 2, minute: 30, second: 0 },
      'Australia/Sydney',
    )
    expect(r.kind).toBe('ambiguous')
  })
})

describe('wallClockToInstant — the project rule (ADR-0004 §2)', () => {
  it('clamps a gap forward to the transition instant', () => {
    const ts = wallClockToInstant(
      { year: 2026, month: 3, day: 29, hour: 3, minute: 30, second: 0 },
      'Europe/Kyiv',
    )
    expect(toWallClock(ts, 'Europe/Kyiv').hour).toBe(4)
    expect(toWallClock(ts, 'Europe/Kyiv').minute).toBe(0)
  })

  it('takes the FIRST occurrence when ambiguous', () => {
    const wc = { year: 2026, month: 10, day: 25, hour: 3, minute: 30, second: 0 }
    const r = resolveWallClock(wc, 'Europe/Kyiv')
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') {
      expect(wallClockToInstant(wc, 'Europe/Kyiv')).toBe(r.first)
    }
  })

  it('round-trips normal times exactly', () => {
    for (const tz of ['Europe/Kyiv', 'America/New_York', 'Asia/Kolkata', 'Pacific/Chatham']) {
      const wc = { year: 2026, month: 6, day: 15, hour: 14, minute: 30, second: 0 }
      const back = toWallClock(wallClockToInstant(wc, tz), tz)
      expect({ tz, ...back }).toEqual({ tz, ...wc })
    }
  })
})

describe('localTimeToInstant', () => {
  it('resolves minutes-from-midnight in the host zone', () => {
    const ts = localTimeToInstant('2026-06-15', 9 * 60, 'Europe/Kyiv')
    const wc = toWallClock(ts, 'Europe/Kyiv')
    expect([wc.hour, wc.minute]).toEqual([9, 0])
  })

  it('rolls minutes past midnight into the next day (overnight windows)', () => {
    // 26:00 = 02:00 the following day.
    const ts = localTimeToInstant('2026-06-15', 26 * 60, 'Europe/Kyiv')
    const wc = toWallClock(ts, 'Europe/Kyiv')
    expect([wc.day, wc.hour]).toEqual([16, 2])
  })

  it('a window spanning a spring-forward loses the missing hour in real time', () => {
    // 01:00 → 05:00 local on the Kyiv transition day is only 3 real hours,
    // because 03:00–04:00 never happens.
    const start = localTimeToInstant('2026-03-29', 60, 'Europe/Kyiv')
    const end = localTimeToInstant('2026-03-29', 5 * 60, 'Europe/Kyiv')
    expect(end - start).toBe(3 * HOUR)
  })

  it('a window spanning a fall-back gains an hour in real time', () => {
    // 01:00 → 04:00 local on the Kyiv fall-back day is 4 real hours: the
    // repeated hour genuinely falls inside the window (ADR-0004 §2).
    const start = localTimeToInstant('2026-10-25', 60, 'Europe/Kyiv')
    const end = localTimeToInstant('2026-10-25', 4 * 60, 'Europe/Kyiv')
    expect(end - start).toBe(4 * HOUR)
  })

  it('handles Lord Howe 30-minute transitions in window arithmetic', () => {
    const start = localTimeToInstant('2026-10-04', 60, 'Australia/Lord_Howe')
    const end = localTimeToInstant('2026-10-04', 5 * 60, 'Australia/Lord_Howe')
    expect(end - start).toBe(3 * HOUR + 30 * MINUTE) // 4 local hours minus the 30-min jump
  })
})

describe('date helpers', () => {
  it('localDateString reads the date in the target zone, not UTC', () => {
    // 2026-06-15T23:30Z is already the 16th in Kyiv (+3).
    const ts = Date.UTC(2026, 5, 15, 23, 30)
    expect(localDateString(ts, 'Europe/Kyiv')).toBe('2026-06-16')
    expect(localDateString(ts, 'America/New_York')).toBe('2026-06-15')
  })

  it('parseLocalDate rejects dates that do not exist', () => {
    expect(parseLocalDate('2026-02-30')).toBeNull()
    expect(parseLocalDate('2026-13-01')).toBeNull()
    expect(parseLocalDate('nonsense')).toBeNull()
    expect(parseLocalDate('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 })
  })

  it('localDatesBetween walks calendar dates, including across a DST day', () => {
    const from = localTimeToInstant('2026-03-28', 12 * 60, 'Europe/Kyiv')
    const to = localTimeToInstant('2026-03-31', 12 * 60, 'Europe/Kyiv')
    expect(localDatesBetween(from, to, 'Europe/Kyiv')).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
    ])
  })

  it('localDatesBetween throws instead of silently truncating an oversized range', () => {
    // ~3 years, well past the 800-day guard — must fail loudly, not return a
    // short list, since this is reachable directly by callers who skip the
    // HTTP layer's MAX_SLOT_RANGE_MS cap.
    const from = localTimeToInstant('2026-01-01', 12 * 60, 'UTC')
    const to = localTimeToInstant('2029-01-01', 12 * 60, 'UTC')
    expect(() => localDatesBetween(from, to, 'UTC')).toThrow(/range too large/)
  })

  it('dayOfWeek indexes Sunday as 0, matching WeeklySchedule', () => {
    expect(dayOfWeek('2026-08-16')).toBe(0) // Sunday
    expect(dayOfWeek('2026-08-17')).toBe(1) // Monday
    expect(dayOfWeek('2026-08-22')).toBe(6) // Saturday
  })

  it('offsetLabel renders 45-minute offsets readably', () => {
    expect(offsetLabel(Date.UTC(2026, 6, 15, 12), 'Pacific/Chatham')).toBe('GMT+12:45')
    expect(offsetLabel(Date.UTC(2026, 0, 15, 12), 'America/New_York')).toBe('GMT-5')
  })
})
