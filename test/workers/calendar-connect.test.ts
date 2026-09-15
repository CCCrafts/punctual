import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildPorts, type Env } from '../../src/index.js'
import { saveCalendarConnection, type CalendarGrant } from '../../src/http/calendar-connect.js'
import type { CalendarConnection } from '../../src/core/domain/types.js'

/**
 * A grant for an account that is already connected is a RE-connect: same
 * row, same calendar selection, new tokens. It used to insert every time,
 * and a host chasing an empty calendar picker ended up with two Google
 * connections they could not tell apart.
 */
describe('saving a calendar grant', () => {
  /** Deterministic key material — test keys, never near a deployment. */
  const keyMaterial = (seed: number): string => {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) & 0xff
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    return btoa(binary)
  }
  const ports = buildPorts({ ...env, BASE_URL: 'https://punctual.test', ENCRYPTION_KEY_V1: keyMaterial(1), SIGNING_KEY: keyMaterial(9) } as Env)
  const repos = ports.repositories({ consistency: 'bookmark' })
  const grant = (over: Partial<CalendarGrant> = {}): CalendarGrant => ({
    accessToken: `at_${Math.random()}`,
    refreshToken: 'rt',
    expiresInMs: 3_600_000,
    scope: 'calendar',
    accountEmail: '',
    ...over,
  })
  // As the providers report it: the primary calendar carries the account's address.
  const primary = (id: string) => async () => [{ id, name: 'Primary', primary: true, accountEmail: id }]
  const deps = (list: (c: CalendarConnection) => Promise<Array<{ id: string; name: string; primary: boolean }>>) => ({
    repos,
    crypto: ports.crypto,
    clock: ports.clock,
    listCalendars: list,
  })

  it('creates the first connection, learning the Google account from the primary calendar', async () => {
    const user = await repos.users.create({ id: 'u_cc_1', email: 'cc1@example.com', name: 'CC One', tz: 'UTC', slug: 'cc-one', avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'member' })
    const first = await saveCalendarConnection(deps(primary('me@acme.com')), user!.id, 'google', grant())
    expect(first.reconnected).toBe(false)
    expect(first.connection.providerAccountEmail).toBe('me@acme.com')
    expect(first.connection.calendarIdWrite).toBe('me@acme.com')
    const stored = await repos.connections.listForUser(user!.id)
    expect(stored.map((c) => [c.id, c.providerAccountEmail])).toEqual([[first.connection.id, 'me@acme.com']])
  })

  it('a second grant for the same account refreshes that connection and keeps its selection', async () => {
    const user = await repos.users.create({ id: 'u_cc_2', email: 'cc2@example.com', name: 'CC Two', tz: 'UTC', slug: 'cc-two', avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'member' })
    const first = await saveCalendarConnection(deps(primary('me@acme.com')), user!.id, 'google', grant())
    await repos.connections.updateCalendars(first.connection.id, { read: ['me@acme.com', 'team@acme.com'], write: 'team@acme.com' })
    await repos.connections.updateSyncStatus(first.connection.id, 'needs_reconnect')

    // The token said nothing about the account, as the calendar flow's
    // token never does; the only connection of the provider is the one.
    const again = await saveCalendarConnection(deps(primary('me@acme.com')), user!.id, 'google', grant())
    expect(again.reconnected).toBe(true)
    expect(again.connection.id).toBe(first.connection.id)
    const stored = await repos.connections.listForUser(user!.id)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.calendarIdsRead).toEqual(['me@acme.com', 'team@acme.com'])
    expect(stored[0]!.calendarIdWrite).toBe('team@acme.com')
    expect(stored[0]!.syncStatus).toBe('ok')
    expect(stored[0]!.encryptedTokens).not.toBe(first.connection.encryptedTokens)
  })

  it('a grant for a different account on the same provider is a second connection, never the first one overwritten', async () => {
    const user = await repos.users.create({ id: 'u_cc_3', email: 'cc3@example.com', name: 'CC Three', tz: 'UTC', slug: 'cc-three', avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'member' })
    // The token names no account (the calendar flow's never does); the
    // calendar list is what says who this is.
    const work = await saveCalendarConnection(deps(primary('work@acme.com')), user!.id, 'google', grant())
    const personal = await saveCalendarConnection(deps(primary('me@gmail.com')), user!.id, 'google', grant())
    expect(personal.reconnected).toBe(false)
    expect(personal.connection.id).not.toBe(work.connection.id)
    const stored = await repos.connections.listForUser(user!.id)
    expect(stored.map((c) => [c.providerAccountEmail, c.calendarIdWrite]).sort()).toEqual([
      ['me@gmail.com', 'me@gmail.com'],
      ['work@acme.com', 'work@acme.com'],
    ])
    // Each reconnects onto its own row.
    const workAgain = await saveCalendarConnection(deps(primary('work@acme.com')), user!.id, 'google', grant())
    expect(workAgain.reconnected).toBe(true)
    expect(workAgain.connection.id).toBe(work.connection.id)
    expect(await repos.connections.listForUser(user!.id)).toHaveLength(2)
  })

  it('a named connection is not reused when the new grant cannot be identified', async () => {
    const user = await repos.users.create({ id: 'u_cc_5', email: 'cc5@example.com', name: 'CC Five', tz: 'UTC', slug: 'cc-five', avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'member' })
    await saveCalendarConnection(deps(primary('me@contoso.com')), user!.id, 'microsoft', grant({ accountEmail: 'me@contoso.com' }))
    // The list came back without an owner and the token said nothing: a
    // duplicate is the lesser evil next to overwriting a different account.
    const unknown = await saveCalendarConnection(deps(async () => [{ id: 'AAMk', name: 'Calendar', primary: true }]), user!.id, 'microsoft', grant())
    expect(unknown.reconnected).toBe(false)
    expect(await repos.connections.listForUser(user!.id)).toHaveLength(2)
  })

  it('survives a provider that cannot list calendars, saving the grant with nothing selected', async () => {
    const user = await repos.users.create({ id: 'u_cc_4', email: 'cc4@example.com', name: 'CC Four', tz: 'UTC', slug: 'cc-four', avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'member' })
    const saved = await saveCalendarConnection(deps(async () => { throw new Error('403 accessNotConfigured') }), user!.id, 'microsoft', grant({ accountEmail: 'me@contoso.com' }))
    expect(saved.connection.calendarIdWrite).toBeNull()
    expect(saved.connection.providerAccountEmail).toBe('me@contoso.com')
    expect(await repos.connections.listForUser(user!.id)).toHaveLength(1)
  })
})
