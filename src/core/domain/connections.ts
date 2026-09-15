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
 * is the address the grant turned out to be for — learned from the
 * provider's calendar list BEFORE this is called — or '' when nothing said.
 *
 * - An address that matches a stored one: that connection.
 * - Otherwise, exactly one connection and it has no address on record (a
 *   row stored before addresses were learned): that one — the only account
 *   ever connected, most likely the same one. A row that names a DIFFERENT
 *   address is never overwritten: that grant is a second account, and
 *   taking its tokens onto the first would disconnect the first while
 *   never adding the second (caught by review).
 * - Otherwise null: a new connection.
 */
export function matchConnection(existing: CalendarConnection[], accountEmail: string): CalendarConnection | null {
  const email = accountEmail.trim().toLowerCase()
  if (email !== '') {
    const byEmail = existing.find((c) => c.providerAccountEmail.toLowerCase() === email)
    if (byEmail) return byEmail
  }
  return existing.length === 1 && existing[0]!.providerAccountEmail === '' ? existing[0]! : null
}
