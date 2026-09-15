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

  it('the only connection of the provider when the address is unknown, or when it is the one without an address', () => {
    const only = conn('c_only', '')
    expect(matchConnection([only], '')).toBe(only)
    expect(matchConnection([only], 'me@acme.com')).toBe(only)
    const named = conn('c_named', 'me@acme.com')
    expect(matchConnection([named], '')).toBe(named)
  })

  it('a new connection when the address matches nothing and there is more than one, or none', () => {
    const work = conn('c_work', 'me@acme.com')
    const personal = conn('c_home', '')
    expect(matchConnection([work, personal], 'other@acme.com')).toBeNull()
    expect(matchConnection([work, personal], '')).toBeNull()
    expect(matchConnection([], 'me@acme.com')).toBeNull()
  })
})
