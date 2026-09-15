import { describe, expect, it } from 'vitest'
import type { EventType } from '../../src/core/domain/types.js'
import { homeItems, parseHomeSettings } from '../../src/core/domain/home.js'
import { instanceHomePage } from '../../src/http/pages/home.js'

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

describe('homepage settings', () => {
  it('default to the landing, and read the index settings back with their limits', () => {
    expect(parseHomeSettings({})).toEqual({ mode: 'landing', title: '', intro: '', eventTypeIds: [] })
    const s = parseHomeSettings({ home_mode: 'index', home_title: '  Acme  ', home_intro: 'Hi\n\nThere', home_event_types: '["et_2","et_1",3]' })
    expect(s).toEqual({ mode: 'index', title: 'Acme', intro: 'Hi\n\nThere', eventTypeIds: ['et_2', 'et_1'] })
    expect(parseHomeSettings({ home_mode: 'index', home_event_types: 'not json' }).eventTypeIds).toEqual([])
    expect(parseHomeSettings({ home_mode: 'garbage' }).mode).toBe('landing')
  })

  it("lists the picked event types in the admin's order and drops what is gone or inactive", () => {
    const listed = [
      { eventType: eventType({ id: 'et_1' }), ownerSlug: 'grace', ownerName: 'Grace' },
      { eventType: eventType({ id: 'et_2', title: 'Support', slug: 'support' }), ownerSlug: 'support', ownerName: 'Support Crew' },
      { eventType: eventType({ id: 'et_3', active: false }), ownerSlug: 'grace', ownerName: 'Grace' },
    ]
    const items = homeItems(parseHomeSettings({ home_event_types: '["et_2","et_gone","et_3","et_1"]' }), listed)
    expect(items.map((i) => i.eventType.id)).toEqual(['et_2', 'et_1'])
  })
})

describe('the instance homepage', () => {
  const base = {
    brandName: 'Punctual',
    baseUrl: 'https://book.acme.com',
    title: 'Acme',
    intro: 'Book time with us.\n\nWe answer within a day.',
    companyLogo: null,
    items: [
      { eventType: eventType({ id: 'et_1' }), ownerSlug: 'grace', ownerName: 'Grace Hopper' },
      { eventType: eventType({ id: 'et_2', title: 'Support call', slug: 'support', description: '', durationMinutes: 15 }), ownerSlug: 'support', ownerName: 'Support Crew' },
    ],
  }

  it('links every picked event type under its owner, with duration and owner, and is indexable under its own URL', () => {
    const html = instanceHomePage(base)
    expect(html).toContain('<title>Acme</title>')
    expect(html).toContain('<link rel="canonical" href="https://book.acme.com/">')
    expect(html).toContain('<meta name="description" content="Book time with us.">')
    expect(html).toContain('href="/grace/intro"')
    expect(html).toContain('href="/support/support"')
    expect(html).toContain('30 min · Grace Hopper')
    expect(html).toContain('15 min · Support Crew')
    expect(html).toContain('<p>Book time with us.</p>')
    expect(html).toContain('<p>We answer within a day.</p>')
    expect(html).not.toContain('Calendly')
  })

  it('heads with the company logo — the title beside a round one, alone as a wordmark — and escapes what the admin typed', () => {
    const key = `${'ab'.repeat(32)}-thumb.webp`
    const round = instanceHomePage({ ...base, title: '<Acme> & co', companyLogo: { key, shape: 'circle' } })
    expect(round).toContain(`/avatars/${key}`)
    expect(round).toContain('<p class="pu-host-name">&lt;Acme&gt; &amp; co</p>')
    expect(round).toContain('<h1 class="pu-sr">&lt;Acme&gt; &amp; co</h1>')
    const wordmark = instanceHomePage({ ...base, companyLogo: { key, shape: 'natural' } })
    expect(wordmark).toContain(`/avatars/${'ab'.repeat(32)}-fit.webp`)
    // The wordmark says the name; the heading is for assistive tech only.
    expect(wordmark).toContain('<h1 class="pu-sr">Acme</h1>')
    expect(wordmark).not.toContain('class="pu-host-name"')
  })

  it('falls back to the brand name and says so when nothing is picked', () => {
    const html = instanceHomePage({ ...base, title: '', intro: '', items: [] })
    expect(html).toContain('<h1>Punctual</h1>')
    expect(html).toContain('Nothing to book here yet.')
    expect(html).not.toContain('name="description"')
  })
})
