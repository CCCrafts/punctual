/**
 * Store a calendar grant the host just gave — onto the connection it belongs
 * to, if there is one, else as a new connection.
 *
 * Connecting used to always insert. A host who reconnected Google — chasing
 * an empty calendar picker, or after a revoked grant — ended up with two
 * connections to the same account: both syncing, both listed, and
 * indistinguishable, because the calendar flow asks for no identity scope
 * (ADR-0005 §1) and so learns no account address from the token. The address
 * is taken from the provider's own calendar list instead: Google's primary
 * calendar is the account, and its id IS the address.
 */

import type { CalendarConnection } from '../core/domain/types.js'
import type { CalendarProviderName, Clock, Crypto, Repositories } from '../ports.js'
import { matchConnection } from '../core/domain/connections.js'

export interface ConnectDeps {
  repos: Repositories
  crypto: Pick<Crypto, 'encrypt' | 'randomToken'>
  clock: Clock
  listCalendars: (conn: CalendarConnection) => Promise<Array<{ id: string; name: string; primary: boolean }>>
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
  const accountEmail = tokens.accountEmail
  const existing = (await repos.connections.listForUser(userId)).filter((c) => c.provider === provider)
  const reuse = matchConnection(existing, accountEmail)
  const id = reuse ? reuse.id : `cal_${deps.crypto.randomToken(12)}`

  const { ciphertext, keyVersion } = await deps.crypto.encrypt(
    JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: now + tokens.expiresInMs,
      scope: tokens.scope,
    }),
    // AAD binds the ciphertext to this row (ADR-0005 §6) — the reused row's
    // id on a reconnect, so the stored tokens decrypt under the same binding
    // the refresh path writes with.
    `${userId}|${provider}|${id}`,
  )

  const connection: CalendarConnection = reuse
    ? { ...reuse, providerAccountEmail: accountEmail || reuse.providerAccountEmail, encryptedTokens: ciphertext, keyVersion, syncStatus: 'ok' }
    : {
        id,
        userId,
        provider,
        providerAccountEmail: accountEmail,
        encryptedTokens: ciphertext,
        keyVersion,
        calendarIdsRead: [],
        calendarIdWrite: null,
        syncStatus: 'ok',
        createdAt: now,
      }

  let selectionChanged = false
  try {
    const calendars = await deps.listCalendars(connection)
    const primary = calendars.find((cal) => cal.primary) ?? calendars[0]
    if (primary) {
      // Google's primary calendar id is the account's address — the one
      // fact that tells two connections to one provider apart, and the
      // calendar scopes yield it nowhere else.
      if (provider === 'google' && connection.providerAccountEmail === '' && primary.id.includes('@')) {
        connection.providerAccountEmail = primary.id
      }
      // A reconnect keeps the host's own selection; only an empty one is
      // filled in. Microsoft's `getBusy` keys on the mailbox SMTP address,
      // not a calendar id (see adapters/microsoft/provider.ts) — it falls
      // back to `providerAccountEmail` only when `calendarIdsRead` is empty.
      // Filling it with a calendar id here defeated that fallback and made
      // every Microsoft conflict check silently see an empty schedule,
      // i.e. treat busy time as free.
      if (connection.calendarIdWrite === null) {
        if (provider !== 'microsoft') connection.calendarIdsRead = [primary.id]
        connection.calendarIdWrite = primary.id
        selectionChanged = true
      }
    }
  } catch (err) {
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

  if (!reuse) {
    await repos.connections.create(connection)
    return { connection, reconnected: false }
  }
  // Column by column, never delete+create: a failure mid-way must not lose
  // the row (which would force a full reconnect) or the stored event ids.
  await repos.connections.updateTokens(id, ciphertext, keyVersion)
  if (reuse.syncStatus !== 'ok') await repos.connections.updateSyncStatus(id, 'ok')
  if (connection.providerAccountEmail !== reuse.providerAccountEmail) {
    await repos.connections.updateAccountEmail(id, connection.providerAccountEmail)
  }
  if (selectionChanged) {
    await repos.connections.updateCalendars(id, { read: connection.calendarIdsRead, write: connection.calendarIdWrite })
  }
  return { connection, reconnected: true }
}
