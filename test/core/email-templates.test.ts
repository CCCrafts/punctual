import { describe, expect, it } from 'vitest'
import type { Booking, EventType, User } from '../../src/core/domain/types.js'
import {
  bookingCancelled,
  bookingConfirmationForGuest,
  bookingConfirmationForHost,
  bookingRescheduled,
  bookingReminder,
  escapeHtml,
  formatWhen,
  magicLinkEmail,
  sanitizeHeader,
  type BookingEmailContext,
} from '../../src/core/email-templates.js'
import { formatInZone } from '../../src/core/time/zone.js'

// 2026-08-14 09:00 UTC = 12:00 in Kyiv (GMT+3), 05:00 in New York (GMT-4).
const START = Date.UTC(2026, 7, 14, 9, 0, 0)

const host: User = {
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

function eventType(patch: Partial<EventType> = {}): EventType {
  return {
    id: 'et_1',
    ownerUserId: 'u_host',
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
    ...patch,
  }
}

function booking(patch: Partial<Booking> = {}): Booking {
  return {
    id: 'bk_1',
    eventTypeId: 'et_1',
    hostUserId: 'u_host',
    hostUserIds: ['u_host'],
    guestName: 'Ada Lovelace',
    guestEmail: 'ada@example.com',
    guestTimezone: 'Europe/Kyiv',
    startUtc: START,
    endUtc: START + 30 * 60_000,
    localDate: '2026-08-14',
    status: 'confirmed',
    answers: {},
    externalEventIds: {},
    rescheduleOf: null,
    rescheduledTo: null,
    manageTokenHash: 'hash',
    cancelledAt: null,
    createdAt: Date.UTC(2026, 7, 10, 12, 0, 0),
    ...patch,
  }
}

function ctx(patch: Partial<BookingEmailContext> = {}): BookingEmailContext {
  return {
    booking: booking(),
    eventType: eventType(),
    host,
    brandName: 'Punctual',
    rescheduleUrl: 'https://punctual.example/b/bk_1/reschedule?t=abc',
    cancelUrl: 'https://punctual.example/b/bk_1/cancel?t=abc',
    bookingUrl: 'https://punctual.example/dashboard/bookings/bk_1',
    supportEmail: 'help@punctual.example',
    ...patch,
  }
}

/** Whatever ICU produces locally — hardcoding "12:00 PM" breaks on ICU drift. */
const timeIn = (ts: number, tz: string): string => formatInZone(ts, tz, { timeStyle: 'short' })

describe('the recipient reads their own timezone', () => {
  it('renders the SAME booking differently for guest and host', () => {
    const c = ctx()
    const guest = bookingConfirmationForGuest(c)
    const forHost = bookingConfirmationForHost(c)

    expect(guest.text).toContain(timeIn(START, 'Europe/Kyiv'))
    expect(forHost.text).toContain(timeIn(START, 'America/New_York'))
    // The point of the whole exercise: same instant, different strings.
    expect(timeIn(START, 'Europe/Kyiv')).not.toBe(timeIn(START, 'America/New_York'))
    expect(guest.text).not.toBe(forHost.text)
    expect(guest.subject).not.toBe(forHost.subject)
  })

  it('labels the offset so an ambiguous local time is still checkable', () => {
    const guest = bookingConfirmationForGuest(ctx())
    expect(guest.text).toContain('GMT+3')
    expect(guest.text).toContain('Europe/Kyiv')

    const forHost = bookingConfirmationForHost(ctx())
    expect(forHost.text).toContain('GMT-4')
    // The host also sees the guest's time, so "did we agree on the same
    // instant?" is answerable without a converter.
    expect(forHost.text).toContain(timeIn(START, 'Europe/Kyiv'))
  })

  it('the "All times shown in" note reads like a place, not a raw IANA id', () => {
    // Same humanization as the timezone picker on the booking page — the
    // underscore in the raw id reads as a system identifier, not a place,
    // in a sentence written for a guest.
    const forHost = bookingConfirmationForHost(ctx())
    expect(forHost.text).toContain('All times shown in America/New York')
    expect(forHost.text).not.toContain('America/New_York')
  })

  it('formatWhen spans start to end with the start offset', () => {
    const s = formatWhen(START, START + 30 * 60_000, 'Europe/Kyiv')
    expect(s).toContain(timeIn(START, 'Europe/Kyiv'))
    expect(s).toContain(timeIn(START + 30 * 60_000, 'Europe/Kyiv'))
    expect(s).toContain('(GMT+3)')
  })

  it('handles a 45-minute offset zone without rounding it away', () => {
    const guest = bookingConfirmationForGuest(
      ctx({ booking: booking({ guestTimezone: 'Pacific/Chatham' }) }),
    )
    expect(guest.text).toContain('GMT+12:45')
  })
})

describe('escaping — guest name is attacker-controlled', () => {
  const hostile = '<script>alert(1)</script>'

  it('escapes the guest name everywhere it appears in HTML', () => {
    const c = ctx({ booking: booking({ guestName: hostile }) })
    for (const mail of [bookingConfirmationForGuest(c), bookingConfirmationForHost(c)]) {
      expect(mail.html).not.toContain('<script>')
      expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    }
  })

  it('escapes answers, which are equally untrusted', () => {
    const c = ctx({
      eventType: eventType({
        questions: [{ id: 'q1', label: 'Agenda', type: 'text', required: false }],
      }),
      booking: booking({ answers: { q1: '"><img src=x onerror=alert(1)>' } }),
    })
    const mail = bookingConfirmationForHost(c)
    // The payload survives as visible text — which is the point. What must not
    // survive is the markup: no tag opens, and the attribute-breaking quote is
    // an entity, so it cannot escape the td it sits in either.
    expect(mail.html).not.toContain('<img')
    expect(mail.html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapeHtml covers the attribute characters too', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b')
    expect(escapeHtml('<a href="x">')).toBe('&lt;a href=&quot;x&quot;&gt;')
    expect(escapeHtml("it's")).toBe('it&#39;s')
    // Ampersand first, or the entity below would be double-escaped.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('strips CRLF from subjects so a name cannot inject a header', () => {
    expect(sanitizeHeader('Ada\r\nBcc: victim@example.com')).toBe('Ada Bcc: victim@example.com')
    const mail = bookingConfirmationForHost(
      ctx({ booking: booking({ guestName: 'Ada\r\nBcc: victim@example.com' }) }),
    )
    expect(mail.subject).not.toMatch(/[\r\n]/)
  })

  it('refuses to link a non-http URL', () => {
    const mail = bookingConfirmationForGuest(ctx({ rescheduleUrl: 'javascript:alert(1)' }))
    expect(mail.html).not.toContain('javascript:')
    expect(mail.text).not.toContain('javascript:')
  })
})

describe('email-client safety', () => {
  it('uses inline styles only — no <style> block, no flexbox or grid', () => {
    const html = bookingConfirmationForGuest(ctx()).html
    expect(html).not.toContain('<style')
    expect(html).not.toContain('display:flex')
    expect(html).not.toContain('display:grid')
    expect(html).toContain('<table')
    expect(html).toContain('max-width:600px')
  })

  it('paints the brand colours', () => {
    const html = bookingConfirmationForGuest(ctx()).html
    expect(html).toContain('#0E7C4C') // meridian green CTA
    expect(html).toContain('#FAFAF7') // paper
    expect(html).toContain('#0F1512') // ink
  })

  it('declares an explicit charset, so an en dash never turns to mojibake', () => {
    // Without <meta charset="utf-8">, a client that ignores or overrides the
    // transport's Content-Type header falls back to sniffing, and every en
    // dash and curly quote in this file (formatWhen's "9:00 AM – 9:30 AM")
    // renders as "â€"" instead. The meta tag must come before any non-ASCII
    // byte can be read, so it belongs at the very top of <head>.
    const html = bookingConfirmationForGuest(ctx()).html
    expect(html).toMatch(/^<!doctype html><html lang="en"><head><meta charset="utf-8">/)
  })

  it('opts out of forced dark-mode inversion via meta, not a stripped <style> block', () => {
    const html = bookingConfirmationForGuest(ctx()).html
    expect(html).toContain('<meta name="color-scheme" content="light">')
    expect(html).toContain('<meta name="supported-color-schemes" content="light">')
  })
})

describe('host photo', () => {
  it('omits the <img> entirely when the host has no avatar', () => {
    const html = bookingConfirmationForGuest(ctx({ baseUrl: 'https://punctual.example' })).html
    expect(html).not.toContain('<img')
  })

  it('omits the <img> when a photo exists but baseUrl was not passed — a relative /avatars/:key is useless in an inbox', () => {
    const html = bookingConfirmationForGuest(
      ctx({ host: { ...host, avatarKey: 'a'.repeat(64) + '-thumb.webp' } }),
    ).html
    expect(html).not.toContain('<img')
  })

  it('renders an absolute /avatars/:key URL, empty alt, when both are present', () => {
    const key = 'a'.repeat(64) + '-thumb.webp'
    const html = bookingConfirmationForGuest(
      ctx({ host: { ...host, avatarKey: key }, baseUrl: 'https://punctual.example/' }),
    ).html
    expect(html).toContain(`<img src="https://punctual.example/avatars/${key}"`)
    // Empty, not the host's name: the "Host" row already says it, and a
    // client that fails to load the image renders a broken-image icon with
    // the alt text spilling out next to it when alt is non-empty.
    expect(html).toContain(`alt=""`)
  })

  it('every fact in the email is still plain text — the photo is decorative, not load-bearing', () => {
    const key = 'a'.repeat(64) + '-thumb.webp'
    const mail = bookingConfirmationForGuest(
      ctx({ host: { ...host, avatarKey: key }, baseUrl: 'https://punctual.example' }),
    )
    // The plain-text alternative has no <img> at all, and never could.
    expect(mail.text).not.toContain('<img')
    expect(mail.text).toContain(host.name)
  })
})

/** The value cell of the row labelled `label`, tags stripped — the row order/layout is not this test's concern. */
function rowValue(html: string, label: string): string {
  const match = new RegExp(`>${label}<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`).exec(html)
  if (!match) throw new Error(`no row labelled "${label}" found`)
  return match[1]!.replace(/<[^>]+>/g, '').trim()
}

describe('host company', () => {
  it('the Host row is just the name when no company is set', () => {
    const html = bookingConfirmationForGuest(ctx()).html
    expect(rowValue(html, 'Host')).toBe(host.name)
  })

  it('the Host row appends the company, comma-separated', () => {
    const html = bookingConfirmationForGuest(ctx({ host: { ...host, company: 'Acme Inc' } })).html
    expect(rowValue(html, 'Host')).toBe(`${host.name}, Acme Inc`)
  })

  it('the Host row reads like a signature with a position set: name, title, company', () => {
    const html = bookingConfirmationForGuest(
      ctx({ host: { ...host, jobTitle: 'CEO', company: 'Acme Inc' } }),
    ).html
    expect(rowValue(html, 'Host')).toBe(`${host.name}, CEO, Acme Inc`)
  })

  it('a team event with multiple hosts never attaches one host company to the whole list', () => {
    const teammate: User = { ...host, id: 'u_2', name: 'Ada Lovelace', company: 'Analytical Engines' }
    const html = bookingConfirmationForGuest(
      ctx({ host: { ...host, company: 'Acme Inc' }, hosts: [host, teammate] }),
    ).html
    // Both names appear (the existing multi-host list), but neither company does.
    expect(html).toContain(`${host.name}, ${teammate.name}`)
    expect(html).not.toContain('Acme Inc')
    expect(html).not.toContain('Analytical Engines')
  })

  it('is not shown to the host viewing their own confirmation', () => {
    const html = bookingConfirmationForHost(ctx({ host: { ...host, company: 'Acme Inc' } })).html
    expect(html).not.toContain('Acme Inc')
  })

  it('escapes an attacker-controlled company the same as the name', () => {
    const html = bookingConfirmationForGuest(
      ctx({ host: { ...host, company: '<script>alert(1)</script>' } }),
    ).html
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('the text alternative is genuinely readable', () => {
  it('is non-empty, carries the time and is not stripped HTML', () => {
    const mail = bookingConfirmationForGuest(ctx())
    expect(mail.text.length).toBeGreaterThan(80)
    expect(mail.text).not.toContain('<')
    expect(mail.text).toContain(timeIn(START, 'Europe/Kyiv'))
    expect(mail.text).toContain('Intro call')
    expect(mail.text).toContain('Grace Hopper')
    expect(mail.text).toContain('https://punctual.example/b/bk_1/reschedule?t=abc')
  })
})

describe('lifecycle templates', () => {
  it('confirmation and reschedule mail to the host mentions the attached invite', () => {
    // notify.ts attaches the same .ics to the host's copy as the guest's, but
    // the host intro only ever talked about the calendar being "already"
    // updated — silent about the attachment for the host without a connected
    // calendar, or whose client doesn't auto-detect it.
    const confirmed = bookingConfirmationForHost(ctx())
    expect(confirmed.text).toContain('invite is attached')

    const moved = booking({ startUtc: START + 86_400_000, endUtc: START + 86_400_000 + 30 * 60_000 })
    const rescheduled = bookingRescheduled({
      ...ctx({ booking: moved }),
      audience: 'host',
      previous: { startUtc: START, endUtc: START + 30 * 60_000 },
    })
    expect(rescheduled.text).toContain('invite is attached')
  })

  it('a reschedule shows both the new and the old time, in the reader zone', () => {
    const moved = booking({ startUtc: START + 86_400_000, endUtc: START + 86_400_000 + 30 * 60_000 })
    const mail = bookingRescheduled({
      ...ctx({ booking: moved }),
      audience: 'guest',
      previous: { startUtc: START, endUtc: START + 30 * 60_000 },
    })
    expect(mail.subject.startsWith('Rescheduled:')).toBe(true)
    expect(mail.text).toContain('Previously')
    expect(mail.text).toContain(formatWhen(START, START + 30 * 60_000, 'Europe/Kyiv'))
    expect(mail.text).toContain(formatWhen(moved.startUtc, moved.endUtc, 'Europe/Kyiv'))
    // ADR-0005 §4: the old links are dead, and the guest is told so.
    expect(mail.text).toContain('no longer work')
  })

  it('a cancellation names who cancelled and offers a rebook link', () => {
    const mail = bookingCancelled({
      ...ctx({ booking: booking({ status: 'cancelled', cancelledAt: START - 3600_000 }) }),
      audience: 'guest',
      cancelledBy: 'host',
      reason: 'Travelling',
      rebookUrl: 'https://punctual.example/grace/intro',
    })
    expect(mail.subject.startsWith('Cancelled:')).toBe(true)
    expect(mail.text).toContain('Grace Hopper cancelled')
    expect(mail.text).toContain('Travelling')
    expect(mail.text).toContain('https://punctual.example/grace/intro')
    expect(mail.html).toContain('#D92D20')
  })

  it('reminders differ between 24h and 1h', () => {
    const base = { ...ctx(), audience: 'guest' as const }
    const day = bookingReminder({ ...base, when: '24h' })
    const hour = bookingReminder({ ...base, when: '1h' })
    expect(day.subject.startsWith('Tomorrow:')).toBe(true)
    expect(hour.subject.startsWith('In 1 hour:')).toBe(true)
    expect(day.text).not.toBe(hour.text)
    for (const mail of [day, hour]) expect(mail.text).toContain(timeIn(START, 'Europe/Kyiv'))
  })
})

describe('magicLinkEmail — ADR-0005 §3', () => {
  const mail = magicLinkEmail({
    url: 'https://punctual.example/auth/callback?token=abc123',
    ip: '203.0.113.42',
    userAgent: 'Mozilla/5.0 (Macintosh) <b>Safari</b>',
    expiresMinutes: 15,
    brandName: 'Punctual',
  })

  it('states the requesting IP and user agent', () => {
    expect(mail.text).toContain('203.0.113.42')
    expect(mail.text).toContain('Mozilla/5.0 (Macintosh)')
    expect(mail.html).toContain('203.0.113.42')
  })

  it('escapes the user agent, which is a raw untrusted header', () => {
    expect(mail.html).not.toContain('<b>Safari</b>')
    expect(mail.html).toContain('&lt;b&gt;Safari&lt;/b&gt;')
  })

  it('states the expiry and carries a usable link in both parts', () => {
    expect(mail.subject).toBe('Sign in to Punctual')
    expect(mail.text).toContain('15 minutes')
    expect(mail.text).toContain('https://punctual.example/auth/callback?token=abc123')
    expect(mail.html).toContain('https://punctual.example/auth/callback?token=abc123')
  })
})
