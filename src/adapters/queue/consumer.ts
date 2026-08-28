/**
 * Queue consumer: emails, webhooks, calendar sync.
 *
 * Everything here happens AFTER a booking is committed (ADR-0002 §2), so a
 * failure means a missing email or a delayed calendar entry — never a lost
 * booking. That is why each message is acked or retried individually rather
 * than failing the whole batch.
 */

import type { EnginePorts, QueueMessage } from '../../ports.js'
import { needsReconnect } from '../oauth.js'
import { issueManageToken } from '../../core/domain/auth-flows.js'
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
          createConference: eventType.locationType === 'google_meet',
          location: eventType.locationType === 'in_person' ? (eventType.locationValue ?? undefined) : undefined,
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
          // First writer wins. Re-minting per connection would hand different
          // hosts different links for one meeting.
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
    await dispatchConfirmation(booking.id, ports).catch((err) =>
      console.error('[punctual] confirmation dispatch failed', err),
    )
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
 * The manage token is re-issued rather than carried through the queue. Only
 * its hash is stored, so the original raw token is unrecoverable here — and
 * putting a live credential into a queue message to work around that would
 * widen its exposure for no benefit. Rotating is already a supported
 * operation (ADR-0005 §4 rotates on reschedule), and nothing is invalidated
 * because the confirmation carrying the previous token has not been sent.
 */
async function dispatchConfirmation(bookingId: string, ports: EnginePorts): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })

  // Claimed BEFORE any work: Queues is at-least-once, and a redelivered sync
  // message would otherwise send the guest a second confirmation. The
  // condition is inside the UPDATE, so two concurrent attempts cannot both win.
  if (!(await repos.bookings.claimConfirmation(bookingId, ports.clock.now()))) return

  const booking = await repos.bookings.byId(bookingId)
  if (!booking || booking.status !== 'confirmed') return
  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  if (!eventType) return
  const host = await repos.users.byId(booking.hostUserId)
  if (!host) return
  const hosts = (await Promise.all(booking.hostUserIds.map((id) => repos.users.byId(id)))).filter(
    (u): u is NonNullable<typeof u> => u !== null,
  )

  const issued = await issueManageToken(
    { crypto: ports.crypto },
    { id: booking.id, startUtc: booking.startUtc },
    'manage',
  )
  await repos.bookings.rotateManageToken(booking.id, issued.tokenHash)

  // A reschedule's replacement leg gets the "Rescheduled" mail, not
  // "Confirmed" — `notifyBookingCreated` early-returns on `rescheduleOf` for
  // exactly this reason, so branching here is what makes the new leg's link
  // reach the guest at all.
  if (booking.rescheduleOf) {
    const previous = await repos.bookings.byId(booking.rescheduleOf)
    if (!previous) return
    await notifyBookingRescheduled({
      ports,
      booking,
      previous,
      eventType,
      host,
      hosts,
      manageToken: issued.token,
    })
    return
  }

  await notifyBookingCreated({ ports, booking, eventType, host, hosts, manageToken: issued.token })
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
