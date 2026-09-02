/**
 * "You're a host on …" — sent to each host NEWLY added to a team event
 * type, by whichever surface added them (dashboard or API). Tells them
 * which of their schedules the slots will use and where to change it:
 * an admin arranging someone's availability is exactly the case where
 * that person needs telling. Best-effort, after the write — a mail
 * provider hiccup must not undo a saved host list. Nothing for hosts who
 * were already on the event type; never to the editor about themselves.
 */

import type { EnginePorts, Repositories } from '../ports.js'
import type { EventType, User } from '../core/domain/types.js'
import { hostAddedEmail } from '../core/email-templates.js'

export interface HostChange {
  userId: string
  required: boolean
  scheduleId: string | null
}

export async function notifyNewHosts(
  ports: EnginePorts,
  repos: Repositories,
  editor: User,
  eventType: EventType,
  before: Set<string>,
  after: HostChange[],
): Promise<void> {
  const team = eventType.ownerTeamId ? await repos.teams.byId(eventType.ownerTeamId) : null
  if (!team || eventType.schedulingType === 'personal') return
  for (const host of after) {
    if (before.has(host.userId) || host.userId === editor.id) continue
    const user = await repos.users.byId(host.userId)
    if (!user) continue
    const schedule = host.scheduleId ? await repos.availability.byId(host.userId, host.scheduleId) : null
    const content = hostAddedEmail({
      brandName: ports.config.brandName,
      hostName: user.name || user.slug,
      eventTitle: eventType.title,
      teamName: team.name,
      schedulingType: eventType.schedulingType,
      required: host.required,
      scheduleName: schedule?.name ?? null,
      editorName: editor.name || editor.slug,
      availabilityUrl: `${ports.config.baseUrl.replace(/\/$/, '')}/dashboard/availability`,
      ...(ports.config.supportEmail ? { supportEmail: ports.config.supportEmail } : {}),
    })
    await ports.email
      .send({ to: user.email, toName: user.name, subject: content.subject, html: content.html, text: content.text })
      .catch((err) => console.error('[punctual] host-added email not sent', err))
  }
}

/** The effective host set before a change: the explicit rows, or every member. */
export async function currentHostIds(repos: Repositories, eventType: EventType): Promise<Set<string>> {
  if (!eventType.ownerTeamId) return new Set()
  const rows = await repos.eventTypeHosts.forEventType(eventType.id)
  if (rows.length > 0) return new Set(rows.map((r) => r.userId))
  return new Set((await repos.teams.members(eventType.ownerTeamId)).map((m) => m.userId))
}
