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
  const primary = (id: string) => async () => [{ id, name: 'Primary', primary: true }]
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

  it('a grant for a different account on the same provider is a second connection', async () => {
    const user = await repos.users.create({ id: 'u_cc_3', email: 'cc3@example.com', name: 'CC Three', tz: 'UTC', slug: 'cc-three', avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'member' })
    await saveCalendarConnection(deps(primary('work@acme.com')), user!.id, 'google', grant({ accountEmail: 'work@acme.com' }))
    const personal = await saveCalendarConnection(deps(primary('me@gmail.com')), user!.id, 'google', grant({ accountEmail: 'me@gmail.com' }))
    expect(personal.reconnected).toBe(false)
    const stored = await repos.connections.listForUser(user!.id)
    expect(stored.map((c) => c.providerAccountEmail).sort()).toEqual(['me@gmail.com', 'work@acme.com'])
    // And with two, a token that names neither becomes a third rather than a guess.
    const third = await saveCalendarConnection(deps(primary('x@other.com')), user!.id, 'google', grant())
    expect(third.reconnected).toBe(false)
    expect(await repos.connections.listForUser(user!.id)).toHaveLength(3)
  })

  it('survives a provider that cannot list calendars, saving the grant with nothing selected', async () => {
    const user = await repos.users.create({ id: 'u_cc_4', email: 'cc4@example.com', name: 'CC Four', tz: 'UTC', slug: 'cc-four', avatarKey: null, company: null, jobTitle: null, companyUrl: null, role: 'member' })
    const saved = await saveCalendarConnection(deps(async () => { throw new Error('403 accessNotConfigured') }), user!.id, 'microsoft', grant({ accountEmail: 'me@contoso.com' }))
    expect(saved.connection.calendarIdWrite).toBeNull()
    expect(saved.connection.providerAccountEmail).toBe('me@contoso.com')
    expect(await repos.connections.listForUser(user!.id)).toHaveLength(1)
  })
})
