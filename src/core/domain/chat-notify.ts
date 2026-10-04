/**
 * Booking notifications in the places a team actually looks: a Slack
 * channel, a Telegram chat. Email reaches the host; this reaches the room.
 *
 * A channel belongs to a user (their own bookings) or to a team (every
 * booking of the team's event types), carries a list of events, and a
 * destination — a Slack incoming-webhook URL, or a Telegram bot token and
 * chat id — that is a secret and is stored encrypted. Delivery runs on the
 * queue beside webhooks, so a slow chat API never slows a booking.
 */

import type { Booking, EventType, User, WebhookEvent } from './types.js'
import { formatInZone } from '../time/zone.js'
import { joinNames } from './calendar-text.js'

export type ChannelKind = 'slack' | 'telegram'
export type ChannelOwnerKind = 'user' | 'team'

export type ChannelConfig = { kind: 'slack'; webhookUrl: string } | { kind: 'telegram'; botToken: string; chatId: string }

export interface NotificationChannel {
  id: string
  ownerKind: ChannelOwnerKind
  ownerId: string
  kind: ChannelKind
  /** Shown in the dashboard in place of the secret: "Slack · hooks.slack.com/…/T0…" */
  label: string
  /** The encrypted `ChannelConfig` and the key it was encrypted with (ADR-0005 §6). */
  configEncrypted: string
  keyVersion: number
  events: WebhookEvent[]
  active: boolean
  createdAt: number
}

export const CHANNEL_EVENTS: ReadonlyArray<{ value: WebhookEvent; label: string }> = [
  { value: 'booking.created', label: 'New booking' },
  { value: 'booking.rescheduled', label: 'Rescheduled' },
  { value: 'booking.cancelled', label: 'Cancelled' },
  { value: 'booking.hosts_changed', label: 'Hosts changed' },
]

/** AAD for the encrypted destination: the row it belongs to, so a ciphertext cannot be moved between channels. */
export function channelAad(ownerKind: ChannelOwnerKind, ownerId: string, id: string): string {
  return `channel|${ownerKind}|${ownerId}|${id}`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ParsedDestination = { ok: true; config: ChannelConfig; label: string } | { ok: false; message: string }

const TELEGRAM_TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/
const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/

/**
 * Only the two destinations this engine knows how to post to, each checked
 * for the shape its service issues — a webhook URL on any other host would
 * make the instance post booking details wherever a host typed.
 */
export function parseDestination(kind: string, fields: { webhookUrl?: string; botToken?: string; chatId?: string }): ParsedDestination {
  if (kind === 'slack') {
    const url = (fields.webhookUrl ?? '').trim()
    let parsed: URL | null = null
    try {
      parsed = new URL(url)
    } catch {
      parsed = null
    }
    if (!parsed || parsed.protocol !== 'https:' || parsed.hostname !== 'hooks.slack.com' || !parsed.pathname.startsWith('/services/')) {
      return { ok: false, message: 'A Slack incoming webhook URL looks like https://hooks.slack.com/services/T…/B…/…' }
    }
    const parts = parsed.pathname.split('/').filter(Boolean)
    return { ok: true, config: { kind: 'slack', webhookUrl: url }, label: `Slack · …/${parts[1] ?? ''}/${parts[2] ?? ''}` }
  }
  if (kind === 'telegram') {
    const botToken = (fields.botToken ?? '').trim()
    const chatId = (fields.chatId ?? '').trim()
    if (!TELEGRAM_TOKEN.test(botToken)) return { ok: false, message: 'A Telegram bot token looks like 123456789:AAH… — from @BotFather' }
    if (!TELEGRAM_CHAT.test(chatId)) return { ok: false, message: 'A Telegram chat id is a number (negative for groups) or @channelname' }
    return { ok: true, config: { kind: 'telegram', botToken, chatId }, label: `Telegram · ${chatId} via bot ${botToken.split(':')[0]}` }
  }
  return { ok: false, message: 'Choose Slack or Telegram' }
}

export function parseChannelEvents(values: string[]): WebhookEvent[] {
  const known = new Set(CHANNEL_EVENTS.map((e) => e.value))
  return [...new Set(values)].filter((v): v is WebhookEvent => known.has(v as WebhookEvent))
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

export interface ChatMessageInput {
  event: WebhookEvent
  booking: Booking
  eventType: EventType
  hosts: User[]
  /** Who the message is for — decides the timezone the time is written in. */
  tz: string
  /** The host-side link to the booking in the dashboard. */
  link: string
  /** For hosts_changed: who came and who went. */
  hostsAdded?: string[]
  hostsRemoved?: string[]
}

export interface ChatMessage {
  /** One line, for a notification banner. */
  headline: string
  /** Plain-text lines under it. */
  lines: string[]
  link: string
}

const HEADLINE: Record<WebhookEvent, string> = {
  'booking.created': 'New booking',
  'booking.rescheduled': 'Booking rescheduled',
  'booking.cancelled': 'Booking cancelled',
  'booking.hosts_changed': 'Hosts changed',
}

export function chatMessage(input: ChatMessageInput): ChatMessage {
  const { booking, eventType } = input
  const when = `${formatInZone(booking.startUtc, input.tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${input.tz})`
  const hosts = input.hosts.map((h) => h.name || h.slug)
  const lines = [
    `${eventType.title} · ${eventType.durationMinutes} min`,
    `${booking.guestName} <${booking.guestEmail}>`,
    when,
    hosts.length > 0 ? `With ${joinNames(hosts)}` : '',
  ]
  if (input.event === 'booking.hosts_changed') {
    if (input.hostsAdded?.length) lines.push(`Added: ${input.hostsAdded.join(', ')}`)
    if (input.hostsRemoved?.length) lines.push(`Removed: ${input.hostsRemoved.join(', ')}`)
  }
  return { headline: `${HEADLINE[input.event]}: ${eventType.title}`, lines: lines.filter(Boolean), link: input.link }
}

/**
 * What goes over the wire to each service. Slack reads `text` as mrkdwn,
 * where `<…>` is a mention or a link — and the guest's name is public,
 * unauthenticated input (a guest named `<!channel>` would page the room;
 * caught by review). Slack's own rule: escape exactly `&`, `<`, `>`.
 */
export function slackPayload(m: ChatMessage): Record<string, unknown> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return { text: `*${esc(m.headline)}*\n${m.lines.map(esc).join('\n')}\n<${m.link}|Open booking>` }
}

export function telegramPayload(m: ChatMessage, chatId: string): Record<string, unknown> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return {
    chat_id: chatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: `<b>${esc(m.headline)}</b>\n${m.lines.map(esc).join('\n')}\n<a href="${esc(m.link)}">Open booking</a>`,
  }
}
