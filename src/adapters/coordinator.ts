/**
 * The `HostCoordinator` adapter (ADR-0002).
 *
 * Sequences the write path: dedupe → lease (collective only) → re-validate →
 * D1 batch → release. The D1 batch is the only step that guarantees anything;
 * everything else turns a doomed write into an early, clean 409.
 */

import type {
  BookingOutcome,
  EnginePorts,
  HoldRequest,
  HostCoordinator,
  Repositories,
} from '../ports.js'
import type { Booking } from '../core/domain/types.js'
import { combineBusy, partitionConnections, prepareBooking } from '../core/domain/booking-service.js'
import { bookingFootprint } from '../core/slots/engine.js'
import { intervalToBuckets } from '../core/slots/intervals.js'
import { issueManageToken } from '../core/domain/auth-flows.js'
import { notifyBookingCreated } from './notify.js'
import { localDateString } from '../core/time/zone.js'
import { dayRange, resolveSchedule } from '../engine.js'
import { needsReconnect } from './oauth.js'
import type { HostAvailabilityInput } from '../core/slots/engine.js'

export interface CoordinatorDeps {
  ports: EnginePorts
  hostCalendarNamespace: DurableObjectNamespace
  /** Fresh, bookmark-consistent repositories for the commit path. */
  repositories: () => Repositories
}

export function createCoordinator(deps: CoordinatorDeps): HostCoordinator {
  const { ports } = deps

  const stub = (hostUserId: string) =>
    deps.hostCalendarNamespace.get(deps.hostCalendarNamespace.idFromName(hostUserId)) as unknown as {
      createHold(holdId: string, start: number, end: number, ttlMs: number): Promise<number>
      releaseHold(holdId: string): Promise<void>
      acquireLease(leaseId: string, ttlMs?: number): Promise<boolean>
      releaseLease(leaseId: string): Promise<void>
    }

  return {
    async book(_hostUserId, request): Promise<BookingOutcome> {
      const repos = deps.repositories()
      const now = ports.clock.now()

      // ---- Idempotency (ADR-0002 §4) -------------------------------------
      const scope = `booking:${request.eventTypeId}:${request.guestEmail.toLowerCase()}`
      const requestHash = await ports.crypto.hash(
        JSON.stringify([request.eventTypeId, request.start, request.end, request.guestEmail]),
      )
      if (request.idempotencyKey) {
        // `reserve` is a compare-and-swap: a plain get-then-work-then-put has
        // a window where two requests with the same key both see "nothing
        // yet" and both go on to create a real booking. Only the reservation
        // winner proceeds past this point.
        const claim = await repos.idempotency.reserve({
          key: request.idempotencyKey,
          scope,
          requestHash,
          responseJson: '',
          status: 0,
          expiresAt: now + 24 * 3_600_000,
        })
        if (!claim.reserved) {
          const prior = claim.existing
          // A replay with a DIFFERENT body is a client bug, not a retry.
          if (prior.requestHash !== requestHash) {
            return { ok: false, reason: 'policy', detail: 'idempotency key reused with different request' }
          }
          if (prior.responseJson) {
            const booking = await repos.bookings.byId(JSON.parse(prior.responseJson).id)
            if (booking) return { ok: true, booking }
          }
          // The empty-response placeholder means another request with this
          // exact key is still mid-flight — proceeding here is the race this
          // whole mechanism exists to close.
          return {
            ok: false,
            reason: 'policy',
            detail: 'a booking with this idempotency key is already being created; retry shortly',
          }
        }
      }

      // Set once the reservation above actually won. Every exit from here on
      // — an early return OR a thrown error — must release it unless it was
      // settled with the real result, or a genuine retry (wrong event type,
      // lost lease, slot taken) is locked out for the full 24h TTL instead of
      // being able to try again immediately.
      const idempotencyClaimed = Boolean(request.idempotencyKey)
      let idempotencySettled = false
      // Set once `createWithLocks` actually commits. Distinct from
      // `idempotencySettled`: a real booking can exist even when persisting
      // its idempotency response afterward fails. Declared here, not inside
      // the `try` below, so `finally` can still see it.
      let committed = false
      let written: Booking | null = null
      const acquired: string[] = []
      const leaseId = ports.crypto.randomToken(12)

      try {
        const eventType = await repos.eventTypes.byId(request.eventTypeId)
        if (!eventType) return { ok: false, reason: 'policy', detail: 'unknown event type' }

        // ---- Leases for collective (ADR-0002 §3) ----------------------------
        // Ascending host id order makes deadlock impossible: every caller
        // walks the same order, so a cycle cannot form.
        const needsLease = eventType.schedulingType === 'collective' && request.hostUserIds.length > 1
        const ordered = [...request.hostUserIds].sort()

        if (needsLease) {
          for (const id of ordered) {
            const ok = await stub(id).acquireLease(leaseId)
            if (!ok) return { ok: false, reason: 'lease_failed' }
            acquired.push(id)
          }
        }

        // ---- Re-validate against fresh data (ADR-0002 §2) -----------------
        // Query the BUFFERED footprint, not the bare meeting. For our own
        // bookings a narrow window only costs an avoidable 409, because
        // slot_locks still arbitrates — but external calendars have no such
        // backstop, so an event sitting entirely inside the buffer would never
        // be fetched and the booking would commit on top of it.
        const footprint = bookingFootprint(request.start, request.end, eventType)
        const hosts = await buildHostInputs(
          ports,
          repos,
          request.hostUserIds,
          footprint,
          eventType,
          request.start,
          request.holdId,
        )
        if (hosts.length === 0) return { ok: false, reason: 'outside_availability' }

        const rrContext =
          eventType.schedulingType === 'round_robin' && eventType.ownerTeamId
            ? {
                teamId: eventType.ownerTeamId,
                members: await repos.teams.members(eventType.ownerTeamId),
                lastAssignedAt: await repos.teams.lastAssignedAt(
                  eventType.ownerTeamId,
                  request.hostUserIds,
                ),
              }
            : undefined

        const bookingId = crypto.randomUUID()
        // A SIGNED token, not bare randomness: verifyManageToken parses and
        // checks the signature, so an unsigned value could never validate and
        // the whole guest manage surface was silently dead.
        const issued = await issueManageToken(
          { crypto: ports.crypto },
          { id: bookingId, startUtc: request.start },
          'manage',
        )
        const manageTokenHash = issued.tokenHash

        const prepared = prepareBooking({
          eventType,
          hosts,
          start: request.start,
          guestName: request.guestName,
          guestEmail: request.guestEmail,
          guestTimezone: request.guestTimezone,
          answers: request.answers,
          now,
          bookingId,
          manageTokenHash,
          rescheduleOf: request.rescheduleOf ?? null,
          rrContext,
          expectedHostCount: request.hostUserIds.length,
        })

        if (!prepared.ok) {
          return {
            ok: false,
            reason: prepared.reason === 'no_eligible_host' ? 'outside_availability' : prepared.reason,
            detail: prepared.detail,
          }
        }

        // ---- The write that actually arbitrates ---------------------------
        written = await repos.bookings.createWithLocks(prepared.booking, prepared.buckets)
        if (!written) return { ok: false, reason: 'slot_taken' }
        // From here on a real booking exists. The idempotency release in
        // `finally` must never fire past this point: if the `idempotency.put`
        // below throws (a transient D1 error) before setting
        // `idempotencySettled`, releasing the claim would make this exact
        // key immediately retryable — and a retry re-runs `coordinator.book`
        // from scratch, which for round-robin can land a SECOND real booking
        // on a different host instead of replaying this one.
        committed = true

        // Advance the rotation, and only now — a failed commit must not move
        // it, or a losing race would push the next booking to another host.
        if (eventType.schedulingType === 'round_robin' && eventType.ownerTeamId) {
          await repos.teams
            .recordAssignment(eventType.ownerTeamId, written.hostUserId, now)
            .catch((err) => console.error('[punctual] round-robin rotation not advanced', err))
        }

        // The hold has done its job; releasing early frees the slot for others
        // if this booking is later cancelled.
        if (request.holdId) {
          await repos.slotLocks.releaseHold(request.holdId).catch(() => {})
        }

        if (request.idempotencyKey) {
          // Best-effort, like the calendar-sync send right below: a booking
          // we already promised the guest on screen must not be lost — or
          // turned into an uncaught 500 that also skips that calendar sync
          // and the confirmation email below — just because persisting the
          // idempotency record hit a transient D1 error. `idempotencySettled`
          // stays false on failure, so `finally` makes one repair attempt.
          await repos.idempotency
            .put({
              key: request.idempotencyKey,
              scope,
              requestHash,
              responseJson: JSON.stringify({ id: written.id }),
              status: 200,
              expiresAt: now + 24 * 3_600_000,
            })
            .then(() => {
              idempotencySettled = true
            })
            .catch((err) => console.error('[punctual] idempotency success record not persisted', err))
        }

        // Side effects come AFTER the commit, deliberately: a calendar API or
        // a mail provider failing must not lose a booking we already promised
        // the guest on screen.
        // Swallowing this used to be harmless — the confirmation was sent
        // right below. Now that the sync message is the ONLY thing that
        // sends it, a failed enqueue would mean the guest hears nothing at
        // all, so the fallback sends directly (without a link, which is the
        // honest outcome when no calendar work will ever run).
        // A RESCHEDULE's sync is enqueued by its route instead, after
        // `markRescheduled` lands (CCC-647). Enqueuing here too would mean two
        // independent messages, and Cloudflare Queues guarantees no ordering
        // between them — the notification could claim and send before the
        // calendar write recorded the new Meet link, permanently omitting it
        // from the very email this work exists to put it in.
        let syncQueued = true
        if (!request.rescheduleOf) {
          await ports.queue
            .send({
              kind: 'calendar.sync',
              bookingId: written.id,
              action: 'create',
              manageToken: issued.token,
            })
            .catch(() => {
              syncQueued = false
            })
        }

        if (!syncQueued) {
          const primaryHost = await repos.users.byId(written.hostUserId)
          if (primaryHost && !written.rescheduleOf) {
            const allHosts = (
              await Promise.all(written.hostUserIds.map((id) => repos.users.byId(id)))
            ).filter((u): u is NonNullable<typeof u> => u !== null)
            // Claimed here too, so the fallback and a later redelivery of the
            // sync message can never both send.
            if (await repos.bookings.claimConfirmation(written.id, now)) {
              await notifyBookingCreated({
                ports,
                booking: written,
                eventType,
                host: primaryHost,
                hosts: allHosts,
                manageToken: issued.token,
              }).catch((err) => console.error('[punctual] fallback confirmation failed', err))
            }
          }
        }

        // The confirmation is NOT sent here any more (CCC-647). It is
        // dispatched by the calendar-sync handler above, which is the first
        // point that knows the conference link Google/Graph minted — and the
        // email body is rendered at enqueue time, so sending it from here
        // baked in a "link to follow" that nothing ever followed up. The
        // handler claims the send with a conditional UPDATE, so a queue
        // redelivery cannot double-send, and it reaches that dispatch even
        // when every calendar connection fails or the host has none.

        // The raw token leaves here exactly once — only its hash is stored.
        return { ok: true, booking: { ...written, manageTokenHash }, manageToken: issued.token }
      } finally {
        for (const id of acquired) {
          await stub(id).releaseLease(leaseId).catch(() => {})
        }
        if (idempotencyClaimed && !idempotencySettled && !committed && request.idempotencyKey) {
          // expiresAt in the past makes the placeholder immediately
          // reclaimable by `reserve`'s WHERE clause, so the next attempt
          // with this key does not have to wait out the full 24h TTL.
          //
          // Guarded on `!committed`: once a real booking has been written,
          // releasing the claim would let a retry create a second one
          // instead of replaying this one. Leaving the placeholder in place
          // for the rest of its TTL — a client sees "in progress, retry
          // shortly" for up to 24h — is the safe failure mode here, not a
          // fast retry.
          await repos.idempotency
            .put({ key: request.idempotencyKey, scope, requestHash, responseJson: '', status: 0, expiresAt: now })
            .catch(() => {})
        }
        if (committed && written && !idempotencySettled && request.idempotencyKey) {
          // The booking committed but persisting its idempotency response
          // failed (e.g. a transient D1 error). Best-effort repair: try once
          // more to record the real result so a retry within the TTL replays
          // this booking instead of hitting a stale empty placeholder.
          await repos.idempotency
            .put({
              key: request.idempotencyKey,
              scope,
              requestHash,
              responseJson: JSON.stringify({ id: written.id }),
              status: 200,
              expiresAt: now + 24 * 3_600_000,
            })
            .catch(() => {})
        }
      }
    },

    async hold(hostUserId, request: HoldRequest) {
      const repos = deps.repositories()
      const now = ports.clock.now()
      const holdId = ports.crypto.randomToken(12)

      const eventType = await repos.eventTypes.byId(request.eventTypeId)
      if (!eventType) return null

      const footprint = bookingFootprint(request.start, request.end, eventType)
      const buckets = intervalToBuckets(footprint).flatMap((b) =>
        request.hostUserIds.map((h) => ({ hostUserId: h, bucketStart: b })),
      )

      const expiresAt = await stub(hostUserId).createHold(
        holdId,
        request.start,
        request.end,
        request.ttlMs,
      )

      const placed = await repos.slotLocks.createHold(
        { id: holdId, eventTypeId: request.eventTypeId, expiresAt, createdAt: now },
        buckets,
      )
      // A hold that could not be placed is not an error: holds are advisory,
      // and the booking will still be arbitrated by slot_locks.
      return placed ? { holdId, expiresAt } : null
    },

    async releaseHold(hostUserId, holdId) {
      await stub(hostUserId).releaseHold(holdId)
    },

    async lease(hostUserIds, ttlMs) {
      const leaseId = ports.crypto.randomToken(12)
      const acquired: string[] = []
      for (const id of [...hostUserIds].sort()) {
        const ok = await stub(id).acquireLease(leaseId, ttlMs)
        if (!ok) {
          for (const a of acquired) await stub(a).releaseLease(leaseId).catch(() => {})
          return null
        }
        acquired.push(id)
      }
      return { leaseId }
    },

    async releaseLease(hostUserIds, leaseId) {
      for (const id of hostUserIds) await stub(id).releaseLease(leaseId).catch(() => {})
    },
  }
}

/**
 * Fresh availability for the commit path.
 *
 * This deliberately does NOT use the freeBusy cache: ADR-0002 §2 requires a
 * live provider re-check immediately before commit, and reading a 60-second
 * cache here would defeat the entire point of having one.
 */
async function buildHostInputs(
  ports: EnginePorts,
  repos: Repositories,
  hostUserIds: string[],
  range: { start: number; end: number },
  eventType?: { maxPerDay: number | null; scheduleId: string | null },
  /** The booking's real start; `range` is buffered and must not be used here. */
  capAnchor: number = range.start,
  /**
   * The current request's own hold, if any. Without excluding it, a guest
   * who held this exact slot sees their own advisory hold come back as busy
   * and the commit-time re-check rejects the booking the hold was meant to
   * protect.
   */
  excludeHoldId?: string,
): Promise<HostAvailabilityInput[]> {
  const now = ports.clock.now()
  const [busyByHost, holdsByHost] = await Promise.all([
    repos.slotLocks.busyBuckets(hostUserIds, range),
    repos.slotLocks.activeHolds(hostUserIds, range, now, excludeHoldId),
  ])

  const out: HostAvailabilityInput[] = []
  for (const id of hostUserIds) {
    const [user, availability, connections] = await Promise.all([
      repos.users.byId(id),
      // Same resolution as the listing path (engine.ts's forEventType) —
      // this is the commit-time re-check (ADR-0002 §2), and it must
      // validate against the SAME schedule the guest was shown, or a real
      // listed slot on an assigned schedule 409s while a slot the assigned
      // schedule never offered can still commit.
      resolveSchedule(repos, id, eventType?.scheduleId ?? null),
      repos.connections.listForUser(id),
    ])
    if (!user || !availability) continue

    const external: Array<{ start: number; end: number }> = []
    for (const conn of partitionConnections(connections).read) {
      try {
        external.push(...(await ports.calendars.get(conn.provider).getBusy(conn, range)))
      } catch (err) {
        // A provider outage must not block bookings outright; slot_locks still
        // prevents conflicts with our own bookings. A REVOKED grant is
        // different — it never recovers on its own, so it is recorded and the
        // host gets a reconnect prompt instead of silently losing conflict
        // checking on every future booking.
        if (needsReconnect(err)) {
          await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
        }
      }
    }

    // The cap MUST be populated here, not left undefined. `isSlotStillValid`
    // reads `bookingsPerLocalDate?.get(...) ?? 0`, so an absent map makes the
    // check `0 >= maxPerDay` — always false — and the cap silently exists only
    // as a listing-time filter. A direct API booking would bypass it entirely,
    // and concurrent bookings on a capped day would all commit, because the D1
    // batch arbitrates buckets, not counts.
    let perDay: Map<string, number> | undefined
    if (eventType?.maxPerDay != null) {
      // Keyed on the booking's own start, NOT range.start — `range` is the
      // buffered footprint, so a leading buffer that crosses local midnight
      // wrote one date and read another, and the cap silently did nothing.
      const localDate = localDateString(capAnchor, availability.timezone)
      perDay = new Map([
        [localDate, await repos.bookings.countForHostOnDate(id, dayRange(localDate, availability.timezone))],
      ])
    }

    out.push({
      hostUserId: id,
      availability,
      busy: combineBusy(busyByHost.get(id) ?? [], holdsByHost.get(id) ?? [], external),
      bookingsPerLocalDate: perDay,
    })
  }
  return out
}
