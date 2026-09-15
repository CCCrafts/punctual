import { describe, expect, it } from 'vitest'
import type { CalendarConnection } from '../../src/core/domain/types.js'
import { matchConnection } from '../../src/core/domain/connections.js'

function conn(id: string, providerAccountEmail: string): CalendarConnection {
  return {
    id,
    userId: 'u_1',
    provider: 'google',
    providerAccountEmail,
    encryptedTokens: 'x',
    keyVersion: 1,
    calendarIdsRead: [],
    calendarIdWrite: null,
    syncStatus: 'ok',
    createdAt: 0,
  }
}

describe('which connection a fresh grant belongs to', () => {
  it('the one with the same account address, case-insensitively', () => {
    const work = conn('c_work', 'me@acme.com')
    const personal = conn('c_home', 'me@gmail.com')
    expect(matchConnection([work, personal], 'Me@Acme.com')).toBe(work)
    expect(matchConnection([work, personal], 'me@gmail.com')).toBe(personal)
  })

  it('the only connection of the provider when that one has no address on record', () => {
    const only = conn('c_only', '')
    expect(matchConnection([only], '')).toBe(only)
    expect(matchConnection([only], 'me@acme.com')).toBe(only)
  })

  it('never a connection that names a DIFFERENT address, even when it is the only one (caught by review)', () => {
    const named = conn('c_named', 'work@acme.com')
    expect(matchConnection([named], 'me@gmail.com')).toBeNull()
    // And with nothing learned about the new grant, a named row is not assumed either.
    expect(matchConnection([named], '')).toBeNull()
  })

  it('a new connection when the address matches nothing and there is more than one, or none', () => {
    const work = conn('c_work', 'me@acme.com')
    const personal = conn('c_home', '')
    expect(matchConnection([work, personal], 'other@acme.com')).toBeNull()
    expect(matchConnection([work, personal], '')).toBeNull()
    expect(matchConnection([], 'me@acme.com')).toBeNull()
  })
})
