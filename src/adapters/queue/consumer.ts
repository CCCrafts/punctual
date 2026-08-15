/**
 * Queue consumer: emails, webhooks, calendar sync.
 *
 * Everything here happens AFTER a booking is committed (ADR-0002 §2), so a
 * failure means a missing email or a delayed calendar entry — never a lost
 * booking. That is why each message is acked or retried individually rather
 * than failing the whole batch.
 */

import type { EnginePorts, QueueMessage } from '../../ports.js'

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

async function handleOne(msg: QueueMessage, ports: EnginePorts): Promise<void> {
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

  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  if (!eventType) return

  // Accumulated across every host and connection, then persisted once.
  const createdIds: Record<string, string> = { ...booking.externalEventIds }

  for (const hostId of booking.hostUserIds) {
    const host = await repos.users.byId(hostId)
    if (!host) continue
    const connections = await repos.connections.listForUser(hostId)

    for (const conn of connections) {
      if (!conn.calendarIdWrite || conn.syncStatus !== 'ok') continue
      try {
        const provider = ports.calendars.get(conn.provider)
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
          // Keep the id: reschedule and cancel need it, and without it a
          // cancelled meeting stays on the host's real calendar forever.
          createdIds[conn.id] = await provider.createEvent(conn, external)
        } else if (msg.action === 'update') {
          const existing = booking.externalEventIds[conn.id]
          if (existing) await provider.updateEvent(conn, existing, external)
        } else if (msg.action === 'delete') {
          const existing = booking.externalEventIds[conn.id]
          if (existing) await provider.deleteEvent(conn, existing)
        }
      } catch (err) {
        console.error(`[punctual] calendar sync failed for connection ${conn.id}`, err)
      }
    }
  }

  // Persist whatever succeeded. Partial success is normal — one host's expired
  // token must not discard another host's event id.
  if (msg.action === 'create') {
    const changed = Object.keys(createdIds).length !== Object.keys(booking.externalEventIds).length
    if (changed) await repos.bookings.setExternalEventIds(booking.id, createdIds)
  } else if (msg.action === 'delete') {
    await repos.bookings.setExternalEventIds(booking.id, {})
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
