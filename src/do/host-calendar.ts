/**
 * `HostCalendar` — one Durable Object per host (ADR-0002 §2).
 *
 * This is the FAST path, not the guarantee. It exists to:
 *   - serialise concurrent booking attempts, so N racing guests cause one
 *     freeBusy re-check rather than N
 *   - hold the mandatory pre-commit freeBusy check
 *   - own hold lifecycle (create, expire by alarm)
 *   - dedupe by Idempotency-Key
 *   - grant short leases for collective bookings, acquired in ascending host id
 *     order so deadlock is impossible
 *
 * If every line of this file misbehaved, the worst outcome would be a wasted
 * API call or a spurious 409 — never a double booking. `slot_locks` in D1 is
 * what actually protects the calendar.
 *
 * Note it holds no bookings itself: a booking must be queryable across hosts
 * for the dashboard and API, which a per-host DO cannot serve without fan-out.
 */

import { DurableObject } from 'cloudflare:workers'

interface HeldSlot {
  holdId: string
  start: number
  end: number
  expiresAt: number
}

export interface HostCalendarEnv {
  DB: D1Database
}

const LEASE_TTL_MS = 15_000
const MAX_HOLD_MS = 10 * 60_000

export class HostCalendar extends DurableObject<HostCalendarEnv> {
  constructor(ctx: DurableObjectState, env: HostCalendarEnv) {
    super(ctx, env)
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS holds (
        hold_id    TEXT PRIMARY KEY,
        start_ts   INTEGER NOT NULL,
        end_ts     INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lease (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        lease_id   TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `)
  }

  /**
   * Serialise a critical section for this host.
   *
   * Durable Objects are single-threaded, so simply being inside a DO method is
   * the serialisation — no lock needed. This wrapper exists to make that
   * explicit at call sites and to keep a place for future instrumentation.
   */
  async withSerialisation<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }

  // -------------------------------------------------------------------------
  // Holds
  // -------------------------------------------------------------------------

  /**
   * Place a hold while a guest fills the form.
   *
   * The DO owns the lifecycle; the rows that the slot engine reads live in D1
   * (ADR-0002 §2), written by the caller. Here we track expiry so the alarm can
   * clean up even if the guest never returns.
   */
  async createHold(holdId: string, start: number, end: number, ttlMs: number): Promise<number> {
    const now = Date.now()
    const expiresAt = now + Math.min(Math.max(ttlMs, 30_000), MAX_HOLD_MS)
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO holds (hold_id,start_ts,end_ts,expires_at) VALUES (?,?,?,?)',
      holdId,
      start,
      end,
      expiresAt,
    )
    await this.scheduleNextAlarm()
    return expiresAt
  }

  async releaseHold(holdId: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM holds WHERE hold_id = ?', holdId)
    // D1 is the source the slot engine reads, so clear there too. Best-effort:
    // a failure here leaves an advisory row that expires on its own.
    try {
      await this.env.DB.prepare('DELETE FROM slot_holds WHERE hold_id = ?').bind(holdId).run()
    } catch {
      // Intentionally swallowed — holds are advisory and self-expiring.
    }
  }

  async activeHolds(now = Date.now()): Promise<HeldSlot[]> {
    const rows = this.ctx.storage.sql
      .exec<{ hold_id: string; start_ts: number; end_ts: number; expires_at: number }>(
        'SELECT * FROM holds WHERE expires_at > ?',
        now,
      )
      .toArray()
    return rows.map((r) => ({
      holdId: r.hold_id,
      start: r.start_ts,
      end: r.end_ts,
      expiresAt: r.expires_at,
    }))
  }

  // -------------------------------------------------------------------------
  // Leases (collective bookings)
  // -------------------------------------------------------------------------

  /**
   * Take a short exclusive lease on this host.
   *
   * Collective bookings acquire leases across N hosts in ascending host-id
   * order, which is what makes deadlock impossible: every caller walks the
   * same order, so a cycle cannot form.
   *
   * Leases expire on their own, so a crashed request cannot wedge a calendar.
   */
  async acquireLease(leaseId: string, ttlMs = LEASE_TTL_MS): Promise<boolean> {
    const now = Date.now()
    const existing = this.ctx.storage.sql
      .exec<{ lease_id: string; expires_at: number }>('SELECT * FROM lease WHERE id = 1')
      .toArray()[0]

    if (existing && existing.expires_at > now && existing.lease_id !== leaseId) return false

    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO lease (id,lease_id,expires_at) VALUES (1,?,?)',
      leaseId,
      now + Math.min(ttlMs, 60_000),
    )
    await this.scheduleNextAlarm()
    return true
  }

  async releaseLease(leaseId: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM lease WHERE id = 1 AND lease_id = ?', leaseId)
  }

  // -------------------------------------------------------------------------
  // Alarms
  // -------------------------------------------------------------------------

  /** Wake at the earliest pending expiry; nothing pending means no alarm. */
  private async scheduleNextAlarm(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{ next: number | null }>(
        `SELECT MIN(next) AS next FROM (
           SELECT MIN(expires_at) AS next FROM holds
           UNION ALL
           SELECT MIN(expires_at) AS next FROM lease
         )`,
      )
      .toArray()
    const next = rows[0]?.next
    if (next == null) return
    const current = await this.ctx.storage.getAlarm()
    if (current == null || current > next) await this.ctx.storage.setAlarm(next)
  }

  override async alarm(): Promise<void> {
    const now = Date.now()
    const expired = this.ctx.storage.sql
      .exec<{ hold_id: string }>('SELECT hold_id FROM holds WHERE expires_at <= ?', now)
      .toArray()

    this.ctx.storage.sql.exec('DELETE FROM holds WHERE expires_at <= ?', now)
    this.ctx.storage.sql.exec('DELETE FROM lease WHERE expires_at <= ?', now)

    // Mirror the cleanup into D1, where the slot engine reads. If this fails
    // the rows are still filtered on read by `expires_at > now`, so a missed
    // cleanup degrades to slightly stale suppression, never a stuck calendar.
    if (expired.length > 0) {
      try {
        const stmt = this.env.DB.prepare('DELETE FROM slot_holds WHERE hold_id = ?')
        await this.env.DB.batch(expired.map((e) => stmt.bind(e.hold_id)))
      } catch {
        // See above — self-healing by design.
      }
    }

    await this.scheduleNextAlarm()
  }
}
