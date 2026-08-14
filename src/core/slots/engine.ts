/**
 * The slot engine (ADR-0004).
 *
 * Pure and deterministic: same inputs, same slots, always. No I/O, no clock —
 * `now` is passed in, which is what lets the DST matrix freeze time.
 *
 * The pipeline, in this order and no other:
 *   1. expand the weekly schedule over host-local dates (overrides replace days)
 *   2. resolve local windows to UTC instants, applying the DST rules
 *   3. subtract busy time (own bookings, holds, external calendars)
 *   4. walk a grid anchored at each free window's own start
 *   5. test each candidate against its buffered footprint
 *   6. apply min-notice and horizon
 *   7. apply the per-day cap, counted on host-local dates
 */

import type {
  Availability,
  DayWindow,
  EventType,
  Interval,
  Slot,
} from '../domain/types.js'
import {
  dayOfWeek,
  localDateString,
  localDatesBetween,
  localTimeToInstant,
} from '../time/zone.js'
import { intersectAll, mergeIntervals, subtractIntervals } from './intervals.js'

const MINUTE = 60_000
const DAY = 86_400_000

export interface HostAvailabilityInput {
  hostUserId: string
  availability: Availability
  /** Merged busy time: own bookings (already buffered), holds, external calendars. */
  busy: Interval[]
  /** Bookings already on each host-local date, for the per-day cap. */
  bookingsPerLocalDate?: Map<string, number>
}

export interface SlotQuery {
  eventType: EventType
  hosts: HostAvailabilityInput[]
  /** The window the guest is looking at. */
  range: Interval
  now: number
}

/**
 * The free time for one host, as UTC intervals, before any slot gridding.
 * Exported because collective needs to intersect these across hosts.
 */
export function freeIntervalsForHost(
  host: HostAvailabilityInput,
  range: Interval,
): Interval[] {
  const { availability } = host
  const tz = availability.timezone
  const overrides = new Map(availability.overrides.map((o) => [o.date, o.windows]))

  // Widen by a day on each side: a host-local day can start before the range
  // begins (or end after it finishes) and still contribute overlapping time.
  const dates = localDatesBetween(range.start - DAY, range.end + DAY, tz)

  const windows: Interval[] = []
  for (const date of dates) {
    // A date override replaces the whole day, including replacing it with none.
    const dayWindows: DayWindow[] = overrides.has(date)
      ? overrides.get(date)!
      : (availability.weekly[dayOfWeek(date)] ?? [])

    for (const w of dayWindows) {
      if (w.endMinute <= w.startMinute) continue
      const start = localTimeToInstant(date, w.startMinute, tz)
      const end = localTimeToInstant(date, w.endMinute, tz)
      // Clamping a gap can collapse a window to nothing (ADR-0004 §2).
      if (end > start) windows.push({ start, end })
    }
  }

  const merged = mergeIntervals(windows)
  const free = subtractIntervals(merged, host.busy)
  // Clip to the requested range last, so busy subtraction sees whole windows.
  return free
    .map((f) => ({ start: Math.max(f.start, range.start), end: Math.min(f.end, range.end) }))
    .filter((f) => f.end > f.start)
}

/**
 * Candidate starts inside a free window.
 *
 * The grid is anchored at the window's own start, not at the hour. A window
 * beginning 09:15 with 30-minute events yields 09:15, 09:45, 10:15 — never
 * 09:30. Anchoring to the window is what makes half-hour and 45-minute offset
 * zones behave predictably (ADR-0004 §3.4).
 */
function candidatesInWindow(
  window: Interval,
  durationMs: number,
  stepMs: number,
  bufferBeforeMs: number,
  bufferAfterMs: number,
): number[] {
  const out: number[] = []
  // The first candidate must leave room for its own leading buffer.
  let start = window.start + bufferBeforeMs
  // Guard against a pathological step; callers validate, this is belt and braces.
  if (stepMs <= 0) return out
  while (start + durationMs + bufferAfterMs <= window.end) {
    out.push(start)
    start += stepMs
  }
  return out
}

/** Free intervals per host, keyed by host id. */
export function freeByHost(query: SlotQuery): Map<string, Interval[]> {
  const map = new Map<string, Interval[]>()
  for (const host of query.hosts) {
    map.set(host.hostUserId, freeIntervalsForHost(host, query.range))
  }
  return map
}

/**
 * Compute bookable slots.
 *
 * Personal   — one host.
 * Collective — every member must be free; intersect, then grid once.
 * Round-robin — at least one member free; grid per host, then union by start.
 */
export function computeSlots(query: SlotQuery): Slot[] {
  const { eventType: et, now } = query
  if (!et.active || query.hosts.length === 0) return []

  const durationMs = et.durationMinutes * MINUTE
  const stepMs = (et.slotIntervalMinutes ?? et.durationMinutes) * MINUTE
  const bufferBeforeMs = et.bufferBeforeMinutes * MINUTE
  const bufferAfterMs = et.bufferAfterMinutes * MINUTE
  if (durationMs <= 0 || stepMs <= 0) return []

  // Policy bounds (ADR-0004 §3.6). Computed once, applied to every candidate.
  const earliest = now + et.minNoticeMinutes * MINUTE
  const latest = now + et.maxHorizonDays * DAY

  const free = freeByHost(query)

  if (et.schedulingType === 'collective') {
    // Every member must be free for the same instant, so intersect first and
    // grid the intersection once — gridding per host and intersecting starts
    // afterwards would produce different (wrong) anchors.
    const sets = query.hosts.map((h) => free.get(h.hostUserId) ?? [])
    const common = intersectAll(sets)
    const hostIds = query.hosts.map((h) => h.hostUserId)
    const slots: Slot[] = []
    for (const window of common) {
      for (const start of candidatesInWindow(window, durationMs, stepMs, bufferBeforeMs, bufferAfterMs)) {
        const end = start + durationMs
        if (start < earliest || start > latest) continue
        if (exceedsDailyCap(query.hosts, start, et)) continue
        slots.push({ start, end, eligibleHostIds: hostIds })
      }
    }
    return dedupeByStart(slots)
  }

  // Personal and round-robin: a candidate is eligible if any host can take it.
  const byStart = new Map<number, Slot>()
  for (const host of query.hosts) {
    const windows = free.get(host.hostUserId) ?? []
    const capMap = host.bookingsPerLocalDate
    const tz = host.availability.timezone
    for (const window of windows) {
      for (const start of candidatesInWindow(window, durationMs, stepMs, bufferBeforeMs, bufferAfterMs)) {
        if (start < earliest || start > latest) continue
        if (et.maxPerDay != null && capMap) {
          const used = capMap.get(localDateString(start, tz)) ?? 0
          if (used >= et.maxPerDay) continue
        }
        const existing = byStart.get(start)
        if (existing) {
          if (!existing.eligibleHostIds.includes(host.hostUserId)) {
            existing.eligibleHostIds.push(host.hostUserId)
          }
        } else {
          byStart.set(start, {
            start,
            end: start + durationMs,
            eligibleHostIds: [host.hostUserId],
          })
        }
      }
    }
  }

  return Array.from(byStart.values()).sort((a, b) => a.start - b.start)
}

/** Collective: the cap applies to every participating host. */
function exceedsDailyCap(
  hosts: HostAvailabilityInput[],
  start: number,
  et: EventType,
): boolean {
  if (et.maxPerDay == null) return false
  for (const host of hosts) {
    const used = host.bookingsPerLocalDate?.get(localDateString(start, host.availability.timezone)) ?? 0
    if (used >= et.maxPerDay) return true
  }
  return false
}

function dedupeByStart(slots: Slot[]): Slot[] {
  const seen = new Map<number, Slot>()
  for (const s of slots) if (!seen.has(s.start)) seen.set(s.start, s)
  return Array.from(seen.values()).sort((a, b) => a.start - b.start)
}

/**
 * The footprint a booking occupies: the meeting plus its buffers.
 *
 * This is the single definition shared by the slot generator and the
 * atomicity layer (ADR-0004 §4). The buckets locked at commit are exactly the
 * buckets tested at listing time, so a slot the engine offers is a slot the D1
 * batch will accept. Any divergence here surfaces as slots that 409 on click.
 */
export function bookingFootprint(
  start: number,
  end: number,
  et: Pick<EventType, 'bufferBeforeMinutes' | 'bufferAfterMinutes'>,
): Interval {
  return {
    start: start - et.bufferBeforeMinutes * MINUTE,
    end: end + et.bufferAfterMinutes * MINUTE,
  }
}

/**
 * Re-validate one slot at booking time.
 *
 * The listing was advisory (it may have come from a read replica, ADR-0007
 * §2); this runs inside the host's Durable Object against fresh data, before
 * the D1 batch that actually arbitrates.
 */
export function isSlotStillValid(
  host: HostAvailabilityInput,
  et: EventType,
  start: number,
  now: number,
): boolean {
  const end = start + et.durationMinutes * MINUTE
  const footprint = bookingFootprint(start, end, et)

  if (start < now + et.minNoticeMinutes * MINUTE) return false
  if (start > now + et.maxHorizonDays * DAY) return false

  if (et.maxPerDay != null) {
    const used = host.bookingsPerLocalDate?.get(localDateString(start, host.availability.timezone)) ?? 0
    if (used >= et.maxPerDay) return false
  }

  // Widen the probe range so the containing window is fully visible.
  const free = freeIntervalsForHost(host, {
    start: footprint.start - DAY,
    end: footprint.end + DAY,
  })
  return free.some((w) => footprint.start >= w.start && footprint.end <= w.end)
}
