/**
 * The RateLimiter port, backed by the DO (ADR-0006 §3).
 *
 * Fails OPEN. If the DO is unreachable the request is allowed, because a
 * scheduler that stops taking bookings when its rate limiter has a bad minute
 * is worse than one that briefly under-enforces an abuse limit. These are
 * abuse limits, not correctness invariants — `slot_locks` is what protects the
 * calendar, and it is unaffected by any of this.
 */

import type { RateLimiter, RateLimitResult } from '../ports.js'

export function createRateLimiterAdapter(namespace: DurableObjectNamespace): RateLimiter {
  return {
    async check(scope, identifier, limit, windowSeconds): Promise<RateLimitResult> {
      const key = `${scope}:${identifier}`
      try {
        // Shard by key so one DO does not serialise every request in the world.
        const stub = namespace.get(namespace.idFromName(key)) as unknown as {
          consume(k: string, l: number, w: number): Promise<RateLimitResult>
        }
        return await stub.consume(key, limit, windowSeconds)
      } catch {
        return { allowed: true, remaining: limit, resetAt: Date.now() + windowSeconds * 1000 }
      }
    },
  }
}
