/**
 * Change who attends a team booking after it was made: add a co-host, or
 * take one off. Placeholder — the full implementation lands with the
 * host-change work; the dashboard's co-host forms already speak this
 * contract so the two can merge independently. Until then every call is
 * refused as `not_found`, which the page renders as a plain sentence
 * rather than as a change that silently did not happen.
 */

import type { EnginePorts } from '../../ports.js'
import type { Booking, User } from './types.js'

export type HostChangeFailure =
  | 'not_found'
  | 'not_allowed'
  | 'not_a_team_booking'
  | 'not_a_member'
  | 'already_host'
  | 'not_host'
  | 'last_host'
  | 'slot_taken'
  | 'past'

export type HostChangeResult =
  | { ok: true; booking: Booking; added: User[]; removed: User[] }
  | { ok: false; reason: HostChangeFailure }

export async function changeBookingHosts(
  _ports: EnginePorts,
  _actor: User,
  _input: { bookingId: string; add?: string[]; remove?: string[] },
): Promise<HostChangeResult> {
  return { ok: false, reason: 'not_found' }
}
