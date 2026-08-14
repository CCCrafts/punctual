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
import { combineBusy, partitionConnections, prepareBooking } from '../core/domain/booking-service.js'
import { bookingFootprint } from '../core/slots/engine.js'
import { intervalToBuckets } from '../core/slots/intervals.js'
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
        const prior = await repos.idempotency.get(request.idempotencyKey, scope)
        if (prior) {
          // A replay with a DIFFERENT body is a client bug, not a retry.
          if (prior.requestHash !== requestHash) {
            return { ok: false, reason: 'policy', detail: 'idempotency key reused with different request' }
          }
          const booking = await repos.bookings.byId(JSON.parse(prior.responseJson).id)
          if (booking) return { ok: true, booking }
        }
      }

      const eventType = await repos.eventTypes.byId(request.eventTypeId)
      if (!eventType) return { ok: false, reason: 'policy', detail: 'unknown event type' }

      // ---- Leases for collective (ADR-0002 §3) ----------------------------
      // Ascending host id order makes deadlock impossible: every caller walks
      // the same order, so a cycle cannot form.
      const needsLease = eventType.schedulingType === 'collective' && request.hostUserIds.length > 1
      const ordered = [...request.hostUserIds].sort()
      const leaseId = ports.crypto.randomToken(12)
      const acquired: string[] = []

      try {
        if (needsLease) {
          for (const id of ordered) {
            const ok = await stub(id).acquireLease(leaseId)
            if (!ok) return { ok: false, reason: 'lease_failed' }
            acquired.push(id)
          }
        }

        // ---- Re-validate against fresh data (ADR-0002 §2) -----------------
        const hosts = await buildHostInputs(ports, repos, request.hostUserIds, {
          start: request.start,
          end: request.end,
        })
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
        const manageToken = ports.crypto.randomToken(32)
        const manageTokenHash = await ports.crypto.hash(manageToken)

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
        })

        if (!prepared.ok) {
          return {
            ok: false,
            reason: prepared.reason === 'no_eligible_host' ? 'outside_availability' : prepared.reason,
            detail: prepared.detail,
          }
        }

        // ---- The write that actually arbitrates ---------------------------
        const written = await repos.bookings.createWithLocks(prepared.booking, prepared.buckets)
        if (!written) return { ok: false, reason: 'slot_taken' }

        // The hold has done its job; releasing early frees the slot for others
        // if this booking is later cancelled.
        if (request.holdId) {
          await repos.slotLocks.releaseHold(request.holdId).catch(() => {})
        }

        if (request.idempotencyKey) {
          await repos.idempotency.put({
            key: request.idempotencyKey,
            scope,
            requestHash,
            responseJson: JSON.stringify({ id: written.id }),
            status: 200,
            expiresAt: now + 24 * 3_600_000,
          })
        }

        // Side effects come AFTER the commit, deliberately: a calendar API
        // failing must not lose a booking we already promised the guest.
        await ports.queue
          .send({ kind: 'calendar.sync', bookingId: written.id, action: 'create' })
          .catch(() => {})

        return { ok: true, booking: { ...written, manageTokenHash } }
      } finally {
        for (const id of acquired) {
          await stub(id).releaseLease(leaseId).catch(() => {})
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
): Promise<HostAvailabilityInput[]> {
  const now = ports.clock.now()
  const [busyByHost, holdsByHost] = await Promise.all([
    repos.slotLocks.busyBuckets(hostUserIds, range),
    repos.slotLocks.activeHolds(hostUserIds, range, now),
  ])

  const out: HostAvailabilityInput[] = []
  for (const id of hostUserIds) {
    const [user, availability, connections] = await Promise.all([
      repos.users.byId(id),
      repos.availability.forUser(id),
      repos.connections.listForUser(id),
    ])
    if (!user || !availability) continue

    const external: Array<{ start: number; end: number }> = []
    for (const conn of partitionConnections(connections).read) {
      try {
        external.push(...(await ports.calendars.get(conn.provider).getBusy(conn, range)))
      } catch {
        // A provider outage must not block bookings outright; slot_locks still
        // prevents conflicts with our own bookings.
      }
    }

    out.push({
      hostUserId: id,
      availability,
      busy: combineBusy(busyByHost.get(id) ?? [], holdsByHost.get(id) ?? [], external),
      bookingsPerLocalDate: undefined,
    })
  }
  return out
}
