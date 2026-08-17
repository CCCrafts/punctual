/**
 * Timezone arithmetic (ADR-0004 §1–§2).
 *
 * Pure. No Cloudflare imports, no Date.now() — the caller supplies `now` from
 * the Clock port so the DST matrix can freeze time.
 *
 * Everything here exists to answer one question correctly: given a wall-clock
 * time in an IANA zone, which instant is it? On two days a year that question
 * has either no answer or two, and the whole slot engine rests on handling
 * those two days deliberately rather than accidentally.
 */

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** Formatter construction is the expensive part, so keep them. */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timeZone, f)
  }
  return f
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export interface WallClock {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number
  second: number
}

/** The wall-clock reading in `timeZone` at instant `ts`. */
export function toWallClock(ts: number, timeZone: string): WallClock {
  const parts = partsFormatter(timeZone).formatToParts(new Date(ts))
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type)
    return p ? Number(p.value) : 0
  }
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/**
 * The zone's UTC offset in milliseconds at instant `ts`.
 *
 * Derived by formatting the instant in the zone, reading it back as if it were
 * UTC, and taking the difference. This works for every offset — including the
 * 45-minute ones (Chatham +12:45) that break any implementation assuming whole
 * or half hours.
 */
export function offsetAt(ts: number, timeZone: string): number {
  const wc = toWallClock(ts, timeZone)
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second)
  // Round to the second: formatToParts truncates sub-second, and without this
  // the offset drifts by up to 999ms for non-integral-second instants.
  return asUtc - Math.floor(ts / 1000) * 1000
}

/** How a wall-clock time maps onto the timeline. */
export type Resolution =
  | { kind: 'normal'; instant: number }
  /** Spring forward: the local time does not exist. `instant` is the transition. */
  | { kind: 'gap'; instant: number }
  /** Fall back: the local time happens twice. */
  | { kind: 'ambiguous'; first: number; second: number }

/**
 * Resolve a wall-clock time in a zone to an instant, reporting which of the
 * three cases applies. Callers pick a policy; `wallClockToInstant` below
 * applies the project's (ADR-0004 §2).
 *
 * Method: guess using the offsets slightly before and after the target, then
 * verify by formatting the candidate back. A candidate is real only if it
 * round-trips to the requested wall clock — that check is what detects gaps,
 * and collecting distinct valid candidates is what detects ambiguity.
 */
export function resolveWallClock(wc: WallClock, timeZone: string): Resolution {
  const target = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second)

  // Offsets can differ on either side of a transition; probe both.
  const offBefore = offsetAt(target - DAY, timeZone)
  const offAfter = offsetAt(target + DAY, timeZone)

  const candidates = new Set<number>([target - offBefore, target - offAfter])
  const valid: number[] = []
  for (const c of candidates) {
    if (sameWallClock(toWallClock(c, timeZone), wc)) valid.push(c)
  }
  valid.sort((a, b) => a - b)

  if (valid.length === 1) return { kind: 'normal', instant: valid[0]! }
  if (valid.length >= 2) return { kind: 'ambiguous', first: valid[0]!, second: valid[valid.length - 1]! }

  // No candidate round-trips: the wall-clock time does not exist. Find the
  // transition instant by bisecting between the two offsets, then clamp to it.
  const lo = target - Math.max(offBefore, offAfter)
  const hi = target - Math.min(offBefore, offAfter)
  return { kind: 'gap', instant: findTransition(lo, hi, timeZone) }
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  )
}

/** Bisect to the minute for the instant where the offset changes. */
function findTransition(lo: number, hi: number, timeZone: string): number {
  const startOffset = offsetAt(lo, timeZone)
  let low = lo
  let high = hi
  while (high - low > MINUTE) {
    const mid = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE
    if (mid <= low || mid >= high) break
    if (offsetAt(mid, timeZone) === startOffset) low = mid
    else high = mid
  }
  return high
}

/**
 * The project's rule (ADR-0004 §2), applied uniformly to window starts and ends:
 *
 *   gap       → clamp forward to the transition instant
 *   ambiguous → take the first (earlier) occurrence
 *
 * Applying "first occurrence" to both boundaries is what keeps the rule
 * coherent: a 01:00–03:00 window on a fall-back day becomes a three-hour UTC
 * interval, because the repeated hour genuinely falls inside it and the host is
 * genuinely available for it.
 */
export function wallClockToInstant(wc: WallClock, timeZone: string): number {
  const r = resolveWallClock(wc, timeZone)
  switch (r.kind) {
    case 'normal':
      return r.instant
    case 'gap':
      return r.instant
    case 'ambiguous':
      return r.first
  }
}

/** `YYYY-MM-DD` as read in `timeZone`. */
export function localDateString(ts: number, timeZone: string): string {
  const wc = toWallClock(ts, timeZone)
  return `${pad4(wc.year)}-${pad2(wc.month)}-${pad2(wc.day)}`
}

export function parseLocalDate(date: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  // Reject dates that do not exist (2026-02-30 parses but is not real).
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  return { year, month, day }
}

const MAX_LOCAL_DATES = 800

/**
 * Local dates from `from` to `to` inclusive, as seen in `timeZone`.
 * Walks by calendar date rather than by adding 24h, because DST days are not
 * 24 hours long.
 *
 * Throws rather than truncating when the span exceeds `MAX_LOCAL_DATES` —
 * this is a public building block (via `freeIntervalsForHost`) that callers
 * may invoke directly, without the HTTP layer's `MAX_SLOT_RANGE_MS` cap in
 * front of it. A silently short list is a wrong answer; a thrown error is not.
 */
export function localDatesBetween(from: number, to: number, timeZone: string): string[] {
  const out: string[] = []
  const first = localDateString(from, timeZone)
  const last = localDateString(to, timeZone)
  let cursor = parseLocalDate(first)!
  let guard = 0
  for (;;) {
    const s = `${pad4(cursor.year)}-${pad2(cursor.month)}-${pad2(cursor.day)}`
    out.push(s)
    if (s >= last) break
    if (++guard > MAX_LOCAL_DATES) {
      throw new Error(`localDatesBetween: range too large (over ${MAX_LOCAL_DATES} days)`)
    }
    const next = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day + 1))
    cursor = {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
    }
  }
  return out
}

/** Day of week for a local date. 0 = Sunday, matching WeeklySchedule's indexing. */
export function dayOfWeek(date: string): number {
  const p = parseLocalDate(date)
  if (!p) return 0
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

/**
 * The instant of `minutesFromMidnight` on local `date` in `timeZone`.
 *
 * Minutes past 1440 roll into the following day — a window ending at 24:00
 * means local midnight, and overnight windows (22:00–02:00) express the end as
 * 1560. Rolling by calendar date rather than by adding milliseconds is what
 * keeps this correct across a transition.
 */
export function localTimeToInstant(date: string, minutesFromMidnight: number, timeZone: string): number {
  const p = parseLocalDate(date)
  if (!p) throw new Error(`invalid date: ${date}`)
  const dayOffset = Math.floor(minutesFromMidnight / 1440)
  const within = minutesFromMidnight - dayOffset * 1440
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset))
  return wallClockToInstant(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: Math.floor(within / 60),
      minute: within % 60,
      second: 0,
    },
    timeZone,
  )
}

/** Formatting helper for UI and .ics rendering. */
export function formatInZone(
  ts: number,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'short' },
  locale = 'en-US',
): string {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone }).format(new Date(ts))
}

/** e.g. `GMT+5:45`. Used where the offset itself matters to the reader. */
export function offsetLabel(ts: number, timeZone: string): string {
  const off = offsetAt(ts, timeZone)
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const h = Math.floor(abs / HOUR)
  const m = Math.floor((abs % HOUR) / MINUTE)
  return m === 0 ? `GMT${sign}${h}` : `GMT${sign}${h}:${pad2(m)}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

export const TIME = { MINUTE, HOUR, DAY } as const
