/**
 * The Queue port.
 *
 * Queues is not on Cloudflare's free tier, and spec §8 says the OSS delivery
 * must need no paid plan. So a missing binding degrades to inline execution
 * rather than failing: a self-hoster on the free tier gets working emails and
 * webhooks, just without retries and with the send on the request path.
 *
 * That trade is documented for self-hosters rather than hidden — "your emails
 * send synchronously" is a fair thing to know about your own deployment.
 */

import type { QueueMessage, QueuePort } from '../../ports.js'

export interface InlineHandler {
  (message: QueueMessage): Promise<void>
}

export function createQueueAdapter(queue: Queue | undefined, inline?: InlineHandler): QueuePort {
  if (queue) {
    return {
      async send(message) {
        await queue.send(message)
      },
      async sendBatch(messages) {
        if (messages.length === 0) return
        await queue.sendBatch(messages.map((body) => ({ body })))
      },
    }
  }

  return {
    async send(message) {
      if (inline) await inline(message)
      else console.warn('[punctual] no queue bound and no inline handler; dropping', message.kind)
    },
    async sendBatch(messages) {
      for (const m of messages) {
        if (inline) await inline(m)
      }
    },
  }
}
