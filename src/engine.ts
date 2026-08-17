/**
 * The composition root (ADR-0003 §1).
 *
 * `createEngine(ports)` is the ONLY way the engine is constructed. Nothing
 * inside reaches for a global binding, which is precisely what lets the cloud
 * control-plane supply tenant-scoped repositories without the engine knowing
 * tenants exist.
 */

import type { EnginePorts, RequestScope } from './ports.js'
import { buildRouter } from './http/router.js'
import { computeSlots, type HostAvailabilityInput } from './core/slots/engine.js'
import type { EventType, Interval, Slot, User } from './core/domain/types.js'
import { combineBusy, partitionConnections } from './core/domain/booking-service.js'
import { localDateString, localTimeToInstant } from './core/time/zone.js'
import { needsReconnect } from './adapters/oauth.js'

export interface Engine {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>
  /** Direct domain access for embedders and for the cloud control-plane. */
  slots: SlotService
}

export interface SlotService {
  forEventType(input: {
    eventType: EventType
    hostUsers: User[]
    range: Interval
    scope?: RequestScope
  }): Promise<Slot[]>
}

export interface EngineDeps {
  ports: EnginePorts
}

export function createEngine(ports: EnginePorts): Engine {
  const slots = createSlotService(ports)
  const app = buildRouter(ports, slots)

  return {
    fetch: async (request, env, ctx) => app.fetch(request, env as never, ctx),
    slots,
  }
}

/**
 * Assembling a host's availability picture.
 *
 * Note where each input comes from, because it is the ADR-0006 §1 rule in
 * code: own bookings and holds are read from D1 (strongly consistent, and the
 * writes users notice immediately), external calendars from KV-cached freeBusy
 * (advisory, re-checked before commit).
 */
export function createSlotService(ports: EnginePorts): SlotService {
  return {
    async forEventType({ eventType, hostUsers, range, scope }) {
      const repos = ports.repositories(scope ?? { consistency: 'unconstrained' })
      const hostIds = hostUsers.map((u) => u.id)
      if (hostIds.length === 0) return []

      const [busyByHost, holdsByHost] = await Promise.all([
        repos.slotLocks.busyBuckets(hostIds, range),
        repos.slotLocks.activeHolds(hostIds, range, ports.clock.now()),
      ])

      // Per-host reads run concurrently rather than in an await loop: with N
      // hosts the sequential version costs N x (availability + connections)
      // round trips, and round-trip count is what the latency budget is spent
      // on (ADR-0007, and the measurement in EventTypeRepository).
      const built: Array<HostAvailabilityInput | null> = await Promise.all(
        hostUsers.map(async (user) => {
          const [availability, external] = await Promise.all([
            repos.availability.forUser(user.id),
            externalBusyFor(ports, repos, user.id, range),
          ])
          if (!availability) return null
          const perDay = await perDayCounts(repos, user, range, eventType, availability.timezone)
          return {
            hostUserId: user.id,
            availability,
            busy: combineBusy(
              busyByHost.get(user.id) ?? [],
              holdsByHost.get(user.id) ?? [],
              external,
            ),
            bookingsPerLocalDate: perDay,
          }
        }),
      )
      const hosts = built.filter((h): h is HostAvailabilityInput => h !== null)

      return computeSlots({ eventType, hosts, range, now: ports.clock.now() })
    },
  }
}

/**
 * External calendar busy time, via the freeBusy cache.
 *
 * A cache miss or provider failure yields an EMPTY busy set, which means the
 * host may be offered a slot they are actually busy for. That is the correct
 * trade for a listing: the mandatory pre-commit re-check (ADR-0002 §2) catches
 * it, so the failure mode is a rare 409 rather than a booking page that breaks
 * whenever Google has a bad minute.
 */
async function externalBusyFor(
  ports: EnginePorts,
  repos: ReturnType<EnginePorts['repositories']>,
  userId: string,
  range: Interval,
): Promise<Interval[]> {
  const connections = await repos.connections.listForUser(userId)
  const { read } = partitionConnections(connections)
  if (read.length === 0) return []

  const out: Interval[] = []
  for (const conn of read) {
    const key = `fb:${conn.id}:${range.start}:${range.end}`
    const cached = await ports.cache.get<Interval[]>(key)
    if (cached) {
      out.push(...cached)
      continue
    }
    try {
      const provider = ports.calendars.get(conn.provider)
      const busy = await provider.getBusy(conn, range)
      // 60 s TTL — the spec's number, and also KV's own minimum.
      await ports.cache.put(key, busy, 60)
      out.push(...busy)
    } catch (err) {
      // Degrade to "no known busy time" rather than failing the page — but a
      // REVOKED grant must be recorded, or conflict checking silently switches
      // off and bookings land on top of real meetings with the connections
      // page still showing a green badge.
      if (needsReconnect(err)) {
        await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
      }
    }
  }
  return out
}

/** Per-day booking counts, only when the event type actually caps them. */
async function perDayCounts(
  repos: ReturnType<EnginePorts['repositories']>,
  user: User,
  range: Interval,
  eventType: EventType,
  availabilityTz: string,
): Promise<Map<string, number> | undefined> {
  if (eventType.maxPerDay == null) return undefined
  const counts = new Map<string, number>()
  const bookings = await repos.bookings.listForHost(user.id, range)
  for (const b of bookings) {
    // Recomputed from `startUtc` in THIS host's own availability timezone —
    // never `b.localDate`. That column is stamped once, in the PRIMARY
    // host's timezone (booking-service.ts), so for a collective booking's
    // non-primary hosts it can name the wrong calendar day near a timezone
    // boundary and undercount their cap.
    const date = localDateString(b.startUtc, availabilityTz)
    counts.set(date, (counts.get(date) ?? 0) + 1)
  }
  return counts
}

/**
 * Which days in a month have any bookable slot.
 *
 * Computed from the same pipeline as the slot list so the calendar can never
 * show a day as available that then turns out to have nothing.
 */
export function daysWithSlots(slots: Slot[], timezone: string): Map<string, boolean> {
  const map = new Map<string, boolean>()
  for (const s of slots) map.set(localDateString(s.start, timezone), true)
  return map
}

/** The UTC range covering a host-local month. */
export function monthRange(month: string, timezone: string): Interval {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const first = `${y}-${String(m).padStart(2, '0')}-01`
  const nextMonth = new Date(Date.UTC(y, m, 1))
  const next = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-01`
  return {
    start: localTimeToInstant(first, 0, timezone),
    end: localTimeToInstant(next, 0, timezone),
  }
}

/** The UTC range covering one host-local day — NOT start + 24h (DST). */
export function dayRange(date: string, timezone: string): Interval {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
  return {
    start: localTimeToInstant(date, 0, timezone),
    end: localTimeToInstant(nextDate, 0, timezone),
  }
}
