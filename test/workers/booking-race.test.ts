import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { prepareBooking } from '../../src/core/domain/booking-service.js'
import type { HostAvailabilityInput } from '../../src/core/slots/engine.js'
import type { Availability, EventType, WeeklySchedule } from '../../src/core/domain/types.js'

/**
 * The anti-double-booking invariant, exercised through the real repository
 * against a real D1 (ADR-0002 §1).
 *
 * Verified against production D1 on 2026-08-14 with five concurrent HTTP
 * bookings: exactly one won, four received 409, and zero orphan locks were
 * left behind. These tests keep that property from regressing silently.
 */

const HOUR = 3_600_000
const DAY = 86_400_000

function weeklyAllDay(): WeeklySchedule {
  const w = [{ startMinute: 0, endMinute: 1440 }]
  return [w, w, w, w, w, w, w] as WeeklySchedule
}

function availability(userId: string, tz = 'UTC'): Availability {
  return { userId, timezone: tz, weekly: weeklyAllDay(), overrides: [] }
}

function eventType(over: Partial<EventType> = {}): EventType {
  return {
    id: 'et1',
    ownerUserId: 'h1',
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: '30min',
    title: '30 min',
    description: '',
    durationMinutes: 30,
    slotIntervalMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxHorizonDays: 365,
    maxPerDay: null,
    locationType: 'phone',
    locationValue: null,
    questions: [],
    active: true,
    createdAt: 0,
    ...over,
  }
}

function host(id: string, tz = 'UTC'): HostAvailabilityInput {
  return { hostUserId: id, availability: availability(id, tz), busy: [] }
}

const repos = () => createD1Repositories(env.DB, { consistency: 'bookmark' })

/** A start well in the future, aligned to the 5-minute bucket grid. */
const START = Math.ceil((Date.now() + 7 * DAY) / 300_000) * 300_000
const NOW = Date.now()

describe('slot_locks is the invariant', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM slot_locks'),
      env.DB.prepare('DELETE FROM bookings'),
    ])
  })

  it('commits a booking with one lock per five-minute bucket', async () => {
    const prepared = prepareBooking({
      eventType: eventType(),
      hosts: [host('h1')],
      start: START,
      guestName: 'A',
      guestEmail: 'a@example.com',
      guestTimezone: 'UTC',
      answers: {},
      now: NOW,
      bookingId: 'bk_a',
      manageTokenHash: 'hash_a',
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    // A 30-minute event with no buffers is exactly 6 buckets.
    expect(prepared.buckets).toHaveLength(6)

    const written = await repos().bookings.createWithLocks(prepared.booking, prepared.buckets)
    expect(written).not.toBeNull()

    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks').first<{ n: number }>()
    expect(n?.n).toBe(6)
  })

  it('a second booking of the same slot loses, and leaves NO ghost locks', async () => {
    const mk = (id: string, start: number) => {
      const p = prepareBooking({
        eventType: eventType(),
        hosts: [host('h1')],
        start,
        guestName: id,
        guestEmail: `${id}@example.com`,
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_${id}`,
        manageTokenHash: `hash_${id}`,
      })
      if (!p.ok) throw new Error('prepare failed')
      return p
    }

    const first = mk('first', START)
    expect(await repos().bookings.createWithLocks(first.booking, first.buckets)).not.toBeNull()

    // Overlaps the first by one bucket, and would otherwise claim five new ones.
    const second = mk('second', START + 25 * 60_000)
    expect(await repos().bookings.createWithLocks(second.booking, second.buckets)).toBeNull()

    const ghosts = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = 'bk_second'",
    ).first<{ n: number }>()
    expect(ghosts?.n).toBe(0)

    // And the loser's booking row must not exist either — the batch is atomic.
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE id = 'bk_second'",
    ).first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })

  it('exactly one of five concurrent attempts on the same slot wins', async () => {
    const attempts = Array.from({ length: 5 }, (_, i) => {
      const p = prepareBooking({
        eventType: eventType(),
        hosts: [host('h1')],
        start: START,
        guestName: `racer${i}`,
        guestEmail: `racer${i}@example.com`,
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_racer${i}`,
        manageTokenHash: `hash_racer${i}`,
      })
      if (!p.ok) throw new Error('prepare failed')
      return repos().bookings.createWithLocks(p.booking, p.buckets)
    })

    const results = await Promise.all(attempts)
    expect(results.filter((r) => r !== null)).toHaveLength(1)

    const confirmed = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM bookings WHERE start_utc = ?',
    )
      .bind(START)
      .first<{ n: number }>()
    expect(confirmed?.n).toBe(1)

    // Six buckets total: the four losers contributed nothing.
    const locks = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks').first<{ n: number }>()
    expect(locks?.n).toBe(6)
  })

  it('adjacent bookings do not collide — half-open intervals', async () => {
    const mk = (id: string, start: number) => {
      const p = prepareBooking({
        eventType: eventType(),
        hosts: [host('h1')],
        start,
        guestName: id,
        guestEmail: `${id}@example.com`,
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_${id}`,
        manageTokenHash: `hash_${id}`,
      })
      if (!p.ok) throw new Error('prepare failed')
      return p
    }

    const a = mk('a', START)
    const b = mk('b', START + 30 * 60_000) // starts exactly when A ends

    expect(await repos().bookings.createWithLocks(a.booking, a.buckets)).not.toBeNull()
    expect(await repos().bookings.createWithLocks(b.booking, b.buckets)).not.toBeNull()

    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks').first<{ n: number }>()
    expect(n?.n).toBe(12)
  })

  it('buffers extend the claimed footprint, so back-to-back now conflicts', async () => {
    const et = eventType({ bufferAfterMinutes: 15, bufferBeforeMinutes: 15 })
    const mk = (id: string, start: number) => {
      const p = prepareBooking({
        eventType: et,
        hosts: [host('h1')],
        start,
        guestName: id,
        guestEmail: `${id}@example.com`,
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_${id}`,
        manageTokenHash: `hash_${id}`,
      })
      if (!p.ok) throw new Error('prepare failed')
      return p
    }

    const a = mk('a', START)
    expect(a.buckets).toHaveLength(12) // 15 + 30 + 15 minutes
    expect(await repos().bookings.createWithLocks(a.booking, a.buckets)).not.toBeNull()

    // Starting exactly when A's meeting ends is now a conflict, because A's
    // trailing buffer and B's leading buffer both claim that ground
    // (ADR-0004 §4: buffers are additive by design).
    const b = mk('b', START + 30 * 60_000)
    expect(await repos().bookings.createWithLocks(b.booking, b.buckets)).toBeNull()
  })

  it('a collective booking claims buckets for every host, atomically', async () => {
    const et = eventType({ schedulingType: 'collective', ownerTeamId: 't1', ownerUserId: null })
    const p = prepareBooking({
      eventType: et,
      hosts: [host('h1'), host('h2'), host('h3')],
      start: START,
      guestName: 'C',
      guestEmail: 'c@example.com',
      guestTimezone: 'UTC',
      answers: {},
      now: NOW,
      bookingId: 'bk_c',
      manageTokenHash: 'hash_c',
    })
    expect(p.ok).toBe(true)
    if (!p.ok) return

    expect(p.buckets).toHaveLength(18) // 3 hosts x 6 buckets
    expect(await repos().bookings.createWithLocks(p.booking, p.buckets)).not.toBeNull()

    const perHost = await env.DB.prepare(
      'SELECT host_user_id, COUNT(*) AS n FROM slot_locks GROUP BY host_user_id ORDER BY host_user_id',
    ).all<{ host_user_id: string; n: number }>()
    expect(perHost.results).toEqual([
      { host_user_id: 'h1', n: 6 },
      { host_user_id: 'h2', n: 6 },
      { host_user_id: 'h3', n: 6 },
    ])
  })

  it('a collective booking fails ENTIRELY when one host is already busy', async () => {
    // h2 is booked personally at this time.
    const solo = prepareBooking({
      eventType: eventType(),
      hosts: [host('h2')],
      start: START,
      guestName: 'solo',
      guestEmail: 'solo@example.com',
      guestTimezone: 'UTC',
      answers: {},
      now: NOW,
      bookingId: 'bk_solo',
      manageTokenHash: 'hash_solo',
    })
    if (!solo.ok) throw new Error('prepare failed')
    expect(await repos().bookings.createWithLocks(solo.booking, solo.buckets)).not.toBeNull()

    const et = eventType({ schedulingType: 'collective', ownerTeamId: 't1', ownerUserId: null })
    const p = prepareBooking({
      eventType: et,
      hosts: [host('h1'), host('h2'), host('h3')],
      start: START,
      guestName: 'C',
      guestEmail: 'c@example.com',
      guestTimezone: 'UTC',
      answers: {},
      now: NOW,
      bookingId: 'bk_c',
      manageTokenHash: 'hash_c',
    })
    if (!p.ok) throw new Error('prepare failed')

    expect(await repos().bookings.createWithLocks(p.booking, p.buckets)).toBeNull()

    // h1 and h3 must have NOTHING: a partial collective booking would put a
    // meeting on two calendars that the third person never agreed to.
    const stray = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM slot_locks WHERE host_user_id IN ('h1','h3')",
    ).first<{ n: number }>()
    expect(stray?.n).toBe(0)
  })
})
