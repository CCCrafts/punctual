/**
 * The marketing landing page and the "vs. Calendly" comparison page, served
 * at `/` and `/calendly-alternative`. The docs section itself (`/docs` and
 * its sub-pages) lives in pages/docs.ts, which reuses `shell()`/`footer()`
 * exported from here so both halves of the site share one page frame.
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

import { escapeHtml, PUNCTUAL_SITE_URL } from './booking.js'
import { pageCss, LANDING_CSS } from '../styles.js'

export interface LandingPageOptions {
  brandName: string
  baseUrl: string
  /** Defaults to the public GitHub repo (repo map: CCCrafts/punctual). */
  githubUrl?: string
  /** Path to a real, live booking page used for the "see a booking page" CTA. */
  demoPath?: string
  /**
   * The legal entity operating this deployment — same source as /privacy and
   * /terms (EngineConfig.legalOperator). Unset by default: a self-hosted
   * deployment run by nobody-in-particular has nothing honest to put here,
   * so the footer just omits the line rather than naming this repo's owner.
   */
  operator?: string
}

export interface CalendlyAlternativePageOptions {
  brandName: string
  baseUrl: string
  githubUrl?: string
  operator?: string
}

/**
 * Shared with pages/docs.ts, which owns the docs shell — one repo map (this
 * file) rather than two copies drifting.
 */
export const DEFAULT_GITHUB_URL = 'https://github.com/CCCrafts/punctual'

/** Exported for pages/docs.ts: the docs pages want the exact same page frame. */
export function shell(opts: { title: string; description: string; baseUrl: string; path?: string }, body: string): string {
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
<!-- All faces, same reasoning as shellHead in booking.ts: with
     font-display:optional the first paint is final, so anything not
     preloaded is likely never seen on a cold cache. -->
<link rel="preload" href="/fonts/inter-variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/schibstedgrotesk-600.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/ibmplexmono-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/ibmplexmono-600.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/ibmplexmono-700.woff2" as="font" type="font/woff2" crossorigin>
<style>${pageCss()}${LANDING_CSS}</style>
</head>
<body>
${body}
</body></html>`
}

/** Exported for pages/docs.ts: the docs footer must match the marketing footer exactly. */
export function footer(githubUrl: string, operator?: string): string {
  return `<footer class="pu-landing-footer">
  <nav aria-label="Footer">
    <a href="${escapeHtml(githubUrl)}">GitHub</a>
    <a href="/docs">Docs</a>
    <a href="/calendly-alternative">vs. Calendly</a>
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  </nav>
  <p class="pu-muted" style="text-align:center;margin:0">
    <a class="pu-mark" href="${PUNCTUAL_SITE_URL}" target="_blank" rel="noopener">punctual<span>:</span></a> — scheduling that shows up on time
  </p>
  ${operator ? `<p class="pu-muted" style="text-align:center;margin:.35rem 0 0;font-size:.8125rem">${escapeHtml(operator)}</p>` : ''}
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
  <p class="pu-mark">punctual<span>:</span><span class="pu-hero-clock" id="pu-hero-clock" aria-hidden="true"></span></p>
  <h1>Scheduling that shows up on time</h1>
  <p class="pu-hero-lede">An open, edge-native scheduler — a full single-team alternative to
    Calendly, teams and round-robin included, that runs entirely on Cloudflare Workers.</p>
  <div class="pu-hero-cta">
    <a class="pu-btn" href="${escapeHtml(githubUrl)}">Star on GitHub</a>
    ${demoPath ? `<a class="pu-btn pu-btn-ghost" href="${escapeHtml(demoPath)}">See a booking page</a>` : ''}
  </div>
</header>
<script>(function(){
  var el = document.getElementById('pu-hero-clock');
  if (!el) return;
  function tick(){
    var d = new Date();
    el.textContent = ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  tick();
  // Always add the class — the fade-in it triggers is downgraded to an
  // immediate, static opacity:1 under prefers-reduced-motion (see styles.ts),
  // so gating this on the media query here would leave the clock at its
  // pre-animation opacity:0 forever for exactly the users who most need it
  // to just appear.
  el.classList.add('pu-in');
  setInterval(tick, 15000);
})();</script>

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

${footer(githubUrl, opts.operator)}
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

/**
 * A comparison page has one honesty rule the rest of the marketing site
 * doesn't: every row must be checkable by the reader, not just by us. So
 * this deliberately avoids specific competitor pricing figures, which drift
 * and would be the first thing a skeptical reader tries to catch us being
 * wrong about — the qualitative claims (closed-source, no self-host option,
 * seat-based pricing) are the ones that don't go stale.
 */
export function calendlyAlternativePage(opts: CalendlyAlternativePageOptions): string {
  const githubUrl = opts.githubUrl ?? DEFAULT_GITHUB_URL

  const rows: Array<[string, string, string]> = [
    ['License', 'MIT, open source', 'Proprietary, closed source'],
    ['Self-hosting', 'Yes — your own Cloudflare account', 'Not available'],
    ['Pricing model', 'Free, forever, for one team', 'Seat-based subscription'],
    ['Your calendar data', 'Stays in your own Google/Microsoft account', "Stored on the vendor's infrastructure"],
    ['Rendering', 'Server-rendered at the edge, no client framework', 'Client-rendered SPA'],
    ['AI agent access', 'Built-in MCP server', 'Not available'],
  ]

  const body = `<div class="pu-landing">
<header class="pu-hero">
  <p class="pu-mark"><a href="/" style="color:inherit;text-decoration:none">punctual<span>:</span></a></p>
  <h1>The open-source Calendly alternative</h1>
  <p class="pu-hero-lede">A full single-team scheduler you can self-host for $0 — not a trial,
    not a seat-limited tier, the whole product, MIT licensed.</p>
  <div class="pu-hero-cta">
    <a class="pu-btn" href="${escapeHtml(githubUrl)}">Star on GitHub</a>
    <a class="pu-btn pu-btn-ghost" href="/">See how it works</a>
  </div>
</header>

<main>

<section aria-label="Comparison">
  <div class="pu-section-head">
    <h2>How they compare</h2>
    <p class="pu-muted">Punctual is not a Calendly clone — it's an answer to a narrower
      question: what does a scheduler look like with no seat limits, no vendor
      lock-in on your calendar data, and a license that can't be revoked?</p>
  </div>
  <div class="pu-card pu-compare-table-wrap">
    <table class="pu-compare-table">
      <thead><tr><th scope="col"></th><th scope="col">Punctual</th><th scope="col">Calendly</th></tr></thead>
      <tbody>
        ${rows
          .map(
            ([label, punctual, calendly]) =>
              `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(punctual)}</td><td>${escapeHtml(calendly)}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>
  <p class="pu-muted pu-scroll-hint" style="font-size:.8125rem;margin:.5rem 0 0">Scroll to see the Calendly column &rarr;</p>
</section>

<section aria-label="Open source Calendly">
  <div class="pu-section-head">
    <h2>Looking for &ldquo;open source Calendly&rdquo;?</h2>
    <p class="pu-muted">Several projects have carried that label over the years, and more than
      one has since moved toward a closed-core or hosted-first model as it grew. Punctual's
      MIT license is not a marketing position that can quietly change later — the pledge
      above is the whole single-team product, and it stays that way by construction, not
      by promise.</p>
  </div>
</section>

<section class="pu-card pu-pledge" aria-label="The pledge">
  <h2>The pledge</h2>
  <p>The open-source version is complete for a single team — forever. No seat
  limits, no gated scheduling features, no &ldquo;non-production use&rdquo; clauses.
  MIT makes this promise irrevocable: what we ship can never be taken back.</p>
</section>

</main>

${footer(githubUrl, opts.operator)}
</div>`

  return shell(
    {
      title: `Open-source Calendly alternative · ${opts.brandName}`,
      description:
        'Punctual is a self-hosted, MIT-licensed alternative to Calendly — no seat limits, your calendar data stays yours, deployed on your own Cloudflare account for $0.',
      baseUrl: opts.baseUrl,
      path: '/calendly-alternative',
    },
    body,
  )
}
