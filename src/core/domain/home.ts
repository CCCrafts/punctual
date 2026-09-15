/**
 * What an instance's front page is.
 *
 * `/` used to be the Punctual landing on every deployment — a self-hoster's
 * own domain fronted by our marketing (issue #8). An instance now chooses:
 * the landing (the default, what punctual.sh shows) or an index of the
 * instance — the company logo, a title and an intro, a website and a
 * contact address, and the booking links an admin picked, one of them
 * featured. Stored as `instance_settings` rows, edited on the Admin page.
 */

import type { Repositories } from '../../ports.js'
import type { EventType } from './types.js'

export const HOME_MODE = 'home_mode'
export const HOME_TITLE = 'home_title'
export const HOME_INTRO = 'home_intro'
export const HOME_EVENT_TYPES = 'home_event_types'
export const HOME_FEATURED = 'home_featured'
export const HOME_WEBSITE = 'home_website'
export const HOME_CONTACT = 'home_contact'
export const HOME_KEYS = [HOME_MODE, HOME_TITLE, HOME_INTRO, HOME_EVENT_TYPES, HOME_FEATURED, HOME_WEBSITE, HOME_CONTACT] as const

export type HomeMode = 'landing' | 'index'

export interface HomeSettings {
  mode: HomeMode
  /** Empty means the brand name. */
  title: string
  intro: string
  /** Event type ids, in the order the admin listed them. */
  eventTypeIds: string[]
  /** The one shown large in the hero; null for none. */
  featuredId: string | null
  /** The company's site, an http(s) URL, or ''. */
  website: string
  /** An address a visitor may write to, or ''. */
  contactEmail: string
}

export const HOME_TITLE_MAX = 120
export const HOME_INTRO_MAX = 2000

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== ''
  } catch {
    return false
  }
}

export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
}

export function parseHomeSettings(values: Record<string, string | undefined>): HomeSettings {
  let ids: string[] = []
  try {
    const parsed: unknown = JSON.parse(values[HOME_EVENT_TYPES] ?? '[]')
    if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    ids = []
  }
  const featured = (values[HOME_FEATURED] ?? '').trim()
  const website = (values[HOME_WEBSITE] ?? '').trim()
  const contact = (values[HOME_CONTACT] ?? '').trim()
  return {
    mode: values[HOME_MODE] === 'index' ? 'index' : 'landing',
    title: (values[HOME_TITLE] ?? '').trim().slice(0, HOME_TITLE_MAX),
    intro: (values[HOME_INTRO] ?? '').trim().slice(0, HOME_INTRO_MAX),
    eventTypeIds: ids,
    featuredId: featured !== '' && ids.includes(featured) ? featured : null,
    website: isHttpUrl(website) ? website : '',
    contactEmail: isEmailAddress(contact) ? contact : '',
  }
}

/** Who a booking link belongs to — the first segment of its URL, and the face on its card. */
export interface HomeOwner {
  kind: 'user' | 'team'
  id: string
  slug: string
  name: string
  /** A person's photo; a team has none of its own — see `people`. */
  avatarKey: string | null
  jobTitle: string | null
  company: string | null
  companyUrl: string | null
  /** A team's members, a few of them, for the stack of faces; filled by `withTeamPeople`. */
  people?: Array<{ name: string; avatarKey: string | null }>
  peopleCount?: number
}

export interface HomeItem {
  eventType: EventType
  owner: HomeOwner
}

/**
 * The picked event types, in the admin's order, dropping any that no
 * longer exist or are no longer active — a link on the front page must
 * never 404.
 */
export function homeItems(settings: HomeSettings, listed: HomeItem[]): HomeItem[] {
  const byId = new Map(listed.map((item) => [item.eventType.id, item]))
  return settings.eventTypeIds.map((id) => byId.get(id)).filter((item): item is HomeItem => item !== undefined && item.eventType.active)
}

export interface HomeGroup {
  owner: HomeOwner
  items: HomeItem[]
}

/**
 * The page's sections: one per owner, in order of first appearance, so a
 * team's meetings sit under the team's name and faces, a person's under
 * theirs. The featured item is left out of its group — it is the hero —
 * unless it is the only item there is.
 */
export function homeGroups(items: HomeItem[], featured: HomeItem | null): HomeGroup[] {
  const rest = featured && items.length > 1 ? items.filter((i) => i !== featured) : items
  const groups: HomeGroup[] = []
  for (const item of rest) {
    const key = `${item.owner.kind}:${item.owner.id}`
    const group = groups.find((g) => `${g.owner.kind}:${g.owner.id}` === key)
    if (group) group.items.push(item)
    else groups.push({ owner: item.owner, items: [item] })
  }
  return groups
}

export function homeFeatured(settings: HomeSettings, items: HomeItem[]): HomeItem | null {
  return items.find((i) => i.eventType.id === settings.featuredId) ?? null
}

/** Up to this many faces in a team's stack; the rest is a count. */
export const HOME_FACES = 4

/**
 * Fill each team owner's `people` from its members: a few faces and the
 * count. One query per team, and a handful of user reads — the front page
 * is not a hot path, and a team with faces on it reads as people, not a
 * label.
 */
export async function withTeamPeople(repos: Repositories, items: HomeItem[]): Promise<HomeItem[]> {
  const cache = new Map<string, { people: HomeOwner['people']; peopleCount: number }>()
  const out: HomeItem[] = []
  for (const item of items) {
    if (item.owner.kind !== 'team') {
      out.push(item)
      continue
    }
    let filled = cache.get(item.owner.id)
    if (!filled) {
      const members = await repos.teams.members(item.owner.id)
      const people: NonNullable<HomeOwner['people']> = []
      for (const m of members.slice(0, HOME_FACES)) {
        const u = await repos.users.byId(m.userId)
        if (u) people.push({ name: u.name || u.slug, avatarKey: u.avatarKey })
      }
      filled = { people, peopleCount: members.length }
      cache.set(item.owner.id, filled)
    }
    out.push({ ...item, owner: { ...item.owner, ...filled } })
  }
  return out
}
