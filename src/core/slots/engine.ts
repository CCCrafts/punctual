/**
 * The slot engine (ADR-0004).
 *
 * Pure and deterministic: same inputs, same slots, always. No I/O, no clock —
 * `now` is passed in, which is what lets the DST matrix freeze time.
 *
 * The pipeline, in this order and no other:
 *   1. expand the weekly schedule over host-local dates (overrides replace days)
 *   2. resolve local windows to UTC instants, applying the DST rules
 *   3. walk a grid anchored at each raw availability window's own start
 *   4. filter each candidate against the caller's query range
 *   5. filter each candidate whose buffered footprint collides with busy time
 *      (own bookings, holds, external calendars) — busy time never influences
 *      which windows exist or where the grid anchors, only which generated
 *      candidates survive
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
import { BUCKET_MS, intersectAll, mergeIntervals, overlapsAny } from './intervals.js'

const MINUTE = 60_000
const DAY = 86_400_000

export interface HostAvailabilityInput {
  hostUserId: string
  /**
   * Collective only. A required host (the default) must be free for a slot
   * to exist; an optional host never constrains the listing and is included
   * in a slot's `eligibleHostIds` only when free for it. See
   * `EventTypeHost.required`.
   */
  required?: boolean
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
 * The free-of-schedule-gaps time for one host, as UTC intervals — the raw
 * AVAILABILITY windows, busy-agnostic. Exported because collective needs to
 * intersect these across hosts.
 *
 * Deliberately does NOT subtract `host.busy`. Busy time is applied later, per
 * candidate, as a pure filter (see `overlapsAny` in `computeSlots`) — never as
 * an input to which windows exist or where they start. Subtracting busy time
 * here used to split a window into pieces at each busy interval's edges, and
 * `candidatesInWindow` anchors the grid at each piece's OWN start — so which
 * pieces existed, and therefore where the grid landed, depended on which busy
 * intervals a particular query happened to load. A narrow query (which only
 * loads busy data near its own edges, per the widening below) could miss an
 * earlier conflict a broader query would see, so the two would split the
 * window differently and grid later, otherwise-identical candidates at
 * different offsets. Keeping this function busy-agnostic makes the grid
 * depend only on the availability schedule — deterministic regardless of
 * which busy data a given query happened to load.
 *
 * Windows are returned at their own natural boundaries — NOT clipped to
 * `range`. Two adjacent per-day windows that touch at midnight (say, one day
 * ending 24:00 and the next starting 00:00) merge into a single continuous
 * overnight window, and its natural start (e.g. 22:00 the day before) has to
 * survive so `candidatesInWindow` anchors the grid there — not at wherever
 * the caller's `range` happens to begin. Anchoring to a range-clipped start
 * made the grid depend on which endpoint asked (a single day vs. a month),
 * so the same underlying availability advertised different slot times
 * depending on the query. Callers that need the result bounded to `range`
 * must filter the generated candidates afterward, not clip these windows.
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

  return mergeIntervals(windows)
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
  if (stepMs <= 0) return out

  // The grid is anchored at the WINDOW start (ADR-0004 §3.4) and snapped UP to
  // the 5-minute bucket grid.
  //
  // The snap is what keeps the generator/arbiter contract (§4) true. A free
  // window can begin on any minute — external freeBusy returns raw provider
  // timestamps — and without snapping, two adjacent offered slots can bucket
  // onto a SHARED bucket. `slot_locks` has a primary key on
  // (host, bucket_start), so the second guest would get a hard 409 on a slot
  // we had just offered, and merely opening the form on the first would remove
  // the second from everyone else's listing.
  //
  // Buffers FILTER candidates; they do not move the anchor (§3.5).
  let start = Math.ceil(window.start / BUCKET_MS) * BUCKET_MS

  while (start + durationMs + bufferAfterMs <= window.end) {
    if (start - bufferBeforeMs >= window.start) out.push(start)
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
  const { eventType: et, now, range } = query
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
    // Every REQUIRED host must be free for the same instant, so intersect
    // their windows first and grid the intersection once — gridding per host
    // and intersecting starts afterwards would produce different (wrong)
    // anchors. Optional hosts never narrow the listing: they are checked per
    // candidate and named in it when free, left out when not.
    const required = query.hosts.filter((h) => h.required !== false)
    const optional = query.hosts.filter((h) => h.required === false)
    if (required.length === 0) return []
    const sets = required.map((h) => free.get(h.hostUserId) ?? [])
    const common = intersectAll(sets)
    const slots: Slot[] = []
    for (const window of common) {
      for (const start of candidatesInWindow(window, durationMs, stepMs, bufferBeforeMs, bufferAfterMs)) {
        // The grid was walked on the window's own unclipped, busy-agnostic
        // boundaries (see freeIntervalsForHost); the caller's range is
        // applied here, last, as a pure filter — it must never influence the
        // anchor.
        if (start < range.start || start >= range.end) continue
        const end = start + durationMs
        if (start < earliest || start > latest) continue
        if (exceedsDailyCap(required, start, et)) continue
        // A collective candidate is only valid if EVERY required host is
        // free for it — check each host's own busy set against the
        // candidate's own footprint, not the intersected window.
        const footprint = bookingFootprint(start, end, et)
        if (required.some((h) => overlapsAny(footprint, h.busy))) continue
        const joining = optional.filter(
          (h) => isSlotStillValid(h, et, start, now) && !exceedsDailyCap([h], start, et),
        )
        slots.push({ start, end, eligibleHostIds: [...required, ...joining].map((h) => h.hostUserId) })
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
        // Same rule as the collective branch: filter by range after
        // gridding the natural, busy-agnostic window, never before.
        if (start < range.start || start >= range.end) continue
        if (start < earliest || start > latest) continue
        if (et.maxPerDay != null && capMap) {
          const used = capMap.get(localDateString(start, tz)) ?? 0
          if (used >= et.maxPerDay) continue
        }
        const end = start + durationMs
        // Busy time is a per-candidate filter, checked against this host's
        // own busy set and this candidate's own buffered footprint — never
        // an input to how the window was split or where the grid anchored.
        const footprint = bookingFootprint(start, end, et)
        if (overlapsAny(footprint, host.busy)) continue
        const existing = byStart.get(start)
        if (existing) {
          if (!existing.eligibleHostIds.includes(host.hostUserId)) {
            existing.eligibleHostIds.push(host.hostUserId)
          }
        } else {
          byStart.set(start, {
            start,
            end,
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
  // A start off the 5-minute grid was never offered, and would claim buckets
  // that straddle two legitimately-offered slots — blocking both. The client
  // supplies `start` directly, so this must be checked here rather than
  // trusted from the listing.
  if (start % BUCKET_MS !== 0) return false

  const end = start + et.durationMinutes * MINUTE
  const footprint = bookingFootprint(start, end, et)

  if (start < now + et.minNoticeMinutes * MINUTE) return false
  if (start > now + et.maxHorizonDays * DAY) return false

  if (et.maxPerDay != null) {
    const used = host.bookingsPerLocalDate?.get(localDateString(start, host.availability.timezone)) ?? 0
    if (used >= et.maxPerDay) return false
  }

  // Widen the probe range so the containing window is fully visible.
  // `freeIntervalsForHost` is busy-agnostic now (it only returns the raw
  // availability schedule), so busy time must be checked separately — the
  // footprint must both fit inside an availability window AND not collide
  // with anything in the host's busy set.
  const free = freeIntervalsForHost(host, {
    start: footprint.start - DAY,
    end: footprint.end + DAY,
  })
  const insideAvailability = free.some((w) => footprint.start >= w.start && footprint.end <= w.end)
  if (!insideAvailability) return false
  return !overlapsAny(footprint, host.busy)
}
