/**
 * The docs section: `/docs` and its sub-pages, served on Punctual's own
 * domain instead of bouncing straight to GitHub.
 *
 * Reuses `shell()`/`footer()` from pages/landing.ts so the docs section is
 * visually one site with the marketing pages, not a bolted-on second design.
 * The nav is a flat, ordered list (`DOCS_NAV` below) rather than anything
 * hierarchical — the ticket's bar is "survives a hundred pages", and a flat
 * list with `aria-current` on the active item clears that bar without a nav
 * tree, folder state, or a search index this prototype doesn't need yet.
 *
 * Every claim on these pages is sourced from the engine's own code and from
 * docs/self-hosting.md, both of which ship in this public repo — same
 * discipline as pages/landing.ts, for the same reason (an overclaiming docs
 * page is the fastest way to lose a self-hoster's trust). Anything long or
 * likely to drift (the full Google/Microsoft OAuth walkthrough, the complete
 * troubleshooting list, the full endpoint implementations) links to the
 * canonical source on GitHub instead of being re-derived here.
 */

import { escapeHtml } from './booking.js'
import { DEFAULT_GITHUB_URL, footer, shell } from './landing.js'

export interface DocsPageOptions {
  brandName: string
  baseUrl: string
  githubUrl?: string
  operator?: string
}

interface DocsNavItem {
  path: string
  label: string
}

/**
 * The whole docs nav, in render order. Adding a page is adding one row here
 * plus one exported page function below — nothing about the shell, the CSS
 * or the other pages needs to change.
 */
const DOCS_NAV: DocsNavItem[] = [
  { path: '/docs', label: 'Overview' },
  { path: '/docs/self-hosting', label: 'Self-hosting' },
  { path: '/docs/api', label: 'REST API' },
  { path: '/docs/mcp', label: 'MCP server' },
]

function docsNav(activePath: string): string {
  const items = DOCS_NAV.map((item) => {
    const current = item.path === activePath ? ' aria-current="page"' : ''
    return `<li><a class="pu-nav-link" href="${escapeHtml(item.path)}"${current}>${escapeHtml(item.label)}</a></li>`
  }).join('\n    ')
  return `<nav class="pu-docs-nav" aria-label="Documentation">
  <h2>Documentation</h2>
  <ul>
    ${items}
  </ul>
</nav>`
}

/** A code block. `escapeHtml` first — this is never trusted to be markup. */
function pre(code: string): string {
  return `<pre class="pu-pre"><code>${escapeHtml(code)}</code></pre>`
}

function docsPage(opts: DocsPageOptions, activePath: string, title: string, lede: string, contentHtml: string): string {
  const githubUrl = opts.githubUrl ?? DEFAULT_GITHUB_URL

  const body = `<div class="pu-landing">
<header class="pu-hero pu-docs-hero">
  <p class="pu-mark"><a href="/" style="color:inherit;text-decoration:none">punctual<span>:</span></a></p>
  <h1>${escapeHtml(title)}</h1>
  <p class="pu-hero-lede">${escapeHtml(lede)}</p>
</header>

<main>
<div class="pu-grid">
${docsNav(activePath)}
<div class="pu-docs-content">
${contentHtml}
</div>
</div>
</main>

${footer(githubUrl, opts.operator)}
</div>`

  return shell(
    {
      title: `${title} · ${opts.brandName}`,
      description: lede,
      baseUrl: opts.baseUrl,
      path: activePath,
    },
    body,
  )
}

// ---------------------------------------------------------------------------
// /docs
// ---------------------------------------------------------------------------

function docsIndexContent(opts: DocsPageOptions): string {
  const githubUrl = opts.githubUrl ?? DEFAULT_GITHUB_URL

  return `
<p>Three guides cover everything most self-hosters and integrators need. For
anything not covered here, the full source is on GitHub.</p>

<div class="pu-feature-grid">
  <div class="pu-card">
    <h3>Self-hosting</h3>
    <p class="pu-muted">Zero to a working booking link in about 15 minutes on
      Cloudflare's free tier, for $0.</p>
    <p><a href="/docs/self-hosting">Read the guide &rarr;</a></p>
  </div>
  <div class="pu-card">
    <h3>REST API</h3>
    <p class="pu-muted">Endpoints for event types, availability, slots,
      bookings and webhooks, authenticated with a scoped API key.</p>
    <p><a href="/docs/api">Read the reference &rarr;</a></p>
  </div>
  <div class="pu-card">
    <h3>MCP server</h3>
    <p class="pu-muted">Five tools an AI agent can call, scoped to exactly
      the calling API key's authority.</p>
    <p><a href="/docs/mcp">Read the reference &rarr;</a></p>
  </div>
</div>

<h2>More</h2>
<p class="pu-muted">Full source, issue tracker and the rest of the codebase
  live on <a href="${escapeHtml(githubUrl)}">GitHub</a>.</p>
`
}

export function docsIndexPage(opts: DocsPageOptions): string {
  return docsPage(
    opts,
    '/docs',
    'Documentation',
    `Everything needed to run ${opts.brandName} yourself or build against it.`,
    docsIndexContent(opts),
  )
}

// ---------------------------------------------------------------------------
// /docs/self-hosting
// ---------------------------------------------------------------------------

function selfHostingContent(opts: DocsPageOptions): string {
  const githubUrl = opts.githubUrl ?? DEFAULT_GITHUB_URL
  const repoBlob = `${githubUrl}/blob/main`

  return `
<p>Zero to a working booking link in about 15 minutes, on Cloudflare's free
  tier, for $0.</p>
<p>You need a Cloudflare account and Node 20+. You do <strong>not</strong>
  need a paid Cloudflare plan, a database server, Docker, or a credit card.</p>

<h2>1. Get the code</h2>
${pre(`git clone ${githubUrl}.git\ncd punctual\nnpm install\nnpx wrangler login`)}

<h2>2. Create the two resources</h2>
${pre(`npx wrangler d1 create punctual\nnpx wrangler kv namespace create CACHE`)}
<p>Both commands print an id. Put them in <code>wrangler.toml</code>:</p>
${pre(`[[d1_databases]]\nbinding = "DB"\ndatabase_name = "punctual"\ndatabase_id = "<the id from d1 create>"\n\n[[kv_namespaces]]\nbinding = "CACHE"\nid = "<the id from kv namespace create>"`)}
<p class="pu-muted">D1 stores everything durable. KV caches only external
  calendars' busy times &mdash; never your bookings, which are always read
  from D1 so you see your own writes immediately.</p>

<h2>3. Set two secrets</h2>
${pre(`openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY_V1\nopenssl rand -base64 32 | npx wrangler secret put SIGNING_KEY`)}
<p class="pu-muted"><code>ENCRYPTION_KEY_V1</code> encrypts calendar refresh
  tokens at rest (AES-GCM). <code>SIGNING_KEY</code> signs the reschedule and
  cancel links in your emails.</p>
<div class="pu-docs-callout">
  <p><strong>Keep both.</strong> Losing <code>ENCRYPTION_KEY_V1</code> means
    every host must reconnect their calendar. Rotating it later is
    supported &mdash; add <code>ENCRYPTION_KEY_V2</code> and the engine
    decrypts with the old key while encrypting with the new one.</p>
</div>

<h2>4. Create the schema and deploy</h2>
${pre(`npm run migrate\nnpm run deploy`)}
<p class="pu-muted">Your booking page is live at the URL wrangler prints.</p>

<h2>5. Connect a calendar</h2>
<p>Punctual talks to Google Calendar and Microsoft 365 using
  <strong>your own</strong> OAuth application. That is more setup than a
  hosted service, and it is also why no one else can see your calendar
  data.</p>

<h3>Google</h3>
<ol>
  <li>In <a href="https://console.cloud.google.com/">Google Cloud Console</a>,
    create a project and enable the Google Calendar API.</li>
  <li>Configure the OAuth consent screen. While it is unverified you can add
    up to 100 test users, which is plenty for a team.</li>
  <li>Create an OAuth client ID of type <em>Web application</em> with both
    redirect URIs below registered &mdash; sign-in and calendar connect are
    deliberately separate flows, so a leaked code for one can never be
    exchanged against the other's endpoint:</li>
</ol>
${pre(`https://<your-worker-url>/auth/google/callback?purpose=identity\nhttps://<your-worker-url>/auth/google/callback?purpose=calendar`)}
<ol start="4">
  <li>Set the credentials.</li>
</ol>
${pre(`npx wrangler secret put GOOGLE_CLIENT_ID\nnpx wrangler secret put GOOGLE_CLIENT_SECRET`)}
<p class="pu-muted">Calendar scopes are classed as sensitive by Google.
  Verification takes weeks, so start it early if you plan to go past 100
  users; until then the consent screen shows an "unverified app" warning,
  which is fine for an internal team.</p>

<h3>Microsoft</h3>
<ol>
  <li>In <a href="https://entra.microsoft.com/">Entra ID &rarr; App
    registrations</a>, register an application. Under <strong>Supported
    account types</strong>, pick "Accounts in any organizational directory
    and personal Microsoft accounts" &mdash; the narrower single-tenant
    option locks out any guest or teammate on a different tenant or a
    personal Outlook.com account.</li>
  <li>Entra's registration screen only accepts one redirect URI and rejects
    one with a query string. Register with a bare placeholder URI first
    (<code>.../auth/microsoft/callback</code>), then on the
    <strong>Authentication</strong> blade add both real URIs and remove the
    placeholder:</li>
</ol>
${pre(`https://<your-worker-url>/auth/microsoft/callback/identity\nhttps://<your-worker-url>/auth/microsoft/callback/calendar`)}
<p class="pu-muted">Also on that blade, enable <strong>ID tokens</strong>
  under "Implicit grant and hybrid flows" &mdash; the identity flow needs it.</p>
<ol start="3">
  <li>Grant delegated Graph permissions (<strong>API permissions</strong>
    &rarr; Add a permission &rarr; Microsoft Graph &rarr; Delegated):
    <code>openid</code>, <code>email</code>, <code>profile</code>,
    <code>offline_access</code>, <code>Calendars.ReadWrite</code>. No admin
    consent needed &mdash; these are per-user delegated grants.</li>
  <li>Set the credentials.</li>
</ol>
${pre(`npx wrangler secret put MICROSOFT_CLIENT_ID\nnpx wrangler secret put MICROSOFT_CLIENT_SECRET`)}

<h2>6. Email (optional, but you want it)</h2>
<p>Without an email provider, Punctual logs emails instead of sending them.
  To send for real, set <strong>either</strong> provider's key (Resend is
  tried first if both are set):</p>
${pre(`npx wrangler secret put RESEND_API_KEY\n# or\nnpx wrangler secret put BREVO_API_KEY`)}
<p class="pu-muted">Then set <code>FROM_EMAIL</code> and <code>FROM_NAME</code>
  in <code>wrangler.toml</code>'s <code>[vars]</code> to an address on a
  domain you have verified with your provider, with SPF, DKIM and DMARC
  configured &mdash; booking confirmations that land in spam are worse than
  no email at all.</p>

<h2>7. Make it yours</h2>
<p><strong>Sign in first &mdash; you're the admin.</strong> The first account
  created on a fresh deployment gets the admin role: an <strong>Admin</strong>
  page appears in the dashboard with the user list (grant or remove admin;
  the last admin can never be demoted) and the sign-up policy &mdash; open,
  closed, or an allowlist of emails and <code>@domains</code>. When everyone
  who should have an account has one, close sign-ups there. Existing users
  keep signing in.</p>
<p class="pu-muted">Prefer configuration as code? Setting the
  <code>SIGNUPS</code> variable (same values) <em>pins</em> the policy &mdash;
  the Admin page then shows it read-only. Upgrading an existing deployment
  where nobody is admin yet? Promote yourself once:</p>
${pre(`npx wrangler d1 execute punctual --remote \\\n  --command "UPDATE users SET role='admin' WHERE email='you@acme.com'"`)}
<p><strong>Fill in your profile</strong> at Dashboard &rarr; Settings: photo,
  name, position, company, and a company link. They render on your booking
  pages and in guest confirmation emails, and your company anchors the
  booking page's footer.</p>
<p><strong>Name the operator.</strong> <code>BRAND_NAME</code> is the product
  name in the footer and emails; <code>LEGAL_OPERATOR</code> is the legal
  entity named on <code>/privacy</code> and <code>/terms</code>.</p>
<p><strong>Put a live demo on your landing page.</strong> Once you have a
  real event type, set <code>DEMO_BOOKING_PATH</code> (e.g.
  <code>/jo/30min</code>) and your home page embeds that booking page live.</p>
<p class="pu-muted">Every booking form also asks one built-in optional
  question &mdash; &ldquo;What would you like to discuss?&rdquo; &mdash; whose
  answer flows to the calendar event and both confirmation emails. To reword
  it or make it required, add your own <code>Agenda | textarea | required</code>
  line to the event type's questions; your version replaces the built-in one.</p>

<h2>Upgrading</h2>
${pre(`git pull\nnpm run migrate\nnpm run deploy`)}
<p class="pu-muted">Migrations are forward-only and additive, so skipping
  several versions is fine.</p>

<h2>What you get on the free tier</h2>
<p>A team of ten scheduling normally sits far inside Cloudflare's free
  limits: 100,000 Worker requests a day, 5 GB of D1 storage, 5 million D1 row
  reads a day.</p>
<p>Two features need a paid plan, and both degrade gracefully:</p>
<ul>
  <li><strong>Queues</strong> &mdash; emails and webhooks are delivered
    inline instead, on the request path, with no automatic retries.
    Everything still works; a failed send is simply not retried.</li>
  <li><strong>Read replication</strong> &mdash; without it, D1 reads go to
    your database's home region. Fine for a team in one place; enable it
    later with one API call, no code change.</li>
</ul>

<h2>Configuration reference</h2>
<div class="pu-docs-table-wrap"><table>
<thead><tr><th scope="col">Variable</th><th scope="col">Where</th><th scope="col">Purpose</th></tr></thead>
<tbody>
<tr><td class="pu-time">BASE_URL</td><td>[vars]</td><td>Public origin; used in links and emails</td></tr>
<tr><td class="pu-time">BRAND_NAME</td><td>[vars]</td><td>Shown in the footer and emails</td></tr>
<tr><td class="pu-time">LEGAL_OPERATOR</td><td>[vars]</td><td>Data controller named on /privacy and /terms; defaults to BRAND_NAME</td></tr>
<tr><td class="pu-time">FROM_EMAIL / FROM_NAME</td><td>[vars]</td><td>Sender identity</td></tr>
<tr><td class="pu-time">SUPPORT_EMAIL</td><td>[vars]</td><td>Reply-to on outbound mail</td></tr>
<tr><td class="pu-time">TELEMETRY_ENABLED</td><td>[vars]</td><td>0 by default &mdash; see below</td></tr>
<tr><td class="pu-time">SIGNUPS</td><td>secret or [vars]</td><td>Pins the sign-up policy: open, closed, or a comma list of emails and @domains. Unset (the default), admins manage it from the dashboard's Admin page &mdash; existing users always sign in either way</td></tr>
<tr><td class="pu-time">DEMO_BOOKING_PATH</td><td>[vars]</td><td>A live booking page on this deployment (e.g. /jo/30min), embedded on the landing page</td></tr>
<tr><td class="pu-time">ENCRYPTION_KEY_V1</td><td>secret</td><td>AES-GCM key for calendar tokens</td></tr>
<tr><td class="pu-time">SIGNING_KEY</td><td>secret</td><td>HMAC key for guest manage links</td></tr>
<tr><td class="pu-time">GOOGLE_CLIENT_ID / _SECRET</td><td>secret</td><td>Your Google OAuth app</td></tr>
<tr><td class="pu-time">MICROSOFT_CLIENT_ID / _SECRET</td><td>secret</td><td>Your Microsoft app</td></tr>
<tr><td class="pu-time">RESEND_API_KEY</td><td>secret</td><td>Omit to log emails instead of sending</td></tr>
<tr><td class="pu-time">BREVO_API_KEY</td><td>secret</td><td>Alternative to Resend; Resend wins if both are set</td></tr>
</tbody>
</table></div>

<h2>Telemetry</h2>
<p class="pu-muted">Off unless you set <code>TELEMETRY_ENABLED=1</code>. When
  on, it sends one ping a day: a random instance id, the version, and counts
  of users, event types and bookings &mdash; no names, emails, slugs, URLs or
  calendar content.</p>

<h2>Troubleshooting</h2>
<p><strong>"unverified app" on Google sign-in.</strong> Expected until
  Google finishes verification. Add yourself as a test user on the consent
  screen.</p>
<p><strong>Emails are not arriving.</strong> With no
  <code>RESEND_API_KEY</code> they are logged, not sent. Check
  <code>npx wrangler tail</code>.</p>
<p><strong>Times look wrong by an hour.</strong> Almost always a host
  timezone set incorrectly rather than a DST bug &mdash; the engine computes
  in UTC and converts at the edges.</p>

<p class="pu-muted">Full guide on GitHub:
  <a href="${escapeHtml(repoBlob)}/docs/self-hosting.md">docs/self-hosting.md</a>.</p>
`
}

export function docsSelfHostingPage(opts: DocsPageOptions): string {
  return docsPage(
    opts,
    '/docs/self-hosting',
    'Self-hosting',
    "Zero to a working booking link in about 15 minutes, on Cloudflare's free tier, for $0.",
    selfHostingContent(opts),
  )
}

// ---------------------------------------------------------------------------
// /docs/api
// ---------------------------------------------------------------------------

const API_ENDPOINTS: Array<[string, string, string, string]> = [
  ['GET', '/api/v1/event-types', 'read', 'List your event types'],
  ['POST', '/api/v1/event-types', 'write', 'Create an event type'],
  ['GET', '/api/v1/event-types/:id', 'read', 'Get one event type'],
  ['PATCH', '/api/v1/event-types/:id', 'write', 'Update fields on an event type'],
  ['DELETE', '/api/v1/event-types/:id', 'write', 'Delete an event type'],
  ['GET', '/api/v1/availability', 'read', "Get the key holder's weekly schedule and date overrides"],
  ['PUT', '/api/v1/availability', 'write', 'Replace the weekly schedule and overrides'],
  ['GET', '/api/v1/slots', 'read', 'List bookable start times for an event type in a time range'],
  ['GET', '/api/v1/bookings', 'read', 'List confirmed bookings in a time range'],
  ['GET', '/api/v1/bookings/:id', 'read', 'Get one booking, any status — cancelled and rescheduled included'],
  ['POST', '/api/v1/bookings', 'write', 'Create a booking directly, bypassing the public booking page'],
  ['POST', '/api/v1/bookings/:id/cancel', 'write', 'Cancel a confirmed booking'],
  ['POST', '/api/v1/bookings/:id/reschedule', 'write', 'Move a confirmed booking to a new time'],
  ['GET', '/api/v1/webhooks', 'read', 'List registered webhooks'],
  ['POST', '/api/v1/webhooks', 'write', "Register a webhook; the response includes its signing secret once"],
  ['DELETE', '/api/v1/webhooks/:id', 'write', 'Remove a webhook'],
]

function apiContent(opts: DocsPageOptions): string {
  const githubUrl = opts.githubUrl ?? DEFAULT_GITHUB_URL
  const repoBlob = `${githubUrl}/blob/main`
  const base = opts.baseUrl.replace(/\/$/, '')

  const rows = API_ENDPOINTS.map(
    ([method, path, scope, description]) =>
      `<tr><td class="pu-time">${escapeHtml(method)}</td><td class="pu-time">${escapeHtml(path)}</td><td class="pu-time">${escapeHtml(scope)}</td><td>${escapeHtml(description)}</td></tr>`,
  ).join('\n')

  return `
<p>A REST API mounted at <span class="pu-time">/api/v1</span>. Every request
  needs an API key with the right scope; every response body &mdash; success
  or error &mdash; is JSON, except a successful
  <span class="pu-time">DELETE</span>, which returns
  <span class="pu-time">204 No Content</span> with no body at all.</p>

<h2>Authentication</h2>
<p>Send your key as a bearer token:</p>
${pre(`curl ${base}/api/v1/event-types \\\n  -H "Authorization: Bearer pk_..."`)}
<p class="pu-muted">A key carries one or more scopes &mdash;
  <span class="pu-time">read</span>, <span class="pu-time">write</span>, or
  <span class="pu-time">*</span> for both. GET and HEAD requests need
  <span class="pu-time">read</span>; everything else needs
  <span class="pu-time">write</span>. A key without the required scope gets
  <span class="pu-time">403</span>, never a silent downgrade.</p>

<h2>Errors</h2>
<p>Errors are RFC 7807 problem documents,
  <span class="pu-time">application/problem+json</span>:</p>
${pre(`{\n  "type": "urn:punctual:problem:invalid-request",\n  "title": "Invalid request",\n  "status": 400,\n  "detail": "The request body did not validate.",\n  "errors": [\n    { "field": "durationMinutes", "message": "Number must be a multiple of 5" }\n  ]\n}`)}
<p class="pu-muted">The <span class="pu-time">type</span> is a URN, not a
  dereferenceable URL &mdash; a self-hoster's error payloads never point at
  punctual's own domain.</p>

<h2>Endpoints</h2>
<div class="pu-docs-table-wrap"><table>
<thead><tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Scope</th><th scope="col">Description</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>

<h2>Example: create a booking</h2>
${pre(`curl ${base}/api/v1/bookings \\\n  -X POST \\\n  -H "Authorization: Bearer pk_..." \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "eventTypeId": "evt_abc123",\n    "start": "2026-08-20T14:30:00Z",\n    "guestName": "Ada Lovelace",\n    "guestEmail": "ada@example.com"\n  }'`)}
<p class="pu-muted"><span class="pu-time">start</span> must be ISO-8601 with
  an explicit offset (or epoch milliseconds) &mdash; an offsetless string is
  rejected rather than silently read as UTC.</p>

<h2>Ranges</h2>
<p class="pu-muted">Any endpoint that takes
  <span class="pu-time">from</span>/<span class="pu-time">to</span>
  (<span class="pu-time">/slots</span>, <span class="pu-time">/bookings</span>)
  caps the span at 62 days per request.</p>

<p class="pu-muted">Full route definitions:
  <a href="${escapeHtml(repoBlob)}/src/http/api/rest.ts">src/http/api/rest.ts</a>.</p>
`
}

export function docsApiPage(opts: DocsPageOptions): string {
  return docsPage(
    opts,
    '/docs/api',
    'REST API',
    'The REST API mounted at /api/v1 — endpoints, authentication, scopes and the error format.',
    apiContent(opts),
  )
}

// ---------------------------------------------------------------------------
// /docs/mcp
// ---------------------------------------------------------------------------

const MCP_TOOLS: Array<[string, string, string, string]> = [
  [
    'list_event_types',
    'read',
    'List the bookable event types owned by the API key holder — id, title, duration, and public booking URL.',
    'includeInactive (boolean, optional; default false)',
  ],
  [
    'get_available_slots',
    'read',
    'List bookable start times for an event type in a window. Each slot is a UTC instant plus a rendering in the requested timezone.',
    'eventTypeId (required); from, to, timezone, limit (1–200, default 50)',
  ],
  [
    'create_booking',
    'write',
    'Book a slot for a guest. start must be exactly a slot start returned by get_available_slots.',
    'eventTypeId, start, guestName, guestEmail (required); guestTimezone, answers, idempotencyKey',
  ],
  [
    'reschedule_booking',
    'write',
    'Move a confirmed booking to a new time. Returns a new booking id — the old one is marked rescheduled.',
    'bookingId, newStart (required); reason',
  ],
  [
    'cancel_booking',
    'write',
    'Cancel a confirmed booking, free its time, and notify the guest. Cannot be undone.',
    'bookingId (required); reason',
  ],
]

function mcpContent(opts: DocsPageOptions): string {
  const githubUrl = opts.githubUrl ?? DEFAULT_GITHUB_URL
  const repoBlob = `${githubUrl}/blob/main`
  const base = opts.baseUrl.replace(/\/$/, '')

  const rows = MCP_TOOLS.map(
    ([name, scope, description, params]) =>
      `<tr><td class="pu-time">${escapeHtml(name)}</td><td class="pu-time">${escapeHtml(scope)}</td><td>${escapeHtml(description)}</td><td class="pu-muted">${escapeHtml(params)}</td></tr>`,
  ).join('\n')

  return `
<p>A Model Context Protocol server at <span class="pu-time">/mcp</span> &mdash;
  JSON-RPC 2.0 over a single HTTP POST, no SSE stream, no session id. It
  speaks protocol versions <span class="pu-time">2025-11-25</span>,
  <span class="pu-time">2025-06-18</span> and
  <span class="pu-time">2025-03-26</span>.</p>

<h2>Authority</h2>
<p>An agent's authority is exactly its API key's &mdash; the same
  authentication and the same <span class="pu-time">read</span>/<span class="pu-time">write</span>
  scopes as the REST API. An agent can do nothing to a calendar that the
  key's owner couldn't do themselves, and <span class="pu-time">tools/list</span>
  only returns the tools the presented key's scopes actually allow.</p>

<h2>Connect</h2>
${pre(`curl ${base}/mcp \\\n  -X POST \\\n  -H "Authorization: Bearer pk_..." \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}'`)}

<h2>The five tools</h2>
<div class="pu-docs-table-wrap"><table>
<thead><tr><th scope="col">Tool</th><th scope="col">Scope</th><th scope="col">Does</th><th scope="col">Parameters</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>

<h2>Example: calling a tool</h2>
${pre(`{\n  "jsonrpc": "2.0",\n  "id": 2,\n  "method": "tools/call",\n  "params": {\n    "name": "get_available_slots",\n    "arguments": { "eventTypeId": "evt_abc123", "timezone": "Europe/Berlin" }\n  }\n}`)}
<p class="pu-muted">A tool that ran and refused &mdash; a taken slot, an
  unknown booking id &mdash; comes back as a normal JSON-RPC result with
  <span class="pu-time">isError: true</span> and a readable message, so the
  model can decide what to do next rather than treat it as a transport
  failure.</p>

<div class="pu-docs-callout">
  <p>All times are UTC instants; a timezone parameter only changes how a slot
    is rendered, never which slots exist.
    <span class="pu-time">create_booking</span>'s
    <span class="pu-time">start</span> must be copied exactly from a slot
    returned by <span class="pu-time">get_available_slots</span> &mdash; an
    arbitrary time is refused even if it looks free.</p>
</div>

<p class="pu-muted">Full tool and schema definitions:
  <a href="${escapeHtml(repoBlob)}/src/http/mcp/server.ts">src/http/mcp/server.ts</a>.</p>
`
}

export function docsMcpPage(opts: DocsPageOptions): string {
  return docsPage(
    opts,
    '/docs/mcp',
    'MCP server',
    'A Model Context Protocol server exposing five scheduling tools to AI agents, scoped to the calling API key.',
    mcpContent(opts),
  )
}
