/**
 * The event-type editor and the home cards, rendered straight from the page
 * functions. A usability pass on the live dashboard found this form saying
 * the wrong address for a team-owned event, hiding the hosts table's third
 * column on a phone, and marking a slug required that the route derives
 * anyway; these pin the fixes without a database.
 */

import { describe, expect, it } from 'vitest'
import type { ResolvedHost } from '../../src/core/domain/hosts.js'
import type { EventType, Schedule, Team, User } from '../../src/core/domain/types.js'
import { hostsRow } from '../../src/http/pages/booking.js'
import {
  type EventTypeFormData,
  type HostChoice,
  dashboardHome,
  eventTypeForm,
  parseQuestions,
  questionsParseError,
} from '../../src/http/pages/dashboard.js'

const user: User = {
  id: 'u_host',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  tz: 'America/New_York',
  slug: 'grace',
  avatarKey: null,
  company: null,
  jobTitle: null,
  companyUrl: null,
  role: 'member',
  createdAt: 0,
}

const bob: User = { ...user, id: 'u_bob', email: 'bob@example.com', name: 'Bob Chen', slug: 'bob' }

const support: Team = { id: 'team_support', name: 'Support Crew', slug: 'support', logoKey: null, createdAt: 0 }

const workday = [{ startMinute: 9 * 60, endMinute: 17 * 60 }]
const schedule = (id: string, userId: string, name: string, isDefault: boolean): Schedule => ({
  id,
  userId,
  name,
  isDefault,
  timezone: 'UTC',
  weekly: [[], workday, workday, workday, workday, workday, []],
  overrides: [],
})

const eventType: EventType = {
  id: 'evt_1',
  ownerUserId: 'u_host',
  ownerTeamId: null,
  schedulingType: 'personal',
  slug: 'intro',
  title: 'Intro call',
  description: '',
  durationMinutes: 30,
  slotIntervalMinutes: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 60,
  maxHorizonDays: 60,
  maxPerDay: null,
  locationType: 'google_meet',
  locationValue: null,
  questions: [],
  active: true,
  scheduleId: null,
  createdAt: 0,
}

const teamEvent: EventType = {
  ...eventType,
  id: 'evt_team',
  ownerUserId: null,
  ownerTeamId: support.id,
  schedulingType: 'collective',
  slug: 'support-call',
  title: 'Support call',
}

const hostChoices: HostChoice[] = [
  { user, schedules: [schedule('sch_g', user.id, 'Default', true)], row: null, selected: true, teamWeight: 1 },
  {
    user: bob,
    schedules: [schedule('sch_b', bob.id, 'Default', true), schedule('sch_b2', bob.id, 'Support hours', false)],
    row: { eventTypeId: teamEvent.id, userId: bob.id, required: false, scheduleId: 'sch_b2', rrWeight: null, position: 1 },
    selected: true,
    teamWeight: 2,
  },
]

const base: EventTypeFormData = { brandName: 'Punctual', user, csrf: 'tok', emailDelivery: 'brevo' }

/** The `<input>`/`<select>`/`<textarea>` tag carrying this id, or '' when absent. */
function control(html: string, id: string): string {
  return new RegExp(`<(?:input|select|textarea) id="${id}"[^>]*>`).exec(html)?.[0] ?? ''
}

describe('eventTypeForm — the address a guest will use', () => {
  it('previews the TEAM slug for a team-owned event type', () => {
    const html = eventTypeForm({ ...base, eventType: teamEvent, teams: [support], hostChoices })
    expect(html).toContain('Booked at <code>/support/support-call</code>')
    expect(html).not.toContain('/grace/')
    // The old second copy under the Owner select, with placeholders instead
    // of the real address, is gone.
    expect(html).not.toContain('team-slug')
  })

  it('previews the user slug for a personal one, with a placeholder while the slug is blank', () => {
    expect(eventTypeForm({ ...base, eventType })).toContain('Booked at <code>/grace/intro</code>')
    expect(eventTypeForm({ ...base, teams: [support] })).toContain('Booked at <code>/grace/&lt;slug&gt;</code>')
    // A rejected slug is quoted by the error, not previewed as an address.
    expect(eventTypeForm({ ...base, eventType: { ...eventType, slug: 'Bad Slug!' } })).toContain('Booked at <code>/grace/&lt;slug&gt;</code>')
  })

  it('does not require the slug — the route derives it from the title', () => {
    const slug = control(eventTypeForm(base), 'slug')
    expect(slug).not.toContain('required')
    expect(eventTypeForm(base)).toContain('Leave blank to use the title')
    expect(control(eventTypeForm(base), 'title')).toContain('placeholder="30 min intro call"')
  })
})

describe('eventTypeForm — structure', () => {
  it('groups the fields into legended fieldsets, in reading order', () => {
    const html = eventTypeForm({ ...base, teams: [support] })
    const legends = [...html.matchAll(/<legend>([^<]+)<\/legend>/g)].map((m) => m[1])
    expect(legends).toEqual(['Basics', 'Who hosts', 'When and how long', 'Where', 'Questions'])
    // Description moved under the slug, into Basics.
    expect(html.indexOf('id="description"')).toBeLessThan(html.indexOf('<legend>Who hosts</legend>'))
  })

  it('omits "Who hosts" for a host with no team and only the default schedule', () => {
    const html = eventTypeForm({ ...base, schedules: [schedule('sch_g', user.id, 'Default', true)] })
    expect(html).not.toContain('Who hosts')
    expect(html).toContain('<legend>Basics</legend>')
  })

  it('wraps the conditional columns for the stylesheet, with short option labels', () => {
    const html = eventTypeForm({ ...base, teams: [support], eventType })
    expect(html).toContain('class="pu-sched-wrap"')
    expect(html).toContain('class="pu-loc-wrap"')
    expect(html).toContain('>Round robin</option>')
    expect(html).toContain('>Collective</option>')
    expect(html).toContain('Round robin: one host takes each booking. Collective: every host attends.')
  })

  it('lays the seven numbers out with a help line under every cell', () => {
    const html = eventTypeForm(base)
    const grid = html.slice(html.indexOf('class="pu-num-grid"'), html.indexOf('<legend>Where</legend>'))
    expect((grid.match(/type="number"/g) ?? []).length).toBe(7)
    expect((grid.match(/class="pu-help"/g) ?? []).length).toBe(7)
    expect(grid).toContain('Minimum notice (minutes, e.g. 1440 = 1 day)')
    const order = ['durationMinutes', 'slotIntervalMinutes', 'bufferBeforeMinutes', 'bufferAfterMinutes', 'minNoticeMinutes', 'maxHorizonDays', 'maxPerDay']
    const positions = order.map((id) => grid.indexOf(`id="${id}"`))
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('shows a worked example in the questions box', () => {
    const html = eventTypeForm(base)
    expect(control(html, 'questions')).toContain('placeholder="Company | text | required&#10;Topic | select | optional | Sales, Support"')
    expect(html).toContain('One question per line &mdash; label, type, required?, options. Example above.')
  })
})

describe('eventTypeForm — errors', () => {
  const errors = { title: 'Give it a title (up to 120 characters)', durationMinutes: 'Between 5 and 1440 minutes, in steps of 5' }

  it('counts the errors in a notice at the top and focuses the first one', () => {
    const html = eventTypeForm({ ...base, eventType: { ...eventType, title: '', durationMinutes: 7 }, errors })
    expect(html).toContain('role="alert">Fix the 2 fields marked below.')
    expect(html.indexOf('Fix the 2 fields')).toBeLessThan(html.indexOf('<legend>Basics</legend>'))
    expect(control(html, 'title')).toContain(' autofocus')
    expect(control(html, 'durationMinutes')).not.toContain('autofocus')
    expect((html.match(/ autofocus/g) ?? []).length).toBe(1)
  })

  it('reads naturally for one error, and stays silent with none', () => {
    const html = eventTypeForm({ ...base, eventType: { ...eventType, slug: 'Bad Slug' }, errors: { slug: 'Lowercase letters, numbers and hyphens only' } })
    expect(html).toContain('Fix the field marked below.')
    expect(control(html, 'slug')).toContain(' autofocus')
    expect(eventTypeForm({ ...base, eventType })).not.toContain('marked below')
  })

  it('does not count the delete form’s own message', () => {
    const html = eventTypeForm({ ...base, eventType, errors: { delete: 'Still has bookings' } })
    expect(html).not.toContain('marked below')
    expect(html).not.toContain('autofocus')
  })

  it('puts every field error right after its control, so the red-border rule applies to all of them', () => {
    const all: Record<string, string> = {}
    for (const id of ['title', 'slug', 'description', 'owner', 'schedulingType', 'scheduleId', 'durationMinutes', 'maxPerDay', 'locationType', 'locationValue', 'questions']) all[id] = `bad ${id}`
    const html = eventTypeForm({
      ...base,
      eventType: teamEvent,
      teams: [support],
      schedules: [schedule('sch_g', user.id, 'Default', true), schedule('sch_g2', user.id, 'Evenings', false)],
      errors: all,
    })
    for (const id of Object.keys(all)) {
      const tag = control(html, id)
      expect(tag, id).not.toBe('')
      const after = html.slice(html.indexOf(tag) + tag.length)
      // A select's or textarea's error follows its closing tag; an input is void.
      const next = /^(?:[^<]*<\/textarea>|(?:\s*<option[^>]*>[^<]*<\/option>)*\s*<\/select>)?\s*<p class="pu-err"/.test(after)
      expect(next, `${id} error must be the next sibling`).toBe(true)
    }
  })
})

describe('eventTypeForm — hosts block', () => {
  it('renders one stacked row per host, with the same field names the route reads back', () => {
    const html = eventTypeForm({ ...base, eventType: teamEvent, teams: [support], hostChoices })
    const rows = html.match(/class="pu-host-row"/g) ?? []
    expect(rows).toHaveLength(2)
    expect(html).not.toContain('<table')
    for (const id of [user.id, bob.id]) {
      expect(html).toContain(`name="host-${id}" value="on" checked`)
      expect(html).toContain(`name="host-${id}-mode"`)
      expect(html).toContain(`name="host-${id}-schedule"`)
    }
    expect(html).toContain('<option value="sch_b2" selected>Support hours</option>')
  })

  it('offers one link to the Teams page, in a new tab, instead of a link per host', () => {
    const html = eventTypeForm({ ...base, eventType: teamEvent, teams: [support], hostChoices })
    expect(html.match(/Manage member schedules/g)).toHaveLength(1)
    expect(html).toContain('<a href="/dashboard/teams" target="_blank" rel="noopener">Manage member schedules (opens in a new tab)</a>')
    expect(html).not.toContain('New schedule for')
  })
})

describe('eventTypeForm — hosts editor', () => {
  const roundRobin: EventType = { ...teamEvent, schedulingType: 'round_robin' }
  const render = (et: EventType, choices: HostChoice[] = hostChoices) =>
    eventTypeForm({ ...base, eventType: et, teams: [support], hostChoices: choices })
  /** The "Guests will see" line's sentence, without the label. */
  const preview = (html: string): string => /<p class="pu-host-preview">Guests will see: ([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ''
  /** What the booking page would print for the same hosts — the sentence inside its row. */
  const bookingSentence = (et: EventType, hosts: ResolvedHost[]): string =>
    /<p class="pu-hosts-text">([\s\S]*?)<\/p>/.exec(hostsRow({ eventType: et, hosts, team: support }))?.[1] ?? ''

  it('previews the collective sentence with the booking page\'s own wording', () => {
    const html = render(teamEvent)
    expect(preview(html)).toBe("You'll meet <strong>Grace Hopper</strong> <span class=\"pu-hosts-team\">(Support Crew)</span>. <strong>Bob Chen</strong> joins when free")
    expect(preview(html)).toBe(
      bookingSentence(teamEvent, [
        { user, required: true, scheduleId: null, rrWeight: 1 },
        { user: bob, required: false, scheduleId: 'sch_b2', rrWeight: 2 },
      ]),
    )
  })

  it('previews the round-robin pool with "or", never a specific person', () => {
    const html = render(roundRobin)
    expect(preview(html)).toBe('With one of <strong>Grace Hopper or Bob Chen</strong> <span class="pu-hosts-team">(Support Crew)</span>')
    expect(preview(html)).toBe(
      bookingSentence(roundRobin, [
        { user, required: true, scheduleId: null, rrWeight: 1 },
        { user: bob, required: true, scheduleId: 'sch_b2', rrWeight: 2 },
      ]),
    )
  })

  it('previews the submitted state on a round trip, and says so when nobody is ticked', () => {
    const drafted = hostChoices.map((c) => ({
      ...c,
      draft: { selected: c.user.id === bob.id, required: true, scheduleId: null, weightText: '' },
    }))
    expect(preview(render(teamEvent, drafted))).toBe("You'll meet <strong>Bob Chen</strong> <span class=\"pu-hosts-team\">(Support Crew)</span>")
    expect(render(teamEvent, drafted)).toContain(`name="host-${user.id}" value="on">`)
    expect(render(teamEvent, drafted)).toContain(`name="host-${bob.id}" value="on" checked`)

    const nobody = hostChoices.map((c) => ({ ...c, draft: { selected: false, required: true, scheduleId: null, weightText: '' } }))
    expect(preview(render(teamEvent, nobody))).toBe('<em>nobody yet &mdash; tick at least one host</em>')
  })

  it('round robin: a share beside each weight, from the effective weights over the ticked hosts', () => {
    // Team weights 1 and 2, no overrides: a third and two thirds.
    const html = render(roundRobin)
    expect(html.match(/<span class="pu-host-share">&asymp; (\d+)%<\/span>/g)).toEqual([
      '<span class="pu-host-share">&asymp; 33%</span>',
      '<span class="pu-host-share">&asymp; 67%</span>',
    ])
    expect(html).toContain('A higher weight takes a proportionally larger share')

    // A typed override of 3 for Grace over Bob's team weight of 2: 60/40.
    // An unticked host takes no share at all, so the line is left off.
    const drafted = hostChoices.map((c) => ({
      ...c,
      draft: { selected: true, required: true, scheduleId: null, weightText: c.user.id === user.id ? '3' : '' },
    }))
    expect(render(roundRobin, drafted).match(/&asymp; \d+%/g)).toEqual(['&asymp; 60%', '&asymp; 40%'])
    const one = drafted.map((c) => (c.user.id === bob.id ? { ...c, draft: { ...c.draft, selected: false } } : c))
    expect(render(roundRobin, one).match(/&asymp; \d+%/g)).toEqual(['&asymp; 100%'])
    // Collective has no shares.
    expect(render(teamEvent)).not.toContain('<span class="pu-host-share">')
  })

  it('echoes a typed weight verbatim on a round trip, sharing by the team weight until it is valid', () => {
    const drafted = hostChoices.map((c) => ({
      ...c,
      draft: { selected: true, required: true, scheduleId: null, weightText: c.user.id === user.id ? '250' : '' },
    }))
    const html = render(roundRobin, drafted)
    expect(html).toContain(`name="host-${user.id}-weight" type="number" min="1" max="100" aria-label="Grace Hopper: round-robin weight"\n                 value="250"`)
    expect(html.match(/&asymp; \d+%/g)).toEqual(['&asymp; 33%', '&asymp; 67%'])
  })

  it('summarises the selected schedule beside each select — the default when "Default" is chosen', () => {
    const html = render(teamEvent)
    const notes = [...html.matchAll(/<span class="pu-host-sched-note">([^<]*)<\/span>/g)].map((m) => m[1])
    expect(notes).toEqual(['Mon\u2013Fri 09:00\u201317:00 \u00b7 UTC', 'Mon\u2013Fri 09:00\u201317:00 \u00b7 UTC'])

    const evening = [{ startMinute: 18 * 60, endMinute: 21 * 60 }]
    const varied: HostChoice[] = [
      {
        ...hostChoices[0]!,
        schedules: [
          { ...schedule('sch_g', user.id, 'Default', true), timezone: 'Europe/Kyiv', weekly: [[], workday, [], workday, [], workday, []] },
          { ...schedule('sch_g2', user.id, 'Evenings', false), weekly: [[], workday, evening, workday, evening, [], []] },
        ],
        row: { eventTypeId: teamEvent.id, userId: user.id, required: true, scheduleId: 'sch_g2', rrWeight: null, position: 0 },
      },
    ]
    // Same hours on non-adjacent days are listed; differing hours fall back to the count-and-total form.
    expect(render(teamEvent, varied)).toContain('<span class="pu-host-sched-note">4 days/week &middot; ~22h total &middot; UTC</span>')
    const asDefault = [{ ...varied[0]!, row: null }]
    expect(render(teamEvent, asDefault)).toContain('<span class="pu-host-sched-note">Mon, Wed, Fri 09:00\u201317:00 \u00b7 Europe/Kyiv</span>')
  })

  it('offers move up/down per row as no-JS submits, with the ends disabled', () => {
    const html = render(teamEvent)
    expect(html).toContain(`name="host-move" value="${user.id}:up" formnovalidate class="pu-host-move-btn"\n                  aria-label="Move Grace Hopper up" title="Move up" disabled>`)
    expect(html).toContain(`name="host-move" value="${user.id}:down" formnovalidate class="pu-host-move-btn"\n                  aria-label="Move Grace Hopper down" title="Move down">`)
    expect(html).toContain(`name="host-move" value="${bob.id}:up" formnovalidate class="pu-host-move-btn"\n                  aria-label="Move Bob Chen up" title="Move up">`)
    expect(html).toContain(`name="host-move" value="${bob.id}:down" formnovalidate class="pu-host-move-btn"\n                  aria-label="Move Bob Chen down" title="Move down" disabled>`)
    // The rows render in the order of the choices, which the route controls.
    const reversed = render(teamEvent, [hostChoices[1]!, hostChoices[0]!])
    expect(reversed.indexOf(`name="host-${bob.id}"`)).toBeLessThan(reversed.indexOf(`name="host-${user.id}"`))
    expect(reversed).toContain(`aria-label="Move Bob Chen up" title="Move up" disabled>`)
    expect(preview(reversed)).toBe("You'll meet <strong>Grace Hopper</strong> <span class=\"pu-hosts-team\">(Support Crew)</span>. <strong>Bob Chen</strong> joins when free")
  })

  it('keeps Enter as "save": a hidden default submit precedes the first move button', () => {
    const html = render(teamEvent)
    const hidden = html.indexOf('<button type="submit" class="pu-sr" tabindex="-1">Save changes</button>')
    expect(hidden).toBeGreaterThan(html.indexOf('<legend>Hosts</legend>'))
    expect(hidden).toBeLessThan(html.indexOf('name="host-select"'))
    expect(hidden).toBeLessThan(html.indexOf('name="host-move"'))
    expect(html.slice(html.indexOf('class="pu-et-form"'), hidden)).not.toContain('<button')
  })

  it('offers select all / none on the same round trip, and a preview link to the team\'s booking page', () => {
    const html = render(teamEvent)
    expect(html).toContain('<button type="submit" name="host-select" value="all" formnovalidate class="pu-btn pu-btn-ghost">Select all</button>')
    expect(html).toContain('<button type="submit" name="host-select" value="none" formnovalidate class="pu-btn pu-btn-ghost">Select none</button>')
    expect(html).toContain('<a href="/support/support-call" target="_blank" rel="noopener">Preview booking page (opens in a new tab)</a>')
    // A slug that failed validation is not linked: the page would only 404.
    expect(render({ ...teamEvent, slug: 'Bad Slug!' })).not.toContain('Preview booking page')
  })
})

describe('custom questions — parse errors name the line', () => {
  it('quotes the offending line and says what is wrong with it', () => {
    const text = 'Company | text | required\nTopic | dropdown | optional'
    expect(questionsParseError(text)).toBe('Line 2 ("Topic | dropdown | optional"): the type must be text, textarea or select, not "dropdown"')
    expect(parseQuestions(text)).toBeNull()
  })

  it('counts blank lines, so the number matches the box', () => {
    expect(questionsParseError('\n\nTopic | select | optional')).toMatch(/^Line 3 \("Topic \| select \| optional"\): a select needs its options/)
    expect(questionsParseError('Topic | text | maybe')).toContain('required or optional, not "maybe"')
  })

  it('is null for text that parses', () => {
    expect(questionsParseError('Company | text | required\nTopic | select | optional | Sales, Support')).toBeNull()
    expect(questionsParseError('')).toBeNull()
  })
})

describe('dashboardHome — event type cards', () => {
  const home = {
    ...base,
    baseUrl: 'https://punctual.test',
    upcomingBookings: [],
    hasCalendarConnection: true,
    defaultSchedule: null,
    eventTypes: [
      { eventType, ownerSlug: 'grace' },
      { eventType: { ...teamEvent, active: false }, ownerSlug: 'support', teamName: 'Support Crew', canEdit: false },
    ],
  }

  it('keeps the link row without a visible caption, labelled for assistive tech', () => {
    const html = dashboardHome(home)
    expect(html).not.toContain('Public link</label>')
    expect(html).toContain('aria-label="Public link for Intro call"')
    expect(html).toContain('value="https://punctual.test/support/support-call"')
  })

  it('puts Edit and Preview in the header beside the badges, and drops the decorative dot', () => {
    const html = dashboardHome(home)
    const card = html.slice(html.indexOf('<article class="pu-card pu-et-card">'), html.indexOf('</article>'))
    const head = card.slice(card.indexOf('class="pu-et-head"'), card.indexOf('class="pu-meta'))
    expect(head).toContain('>Edit</a>')
    expect(head).toContain('>Preview</a>')
    expect(card).not.toContain('pu-dot')
    expect(html).toContain('>Hidden</span>')
    expect(html).toContain('Managed by the team')
  })
})
