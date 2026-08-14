/**
 * `EmailSender` adapters.
 *
 * Every booking email carries an .ics attachment, so attachment support is not
 * optional in either implementation — a sender that silently drops attachments
 * would produce confirmations that do not land in the guest's calendar.
 *
 * Delivery failures throw. The queue consumer (ADR-0006) is what retries, so
 * swallowing an error here would turn a transient provider blip into a
 * permanently missing confirmation.
 */

import type { EmailMessage, EmailSender } from '../../ports.js'

export interface ResendOptions {
  apiKey: string
  from: string
  fromName?: string
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export function createResendSender(opts: ResendOptions): EmailSender {
  return {
    async send(message) {
      const body: Record<string, unknown> = {
        from: formatAddress(opts.from, opts.fromName),
        to: [formatAddress(message.to, message.toName)],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }
      // Snake case: the REST API's field names differ from the Node SDK's
      // camelCase wrappers.
      if (message.replyTo) body.reply_to = message.replyTo
      if (message.attachments?.length) {
        body.attachments = message.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          content_type: a.contentType,
        }))
      }

      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        // Status and body both, because Resend puts the actionable part
        // (unverified domain, invalid recipient) only in the body.
        const detail = await res.text().catch(() => '')
        throw new Error(`resend: ${res.status} ${res.statusText} ${detail}`.trim())
      }
    },
  }
}

/**
 * For local dev and for self-hosters who have not configured a provider yet.
 * Booking still works and nothing throws — the operator sees exactly what would
 * have been sent, rather than a broken flow they have to debug before their
 * first booking (spec §15).
 */
export function createConsoleSender(): EmailSender {
  return {
    async send(message: EmailMessage) {
      // Attachment bodies are base64 blobs; logging their names is useful,
      // logging their contents would bury the log.
      const attachments = (message.attachments ?? []).map((a) => `${a.filename} (${a.contentType})`)
      console.log('[email]', {
        to: message.toName ? `${message.toName} <${message.to}>` : message.to,
        subject: message.subject,
        replyTo: message.replyTo,
        attachments,
        text: message.text,
      })
    },
  }
}

/** `Name <addr>` when a display name exists; quoted so commas cannot split the header. */
function formatAddress(email: string, name?: string): string {
  if (!name) return email
  return `"${name.replace(/"/g, '')}" <${email}>`
}
