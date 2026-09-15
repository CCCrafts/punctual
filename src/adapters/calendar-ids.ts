/**
 * Stable ids for the calendar events one booking writes, so a retried
 * `calendar.sync` cannot create a second real event.
 *
 * The queue is at-least-once. The create path used to write the provider
 * event, then persist its id; a transient failure between the two left the
 * booking with no id, the redelivery found nothing to skip, and the host
 * ended up with a twin on their calendar that nothing could ever delete.
 * Both providers can be told the id in advance — Google accepts a
 * client-chosen event `id`, Graph an idempotent `transactionId` — and both
 * then answer a repeat with the original event rather than a new one.
 *
 * Derived from `booking id + connection id`: one event per booking per
 * connection is exactly the invariant (ADR-0011), so that pair is the
 * identity of the event.
 */

export interface StableEventIds {
  /** Google event id: base32hex of the digest — the `[a-v0-9]{5,1024}` alphabet Google requires. */
  googleEventId: string
  /** A short token for Graph's `transactionId` and Google's conference `requestId`. */
  short: string
}

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv'

function base32hex(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31]
  return out
}

export async function stableEventIds(key: string): Promise<StableEventIds> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { googleEventId: `pu${base32hex(digest)}`, short: hex.slice(0, 24) }
}
