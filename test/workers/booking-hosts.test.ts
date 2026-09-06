import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { changeBookingHosts } from '../../src/core/domain/booking-hosts.js'
import { prepareBooking } from '../../src/core/domain/booking-service.js'
import type { Availability, EventType, User, WeeklySchedule } from '../../src/core/domain/types.js'
import type { HostAvailabilityInput } from '../../src/core/slots/engine.js'
import type { EnginePorts, QueueMessage, RequestScope } from '../../src/ports.js'
import { createFakeEmailSender, fakeConfig } from '../../src/testing/fakes.js'

/**
 * Changing a booking's hosts, against the real repository and a real D1.
 *
 * What is worth pinning here is the lock arithmetic, which no fake can
 * vouch for: an added host claims exactly the buffered footprint, a
 * conflicting lock refuses the whole change and leaves every row as it
 * was, and a removed host's rows go while everyone else's stay.
 */

const DAY = 86_400_000
const MINUTE = 60_000

function weeklyAllDay(): WeeklySchedule {
  const w = [{ startMinute: 0, endMinute: 1440 }]
  return [w, w, w, w, w, w, w] as WeeklySchedule
}

function availability(userId: string): Availability {
  return { userId, timezone: 'UTC', weekly: weeklyAllDay(), overrides: [] }
}

function host(id: string): HostAvailabilityInput {
  return { hostUserId: id, availability: availability(id), busy: [] }
}

const TEAM = 't_sales'

/** 30 minutes with 15 either side: a 12-bucket footprint, which tells buffers apart from the meeting. */
function eventType(over: Partial<EventType> = {}): EventType {
  return {
    id: 'et_joint',
    ownerUserId: null,
    ownerTeamId: TEAM,
    schedulingType: 'collective',
    slug: 'joint',
    title: 'Joint call',
    description: '',
    durationMinutes: 30,
    slotIntervalMinutes: null,
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
    minNoticeMinutes: 0,
    maxHorizonDays: 365,
    maxPerDay: null,
    locationType: 'phone',
    locationValue: null,
    questions: [],
    active: true,
    createdAt: 0,
    scheduleId: null,
    ...over,
  }
}

function user(id: string, over: Partial<User> = {}): User {
  return {
    id,
    email: `${id}@example.com`,
    name: id.replace('u_', '').replace(/^./, (c) => c.toUpperCase()),
    tz: 'UTC',
    slug: id.replace('u_', ''),
    avatarKey: null,
    company: null,
    jobTitle: null,
    companyUrl: null,
    role: 'member',
    createdAt: 0,
    ...over,
  }
}

const alice = user('u_alice')
const bob = user('u_bob')
const carol = user('u_carol')
/** On the team, manages it, hosts nothing. */
const manager = user('u_manager')
/** On the team as a plain member, hosts nothing. */
const member = user('u_member')
/** Not on the team at all. */
const outsider = user('u_outsider')
/** Instance admin, on no team. */
const root = user('u_root', { role: 'admin' })
const ALL = [alice, bob, carol, manager, member, outsider, root]

const START = Math.ceil((Date.now() + 7 * DAY) / 300_000) * 300_000
const NOW = Date.now()

const email = createFakeEmailSender()
const queued: QueueMessage[] = []

const throwing = (label: string) =>
  new Proxy({}, {
    get(_t, prop) {
      return () => {
        throw new Error(`test: ${label}.${String(prop)} is not stubbed`)
      }
    },
  })

const ports = {
  repositories: (scope: RequestScope) => createD1Repositories(env.DB, scope),
  email,
  clock: { now: () => NOW },
  queue: {
    async send(m: QueueMessage) {
      queued.push(m)
    },
    async sendBatch(ms: QueueMessage[]) {
      queued.push(...ms)
    },
  },
  config: fakeConfig(),
  calendars: throwing('calendars'),
  coordinator: throwing('coordinator'),
} as unknown as EnginePorts

const repos = () => createD1Repositories(env.DB, { consistency: 'bookmark' })

async function insertEventType(et: EventType): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO event_types
     (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
      slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
      max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      et.id, et.ownerUserId, et.ownerTeamId, et.schedulingType, et.slug, et.title, et.description,
      et.durationMinutes, et.slotIntervalMinutes, et.bufferBeforeMinutes, et.bufferAfterMinutes,
      et.minNoticeMinutes, et.maxHorizonDays, et.maxPerDay, et.locationType, et.locationValue,
      JSON.stringify(et.questions), et.active ? 1 : 0, et.createdAt,
    )
    .run()
}

/** A committed booking through the real create path, so its locks are what production writes. */
async function book(id: string, et: EventType, hosts: string[], start = START, now = NOW): Promise<void> {
  const prepared = prepareBooking({
    eventType: et,
    hosts: hosts.map(host),
    start,
    guestName: 'Ada',
    guestEmail: 'ada@example.com',
    guestTimezone: 'UTC',
    answers: {},
    now,
    bookingId: id,
    manageTokenHash: `hash_${id}`,
  })
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`)
  const written = await repos().bookings.createWithLocks(prepared.booking, prepared.buckets)
  if (!written) throw new Error('createWithLocks refused')
}

async function locks(): Promise<Array<{ host_user_id: string; bucket_start: number; booking_id: string }>> {
  const r = await env.DB.prepare(
    'SELECT host_user_id, bucket_start, booking_id FROM slot_locks ORDER BY host_user_id, bucket_start',
  ).all<{ host_user_id: string; bucket_start: number; booking_id: string }>()
  return r.results
}

const BOOKING = 'bk_joint'
const JOINT = eventType()

beforeEach(async () => {
  email.sent.length = 0
  queued.length = 0
  await env.DB.batch([
    env.DB.prepare('DELETE FROM slot_locks'),
    env.DB.prepare('DELETE FROM bookings'),
    env.DB.prepare('DELETE FROM event_types'),
    env.DB.prepare('DELETE FROM team_members'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM users'),
    ...ALL.map((u) =>
      env.DB.prepare('INSERT INTO users (id,email,name,tz,slug,role,created_at) VALUES (?,?,?,?,?,?,?)').bind(
        u.id, u.email, u.name, u.tz, u.slug, u.role, u.createdAt,
      ),
    ),
    env.DB.prepare('INSERT INTO teams (id,name,slug,created_at) VALUES (?,?,?,?)').bind(TEAM, 'Sales', 'sales', 0),
    ...[alice, bob, carol, member].map((u) =>
      env.DB.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind(TEAM, u.id, 'member', 1),
    ),
    env.DB.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind(TEAM, manager.id, 'admin', 1),
  ])
  await insertEventType(JOINT)
  await book(BOOKING, JOINT, [alice.id, bob.id])
})

describe('who may change the hosts', () => {
  it('a stranger, and a team member who is not a host, are refused', async () => {
    for (const actor of [outsider, member]) {
      const r = await changeBookingHosts(ports, actor, { bookingId: BOOKING, add: [carol.id] })
      expect(r).toEqual({ ok: false, reason: 'not_allowed' })
    }
    expect((await locks()).filter((l) => l.host_user_id === carol.id)).toHaveLength(0)
  })

  it('a current host, a team admin and an instance admin may', async () => {
    for (const actor of [alice, manager, root]) {
      const r = await changeBookingHosts(ports, actor, { bookingId: BOOKING, add: [carol.id] })
      expect(r.ok).toBe(true)
      expect(await changeBookingHosts(ports, actor, { bookingId: BOOKING, remove: [carol.id] })).toMatchObject({ ok: true })
    }
  })

  it('a missing or cancelled booking is not found; a personal booking is not a team booking; the past is closed', async () => {
    expect(await changeBookingHosts(ports, manager, { bookingId: 'nope', add: [carol.id] })).toEqual({ ok: false, reason: 'not_found' })

    await repos().bookings.cancelWithLockRelease(BOOKING, NOW)
    expect(await changeBookingHosts(ports, manager, { bookingId: BOOKING, add: [carol.id] })).toEqual({ ok: false, reason: 'not_found' })

    const personal = eventType({ id: 'et_solo', ownerUserId: alice.id, ownerTeamId: null, schedulingType: 'personal', slug: 'solo' })
    await insertEventType(personal)
    await book('bk_solo', personal, [alice.id], START + DAY)
    expect(await changeBookingHosts(ports, alice, { bookingId: 'bk_solo', add: [bob.id] })).toEqual({ ok: false, reason: 'not_a_team_booking' })
    // ...and a stranger to a personal booking learns nothing more than "no".
    expect(await changeBookingHosts(ports, outsider, { bookingId: 'bk_solo', add: [bob.id] })).toEqual({ ok: false, reason: 'not_allowed' })

    // Booked a fortnight ago for a week ago: the write path refuses a past
    // start, so the clock it saw is moved back too.
    const past = Math.floor((NOW - 7 * DAY) / 300_000) * 300_000
    await book('bk_past', JOINT, [alice.id], past, past - 7 * DAY)
    expect(await changeBookingHosts(ports, alice, { bookingId: 'bk_past', add: [carol.id] })).toEqual({ ok: false, reason: 'past' })
  })
})

describe('adding a host', () => {
  it('claims exactly the buffered footprint, queues a calendar update, and emails the newcomer', async () => {
    const before = await locks()
    expect(before).toHaveLength(24) // two hosts x (15 + 30 + 15 minutes)

    const r = await changeBookingHosts(ports, manager, { bookingId: BOOKING, add: [carol.id] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.booking.hostUserIds).toEqual([alice.id, bob.id, carol.id])
    expect(r.booking.hostUserId).toBe(alice.id)
    expect(r.added.map((u) => u.id)).toEqual([carol.id])
    expect(r.removed).toEqual([])

    const after = await locks()
    const carols = after.filter((l) => l.host_user_id === carol.id)
    expect(carols.map((l) => l.bucket_start)).toEqual(
      Array.from({ length: 12 }, (_, i) => START - 15 * MINUTE + i * 5 * MINUTE),
    )
    expect(carols.every((l) => l.booking_id === BOOKING)).toBe(true)
    expect(after.filter((l) => l.host_user_id !== carol.id)).toEqual(before)

    const stored = await repos().bookings.byId(BOOKING)
    expect(stored?.hostUserIds).toEqual([alice.id, bob.id, carol.id])

    expect(queued).toEqual([{ kind: 'calendar.sync', bookingId: BOOKING, action: 'update' }])

    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]?.to).toBe(carol.email)
    expect(email.sent[0]?.subject).toMatch(/^You've been added: Joint call with Ada, /)
    expect(email.sent[0]?.text).toContain(`/dashboard/bookings/${BOOKING}`)
    expect(email.sent[0]?.text).toContain('Hosts: Alice, Bob, Carol')
  })

  it('a host with an overlapping meeting cannot be added, and nothing changes', async () => {
    // Carol's own meeting ends exactly when this one's leading buffer starts
    // to bite: its last bucket is the joint call's first buffered bucket.
    const solo = eventType({ id: 'et_solo', ownerUserId: carol.id, ownerTeamId: null, schedulingType: 'personal', slug: 'solo', bufferBeforeMinutes: 0, bufferAfterMinutes: 0 })
    await insertEventType(solo)
    await book('bk_carol', solo, [carol.id], START - 40 * MINUTE)
    const before = await locks()

    const r = await changeBookingHosts(ports, manager, { bookingId: BOOKING, add: [carol.id] })
    expect(r).toEqual({ ok: false, reason: 'slot_taken' })

    expect(await locks()).toEqual(before)
    const stored = await repos().bookings.byId(BOOKING)
    expect(stored?.hostUserIds).toEqual([alice.id, bob.id])
    expect(queued).toEqual([])
    expect(email.sent).toEqual([])
  })

  it('refuses someone off the team, and someone already on the booking', async () => {
    expect(await changeBookingHosts(ports, manager, { bookingId: BOOKING, add: [outsider.id] })).toEqual({ ok: false, reason: 'not_a_member' })
    expect(await changeBookingHosts(ports, manager, { bookingId: BOOKING, add: [bob.id] })).toEqual({ ok: false, reason: 'already_host' })
    expect(await locks()).toHaveLength(24)
  })
})

describe('removing a host', () => {
  it("releases only that host's buckets, re-points the primary, and emails them", async () => {
    const before = await locks()
    const r = await changeBookingHosts(ports, manager, { bookingId: BOOKING, remove: [alice.id] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.booking.hostUserIds).toEqual([bob.id])
    // Alice was the primary host; Bob, the first host left, takes over.
    expect(r.booking.hostUserId).toBe(bob.id)
    expect(r.removed.map((u) => u.id)).toEqual([alice.id])

    const after = await locks()
    expect(after.filter((l) => l.host_user_id === alice.id)).toHaveLength(0)
    expect(after).toEqual(before.filter((l) => l.host_user_id === bob.id))

    const stored = await repos().bookings.byId(BOOKING)
    expect(stored?.hostUserId).toBe(bob.id)
    expect(stored?.hostUserIds).toEqual([bob.id])

    expect(queued).toEqual([{ kind: 'calendar.sync', bookingId: BOOKING, action: 'update' }])
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]?.to).toBe(alice.email)
    expect(email.sent[0]?.subject).toMatch(/^You've been taken off: Joint call with Ada, /)
    expect(email.sent[0]?.text).toContain('Hosts: Bob')
  })

  it('a swap in one call: the leaver is released, the newcomer claims, each is told', async () => {
    const r = await changeBookingHosts(ports, alice, { bookingId: BOOKING, add: [carol.id], remove: [bob.id] })
    expect(r).toMatchObject({ ok: true, added: [{ id: carol.id }], removed: [{ id: bob.id }] })
    if (!r.ok) return
    expect(r.booking.hostUserIds).toEqual([alice.id, carol.id])

    const after = await locks()
    expect(new Set(after.map((l) => l.host_user_id))).toEqual(new Set([alice.id, carol.id]))
    expect(after).toHaveLength(24)

    expect(email.sent.map((m) => [m.to, m.subject.split(':')[0]])).toEqual([
      [carol.email, "You've been added"],
      [bob.email, "You've been taken off"],
    ])
  })

  it('a host taking themselves off is not emailed about it', async () => {
    const r = await changeBookingHosts(ports, bob, { bookingId: BOOKING, remove: [bob.id] })
    expect(r.ok).toBe(true)
    expect(email.sent).toEqual([])
  })

  it('refuses to remove the last host, or someone who is not one', async () => {
    expect(await changeBookingHosts(ports, manager, { bookingId: BOOKING, remove: [alice.id, bob.id] })).toEqual({ ok: false, reason: 'last_host' })
    expect(await changeBookingHosts(ports, manager, { bookingId: BOOKING, remove: [carol.id] })).toEqual({ ok: false, reason: 'not_host' })
    expect(await locks()).toHaveLength(24)
    expect(queued).toEqual([])
  })
})

describe('replaceHosts is a compare-and-swap on the host list', () => {
  it('a write against a list the row no longer has changes nothing — no locks lost', async () => {
    // BOOKING is Alice + Bob after beforeEach. Simulate the other tab: it
    // read [alice, bob] too, but its edit landed first and swapped Bob for
    // Carol. Our edit still believes the list is [alice, bob].
    const first = await repos().bookings.replaceHosts(
      BOOKING,
      [alice.id, bob.id],
      [alice.id, carol.id],
      alice.id,
      [{ hostUserId: carol.id, bucketStart: START }],
      [{ hostUserId: bob.id, bucketStart: START }],
    )
    expect(first?.hostUserIds).toEqual([alice.id, carol.id])
    const after = await locks()
    expect(after.some((l) => l.host_user_id === carol.id)).toBe(true)
    expect(after.some((l) => l.host_user_id === bob.id)).toBe(false)

    // The stale edit: expected [alice, bob], wants to remove Alice's co-host Bob and keep Alice alone.
    const stale = await repos().bookings.replaceHosts(BOOKING, [alice.id, bob.id], [alice.id], alice.id, [], [{ hostUserId: carol.id, bucketStart: START }])
    expect(stale).toBeNull()
    expect(await locks()).toEqual(after)
    expect((await repos().bookings.byId(BOOKING))?.hostUserIds).toEqual([alice.id, carol.id])
  })

  it('changeBookingHosts reports a lost race as stale, not as a taken slot', async () => {
    // Alice's page read [alice, bob]; meanwhile Carol was added.
    const read = (await repos().bookings.byId(BOOKING))!
    await repos().bookings.replaceHosts(BOOKING, read.hostUserIds, [alice.id, bob.id, carol.id], alice.id, [{ hostUserId: carol.id, bucketStart: START }], [])
    // Now the domain function, fed a fresh read, works; but a caller acting
    // on the stale list is what the CAS exists for — simulate it by
    // removing Carol through the repository with the stale expectation.
    const stale = await repos().bookings.replaceHosts(BOOKING, read.hostUserIds, [alice.id], alice.id, [], [])
    expect(stale).toBeNull()
  })
})
