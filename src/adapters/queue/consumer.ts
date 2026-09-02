/**
 * Queue consumer: emails, webhooks, calendar sync.
 *
 * Everything here happens AFTER a booking is committed (ADR-0002 §2), so a
 * failure means a missing email or a delayed calendar entry — never a lost
 * booking. That is why each message is acked or retried individually rather
 * than failing the whole batch.
 */

import type { EnginePorts, ExternalEvent, QueueMessage, Repositories } from '../../ports.js'
import type { Booking, CalendarConnection, EventType, User } from '../../core/domain/types.js'
import { hostSettings } from '../../core/domain/hosts.js'
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
 * ONE event per booking per provider (ADR-0011). For each provider, the
 * first host in booking order with a writable, healthy connection is the
 * organizer: their connection creates the event, and every host who belongs
 * on that provider is an attendee of it — so co-hosts see each other and
 * each other's responses on one shared event, instead of N events each
 * inviting the other N-1. A host with connections only on the other
 * provider is an attendee there instead; a host with no connection at all
 * is listed on the primary provider's event by address — which lands on
 * their calendar only if that address is an account there (Google sends
 * no email under sendUpdates=none), so it is a courtesy on top of the
 * host confirmation email that already carries the .ics, not the delivery
 * path. Optional hosts are flagged optional in the invite.
 *
 * Per-provider failure is tolerated: the organizer's expired Google token
 * must not stop the event landing in Outlook.
 *
 * `externalEventIds` stays keyed by connection id. Cancel and reschedule
 * walk the STORED ids rather than re-deriving the plan, so bookings written
 * before this change — one event per host connection — still cancel and
 * move correctly.
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
  // Accumulated across every provider, then persisted once.
  const createdIds: Record<string, string> = { ...booking.externalEventIds }

  // ---- delete: the stored events, whatever shape they were written in ----
  if (msg.action === 'delete') {
    for (const [connId, externalId] of Object.entries(booking.externalEventIds)) {
      const conn = await repos.connections.byId(connId)
      if (!conn) {
        // The connection is gone; so is our way to reach the event. Drop the
        // id rather than retry forever against nothing.
        delete createdIds[connId]
        continue
      }
      try {
        await ports.calendars.get(conn.provider).deleteEvent(conn, externalId)
        // Only drop the id once the provider confirms. Clearing the whole
        // map unconditionally meant one host's expired token discarded
        // another host's id too, leaving that event on a real calendar
        // with nothing left to delete it by.
        delete createdIds[connId]
      } catch (err) {
        console.error(`[punctual] calendar delete failed for connection ${connId}`, err)
        if (needsReconnect(err)) {
          await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
        }
      }
    }
    // Persist what actually got deleted, not an empty map. A per-connection
    // failure is caught and logged above, so an unconditional wipe would
    // orphan that event permanently.
    const changed = JSON.stringify(createdIds) !== JSON.stringify(booking.externalEventIds)
    if (changed) await repos.bookings.setExternalEventIds(booking.id, createdIds)
    return
  }
  if (!eventType) return

  const plan = await planInvites(repos, booking, eventType)

  // The first conference link any provider minted. One per booking, not per
  // event: it is the link the GUEST is told to join, and a guest has one
  // meeting to attend however many calendars it was written to.
  let conferenceUrl: string | null = booking.conferenceUrl
  // Tracked separately from `conferenceUrl`: a room that is still being
  // provisioned returns no URL yet, and keying only on the URL meant the next
  // event asked for a SECOND room — so two hosts ended up in different
  // meetings once both resolved. Asked-once is the invariant, not
  // captured-once.
  let conferenceRequested = booking.conferenceUrl !== null
  // Kept so a cancel that raced this pass can be cleaned up below. Waiting
  // for Google to provision a Meet room added up to a second between the
  // event existing in the provider and its id being persisted — long enough
  // for a delete sync to run against a still-empty id map, delete nothing,
  // and leave a real calendar event nothing can ever remove.
  const freshlyCreated: Array<{ conn: CalendarConnection; externalId: string }> = []

  const externalFor = (conn: CalendarConnection, attendees: ExternalEvent['attendees']): ExternalEvent => ({
    title: eventType.title,
    description: buildDescription(booking, eventType.description),
    start: booking.startUtc,
    end: booking.endUtc,
    attendees,
    timezone: plan.organizerTz.get(conn.id) ?? booking.guestTimezone,
    // Mint a conference only until ONE exists for this booking; every later
    // event reuses it as the location instead.
    createConference: eventType.locationType === 'google_meet' && !conferenceRequested,
    location:
      eventType.locationType === 'in_person'
        ? (eventType.locationValue ?? undefined)
        : (conferenceUrl ?? undefined),
  })

  if (msg.action === 'update') {
    // The stored events, whatever shape. An event this plan would have
    // created gets the plan's attendee list; a legacy per-host event keeps
    // its own host and the guest, so an old booking's reschedule does not
    // start multiplying invitations.
    for (const [connId, externalId] of Object.entries(booking.externalEventIds)) {
      const conn = await repos.connections.byId(connId)
      if (!conn) continue
      try {
        const planned = plan.byConnection.get(conn.id)
        const attendees = planned ?? (await legacyAttendees(repos, booking, conn))
        await ports.calendars.get(conn.provider).updateEvent(conn, externalId, externalFor(conn, attendees))
      } catch (err) {
        console.error(`[punctual] calendar update failed for connection ${connId}`, err)
        if (needsReconnect(err)) {
          await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
        }
      }
    }
    return
  }

  // ---- create: one event per provider ----
  for (const target of plan.events) {
    const { conn, attendees } = target
    // Queues is at-least-once, so this message can arrive twice. Without
    // this guard a redelivery creates a SECOND real calendar event and
    // overwrites the first id, leaving it unreachable by every delete
    // path — a permanent phantom on the host's calendar.
    if (booking.externalEventIds[conn.id]) continue
    try {
      const external = externalFor(conn, attendees)
      if (external.createConference === true) conferenceRequested = true
      const result = await ports.calendars.get(conn.provider).createEvent(conn, external)
      // Keep the id: reschedule and cancel need it, and without it a
      // cancelled meeting stays on the host's real calendar forever.
      createdIds[conn.id] = result.id
      freshlyCreated.push({ conn, externalId: result.id })
      // Captured on the first event that mints one; `createConference`
      // above is false from here on, so nothing re-mints.
      if (!conferenceUrl && result.conferenceUrl) conferenceUrl = result.conferenceUrl
    } catch (err) {
      console.error(`[punctual] calendar sync failed for connection ${conn.id}`, err)
      // A revoked grant will fail every future sync too; record it so the
      // host is prompted rather than quietly losing calendar writes.
      if (needsReconnect(err)) {
        await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
      }
    }
  }
  // Persist whatever succeeded. Partial success is normal — one host's expired
  // token must not discard another host's event id.
  if (msg.action === 'create') {
    // Compare by VALUE, not key count. Counting keys meant a second create for
    // the same connection (same key, new id) looked unchanged, so the newer
    // event id was never stored and the event became undeletable.
    // Re-read before persisting: the booking may have been cancelled while
    // this pass was talking to the provider. Persisting the ids onto a
    // cancelled booking is worse than useless — the delete sync has already
    // run and found nothing, so nothing would ever remove these events.
    const current = await repos.bookings.byId(booking.id)
    if (current && current.status !== 'confirmed') {
      for (const made of freshlyCreated) {
        await ports.calendars
          .get(made.conn.provider)
          .deleteEvent(made.conn, made.externalId)
          .catch((err) =>
            console.error(`[punctual] could not remove event for cancelled booking ${booking.id}`, err),
          )
      }
      return
    }

    const changed =
      JSON.stringify(createdIds) !== JSON.stringify(booking.externalEventIds) ||
      conferenceUrl !== booking.conferenceUrl
    if (changed) await repos.bookings.setSyncResult(booking.id, createdIds, conferenceUrl)

    // The confirmation is dispatched HERE, not by the coordinator, because
    // this is the first point that knows the conference link — and the email
    // body is rendered at enqueue time, so sending it any earlier bakes in a
    // "link to follow" that never gets followed up.
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
  }
}

/**
 * Which connection creates each provider's event, and who is on it
 * (ADR-0011). Hosts in booking order; the first with a writable, healthy
 * connection on a provider is that provider's organizer. Attendees of a
 * provider's event: the guest, every host with a writable connection on
 * that provider (by their account email too, so a second account of theirs
 * gets the invitation as well), and — on the primary provider only — every
 * host with no writable connection anywhere, by address. Optional hosts
 * carry the flag from `event_type_hosts` as it stands now.
 *
 * `byConnection` answers the (test-only today — reschedules create a new
 * booking rather than updating) update path: a stored event this plan
 * would organize on gets the plan's attendees, any other stored event is
 * treated as a legacy per-host one.
 */
async function planInvites(
  repos: Repositories,
  booking: Booking,
  eventType: EventType,
): Promise<{
  events: Array<{ conn: CalendarConnection; attendees: ExternalEvent['attendees'] }>
  byConnection: Map<string, ExternalEvent['attendees']>
  organizerTz: Map<string, string>
}> {
  const settings = await hostSettings(repos, eventType)
  const hosts: Array<{ user: User; writable: CalendarConnection[] }> = []
  for (const id of booking.hostUserIds) {
    const user = await repos.users.byId(id)
    if (!user) continue
    const writable = (await repos.connections.listForUser(id)).filter((c) => c.calendarIdWrite && c.syncStatus === 'ok')
    hosts.push({ user, writable })
  }
  const providers = [...new Set(hosts.flatMap((h) => h.writable.map((c) => c.provider)))]
  const unconnected = hosts.filter((h) => h.writable.length === 0)
  const events: Array<{ conn: CalendarConnection; attendees: ExternalEvent['attendees'] }> = []
  const byConnection = new Map<string, ExternalEvent['attendees']>()
  const organizerTz = new Map<string, string>()
  providers.forEach((provider, index) => {
    const organizer = hosts.find((h) => h.writable.some((c) => c.provider === provider))
    if (!organizer) return
    const conn = organizer.writable.find((c) => c.provider === provider)!
    const attendees: ExternalEvent['attendees'] = [{ email: booking.guestEmail, name: booking.guestName }]
    const seen = new Set<string>([booking.guestEmail.toLowerCase()])
    const add = (email: string, name: string, optional: boolean) => {
      const key = email.toLowerCase()
      if (!email || seen.has(key)) return
      seen.add(key)
      attendees.push({ email, name, ...(optional ? { optional: true } : {}) })
    }
    for (const h of hosts) {
      const optional = settings.get(h.user.id)?.required === false
      const onThisProvider = h.writable.filter((c) => c.provider === provider)
      if (onThisProvider.length > 0) {
        add(h.user.email, h.user.name || h.user.slug, optional)
        for (const c of onThisProvider) add(c.providerAccountEmail, h.user.name || h.user.slug, optional)
      } else if (index === 0 && unconnected.includes(h)) {
        add(h.user.email, h.user.name || h.user.slug, optional)
      }
    }
    events.push({ conn, attendees })
    byConnection.set(conn.id, attendees)
    organizerTz.set(conn.id, organizer.user.tz)
  })
  return { events, byConnection, organizerTz }
}

/** A pre-ADR-0011 event's attendee list: the guest and the connection's own host. */
async function legacyAttendees(
  repos: Repositories,
  booking: Booking,
  conn: CalendarConnection,
): Promise<ExternalEvent['attendees']> {
  const host = await repos.users.byId(conn.userId)
  return [
    { email: booking.guestEmail, name: booking.guestName },
    ...(host ? [{ email: host.email, name: host.name || host.slug }] : []),
  ]
}

/**
 * Send this booking's confirmation, exactly once, now that the conference
 * link is known.
 *
 * Ownership of this moved out of the coordinator: the coordinator
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
