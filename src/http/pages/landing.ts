/**
 * The marketing landing page and docs index, served at `/` and `/docs`.
 *
 * Same rendering approach as the booking page (server-rendered template
 * strings, no client framework, no external assets) but with its own page
 * shell: the booking page's `shellHead`/`shellFoot` bakes in the `.pu-wrap`
 * 900px reading column and the "powered by" footer, neither of which fits a
 * page whose job is to sell the product rather than book a meeting. This
 * file owns its own shell instead of reaching into booking.ts for one.
 *
 * Every claim on this page is checkable against README.md, docs/spec.md or
 * docs/self-hosting.md — this is a public repo, and an overclaiming landing
 * page is the fastest way to lose the trust the pledge is supposed to buy.
 */

import { escapeHtml } from './booking.js'
import { pageCss, LANDING_CSS } from '../styles.js'

export interface LandingPageOptions {
  brandName: string
  baseUrl: string
  /** Defaults to the public GitHub repo (repo map: CCCrafts/punctual). */
  githubUrl?: string
  /** Path to a real, live booking page used for the "see a booking page" CTA. */
  demoPath?: string
}

export interface DocsIndexPageOptions {
  brandName: string
  baseUrl: string
  githubUrl?: string
}

const DEFAULT_GITHUB_URL = 'https://github.com/CCCrafts/punctual'

function shell(opts: { title: string; description: string; baseUrl: string; path?: string }, body: string): string {
  const origin = opts.baseUrl.replace(/\/$/, '')
  const url = `${origin}${opts.path ?? ''}`
  const image = `${origin}/og/default.png`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(opts.description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0E7C4C">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${escapeHtml(url)}">
<!-- Open Graph / Twitter: one shared brand card for now — a booking page's
     own title/description still varies per host and event type (see
     pages/booking.ts), only the image is shared until per-page OG images
     exist. -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="Punctual">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:title" content="${escapeHtml(opts.title)}">
<meta property="og:description" content="${escapeHtml(opts.description)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(opts.title)}">
<meta name="twitter:description" content="${escapeHtml(opts.description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
<link rel="preload" href="/fonts/ibmplexmono-600.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/schibstedgrotesk-600.woff2" as="font" type="font/woff2" crossorigin>
<style>${pageCss()}${LANDING_CSS}</style>
</head>
<body>
${body}
</body></html>`
}

function footer(githubUrl: string): string {
  return `<footer class="pu-landing-footer">
  <nav aria-label="Footer">
    <a href="${escapeHtml(githubUrl)}">GitHub</a>
    <a href="/docs">Docs</a>
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  </nav>
  <p class="pu-muted" style="text-align:center;margin:0">
    <a class="pu-mark" href="/">punctual<span>:</span></a> — scheduling that shows up on time
  </p>
</footer>`
}

export function landingPage(opts: LandingPageOptions): string {
  const githubUrl = opts.githubUrl ?? DEFAULT_GITHUB_URL
  const example = `${opts.baseUrl.replace(/\/$/, '')}/you/intro`
  // No fallback: a fresh or self-hosted deployment has no host/event type
  // seeded yet, and a hardcoded demo identity here would make every such
  // deployment's own homepage embed a 404ing iframe on first boot. The demo
  // CTA and the live embed both simply don't render without a real one.
  const demoPath = opts.demoPath
  // `demoPath` is always "/{userSlug}/{eventSlug}".
  const [, demoUser = '', demoEvent = ''] = demoPath?.split('/') ?? []

  const body = `<div class="pu-landing">
<header class="pu-hero">
  <p class="pu-mark">punctual<span>:</span></p>
  <h1>Scheduling that shows up on time</h1>
  <p class="pu-hero-lede">An open, edge-native scheduler — a full single-team alternative to
    Calendly, teams and round-robin included, that runs entirely on Cloudflare Workers.</p>
  <div class="pu-hero-cta">
    <a class="pu-btn" href="${escapeHtml(githubUrl)}">Star on GitHub</a>
    ${demoPath ? `<a class="pu-btn pu-btn-ghost" href="${escapeHtml(demoPath)}">See a booking page</a>` : ''}
  </div>
</header>

<main>

${
  demoPath
    ? `<section aria-label="Live demo" class="pu-live-demo">
  <div class="pu-section-head">
    <h2>This is the actual product</h2>
    <p class="pu-muted">Not a screenshot — a real booking page, embedded with the same
      <code class="pu-time">&lt;script&gt;</code> tag anyone can drop into their own site.
      Pick a time; nothing about this demo is staged.</p>
  </div>
  <div class="pu-card pu-embed-frame">
    <script src="/embed.js" data-user="${escapeHtml(demoUser)}" data-event="${escapeHtml(demoEvent)}" data-height="560"></script>
  </div>
</section>`
    : ''
}

<section class="pu-card pu-pledge" aria-label="The pledge">
  <h2>The pledge</h2>
  <p>The open-source version is complete for a single team — forever. No seat
  limits, no gated scheduling features, no &ldquo;non-production use&rdquo; clauses.
  MIT makes this promise irrevocable: what we ship can never be taken back.</p>
</section>

<section aria-label="Why it's different">
  <div class="pu-section-head">
    <h2>Why it's different</h2>
  </div>
  <div class="pu-feature-grid">
    <div class="pu-card">
      <h3><span class="pu-stat">~0.14s TTFB, 3.8KB gzip</span>Renders at the edge</h3>
      <p class="pu-muted">Measured, not estimated. The booking page is a Cloudflare
        Worker answering from whichever edge is closest to your guest — not a
        Next.js app rendering in one region.</p>
    </div>
    <div class="pu-card">
      <h3><span class="pu-stat">~5 minutes, $0</span>Self-host on the free tier</h3>
      <p class="pu-muted">Clone it, create a D1 database and a KV namespace,
        set two secrets, deploy. No database server, no Docker, no credit card.</p>
    </div>
    <div class="pu-card">
      <h3><span class="pu-stat">MIT, no CLA</span>Irrevocably open</h3>
      <p class="pu-muted">Nothing to sign away, nothing to relicense later.
        What ships under MIT today can't be taken back tomorrow.</p>
    </div>
    <div class="pu-card">
      <h3><span class="pu-stat">Built in</span>An MCP server for agents</h3>
      <p class="pu-muted">Your calendar as tools an AI agent can call — list
        event types, check availability, book, reschedule, cancel — with exactly
        your API key's authority, nothing more.</p>
    </div>
  </div>
</section>

<section aria-label="How it works">
  <div class="pu-section-head">
    <h2>How it works</h2>
  </div>
  <ol class="pu-steps">
    <li><h3>Connect your calendar</h3>
      <p class="pu-muted">Google Calendar or Microsoft 365, through your own
        OAuth app — so no one else ever sees your calendar data.</p></li>
    <li><h3>Share your link</h3>
      <p class="pu-muted">Every event type gets a page, like
        <span class="pu-time">${escapeHtml(example)}</span>.</p></li>
    <li><h3>Get booked</h3>
      <p class="pu-muted">Guests pick an open slot in their own timezone.
        A calendar invite goes out immediately; double-booking is impossible
        at the storage layer, not by convention.</p></li>
  </ol>
</section>

<section aria-label="Open source or hosted">
  <div class="pu-section-head">
    <h2>Open source or hosted</h2>
  </div>
  <div class="pu-compare">
    <div class="pu-card">
      <h3>Open source <span class="pu-badge">Free, forever</span></h3>
      <p class="pu-muted">Everything a single team needs to schedule meetings —
        run it yourself, on your own Cloudflare account.</p>
      <ul class="pu-muted">
        <li>Booking pages rendered and streamed from the edge</li>
        <li>Google Calendar and Microsoft 365 sync, your own OAuth app</li>
        <li>Event types — buffers, notice windows, horizons, daily caps, custom questions</li>
        <li>Teams — round-robin and collective scheduling</li>
        <li>Emails with .ics invites, reschedule/cancel links, reminders</li>
        <li>REST API, HMAC-signed webhooks, embed widget, MCP server</li>
      </ul>
    </div>
    <div class="pu-card">
      <h3>Hosted <span class="pu-badge">Coming soon</span></h3>
      <p class="pu-muted">The same engine, managed — for teams who'd rather not
        run infrastructure. Not launched yet.</p>
      <ul class="pu-muted">
        <li>Managed OAuth — no Google or Microsoft developer console needed</li>
        <li>Custom domain</li>
        <li>Zero setup</li>
      </ul>
      <p class="pu-muted">Watch <a href="${escapeHtml(githubUrl)}">the repo on GitHub</a> for the announcement.</p>
    </div>
  </div>
</section>

</main>

${footer(githubUrl)}
</div>`

  return shell(
    {
      title: `${opts.brandName} — scheduling that shows up on time`,
      description:
        'Open, edge-native scheduling on Cloudflare Workers. Self-host for $0, MIT licensed, with a built-in MCP server for AI agents.',
      baseUrl: opts.baseUrl,
      path: '/',
    },
    body,
  )
}

export function docsIndexPage(opts: DocsIndexPageOptions): string {
  const githubUrl = opts.githubUrl ?? DEFAULT_GITHUB_URL
  const repoBlob = `${githubUrl}/blob/main`

  const body = `<div class="pu-landing">
<header class="pu-hero" style="padding-top:2.5rem;padding-bottom:1.5rem">
  <p class="pu-mark"><a href="/" style="color:inherit;text-decoration:none">punctual<span>:</span></a></p>
  <h1>Documentation</h1>
  <p class="pu-hero-lede">Everything needed to run ${escapeHtml(opts.brandName)} yourself
    or build against it.</p>
</header>

<main>

<section aria-label="Self-hosting">
  <div class="pu-card">
    <h2>Self-hosting</h2>
    <p class="pu-muted">Zero to a working booking link in about 15 minutes on
      Cloudflare's free tier, for $0. You need a Cloudflare account and Node 20+
      — no database server, no Docker, no credit card.</p>
    <p><a href="${escapeHtml(repoBlob)}/docs/self-hosting.md">Read the self-hosting guide</a></p>
  </div>
</section>

<section aria-label="REST API">
  <div class="pu-card">
    <h2>REST API</h2>
    <p class="pu-muted">A REST API mounted at <span class="pu-time">/api/v1</span>,
      authenticated with an API key scoped to <span class="pu-time">read</span> or
      <span class="pu-time">write</span>. Errors are RFC 7807 problem documents
      (<span class="pu-time">application/problem+json</span>). Endpoints cover
      event types, availability, slots, bookings and HMAC-signed webhooks.</p>
    <p><a href="${escapeHtml(repoBlob)}/src/http/api/rest.ts">Browse the API implementation</a></p>
  </div>
</section>

<section aria-label="MCP server">
  <div class="pu-card">
    <h2>MCP server</h2>
    <p class="pu-muted">A Model Context Protocol server at
      <span class="pu-time">/mcp</span> (JSON-RPC 2.0 over a single HTTP POST)
      exposes five tools — <span class="pu-time">list_event_types</span>,
      <span class="pu-time">get_available_slots</span>,
      <span class="pu-time">create_booking</span>,
      <span class="pu-time">reschedule_booking</span>,
      <span class="pu-time">cancel_booking</span> — scoped to exactly the calling
      API key's authority. An agent can do nothing your key couldn't do itself.</p>
    <p><a href="${escapeHtml(repoBlob)}/src/http/mcp/server.ts">Browse the MCP server implementation</a></p>
  </div>
</section>

<section aria-label="More">
  <div class="pu-card">
    <h2>More</h2>
    <p class="pu-muted">Full source, issue tracker and the rest of the codebase
      live on <a href="${escapeHtml(githubUrl)}">GitHub</a>.</p>
  </div>
</section>

</main>

${footer(githubUrl)}
</div>`

  return shell(
    {
      title: `Documentation · ${opts.brandName}`,
      description: 'Self-hosting guide, REST API and MCP server overview for Punctual.',
      baseUrl: opts.baseUrl,
      path: '/docs',
    },
    body,
  )
}
