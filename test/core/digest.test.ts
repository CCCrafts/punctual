import { describe, expect, it } from 'vitest'
import type { Booking, EventType, User } from '../../src/core/domain/types.js'
import type { QueueMessage } from '../../src/ports.js'
import { digestBookings, digestDue, parseDigestHour } from '../../src/core/domain/digest.js'
import { dailyDigestEmail } from '../../src/core/email-templates.js'
import { sendDigests } from '../../src/adapters/scheduled.js'
import { createFakeEmailSender, createFakeRateLimiter, createFakeRepositories, fakeConfig } from '../../src/testing/fakes.js'
import type { EnginePorts } from '../../src/ports.js'

const KYIV_8AM = Date.UTC(2026, 9, 7, 5, 2) // 08:02 Europe/Kyiv (UTC+3 in October)

describe('when a digest is due', () => {
  it('is the chosen hour, its first five minutes, once a day, in the host\'s zone', () => {
    const host = { tz: 'Europe/Kyiv', digestHour: 8, digestSentOn: null }
    expect(digestDue(host, KYIV_8AM)).toBe('2026-10-07')
    expect(digestDue(host, KYIV_8AM + 10 * 60_000)).toBeNull() // 08:12 — the tick at 08:00–08:05 had it
    expect(digestDue(host, KYIV_8AM - 3_600_000)).toBeNull() // 07:02
    expect(digestDue({ ...host, digestSentOn: '2026-10-07' }, KYIV_8AM)).toBeNull()
    expect(digestDue({ ...host, digestSentOn: '2026-10-06' }, KYIV_8AM)).toBe('2026-10-07')
    expect(digestDue({ ...host, digestHour: null }, KYIV_8AM)).toBeNull()
    // The same instant is 22:02 the previous day in Los Angeles: not 8 o'clock there.
    expect(digestDue({ tz: 'America/Los_Angeles', digestHour: 8, digestSentOn: null }, KYIV_8AM)).toBeNull()
    expect(digestDue({ tz: 'America/Los_Angeles', digestHour: 22, digestSentOn: null }, KYIV_8AM)).toBe('2026-10-06')
  })

  it('reads the form: off, an hour from the list, or invalid', () => {
    expect(parseDigestHour('off')).toBeNull()
    expect(parseDigestHour('')).toBeNull()
    expect(parseDigestHour(null)).toBeNull()
    expect(parseDigestHour('8')).toBe(8)
    for (const bad of ['3', '13', 'eight', '8.5']) expect(parseDigestHour(bad), bad).toBe('invalid')
  })
})

function eventType(id: string, title: string): EventType {
  return { id, ownerUserId: 'u_host', ownerTeamId: null, schedulingType: 'personal', slug: id, title, description: '', durationMinutes: 30, slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 60, maxHorizonDays: 60, maxPerDay: null, locationType: 'google_meet', locationValue: null, questions: [], active: true, createdAt: 0, scheduleId: null }
}
function booking(id: string, eventTypeId: string, startUtc: number, over: Partial<Booking> = {}): Booking {
  return { id, eventTypeId, hostUserId: 'u_host', hostUserIds: ['u_host'], guestName: `Guest ${id}`, guestEmail: `${id}@example.com`, guestTimezone: 'UTC', startUtc, endUtc: startUtc + 1_800_000, localDate: '', status: 'confirmed', answers: {}, externalEventIds: {}, conferenceUrl: null, rescheduleOf: null, rescheduledTo: null, manageTokenHash: 'h', cancelledAt: null, createdAt: 0, ...over }
}

describe('the digest run', () => {
  function harness() {
    const repos = createFakeRepositories()
    const queued: QueueMessage[] = []
    const types = new Map([['et_intro', eventType('et_intro', 'Intro call')], ['et_demo', eventType('et_demo', 'Demo')]])
    const ports = {
      repositories: () => ({ ...repos, eventTypes: { ...(repos.eventTypes as object), async byId(id: string) { return types.get(id) ?? null } } }),
      queue: { async send(m: QueueMessage) { queued.push(m) }, async sendBatch(ms: QueueMessage[]) { queued.push(...ms) } },
      email: createFakeEmailSender(),
      rateLimiter: createFakeRateLimiter(),
      clock: { now: () => KYIV_8AM },
      config: fakeConfig({ baseUrl: 'https://punctual.test', brandName: 'Punctual', supportEmail: 'help@punctual.test' }),
    } as unknown as EnginePorts
    return { repos, queued, ports }
  }

  it("emails today's confirmed meetings in the host's zone, once, and nothing on an empty day", async () => {
    const { repos, queued, ports } = harness()
    const host = repos.seedUser({ id: 'u_host', email: 'grace@example.com', name: 'Grace Hopper', slug: 'grace', tz: 'Europe/Kyiv', digestHour: 8 })
    repos.seedUser({ id: 'u_bob', email: 'bob@example.com', name: 'Bob Chen', slug: 'bob', tz: 'UTC', digestHour: 8 }) // 08:00 UTC is 11:00 Kyiv — not due now
    repos.seedUser({ id: 'u_off', email: 'off@example.com', name: 'Off', slug: 'off', tz: 'Europe/Kyiv' })
    const day = Date.UTC(2026, 9, 6, 21) // 00:00 Kyiv on the 7th
    repos.seedBooking(booking('bk_late', 'et_demo', day + 15 * 3_600_000)) // 15:00
    repos.seedBooking(booking('bk_early', 'et_intro', day + 10 * 3_600_000, { hostUserIds: ['u_host', 'u_bob'] })) // 10:00, with Bob
    repos.seedBooking(booking('bk_cancelled', 'et_intro', day + 12 * 3_600_000, { status: 'cancelled' }))
    repos.seedBooking(booking('bk_tomorrow', 'et_intro', day + 34 * 3_600_000))
    repos.seedBooking(booking('bk_yesterday', 'et_intro', day - 3_600_000))

    await sendDigests(ports, KYIV_8AM)
    expect(queued).toHaveLength(1)
    const mail = (queued[0] as Extract<QueueMessage, { kind: 'email' }>).message
    expect(mail.to).toBe('grace@example.com')
    expect(mail.subject).toBe('Today: 2 meetings — Wednesday, October 7')
    // In order, in Kyiv time, with the co-host named and a link to each booking.
    expect(mail.text.indexOf('10:00 AM')).toBeLessThan(mail.text.indexOf('3:00 PM'))
    expect(mail.text).toContain('Intro call — Guest bk_early (with Bob Chen)')
    expect(mail.text).toContain('Demo — Guest bk_late')
    expect(mail.text).not.toContain('bk_cancelled')
    expect(mail.text).not.toContain('bk_tomorrow')
    expect(mail.html).toContain('https://punctual.test/dashboard/bookings/bk_early')
    expect((await repos.users.byId(host.id))?.digestSentOn).toBe('2026-10-07')

    // The next tick within the hour: nothing more.
    await sendDigests(ports, KYIV_8AM + 60_000)
    expect(queued).toHaveLength(1)

    // Bob's hour comes at 08:00 UTC; he has one meeting that day (Grace's, as co-host).
    await sendDigests(ports, Date.UTC(2026, 9, 7, 8, 1))
    expect(queued).toHaveLength(2)
    expect((queued[1] as Extract<QueueMessage, { kind: 'email' }>).message.to).toBe('bob@example.com')

    // An empty day is marked and sends nothing.
    repos.seedUser({ id: 'u_quiet', email: 'quiet@example.com', name: 'Quiet', slug: 'quiet', tz: 'Europe/Kyiv', digestHour: 8 })
    await sendDigests(ports, Date.UTC(2026, 9, 8, 5, 1))
    expect(queued.filter((m) => m.kind === 'email' && m.message.to === 'quiet@example.com')).toHaveLength(0)
    expect((await repos.users.byId('u_quiet'))?.digestSentOn).toBe('2026-10-08')
  })

  it('sorts and filters to confirmed meetings', () => {
    const b = [booking('b', 'et', 20), booking('a', 'et', 10), booking('c', 'et', 15, { status: 'cancelled' })]
    expect(digestBookings(b).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('renders one line per meeting', () => {
    const host = { id: 'u', email: 'g@x', name: 'Grace', tz: 'UTC', slug: 'g', avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'member', createdAt: 0 } as User
    const mail = dailyDigestEmail({ brandName: 'Punctual', host, date: '2026-10-07', dashboardUrl: 'https://punctual.test/dashboard', meetings: [{ booking: booking('bk', 'et', Date.UTC(2026, 9, 7, 9)), eventType: eventType('et', 'Intro'), coHosts: [] }] })
    expect(mail.subject).toBe('Today: 1 meeting — Wednesday, October 7')
    expect(mail.text).toContain('9:00 AM: Intro — Guest bk')
    expect(mail.text).toContain('turned on the morning digest under Settings')
  })
})
