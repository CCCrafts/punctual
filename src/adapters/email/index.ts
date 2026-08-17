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

import { sanitizeHeader } from '../../core/email-templates.js'
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
      if (message.replyTo) body.reply_to = sanitizeHeader(message.replyTo)
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

/**
 * `Name <addr>` when a display name exists; quoted so commas cannot split the
 * header.
 *
 * Both parts pass through `sanitizeHeader` first: `email`/`name` here are
 * frequently a guest-controlled `guestEmail`/`guestName` from an
 * unauthenticated booking form, and this string lands directly in a
 * provider-facing `from`/`to` field, so a CR/LF in either would otherwise let
 * a booking inject an extra header into every email we send.
 */
function formatAddress(email: string, name?: string): string {
  const safeEmail = sanitizeHeader(email)
  if (!name) return safeEmail
  const safeName = sanitizeHeader(name).replace(/"/g, '')
  return `"${safeName}" <${safeEmail}>`
}

// ---------------------------------------------------------------------------
// Brevo
// ---------------------------------------------------------------------------

export interface BrevoOptions {
  apiKey: string
  from: string
  fromName: string
  fetch?: typeof globalThis.fetch
}

/**
 * Brevo (formerly Sendinblue).
 *
 * A second provider exists because the `EmailSender` port is the whole reason
 * ADR-0003 lists it: a self-hoster brings whichever transactional provider
 * they already pay for, and forcing one choice would be a gate in disguise.
 *
 * Note the API shape differs from Resend in two ways that are easy to get
 * wrong: the key goes in `api-key`, not `Authorization`, and attachments are
 * `{name, content}` rather than `{filename, content}`.
 */
export function createBrevoSender(opts: BrevoOptions): EmailSender {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  return {
    async send(message) {
      // sanitizeHeader on every guest-controlled field: Brevo turns
      // `sender`/`to`/`replyTo` into real SMTP headers on its side, so a
      // CR/LF smuggled through here becomes a header-injection vector at the
      // provider even though our own request body is well-formed JSON.
      const body: Record<string, unknown> = {
        sender: { email: sanitizeHeader(opts.from), name: sanitizeHeader(opts.fromName) },
        to: [
          {
            email: sanitizeHeader(message.to),
            ...(message.toName ? { name: sanitizeHeader(message.toName) } : {}),
          },
        ],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
      }
      if (message.replyTo) body['replyTo'] = { email: sanitizeHeader(message.replyTo) }
      if (message.attachments?.length) {
        body['attachment'] = message.attachments.map((a) => ({
          name: a.filename,
          content: a.content,
        }))
      }

      const res = await doFetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': opts.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        // Include the body: Brevo reports a wrong sender domain in it, and
        // that is the single most common reason a first send fails.
        const detail = await res.text().catch(() => '')
        throw new Error(`Brevo send failed: ${res.status} ${res.statusText} ${detail.slice(0, 300)}`)
      }
    },
  }
}
