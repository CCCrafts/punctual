/**
 * Interval algebra. Pure, allocation-conscious — this runs inside the <50 ms
 * CPU budget for a month of slots (spec §7).
 *
 * Every interval is half-open `[start, end)`.
 */

import type { Interval } from '../domain/types.js'

/** Sort by start, then merge anything overlapping or touching. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length <= 1) return intervals.slice()
  const sorted = intervals.slice().sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Interval[] = []
  let cur = { start: sorted[0]!.start, end: sorted[0]!.end }
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!
    // `<=` merges touching intervals too: [9,10) and [10,11) become [9,11),
    // which is what we want for busy time — there is no free gap between them.
    if (next.start <= cur.end) {
      if (next.end > cur.end) cur.end = next.end
    } else {
      out.push(cur)
      cur = { start: next.start, end: next.end }
    }
  }
  out.push(cur)
  return out
}

/** True when the two half-open intervals share any instant. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

/** True when `inner` lies entirely within `outer`. */
export function contains(outer: Interval, inner: Interval): boolean {
  return inner.start >= outer.start && inner.end <= outer.end
}

/**
 * `base` minus `subtract`. Both are merged first, then walked in parallel —
 * linear, not quadratic, because it runs per host per range.
 */
export function subtractIntervals(base: Interval[], subtract: Interval[]): Interval[] {
  if (subtract.length === 0) return mergeIntervals(base)
  const merged = mergeIntervals(base)
  const busy = mergeIntervals(subtract)
  const out: Interval[] = []

  for (const free of merged) {
    let cursor = free.start
    for (const b of busy) {
      if (b.end <= cursor) continue
      if (b.start >= free.end) break
      if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, free.end) })
      cursor = Math.max(cursor, b.end)
      if (cursor >= free.end) break
    }
    if (cursor < free.end) out.push({ start: cursor, end: free.end })
  }
  return out
}

/** Intersection of two interval sets. Used for collective availability. */
export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const A = mergeIntervals(a)
  const B = mergeIntervals(b)
  const out: Interval[] = []
  let i = 0
  let j = 0
  while (i < A.length && j < B.length) {
    const x = A[i]!
    const y = B[j]!
    const start = Math.max(x.start, y.start)
    const end = Math.min(x.end, y.end)
    if (start < end) out.push({ start, end })
    if (x.end < y.end) i++
    else j++
  }
  return out
}

/** Intersection across N sets. Empty input means empty result, not "everything". */
export function intersectAll(sets: Interval[][]): Interval[] {
  if (sets.length === 0) return []
  let acc = mergeIntervals(sets[0]!)
  for (let i = 1; i < sets.length && acc.length > 0; i++) {
    acc = intersectIntervals(acc, sets[i]!)
  }
  return acc
}

export function unionAll(sets: Interval[][]): Interval[] {
  const all: Interval[] = []
  for (const s of sets) all.push(...s)
  return mergeIntervals(all)
}

// ---------------------------------------------------------------------------
// Bucket conversion (ADR-0002 §1)
// ---------------------------------------------------------------------------

/** The 5-minute grid the anti-double-booking invariant is written on. */
export const BUCKET_MS = 5 * 60_000

/**
 * The buckets an interval occupies.
 *
 * Floors the start and ceils the end, so a booking always claims every bucket
 * it touches even partially. Claiming too many is safe (it blocks a slot that
 * could not have been offered anyway, since durations are multiples of 5);
 * claiming too few would permit a real overlap, which is the failure this
 * whole design exists to prevent.
 */
export function intervalToBuckets(interval: Interval): number[] {
  if (interval.end <= interval.start) return []
  const first = Math.floor(interval.start / BUCKET_MS) * BUCKET_MS
  const last = Math.ceil(interval.end / BUCKET_MS) * BUCKET_MS
  const out: number[] = []
  for (let t = first; t < last; t += BUCKET_MS) out.push(t)
  return out
}

/** Buckets back to merged intervals, for feeding the slot engine's busy set. */
export function bucketsToIntervals(buckets: number[]): Interval[] {
  if (buckets.length === 0) return []
  const sorted = buckets.slice().sort((a, b) => a - b)
  const out: Interval[] = []
  let start = sorted[0]!
  let prev = start
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i]!
    if (b === prev) continue
    if (b === prev + BUCKET_MS) {
      prev = b
      continue
    }
    out.push({ start, end: prev + BUCKET_MS })
    start = b
    prev = b
  }
  out.push({ start, end: prev + BUCKET_MS })
  return out
}
