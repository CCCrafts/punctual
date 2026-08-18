# Self-hosting Punctual

Zero to a working booking link in about 15 minutes, on Cloudflare's free tier,
for $0.

You need a Cloudflare account and Node 20+. You do **not** need a paid
Cloudflare plan, a database server, Docker, or a credit card.

## 1. Get the code

```bash
git clone https://github.com/CCCrafts/punctual.git
cd punctual
npm install
npx wrangler login
```

## 2. Create the two resources

```bash
npx wrangler d1 create punctual
npx wrangler kv namespace create CACHE
```

Both commands print an id. Put them in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "punctual"
database_id = "<the id from d1 create>"

[[kv_namespaces]]
binding = "CACHE"
id = "<the id from kv namespace create>"
```

D1 stores everything durable. KV caches only external calendars' busy times —
never your bookings, which are always read from D1 so you see your own writes
immediately.

## 3. Set two secrets

```bash
openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY_V1
openssl rand -base64 32 | npx wrangler secret put SIGNING_KEY
```

`ENCRYPTION_KEY_V1` encrypts calendar refresh tokens at rest (AES-GCM).
`SIGNING_KEY` signs the reschedule and cancel links in your emails.

**Keep both.** Losing `ENCRYPTION_KEY_V1` means every host must reconnect their
calendar. Rotating it later is supported — add `ENCRYPTION_KEY_V2` and the
engine decrypts with the old key while encrypting with the new one.

## 4. Create the schema and deploy

```bash
npm run migrate
npm run deploy
```

Your booking page is live at the URL wrangler prints.

## 5. Connect a calendar

Punctual talks to Google Calendar and Microsoft 365 using **your own** OAuth
application. That is more setup than a hosted service, and it is also why no
one else can see your calendar data.

### Google

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen. While it is unverified you can add up to
   100 test users, which is plenty for a team.
3. Create an **OAuth client ID** of type *Web application* with the redirect
   URI `https://<your-worker-url>/auth/google/callback`.
4. Set the credentials:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Calendar scopes are classed as *sensitive* by Google. Verification takes weeks,
so start it early if you plan to go past 100 users. Until then the consent
screen shows an "unverified app" warning; for an internal team that is fine.

### Microsoft

1. In [Entra ID → App registrations](https://entra.microsoft.com/), register an
   application. Under **Supported account types**, pick "Accounts in any
   organizational directory and personal Microsoft accounts" — the narrower
   single-tenant option only lets people inside your own 365 tenant connect,
   which locks out any guest or teammate on a different tenant or a personal
   Outlook.com account.
2. Entra's registration screen only accepts one redirect URI, and rejects one
   with a query string ("URL may not contain a query string") — a limit that
   also applies later, on the **Authentication** blade, unlike Google. So:
   register with a bare URI first, `https://<your-worker-url>/auth/microsoft/callback`,
   then go to **Authentication** → **Add URI** and add both real ones (path
   segments, not query params — this is the one place Microsoft's redirect
   URI shape differs from Google's):
   ```
   https://<your-worker-url>/auth/microsoft/callback/identity
   https://<your-worker-url>/auth/microsoft/callback/calendar
   ```
   Remove the bare placeholder once both are in. Also on this blade: enable
   **ID tokens** under "Implicit grant and hybrid flows" — the identity flow
   needs it.
3. Grant delegated Graph permissions (**API permissions** → Add a permission
   → Microsoft Graph → Delegated): `openid`, `email`, `profile` (usually
   already present), `offline_access`, `Calendars.ReadWrite`. No admin
   consent needed — these are all per-user delegated grants.
4. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` the same way.

## 6. Email (optional, but you want it)

Without an email provider, Punctual logs emails instead of sending them —
useful for local testing, not for real bookings. To send for real, set
**either** provider's key (Resend is tried first if both are set):

```bash
npx wrangler secret put RESEND_API_KEY
# or
npx wrangler secret put BREVO_API_KEY
```

Then set `FROM_EMAIL` and `FROM_NAME` in `wrangler.toml` `[vars]` to an address
on a domain you have verified with your provider. Configure SPF, DKIM and
DMARC on that domain — booking confirmations that land in spam are worse than
no email at all.

## Upgrading

```bash
git pull
npm run migrate
npm run deploy
```

Migrations are forward-only and additive, and never assume you upgraded
recently, so skipping several versions is fine.

## What you get on the free tier

A team of ten scheduling normally sits far inside Cloudflare's free limits:
100,000 Worker requests a day, 5 GB of D1 storage, 5 million D1 row reads a
day.

Two features need a paid plan, and both degrade gracefully:

- **Queues** — emails and webhooks are delivered inline instead, on the request
  path, with no automatic retries. Everything still works; a failed send is
  simply not retried.
- **Read replication** — without it, D1 reads go to your database's home
  region. Fine for a team in one place; noticeable if your guests are global.
  Enable it later with one API call, no code change.

## Configuration reference

| Variable | Where | Purpose |
|---|---|---|
| `BASE_URL` | `[vars]` | Public origin; used in links and emails |
| `BRAND_NAME` | `[vars]` | Shown in the footer and emails |
| `FROM_EMAIL` / `FROM_NAME` | `[vars]` | Sender identity |
| `SUPPORT_EMAIL` | `[vars]` | Reply-to on outbound mail |
| `TELEMETRY_ENABLED` | `[vars]` | `0` by default. See below |
| `ENCRYPTION_KEY_V1` | secret | AES-GCM key for calendar tokens |
| `SIGNING_KEY` | secret | HMAC key for guest manage links |
| `GOOGLE_CLIENT_ID` / `_SECRET` | secret | Your Google OAuth app |
| `MICROSOFT_CLIENT_ID` / `_SECRET` | secret | Your Microsoft app |
| `RESEND_API_KEY` | secret | Omit to log emails instead of sending |
| `BREVO_API_KEY` | secret | Alternative to Resend; Resend wins if both are set |

## Telemetry

Off unless you set `TELEMETRY_ENABLED=1`.

When on, it sends one ping a day: a random instance id, the version, and counts
of users, event types and bookings. No names, no email addresses, no slugs, no
URLs, no calendar content. The whole payload is built in one short file —
`src/adapters/scheduled.ts` — so you can read exactly what leaves your Worker
rather than take our word for it.

## Troubleshooting

**"unverified app" on Google sign-in.** Expected until Google finishes
verification. Add yourself as a test user on the consent screen.

**Emails are not arriving.** With no `RESEND_API_KEY` they are logged, not
sent. Check `npx wrangler tail`.

**A host's calendar stopped syncing.** Their refresh token was revoked —
usually a password change or an admin policy. Their connections page shows a
reconnect prompt; existing bookings are unaffected.

**Times look wrong by an hour.** Almost always a host timezone set incorrectly
rather than a DST bug. The engine computes in UTC and converts at the edges,
and the DST behaviour is covered by tests across Kyiv, New York, Lord Howe
(30-minute DST), Chatham (+12:45) and Kolkata. If you find a genuine case,
please open an issue with the host timezone, guest timezone and date — that is
enough to reproduce it.
