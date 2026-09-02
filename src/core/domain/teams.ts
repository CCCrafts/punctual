/**
 * Team roles, and what they grant.
 *
 * `team_members.role` existed from the first schema but granted nothing:
 * any member could add or remove anyone. Punctual is a corporate tool, so
 * the person setting up a joint meeting needs to do the whole job — pick
 * the hosts and arrange each host's availability — and that is an admin's
 * job, not every member's.
 *
 * Two tiers, deliberately, not three: `owner` and `admin` are both
 * "manages the team" (the value `owner` stays valid so nothing written
 * before this pass becomes unreadable), and `member` is "hosts meetings,
 * adjusts their own availability". An instance admin manages every team.
 */

import type { TeamMember, TeamRole, User } from './types.js'

const MANAGING_ROLES: ReadonlySet<TeamRole> = new Set<TeamRole>(['owner', 'admin'])

export function isManagingRole(role: TeamRole): boolean {
  return MANAGING_ROLES.has(role)
}

/**
 * Whether `user` may manage a team: its members and roles, its event types,
 * and its members' availability on the team's behalf.
 *
 * `membership` is the user's own row on that team, or null when they are
 * not on it. An instance admin manages every team, member or not — the
 * same reach they already have over users and instance settings.
 */
export function canManageTeam(user: Pick<User, 'role'>, membership: TeamMember | null | undefined): boolean {
  if (user.role === 'admin') return true
  return membership !== null && membership !== undefined && isManagingRole(membership.role)
}
