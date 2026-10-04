/**
 * Posting one booking notification to a Slack or Telegram destination.
 * Shared by the queue consumer (the real path) and the dashboard's "Send a
 * test" button (synchronous, so the host sees the result).
 */

import type { ChannelConfig, ChatMessage } from '../core/domain/chat-notify.js'
import { slackPayload, telegramPayload } from '../core/domain/chat-notify.js'

export async function postChatMessage(
  config: ChannelConfig,
  message: ChatMessage,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const url = config.kind === 'slack' ? config.webhookUrl : `https://api.telegram.org/bot${config.botToken}/sendMessage`
  const body = config.kind === 'slack' ? slackPayload(message) : telegramPayload(message, config.chatId)
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
  if (res.ok) return { ok: true }
  // Telegram explains itself in JSON; Slack answers with a short word. Neither
  // body can contain the secret, which lives in the URL — never echoed.
  const text = (await res.text().catch(() => '')).slice(0, 200)
  return { ok: false, detail: `${config.kind === 'slack' ? 'Slack' : 'Telegram'} answered ${res.status}${text ? `: ${text}` : ''}` }
}
