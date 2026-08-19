# Security

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue:

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/CCCrafts/punctual/security/advisories/new)
- **Email:** hello@punctual.sh

You'll get an acknowledgement within 72 hours. Please include reproduction
steps and, for anything involving dates or times, the timezones in question.
There is no bounty program; credit in the advisory and the changelog is
offered gladly.

## Supported versions

Pre-1.0, only the latest release (and `main`) receives fixes. Self-hosters
upgrade with `git pull && npm run migrate && npm run deploy` — migrations are
forward-only and additive, so skipping versions is safe.

## What the engine defends, by design

Security-load-bearing properties are documented next to the code that
carries them, and each has tests that fail open if it regresses:

- **Double-booking is impossible at the storage layer**: one row per
  five-minute bucket per host in `slot_locks`, primary key
  `(host_user_id, bucket_start)`, written in the same D1 `batch()` as the
  booking. Durable Objects are the fast path, not the guarantee.
- **No account-existence oracles**: the magic-link request answers
  byte-identically — and does identical work, so there is no timing side
  channel either — for known and unknown addresses.
- **Calendar OAuth tokens are encrypted at rest** (AES-GCM, versioned keys,
  AAD binding the ciphertext to its row), and the identity and calendar
  OAuth flows use separate redirect URIs so an authorization code for one
  purpose can never be exchanged against the other's endpoint.
- **Guest manage links are signed, single-purpose and rotate on
  reschedule**; sessions are hashed at rest and revocation is immediate
  (sessions deliberately never touch KV).
- **Everything a guest submits is treated as attacker-controlled**: escaped
  into HTML, sanitised out of email headers, length-capped before it can
  reach a queued email or a calendar event, and image uploads are validated
  by header (type, size, decoded pixel count) before a byte is decoded.
- **Uploaded originals are never served** — only re-encoded,
  metadata-stripped thumbnails, so EXIF (GPS, device serials) a host never
  agreed to publish stays private.

Every change lands only after an adversarial review by two independent
models on the same diff; findings at the data-loss/security tier block the
merge outright. Several entries in the changelog exist because that review
caught them before they shipped.
