/**
 * The `Cache` port over Workers KV.
 *
 * THIS CACHE HOLDS EXTERNAL-CALENDAR freeBusy AND NOTHING ELSE (ADR-0006 §1).
 *
 * Own bookings and holds are always read from D1 (`slot_locks`, `slot_holds`).
 * KV is eventually consistent and propagates "up to 60 seconds or more", and
 * our own writes are precisely the ones users notice immediately — book a slot,
 * reload, it must be gone. Provider data is the part we cannot make
 * authoritative anyway, and it is re-checked before commit inside the
 * HostCalendar DO, which is what makes a stale entry survivable: it can only
 * make a free slot look busy, never the reverse.
 *
 * Putting a booking or a hold through this adapter is a review-blocking defect.
 */

import type { Cache } from '../../ports.js'

/**
 * Cloudflare KV rejects an `expirationTtl` below 60 seconds. The ADR-0006 §1
 * freeBusy TTL is exactly 60, so callers are already at the floor; clamping
 * here means a caller asking for a shorter TTL gets a working cache instead of
 * a runtime error, and the clamp is honest about what KV can actually deliver.
 */
const MIN_TTL_SECONDS = 60

export function createKvCache(kv: KVNamespace): Cache {
  return {
    async get<T>(key: string): Promise<T | null> {
      // KV's own 'json' mode parses in the runtime rather than in our isolate.
      return await kv.get<T>(key, 'json')
    },

    async put<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      await kv.put(key, JSON.stringify(value), {
        expirationTtl: Math.max(MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
      })
    },

    async delete(key: string): Promise<void> {
      // Best-effort by design: a delete that has not propagated is harmless
      // (ADR-0006 §1), so callers never need to await consistency here.
      await kv.delete(key)
    },
  }
}
