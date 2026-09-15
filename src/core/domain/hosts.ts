/**
 * Who hosts an event type.
 *
 * A personal event type: its owner. A team event type: the explicit host
 * set from `event_type_hosts` when the admin has picked one, otherwise every
 * current member of the team — all required, on their default schedules,
 * which is exactly what the table's absence meant before it existed.
 *
 * One resolver, used by the booking page, the dashboard, the REST API and
 * the MCP server alike. It used to be three private copies that agreed by
 * luck; the host set now carries per-host settings, and three copies would
 * have disagreed about those within a week.
 */

import type { Repositories } from '../../ports.js'
import type { Booking, EventType, EventTypeHost, User } from './types.js'

export interface ResolvedHost {
  user: User
  /** See `EventTypeHost.required`. Always true for personal and implicit sets. */
  required: boolean
  /** The schedule this event type draws from for this host; null = their default. */
  scheduleId: string | null
  /** Effective round-robin weight: the per-event override, else the team weight. */
  rrWeight: number
}

/**
 * The hosts of `eventType`, in display order. `fallback` is the user the
 * caller already has in hand (the page's owner, the key's user); it is the
 * answer for a personal event type and the answer of last resort for a
 * team with nobody in it, so a booking page never renders with zero hosts.
 */
export async function resolveHosts(
  repos: Repositories,
  eventType: EventType,
  fallback: User,
): Promise<ResolvedHost[]> {
  if (!eventType.ownerTeamId) {
    let owner: User | null = fallback
    if (eventType.ownerUserId && eventType.ownerUserId !== fallback.id) {
      owner = (await repos.users.byId(eventType.ownerUserId)) ?? fallback
    }
    return [{ user: owner, required: true, scheduleId: eventType.scheduleId, rrWeight: 1 }]
  }

  const [members, explicit] = await Promise.all([
    repos.teams.members(eventType.ownerTeamId),
    repos.eventTypeHosts.forEventType(eventType.id),
  ])
  const weightOf = new Map(members.map((m) => [m.userId, m.rrWeight]))

  // An explicit row for someone no longer on the team is skipped rather
  // than trusted: the membership is what makes a person bookable through
  // the team's page, and removeMemberGuarded keeps the two in step anyway.
  const chosen: Array<{ userId: string; required: boolean; scheduleId: string | null; rrWeight: number }> =
    explicit.length > 0
      ? explicit
          .filter((h) => weightOf.has(h.userId))
          .map((h) => ({
            userId: h.userId,
            required: h.required,
            scheduleId: h.scheduleId,
            rrWeight: h.rrWeight ?? weightOf.get(h.userId) ?? 1,
          }))
      : members.map((m) => ({ userId: m.userId, required: true, scheduleId: null, rrWeight: m.rrWeight }))

  const out: ResolvedHost[] = []
  for (const h of chosen) {
    const user = await repos.users.byId(h.userId)
    if (user) out.push({ user, required: h.required, scheduleId: h.scheduleId, rrWeight: h.rrWeight })
  }
  return out.length > 0 ? out : [{ user: fallback, required: true, scheduleId: null, rrWeight: 1 }]
}

/** The users alone — what the slot service and the coordinator are handed. */
export function hostUsers(hosts: ResolvedHost[]): User[] {
  return hosts.map((h) => h.user)
}

/**
 * Per-host settings keyed by user id, for the two places that assemble
 * availability from a list of ids (the slot service and the commit path)
 * and need to know, per host, which schedule and whether required.
 */
export async function hostSettings(
  repos: Repositories,
  eventType: EventType,
): Promise<Map<string, Pick<EventTypeHost, 'required' | 'scheduleId' | 'rrWeight'>>> {
  if (!eventType.ownerTeamId) return new Map()
  const rows = await repos.eventTypeHosts.forEventType(eventType.id)
  return new Map(rows.map((h) => [h.userId, { required: h.required, scheduleId: h.scheduleId, rrWeight: h.rrWeight }]))
}

/**
 * Who a rescheduled booking is booked with. Not simply "the event type's
 * hosts" (which undid a co-host added or removed after booking) and not
 * simply "the booking's hosts" (which pinned a round-robin meeting to the
 * one host it happened to land on, and left out an optional host who was
 * merely busy the first time):
 *
 * - personal: the owner, as always;
 * - round robin: the whole pool — the coordinator re-picks at commit time,
 *   so a slot the pool can serve is a slot the caller can move to;
 * - collective: the people on the booking now, plus the event type's
 *   optional hosts who are not — they join when free, and being busy at the
 *   first time is no reason to be left out of the second.
 *
 * `fallback` stands in for a personal event type's owner, as in `resolveHosts`.
 */
export async function hostsForReschedule(
  repos: Repositories,
  eventType: EventType,
  booking: Booking,
  fallback: User,
): Promise<User[]> {
  const resolved = await resolveHosts(repos, eventType, fallback)
  if (eventType.schedulingType !== 'collective') return hostUsers(resolved)
  const users: User[] = []
  for (const id of booking.hostUserIds) {
    const u = resolved.find((h) => h.user.id === id)?.user ?? (await repos.users.byId(id))
    if (u) users.push(u)
  }
  for (const h of resolved) {
    if (!h.required && !users.some((u) => u.id === h.user.id)) users.push(h.user)
  }
  return users.length > 0 ? users : hostUsers(resolved)
}
