/**
 * What an instance's front page is.
 *
 * `/` used to be the Punctual landing on every deployment — a self-hoster's
 * own domain fronted by our marketing (issue #8). An instance now chooses:
 * the landing (the default, what punctual.sh shows) or an index of the
 * instance — the company logo, a title, an intro, and the booking links an
 * admin picked. Stored as `instance_settings` rows, edited on the Admin page.
 */

import type { EventType } from './types.js'

export const HOME_MODE = 'home_mode'
export const HOME_TITLE = 'home_title'
export const HOME_INTRO = 'home_intro'
export const HOME_EVENT_TYPES = 'home_event_types'
export const HOME_KEYS = [HOME_MODE, HOME_TITLE, HOME_INTRO, HOME_EVENT_TYPES] as const

export type HomeMode = 'landing' | 'index'

export interface HomeSettings {
  mode: HomeMode
  /** Empty means the brand name. */
  title: string
  intro: string
  /** Event type ids, in the order the admin listed them. */
  eventTypeIds: string[]
}

export const HOME_TITLE_MAX = 120
export const HOME_INTRO_MAX = 2000

export function parseHomeSettings(values: Record<string, string | undefined>): HomeSettings {
  let ids: string[] = []
  try {
    const parsed: unknown = JSON.parse(values[HOME_EVENT_TYPES] ?? '[]')
    if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    ids = []
  }
  return {
    mode: values[HOME_MODE] === 'index' ? 'index' : 'landing',
    title: (values[HOME_TITLE] ?? '').trim().slice(0, HOME_TITLE_MAX),
    intro: (values[HOME_INTRO] ?? '').trim().slice(0, HOME_INTRO_MAX),
    eventTypeIds: ids,
  }
}

export interface HomeItem {
  eventType: EventType
  /** The first segment of the booking link — the owner's or the team's slug. */
  ownerSlug: string
  /** The host's or the team's name, shown under the title. */
  ownerName: string
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
