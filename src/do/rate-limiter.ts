/**
 * `RateLimiter` — a token bucket in a Durable Object (ADR-0006 §3).
 *
 * Cloudflare's zone-level rate limiting is a paid product feature, and spec §8
 * requires the OSS deployment to need no paid plan, so the engine ships its
 * own.
 *
 * These are ABUSE limits, not plan quotas — uniform for every deployment,
 * generous enough that no legitimate team meets them, and raisable by the
 * operator who owns the deployment. That distinction is what keeps this from
 * being the gating mechanism ADR-0003 §4 refuses to put in public code.
 */

import { DurableObject } from 'cloudflare:workers'

export interface RateLimitResponse {
  allowed: boolean
  remaining: number
  resetAt: number
}

export class RateLimiter extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS buckets (
        key        TEXT PRIMARY KEY,
        tokens     REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        reset_at   INTEGER NOT NULL
      );
    `)
  }

  /**
   * Consume one token.
   *
   * Continuous refill rather than fixed windows: a fixed window lets a caller
   * spend the whole budget at 59s and again at 61s, doubling the intended rate
   * right at the boundary. Refilling proportionally to elapsed time has no
   * such edge.
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResponse> {
    const now = Date.now()
    const windowMs = windowSeconds * 1000
    const refillPerMs = limit / windowMs

    const row = this.ctx.storage.sql
      .exec<{ tokens: number; updated_at: number }>(
        'SELECT tokens, updated_at FROM buckets WHERE key = ?',
        key,
      )
      .toArray()[0]

    let tokens = row ? Math.min(limit, row.tokens + (now - row.updated_at) * refillPerMs) : limit

    const allowed = tokens >= 1
    if (allowed) tokens -= 1

    // Full refill time, so callers can send a meaningful Retry-After.
    const resetAt = now + Math.ceil(((limit - tokens) / limit) * windowMs)

    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO buckets (key,tokens,updated_at,reset_at) VALUES (?,?,?,?)',
      key,
      tokens,
      now,
      resetAt,
    )

    // Sweep idle buckets so storage does not grow without bound. Cheap because
    // it only runs when an alarm is not already pending.
    const current = await this.ctx.storage.getAlarm()
    if (current == null) await this.ctx.storage.setAlarm(now + 3_600_000)

    return { allowed, remaining: Math.floor(tokens), resetAt }
  }

  override async alarm(): Promise<void> {
    // A bucket untouched for an hour is at full tokens anyway, so dropping it
    // is equivalent to keeping it.
    this.ctx.storage.sql.exec('DELETE FROM buckets WHERE updated_at < ?', Date.now() - 3_600_000)
  }
}

/** Defaults; every one is overridable by the operator via config. */
export const RATE_LIMITS = {
  'magic-link:email': { limit: 5, windowSeconds: 3600 },
  'magic-link:ip': { limit: 20, windowSeconds: 3600 },
  'booking:ip': { limit: 10, windowSeconds: 3600 },
  'api:key': { limit: 600, windowSeconds: 60 },
  'hold:ip': { limit: 30, windowSeconds: 3600 },
} as const satisfies Record<string, { limit: number; windowSeconds: number }>
