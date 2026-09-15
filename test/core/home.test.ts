import { describe, expect, it } from 'vitest'
import type { EventType } from '../../src/core/domain/types.js'
import { homeFeatured, homeGroups, homeItems, isEmailAddress, isHttpUrl, parseHomeSettings, type HomeItem, type HomeOwner } from '../../src/core/domain/home.js'
import { instanceHomePage, linkify } from '../../src/http/pages/home.js'

function eventType(patch: Partial<EventType>): EventType {
  return {
    id: 'et_1',
    ownerUserId: 'u_1',
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: 'intro',
    title: 'Intro call',
    description: 'A short chat.',
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
    createdAt: 0,
    scheduleId: null,
    ...patch,
  }
}

const grace: HomeOwner = { kind: 'user', id: 'u_1', slug: 'grace', name: 'Grace Hopper', avatarKey: null, jobTitle: 'CTO', company: 'Acme', companyUrl: null }
const crew: HomeOwner = {
  kind: 'team', id: 't_1', slug: 'support', name: 'Support Crew', avatarKey: null, jobTitle: null, company: null, companyUrl: null,
  people: [{ name: 'Alice', avatarKey: null }, { name: 'Bob', avatarKey: `${'ab'.repeat(32)}-thumb.webp` }], peopleCount: 6,
}
const items: HomeItem[] = [
  { eventType: eventType({ id: 'et_1' }), owner: grace },
  { eventType: eventType({ id: 'et_2', title: 'Support call', slug: 'support', description: '', durationMinutes: 15, ownerUserId: null, ownerTeamId: 't_1', schedulingType: 'round_robin' }), owner: crew },
  { eventType: eventType({ id: 'et_3', title: 'Onboarding', slug: 'onboarding', ownerUserId: null, ownerTeamId: 't_1', schedulingType: 'collective' }), owner: crew },
  { eventType: eventType({ id: 'et_4', active: false }), owner: grace },
]

describe('homepage settings', () => {
  it('default to the landing, and read the index settings back with their limits', () => {
    expect(parseHomeSettings({})).toEqual({ mode: 'landing', title: '', intro: '', eventTypeIds: [], featuredId: null, website: '', contactEmail: '' })
    const s = parseHomeSettings({
      home_mode: 'index', home_title: '  Acme  ', home_intro: 'Hi\n\nThere', home_event_types: '["et_2","et_1",3]',
      home_featured: 'et_2', home_website: 'https://acme.com', home_contact: 'hello@acme.com',
    })
    expect(s).toEqual({ mode: 'index', title: 'Acme', intro: 'Hi\n\nThere', eventTypeIds: ['et_2', 'et_1'], featuredId: 'et_2', website: 'https://acme.com', contactEmail: 'hello@acme.com' })
    expect(parseHomeSettings({ home_mode: 'index', home_event_types: 'not json' }).eventTypeIds).toEqual([])
    expect(parseHomeSettings({ home_mode: 'garbage' }).mode).toBe('landing')
    // A featured id that is not picked, a website that is not http(s), an address that is not one: none.
    const off = parseHomeSettings({ home_event_types: '["et_1"]', home_featured: 'et_9', home_website: 'javascript:alert(1)', home_contact: 'not-an-address' })
    expect([off.featuredId, off.website, off.contactEmail]).toEqual([null, '', ''])
  })

  it('validates a website and an address the way the form does', () => {
    expect(isHttpUrl('https://acme.com/about')).toBe(true)
    expect(isHttpUrl('http://acme.com')).toBe(true)
    for (const bad of ['acme.com', 'ftp://acme.com', 'javascript:alert(1)', 'https://', '']) expect(isHttpUrl(bad), bad).toBe(false)
    expect(isEmailAddress('hello@acme.com')).toBe(true)
    for (const bad of ['hello', 'hello@', '@acme.com', 'a b@acme.com', 'hello@acme']) expect(isEmailAddress(bad), bad).toBe(false)
  })

  it("lists the picked event types in the admin's order and drops what is gone or inactive", () => {
    const picked = homeItems(parseHomeSettings({ home_event_types: '["et_2","et_gone","et_4","et_1"]' }), items)
    expect(picked.map((i) => i.eventType.id)).toEqual(['et_2', 'et_1'])
  })

  it('groups by owner in order of first appearance, leaving the featured item to the hero unless it is alone', () => {
    const picked = homeItems(parseHomeSettings({ home_event_types: '["et_1","et_2","et_3"]', home_featured: 'et_2' }), items)
    const featured = homeFeatured(parseHomeSettings({ home_event_types: '["et_1","et_2","et_3"]', home_featured: 'et_2' }), picked)
    expect(featured?.eventType.id).toBe('et_2')
    const groups = homeGroups(picked, featured)
    expect(groups.map((g) => [g.owner.name, g.items.map((i) => i.eventType.id)])).toEqual([
      ['Grace Hopper', ['et_1']],
      ['Support Crew', ['et_3']],
    ])
    const alone = homeGroups([picked[1]!], picked[1]!)
    expect(alone.map((g) => g.items.length)).toEqual([1])
  })
})

describe('links in the intro', () => {
  it('makes URLs and addresses clickable after escaping, and leaves typed markup as text', () => {
    expect(linkify('See https://acme.com/about?a=1&b=2. Write hello@acme.com or <b>nothing</b>')).toBe(
      'See <a href="https://acme.com/about?a=1&amp;b=2" target="_blank" rel="noopener">acme.com/about?a=1&amp;b=2</a>. Write <a href="mailto:hello@acme.com">hello@acme.com</a> or &lt;b&gt;nothing&lt;/b&gt;',
    )
    expect(linkify('(https://acme.com)')).toBe('(<a href="https://acme.com" target="_blank" rel="noopener">acme.com</a>)')
  })

  it('keeps a profile URL with an @ in it as one link, and a quote out of the href (caught by review)', () => {
    expect(linkify('Follow https://www.threads.net/@serge.bulaev today')).toBe(
      'Follow <a href="https://www.threads.net/@serge.bulaev" target="_blank" rel="noopener">www.threads.net/@serge.bulaev</a> today',
    )
    expect(linkify('See "https://acme.com" now')).toBe('See &quot;<a href="https://acme.com" target="_blank" rel="noopener">acme.com</a>&quot; now')
    expect(linkify("It's https://acme.com/a'b")).toBe('It&#39;s <a href="https://acme.com/a" target="_blank" rel="noopener">acme.com/a</a>&#39;b')
  })
})

describe('the instance homepage', () => {
  const picked = homeItems(parseHomeSettings({ home_event_types: '["et_2","et_1","et_3"]', home_featured: 'et_2' }), items)
  const featured = picked[0]!
  const base = {
    brandName: 'Punctual',
    baseUrl: 'https://book.acme.com',
    title: 'Acme',
    intro: 'Book time with us at https://acme.com.\n\nWe answer within a day.',
    website: 'https://acme.com/',
    contactEmail: 'hello@acme.com',
    companyLogo: null,
    featured,
    groups: homeGroups(picked, featured),
  }

  it('is a hero with the featured meeting, then a section per owner, indexable under its own URL', () => {
    const html = instanceHomePage(base)
    expect(html).toContain('<title>Acme</title>')
    expect(html).toContain('<link rel="canonical" href="https://book.acme.com/">')
    expect(html).toContain('<meta name="description" content="Book time with us at https://acme.com.">')
    // Hero: the featured card names its owner with the team's faces and count, and a call to action.
    expect(html).toContain('class="pu-home-hero pu-home-hero-split"')
    expect(html).toContain('class="pu-home-featured" href="/support/support"')
    expect(html).toContain('<strong>Support Crew</strong>')
    expect(html).toContain('6 people')
    expect(html).toContain('aria-hidden="true">+4</span>')
    expect(html).toContain('Pick a time')
    // Intro links are live; the site and the address are under it and in the footer.
    expect(html).toContain('<a href="https://acme.com" target="_blank" rel="noopener">acme.com</a>.')
    expect(html).toContain('<p>We answer within a day.</p>')
    expect((html.match(/href="mailto:hello@acme.com"/g) ?? []).length).toBe(2)
    expect(html).toContain('href="https://acme.com/" target="_blank" rel="noopener">acme.com</a>')
    // Sections: Grace with her title and company, the crew with its remaining meeting.
    expect(html).toContain('<h2>Grace Hopper</h2><p class="pu-muted">CTO, Acme</p>')
    expect(html).toContain('href="/grace/intro"')
    expect(html).toContain('<h2>Support Crew</h2>')
    expect(html).toContain('href="/support/onboarding"')
    expect(html).toContain('with one of the team')
    expect(html).not.toContain('Calendly')
    expect(html).toContain('Scheduling by')
    // The way to the dashboard, for the hosts, without a nav the guests do not need.
    expect(html).toContain('<a href="/login">Sign in</a>')
  })

  it('heads with the company logo — the title beside a round one, alone as a wordmark — and escapes what the admin typed', () => {
    const key = `${'cd'.repeat(32)}-thumb.webp`
    const round = instanceHomePage({ ...base, title: '<Acme> & co', companyLogo: { key, shape: 'circle' } })
    expect(round).toContain(`/avatars/${key}`)
    expect(round).toContain('<p class="pu-host-name">&lt;Acme&gt; &amp; co</p>')
    expect(round).toContain('<h1 class="pu-sr">&lt;Acme&gt; &amp; co</h1>')
    const wordmark = instanceHomePage({ ...base, companyLogo: { key, shape: 'natural' } })
    expect(wordmark).toContain(`/avatars/${'cd'.repeat(32)}-fit.webp`)
    expect(wordmark).toContain('<h1 class="pu-sr">Acme</h1>')
    expect(wordmark).not.toContain('class="pu-host-name"')
  })

  it('without a featured meeting the hero is text alone; with nothing picked it says so', () => {
    const plain = instanceHomePage({ ...base, featured: null, groups: homeGroups(picked, null) })
    expect(plain).toContain('class="pu-home-hero"')
    expect(plain).not.toContain('pu-home-featured"')
    expect(plain).toContain('href="/support/support"')
    const empty = instanceHomePage({ ...base, title: '', intro: '', website: '', contactEmail: '', featured: null, groups: [] })
    expect(empty).toContain('<h1>Punctual</h1>')
    expect(empty).toContain('Nothing to book here yet.')
    expect(empty).not.toContain('name="description"')
    expect(empty).not.toContain('mailto:')
  })
})
