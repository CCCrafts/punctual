import { describe, expect, it } from 'vitest'
import type { Booking, EventType, User } from '../../src/core/domain/types.js'
import { chatMessage, parseChannelEvents, parseDestination, slackPayload, telegramPayload } from '../../src/core/domain/chat-notify.js'
import { postChatMessage } from '../../src/adapters/chat.js'

const eventType = { id: 'et_1', title: 'Intro call', durationMinutes: 30 } as EventType
const booking = {
  id: 'bk_1', eventTypeId: 'et_1', hostUserId: 'u_1', hostUserIds: ['u_1', 'u_2'], guestName: 'Ada <Lovelace>', guestEmail: 'ada@example.com',
  guestTimezone: 'UTC', startUtc: Date.UTC(2026, 9, 7, 13, 30), endUtc: Date.UTC(2026, 9, 7, 14), status: 'confirmed', answers: {},
} as Booking
const hosts = [{ id: 'u_1', name: 'Grace Hopper', slug: 'grace', tz: 'Europe/Kyiv' }, { id: 'u_2', name: '', slug: 'bob', tz: 'UTC' }] as User[]

describe('destinations', () => {
  it('accepts a Slack incoming webhook and nothing that merely looks like a URL', () => {
    const ok = parseDestination('slack', { webhookUrl: ' https://hooks.slack.com/services/T0ABC/B0DEF/xyz123 ' })
    expect(ok).toEqual({ ok: true, config: { kind: 'slack', webhookUrl: 'https://hooks.slack.com/services/T0ABC/B0DEF/xyz123' }, label: 'Slack · …/T0ABC/B0DEF' })
    for (const bad of ['https://evil.example/services/T/B/x', 'http://hooks.slack.com/services/T/B/x', 'https://hooks.slack.com/other', 'not a url', '']) {
      expect(parseDestination('slack', { webhookUrl: bad }).ok, bad).toBe(false)
    }
  })

  it('accepts a Telegram bot token and chat id in the shapes Telegram issues', () => {
    const ok = parseDestination('telegram', { botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', chatId: '-1001234567890' })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.label).toBe('Telegram · -1001234567890 via bot 123456789')
    expect(parseDestination('telegram', { botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', chatId: '@acme_news' }).ok).toBe(true)
    expect(parseDestination('telegram', { botToken: 'nope', chatId: '1' }).ok).toBe(false)
    expect(parseDestination('telegram', { botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', chatId: 'acme' }).ok).toBe(false)
    expect(parseDestination('discord', {}).ok).toBe(false)
  })

  it('keeps only known events, once each', () => {
    expect(parseChannelEvents(['booking.created', 'booking.created', 'nope', 'booking.cancelled'])).toEqual(['booking.created', 'booking.cancelled'])
  })
})

describe('the message', () => {
  it("names the meeting, the guest, the time in the reader's zone and the hosts", () => {
    const m = chatMessage({ event: 'booking.created', booking, eventType, hosts, tz: 'Europe/Kyiv', link: 'https://punctual.test/dashboard/bookings/bk_1' })
    expect(m.headline).toBe('New booking: Intro call')
    expect(m.lines).toEqual(['Intro call · 30 min', 'Ada <Lovelace> <ada@example.com>', 'Wed, Oct 7, 4:30 PM (Europe/Kyiv)', 'With Grace Hopper and bob'])
  })

  it('says who came and went on a host change', () => {
    const m = chatMessage({ event: 'booking.hosts_changed', booking, eventType, hosts, tz: 'UTC', link: 'x', hostsAdded: ['Carol'], hostsRemoved: ['Dan'] })
    expect(m.headline).toBe('Hosts changed: Intro call')
    expect(m.lines.slice(-2)).toEqual(['Added: Carol', 'Removed: Dan'])
  })

  it('renders for Slack as mrkdwn and for Telegram as escaped HTML', () => {
    const m = chatMessage({ event: 'booking.cancelled', booking, eventType, hosts, tz: 'UTC', link: 'https://punctual.test/dashboard/bookings/bk_1?a=1&b=2' })
    // Slack mrkdwn: the guest's angle brackets are text, not a mention; the link stays a link.
    const slack = String(slackPayload(m)['text'])
    expect(slack).toContain('Ada &lt;Lovelace&gt; &lt;ada@example.com&gt;')
    expect(slack).toContain('\n<https://punctual.test/dashboard/bookings/bk_1?a=1&b=2|Open booking>')
    expect(slackPayload(chatMessage({ event: 'booking.created', booking: { ...booking, guestName: '<!channel>' }, eventType, hosts, tz: 'UTC', link: 'x' }))['text']).not.toContain('<!channel>')
    const tg = telegramPayload(m, '-100')
    expect(tg['chat_id']).toBe('-100')
    expect(tg['parse_mode']).toBe('HTML')
    expect(String(tg['text'])).toContain('Ada &lt;Lovelace&gt; &lt;ada@example.com&gt;')
    expect(String(tg['text'])).toContain('<a href="https://punctual.test/dashboard/bookings/bk_1?a=1&amp;b=2">Open booking</a>')
  })
})

describe('posting', () => {
  const m = chatMessage({ event: 'booking.created', booking, eventType, hosts, tz: 'UTC', link: 'https://punctual.test/x' })

  it('posts JSON to the Slack webhook, and to Telegram sendMessage with the bot token in the path', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response('ok', { status: 200 })
    }) as typeof globalThis.fetch
    expect(await postChatMessage({ kind: 'slack', webhookUrl: 'https://hooks.slack.com/services/T/B/x' }, m, fetchImpl)).toEqual({ ok: true })
    expect(await postChatMessage({ kind: 'telegram', botToken: '1:abc', chatId: '@c' }, m, fetchImpl)).toEqual({ ok: true })
    expect(calls[0]!.url).toBe('https://hooks.slack.com/services/T/B/x')
    expect(calls[1]!.url).toBe('https://api.telegram.org/bot1:abc/sendMessage')
    expect((calls[1]!.body as { chat_id: string }).chat_id).toBe('@c')
  })

  it('reports a refusal without echoing the secret, and a network failure', async () => {
    const refusing = (async () => new Response('{"ok":false,"description":"Bad Request: chat not found"}', { status: 400 })) as typeof globalThis.fetch
    const r = await postChatMessage({ kind: 'telegram', botToken: '1:secret', chatId: '5' }, m, refusing)
    expect(r).toEqual({ ok: false, detail: 'Telegram answered 400: {"ok":false,"description":"Bad Request: chat not found"}' })
    expect(JSON.stringify(r)).not.toContain('secret')
    const down = (async () => { throw new Error('fetch failed') }) as unknown as typeof globalThis.fetch
    expect(await postChatMessage({ kind: 'slack', webhookUrl: 'https://hooks.slack.com/services/T/B/x' }, m, down)).toEqual({ ok: false, detail: 'fetch failed' })
  })
})
