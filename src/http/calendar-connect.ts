/**
 * Store a calendar grant the host just gave — onto the connection it belongs
 * to, if there is one, else as a new connection.
 *
 * Connecting used to always insert. A host who reconnected Google — chasing
 * an empty calendar picker, or after a revoked grant — ended up with two
 * connections to the same account: both syncing, both listed, and
 * indistinguishable, because the calendar flow asks for no identity scope
 * (ADR-0005 §1) and so learns no account address from the token. The address
 * is taken from the provider's own calendar list instead — Google's primary
 * calendar id, Graph's calendar owner — and learned BEFORE the row is chosen.
 */

import type { CalendarConnection } from '../core/domain/types.js'
import type { CalendarProviderName, Clock, Crypto, Repositories } from '../ports.js'
import { matchConnection } from '../core/domain/connections.js'

export interface ConnectDeps {
  repos: Repositories
  crypto: Pick<Crypto, 'encrypt' | 'randomToken'>
  clock: Clock
  listCalendars: (conn: CalendarConnection) => Promise<Array<{ id: string; name: string; primary: boolean; accountEmail?: string }>>
}

/** The grant as the provider issued it, plus what its id_token said about the account ('' when nothing). */
export interface CalendarGrant {
  accessToken: string
  refreshToken: string
  expiresInMs: number
  scope: string
  accountEmail: string
}

export async function saveCalendarConnection(
  deps: ConnectDeps,
  userId: string,
  provider: CalendarProviderName,
  tokens: CalendarGrant,
): Promise<{ connection: CalendarConnection; reconnected: boolean }> {
  const { repos } = deps
  const now = deps.clock.now()
  const plaintext = JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + tokens.expiresInMs,
    scope: tokens.scope,
  })
  // AAD binds the ciphertext to its row (ADR-0005 §6), so the tokens are
  // encrypted for a provisional new row first — enough to ask the provider
  // who this account is — and again for the reused row if there is one.
  const encryptFor = (id: string) => deps.crypto.encrypt(plaintext, `${userId}|${provider}|${id}`)
  const provisionalId = `cal_${deps.crypto.randomToken(12)}`
  const provisional = await encryptFor(provisionalId)
  const probe: CalendarConnection = {
    id: provisionalId,
    userId,
    provider,
    providerAccountEmail: tokens.accountEmail,
    encryptedTokens: provisional.ciphertext,
    keyVersion: provisional.keyVersion,
    calendarIdsRead: [],
    calendarIdWrite: null,
    syncStatus: 'ok',
    createdAt: now,
  }

  // Who the account is and what it has, BEFORE deciding which row this is:
  // matching on nothing and then learning the address is how a second
  // account's tokens land on the first account's row.
  let primary: { id: string; accountEmail?: string } | undefined
  let listFailed = false
  try {
    const calendars = await deps.listCalendars(probe)
    primary = calendars.find((cal) => cal.primary) ?? calendars[0]
  } catch (err) {
    listFailed = true
    // A provider having a bad minute must not lose a grant the host just
    // gave us. The connections page lets them pick calendars by hand.
    //
    // But swallowing the REASON is how a permanent misconfiguration — an
    // un-enabled Calendar API, a scope the host declined on the granular
    // consent screen — becomes an empty calendar picker with nothing
    // anywhere to explain it. The grant still survives; the cause now
    // reaches `wrangler tail`.
    console.warn(
      `[punctual] ${provider} listCalendars failed during connect; connection saved with no calendars selected:`,
      err instanceof Error ? err.message : String(err),
    )
  }
  const accountEmail = tokens.accountEmail || primary?.accountEmail || ''
  const existing = (await repos.connections.listForUser(userId)).filter((c) => c.provider === provider)
  let reuse = matchConnection(existing, accountEmail)
  if (reuse && reuse.providerAccountEmail === '' && accountEmail !== '') {
    // A row stored before addresses were recorded. Every connection made
    // before this existed is one, so "the only row, and it has no address"
    // is not enough to say it is the same account: ask the row itself.
    const rowAddress = await addressOfStoredRow(deps, reuse)
    if (rowAddress !== null && rowAddress !== accountEmail) reuse = null
  }
  if (listFailed && !reuse && existing.length === 1) {
    // The provider would not say who this is. A host reconnecting the one
    // account they have — the common reason to be here at all, after a
    // revoked grant — must get their row repaired, not a second, empty
    // row beside a broken one. The cost is that a second account added
    // during a provider outage lands on the first; rare, and visible.
    reuse = existing[0]!
  }

  const connection: CalendarConnection = reuse
    ? { ...reuse, providerAccountEmail: accountEmail || reuse.providerAccountEmail, syncStatus: 'ok' }
    : { ...probe, providerAccountEmail: accountEmail }
  if (reuse) {
    const bound = await encryptFor(reuse.id)
    connection.encryptedTokens = bound.ciphertext
    connection.keyVersion = bound.keyVersion
  }

  // A reconnect keeps the host's own selection; only an empty one is
  // filled in. Microsoft's `getBusy` keys on the mailbox SMTP address,
  // not a calendar id (see adapters/microsoft/provider.ts) — it falls
  // back to `providerAccountEmail` only when `calendarIdsRead` is empty.
  // Filling it with a calendar id here defeated that fallback and made
  // every Microsoft conflict check silently see an empty schedule,
  // i.e. treat busy time as free.
  let selectionChanged = false
  if (primary && connection.calendarIdWrite === null) {
    if (provider !== 'microsoft') connection.calendarIdsRead = [primary.id]
    connection.calendarIdWrite = primary.id
    selectionChanged = true
  }

  if (!reuse) {
    await repos.connections.create(connection)
    return { connection, reconnected: false }
  }
  // Column by column, never delete+create: a failure mid-way must not lose
  // the row (which would force a full reconnect) or the stored event ids.
  await repos.connections.updateTokens(reuse.id, connection.encryptedTokens, connection.keyVersion)
  if (reuse.syncStatus !== 'ok') await repos.connections.updateSyncStatus(reuse.id, 'ok')
  if (connection.providerAccountEmail !== reuse.providerAccountEmail) {
    await repos.connections.updateAccountEmail(reuse.id, connection.providerAccountEmail)
  }
  if (selectionChanged) {
    await repos.connections.updateCalendars(reuse.id, { read: connection.calendarIdsRead, write: connection.calendarIdWrite })
  }
  return { connection, reconnected: true }
}

/**
 * The address a connection stored without one is for, as far as can be
 * told: a Google row's calendar selection was filled with the primary
 * calendar's id, which is the address; a Graph row's ids are opaque, so
 * its calendar list is asked with the row's own tokens. Null when nothing
 * can be learned — a revoked grant, an empty selection.
 */
async function addressOfStoredRow(deps: ConnectDeps, row: CalendarConnection): Promise<string | null> {
  const fromIds = [row.calendarIdWrite, ...row.calendarIdsRead].find((id) => id !== null && id.includes('@'))
  if (fromIds) return fromIds.toLowerCase()
  if (row.provider !== 'microsoft') return null
  try {
    const calendars = await deps.listCalendars(row)
    const primary = calendars.find((cal) => cal.primary) ?? calendars[0]
    return primary?.accountEmail?.toLowerCase() ?? null
  } catch {
    return null
  }
}
