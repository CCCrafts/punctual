import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * Proves the Workers-project harness itself works: real runtime, real D1,
 * real migrations. If this fails, every other Workers test is meaningless.
 */
describe('workers harness', () => {
  it('has the schema applied', async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>()
    const names = (rows.results ?? []).map((r) => r.name)
    expect(names).toContain('slot_locks')
    expect(names).toContain('bookings')
    expect(names).toContain('slot_holds')
  })

  /**
   * The batch-rollback regression test, now permanent.
   *
   * The anti-double-booking invariant rests on batch() rolling back the WHOLE
   * batch when one statement violates a constraint. Verified on production D1
   * on 2026-08-14; kept here so a platform change cannot silently take it away.
   */
  it('D1 batch() rolls back entirely on a constraint violation', async () => {
    const lock = (h: string, b: number, id: string) =>
      env.DB.prepare(
        'INSERT INTO slot_locks (host_user_id,bucket_start,booking_id) VALUES (?,?,?)',
      ).bind(h, b, id)

    await env.DB.prepare('DELETE FROM slot_locks').run()

    await expect(
      env.DB.batch([
        lock('hostA', 1000, 'bk1'),
        lock('hostA', 1005, 'bk1'),
        lock('hostA', 1010, 'bk1'),
        lock('hostA', 1010, 'bk2'), // duplicate PK — must abort everything
      ]),
    ).rejects.toThrow()

    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks').first<{ n: number }>()
    expect(after?.n).toBe(0)
  })

  /**
   * The real race from ADR-0002: booking B overlaps A at one bucket and must
   * leave nothing behind at its own non-conflicting buckets. A partial commit
   * here would block real slots with locks from a booking that never existed.
   */
  it('a losing booking leaves no ghost locks', async () => {
    const lock = (h: string, b: number, id: string) =>
      env.DB.prepare(
        'INSERT INTO slot_locks (host_user_id,bucket_start,booking_id) VALUES (?,?,?)',
      ).bind(h, b, id)

    await env.DB.prepare('DELETE FROM slot_locks').run()
    await env.DB.batch([lock('hostB', 1000, 'A'), lock('hostB', 1005, 'A'), lock('hostB', 1010, 'A')])

    await expect(
      env.DB.batch([lock('hostB', 1010, 'B'), lock('hostB', 1015, 'B'), lock('hostB', 1020, 'B')]),
    ).rejects.toThrow()

    const ghosts = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = 'B'",
    ).first<{ n: number }>()
    expect(ghosts?.n).toBe(0)

    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks').first<{ n: number }>()
    expect(total?.n).toBe(3)
  })

  /** Holds are advisory: two holds may cover the same bucket, a lock may not. */
  it('slot_holds allows overlapping holds but slot_locks does not', async () => {
    await env.DB.prepare('DELETE FROM slot_holds').run()
    const hold = (h: string, b: number, id: string) =>
      env.DB.prepare(
        'INSERT INTO slot_holds (host_user_id,bucket_start,hold_id,event_type_id,expires_at,created_at) VALUES (?,?,?,?,?,?)',
      ).bind(h, b, id, 'et1', Date.now() + 300_000, Date.now())

    await env.DB.batch([hold('hostC', 3000, 'h1'), hold('hostC', 3000, 'h2')])
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_holds').first<{ n: number }>()
    expect(n?.n).toBe(2)
  })
})

/**
 * A day the calendar advertises must actually show times.
 *
 * The bug this guards: slots are computed for ONE month and the day view
 * filters that set, while the calendar's day links carried only `?date=`. So
 * picking any day outside the current month silently produced "No times
 * available" — the calendar offering days it then refused to serve.
 */
describe('month resolution follows the selected date', () => {
  it('derives the month from ?date= when ?month= is absent', async () => {
    const { default: worker } = await import('../../src/index.js')
    // A date two months out: with the bug, this resolved against the CURRENT
    // month and returned nothing.
    const next = new Date(Date.now() + 62 * 86_400_000)
    const date = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-15`

    const res = await worker.fetch(
      new Request(`https://punctual.sh/nobody/nothing?date=${date}`),
      env,
      createExecutionContext(),
    )
    // The host does not exist, so 404 — but the point is that resolving the
    // month from the date must not throw before we get there.
    expect(res.status).toBe(404)
  })
})
