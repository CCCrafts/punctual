/**
 * Which stored calendar connection a fresh OAuth grant belongs to.
 *
 * Connecting a provider used to always insert, so a host who reconnected
 * — chasing an empty calendar picker, or after a revoked grant — ended up
 * with two connections to one account, indistinguishable on the page and
 * both syncing. A grant for an account that is already connected is a
 * RE-connect: it keeps the connection's id (and so its calendar selection
 * and stored event ids) and replaces the tokens.
 */

import type { CalendarConnection } from './types.js'

/**
 * `existing` is the user's connections for this one provider. `accountEmail`
 * is what the provider said about the account, or '' when it said nothing.
 *
 * - An email that matches a stored one: that connection.
 * - No usable email match, and exactly one connection for the provider: that
 *   one — a second grant for the only account connected is a reconnect, not
 *   a new account. (A host with a work and a personal account on the same
 *   provider has two, and then the email decides or nothing does.)
 * - Otherwise null: a new connection.
 */
export function matchConnection(existing: CalendarConnection[], accountEmail: string): CalendarConnection | null {
  const email = accountEmail.trim().toLowerCase()
  if (email !== '') {
    const byEmail = existing.find((c) => c.providerAccountEmail.toLowerCase() === email)
    if (byEmail) return byEmail
    const unnamed = existing.filter((c) => c.providerAccountEmail === '')
    if (existing.length === 1 && unnamed.length === 1) return unnamed[0]!
    return null
  }
  return existing.length === 1 ? existing[0]! : null
}
