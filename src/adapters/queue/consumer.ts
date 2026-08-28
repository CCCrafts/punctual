/**
 * Queue consumer: emails, webhooks, calendar sync.
 *
 * Everything here happens AFTER a booking is committed (ADR-0002 §2), so a
 * failure means a missing email or a delayed calendar entry — never a lost
 * booking. That is why each message is acked or retried individually rather
 * than failing the whole batch.
 */

import type { EnginePorts, QueueMessage } from '../../ports.js'
import type { Booking } from '../../core/domain/types.js'
import { needsReconnect } from '../oauth.js'
import { notifyBookingCreated, notifyBookingRescheduled } from '../notify.js'

export async function handleQueueBatch(batch: MessageBatch, ports: EnginePorts): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleOne(message.body as QueueMessage, ports)
      message.ack()
    } catch (err) {
      // Retry individually: one bad webhook endpoint must not hold up
      // everyone else's confirmation emails.
      console.error('[punctual] queue message failed', err)
      message.retry()
    }
  }
}

export async function handleOne(msg: QueueMessage, ports: EnginePorts): Promise<void> {
  switch (msg.kind) {
    case 'email':
      await ports.email.send(msg.message)
      return

    case 'webhook':
      await deliverWebhook(msg, ports)
      return

    case 'calendar.sync':
      await syncCalendar(msg, ports)
      return
  }
}

/**
 * Deliver a webhook with an HMAC signature.
 *
 * The signature covers `timestamp.body` rather than the body alone, so a
 * captured payload cannot be replayed indefinitely — the receiver rejects an
 * old timestamp even though the signature is valid.
 */
async function deliverWebhook(
  msg: Extract<QueueMessage, { kind: 'webhook' }>,
  ports: EnginePorts,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'unconstrained' })
  const webhook = await repos.webhooks.byId(msg.webhookId)
  if (!webhook || !webhook.active) return

  const body = JSON.stringify({ event: msg.event, data: msg.payload })
  const timestamp = Math.floor(ports.clock.now() / 1000)
  const signature = await hmacHex(webhook.secret, `${timestamp}.${body}`)

  const res = await fetch(webhook.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-punctual-event': msg.event,
      'x-punctual-timestamp': String(timestamp),
      'x-punctual-signature': `sha256=${signature}`,
    },
    body,
  })

  if (!res.ok) {
    throw new Error(`webhook ${webhook.url} returned ${res.status}`)
  }
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Push the booking to the hosts' external calendars.
 *
 * Per-connection failure is tolerated: one host's expired Google token must
 * not stop the event landing in the other host's Outlook.
 */
async function syncCalendar(
  msg: Extract<QueueMessage, { kind: 'calendar.sync' }>,
  ports: EnginePorts,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  const booking = await repos.bookings.byId(msg.bookingId)
  if (!booking) return

  // A create that is still retrying when the booking gets cancelled must not
  // land: the delete already ran against an empty id map, so nothing would ever
  // remove it.
  if (msg.action === 'create' && booking.status !== 'confirmed') return

  // Looked up here, not earlier: a DELETE needs only externalEventIds, and
  // bailing on a missing event type meant deleting an event type stranded its
  // bookings' calendar entries forever.
  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  if (!eventType && msg.action !== 'delete') return

  // Accumulated across every host and connection, then persisted once.
  const createdIds: Record<string, string> = { ...booking.externalEventIds }
  // The first conference link any connection minted. One per booking, not per
  // connection: it is the link the GUEST is told to join, and a guest has one
  // meeting to attend however many host calendars it was written to.
  let conferenceUrl: string | null = booking.conferenceUrl

  for (const hostId of booking.hostUserIds) {
    const host = await repos.users.byId(hostId)
    if (!host) continue
    const connections = await repos.connections.listForUser(hostId)

    for (const conn of connections) {
      if (!conn.calendarIdWrite || conn.syncStatus !== 'ok') continue
      try {
        const provider = ports.calendars.get(conn.provider)

        if (msg.action === 'delete') {
          const existing = booking.externalEventIds[conn.id]
          if (existing) {
            await provider.deleteEvent(conn, existing)
            // Only drop the id once the provider confirms. Clearing the whole
            // map unconditionally meant one host's expired token discarded
            // another host's id too, leaving that event on a real calendar
            // with nothing left to delete it by.
            delete createdIds[conn.id]
          }
          continue
        }

        // Reachable only for create/update, which the guard above already
        // requires a non-null eventType for — this check just proves it to TS.
        if (!eventType) continue
        const external = {
          title: eventType.title,
          description: buildDescription(booking, eventType.description),
          start: booking.startUtc,
          end: booking.endUtc,
          attendees: [
            { email: booking.guestEmail, name: booking.guestName },
            { email: host.email, name: host.name },
          ],
          timezone: host.tz,
          // Mint a conference only until ONE exists for this booking; every
          // later connection reuses it as the event location instead.
          //
          // Minting per connection put a collective booking's hosts in
          // DIFFERENT rooms: two writable calendars meant two Meet links, and
          // the guest was confidently sent to whichever was captured first
          // while the second host sat in the other one. The divergence
          // predates capturing the link at all — it was simply invisible
          // while nobody was told any link.
          createConference: eventType.locationType === 'google_meet' && !conferenceUrl,
          location:
            eventType.locationType === 'in_person'
              ? (eventType.locationValue ?? undefined)
              : (conferenceUrl ?? undefined),
        }

        if (msg.action === 'create') {
          // Queues is at-least-once, so this message can arrive twice. Without
          // this guard a redelivery creates a SECOND real calendar event and
          // overwrites the first id, leaving it unreachable by every delete
          // path — a permanent phantom on the host's calendar.
          if (booking.externalEventIds[conn.id]) continue
          // Keep the id: reschedule and cancel need it, and without it a
          // cancelled meeting stays on the host's real calendar forever.
          const result = await provider.createEvent(conn, external)
          createdIds[conn.id] = result.id
          // Captured on the first connection that mints one; `createConference`
          // above is false from here on, so nothing re-mints.
          if (!conferenceUrl && result.conferenceUrl) conferenceUrl = result.conferenceUrl
        } else if (msg.action === 'update') {
          const existing = booking.externalEventIds[conn.id]
          if (existing) await provider.updateEvent(conn, existing, external)
        }
      } catch (err) {
        console.error(`[punctual] calendar sync failed for connection ${conn.id}`, err)
        // A revoked grant will fail every future sync too; record it so the
        // host is prompted rather than quietly losing calendar writes.
        if (needsReconnect(err)) {
          await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
        }
      }
    }
  }

  // Persist whatever succeeded. Partial success is normal — one host's expired
  // token must not discard another host's event id.
  if (msg.action === 'create') {
    // Compare by VALUE, not key count. Counting keys meant a second create for
    // the same connection (same key, new id) looked unchanged, so the newer
    // event id was never stored and the event became undeletable.
    const changed =
      JSON.stringify(createdIds) !== JSON.stringify(booking.externalEventIds) ||
      conferenceUrl !== booking.conferenceUrl
    if (changed) await repos.bookings.setSyncResult(booking.id, createdIds, conferenceUrl)

    // The confirmation is dispatched HERE, not by the coordinator, because
    // this is the first point that knows the conference link — and the email
    // body is rendered at enqueue time, so sending it any earlier bakes in a
    // "link to follow" that never gets followed up (CCC-647).
    //
    // Reached unconditionally: every per-connection failure above is caught
    // and `continue`d, and a host with no writable connection simply runs an
    // empty loop. So a calendar outage delays nothing here — it only means
    // the email goes out without a link, which is the honest outcome and the
    // same one guests got before this change.
    // Throws on failure so `handleQueueBatch` retries rather than acking —
    // the calendar work above is idempotent (guarded by `externalEventIds`),
    // so redelivery is safe. Releasing the claim is `dispatchConfirmation`'s
    // job, because only it knows whether THIS attempt won one.
    await dispatchConfirmation(booking.id, ports, msg.manageToken)
  } else if (msg.action === 'delete') {
    // Persist what actually got deleted, not an empty map. A per-connection
    // failure is caught and logged above, so an unconditional wipe would
    // orphan that event permanently.
    const changed = JSON.stringify(createdIds) !== JSON.stringify(booking.externalEventIds)
    if (changed) await repos.bookings.setExternalEventIds(booking.id, createdIds)
  }
}

/**
 * Send this booking's confirmation, exactly once, now that the conference
 * link is known.
 *
 * Ownership of this moved out of the coordinator (CCC-647): the coordinator
 * fires immediately after commit, which is BEFORE any calendar event exists,
 * and the email body is rendered at enqueue time — so the link could never
 * make it in from there no matter how the queue happened to interleave.
 *
 * Exported so a route can fall back to it directly when its queue send
 * fails: for a reschedule that message is now the ONLY one, so losing it
 * would cost the guest both the calendar event and the email. The claim
 * inside makes the fallback and a later redelivery mutually exclusive.
 *
 * The manage token arrives on the message rather than being re-issued here.
 * Re-issuing looks safer — only the hash is stored, so the raw token is
 * otherwise unrecoverable — but it is actively wrong: the coordinator hands
 * that same token to the just-booked page, whose "Reschedule or cancel"
 * button embeds it, so rotating the stored hash kills a link the guest is
 * already looking at, seconds after they were shown it. And carrying it adds
 * no exposure: the rendered confirmation email already contains this token
 * and is itself a queue message.
 */
export async function dispatchConfirmation(
  bookingId: string,
  ports: EnginePorts,
  manageToken: string | undefined,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })

  const booking = await repos.bookings.byId(bookingId)
  if (!booking || booking.status !== 'confirmed') return
  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  if (!eventType) return
  const host = await repos.users.byId(booking.hostUserId)
  if (!host) return
  const hosts = (await Promise.all(booking.hostUserIds.map((id) => repos.users.byId(id)))).filter(
    (u): u is NonNullable<typeof u> => u !== null,
  )

  // A reschedule's replacement leg gets the "Rescheduled" mail, not
  // "Confirmed" — `notifyBookingCreated` early-returns on `rescheduleOf` for
  // exactly this reason, so branching here is what makes the new leg's link
  // reach the guest at all.
  let previous: Booking | null = null
  if (booking.rescheduleOf) {
    previous = await repos.bookings.byId(booking.rescheduleOf)
    if (!previous) return
    // Only the reschedule that actually WON may mail, and only once the win
    // is recorded. Two racing reschedules both create a replacement, but
    // `markRescheduled` lets exactly one point the original at its
    // replacement; the loser is cancelled moments later by its own route.
    //
    // This is ALSO not-yet-landed on the first pass: on the inline
    // (no-TASKS) path the sync runs synchronously inside `coordinator.book`,
    // before the route has marked anything. Declining here — crucially
    // WITHOUT claiming — is what lets the route's second pass do the real
    // notification. Claiming first would burn the one claim on a pass that
    // deliberately sends nothing, and the reschedule mail would never go out.
    if (previous.rescheduledTo !== booking.id) return
  }

  // Claimed as late as possible, but still before sending: Queues is
  // at-least-once, so a redelivery must not send a second confirmation.
  if (!(await repos.bookings.claimConfirmation(bookingId, ports.clock.now()))) return

  // Released ONLY on a claim this attempt won. Releasing from an outer catch
  // was wrong in a way that undoes the migration backfill: an attempt that
  // threw BEFORE claiming would clear a claim someone else holds — including
  // the one the backfill wrote for a booking the old code path had already
  // confirmed — and the retry would then send that guest a second
  // confirmation for a meeting they already know about.
  try {
    if (previous) {
      await notifyBookingRescheduled({
        ports,
        booking,
        previous,
        eventType,
        host,
        hosts,
        ...(manageToken ? { manageToken } : {}),
      })
      return
    }
    await notifyBookingCreated({ ports, booking, eventType, host, hosts, ...(manageToken ? { manageToken } : {}) })
  } catch (err) {
    await repos.bookings.releaseConfirmationClaim(bookingId).catch(() => {})
    throw err
  }
}

function buildDescription(
  booking: { guestName: string; guestEmail: string; answers: Record<string, string> },
  base: string,
): string {
  const lines = [base, '', `Booked by ${booking.guestName} (${booking.guestEmail})`]
  for (const [k, v] of Object.entries(booking.answers)) {
    if (v) lines.push(`${k}: ${v}`)
  }
  return lines.filter(Boolean).join('\n')
}
