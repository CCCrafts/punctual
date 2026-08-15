/**
 * Privacy policy and terms.
 *
 * These exist because Google's OAuth verification checks that both URLs
 * resolve and describe the actual data handling for the requested scopes — a
 * generic template is a common rejection reason. So this describes what the
 * engine genuinely does, and the claims are checkable against the code.
 *
 * Self-hosters are a separate data controller: they run their own deployment
 * with their own OAuth app, and this text is about the hosted service. The
 * self-host case is covered in docs/self-hosting.md.
 */

import { escapeHtml } from './booking.js'

export interface LegalPageOptions {
  brandName: string
  supportEmail: string
  baseUrl: string
  /** Company or individual acting as data controller for the hosted service. */
  operator?: string
  lastUpdated?: string
}

function shell(body: string): string {
  return `<article class="pu-card" style="max-width:44rem;margin:0 auto">
  ${body}
</article>`
}

export function privacyPage(o: LegalPageOptions): string {
  const updated = o.lastUpdated ?? '2026-08-15'
  const operator = o.operator ?? o.brandName
  return shell(
    `<h1>Privacy policy</h1>
<p class="pu-muted">Last updated ${escapeHtml(updated)}</p>

<p>${escapeHtml(o.brandName)} is a scheduling service. This policy describes what
${escapeHtml(operator)} collects when you use the hosted service at
${escapeHtml(o.baseUrl)}, and why.</p>

<h2>What we collect</h2>

<h3>If you are a host (you have an account)</h3>
<ul>
  <li><strong>Your email address and name</strong> — to identify your account and send you booking notifications.</li>
  <li><strong>Your timezone and availability</strong> — to calculate which times you can be booked.</li>
  <li><strong>Calendar connection tokens</strong> — encrypted at rest with AES-GCM, used only to read your busy times and write bookings you receive.</li>
</ul>

<h3>If you are a guest (you booked a meeting)</h3>
<ul>
  <li><strong>Your name and email address</strong> — to identify the booking and send you the confirmation and calendar invitation.</li>
  <li><strong>Answers to questions the host asked</strong> — passed to the host, and included in the calendar event.</li>
  <li><strong>Your timezone</strong> — to show you times in your own timezone. Detected from your browser or your network location, and you can change it.</li>
</ul>

<p>We do not use cookies for advertising or analytics. The booking page sets no
cookies at all. A session cookie is set only when a host signs in.</p>

<h2>Google Calendar and Microsoft 365 data</h2>

<p>When you connect a calendar, we request the narrowest scopes that let the
product work:</p>

<ul>
  <li><strong>Free/busy times</strong> — we read <em>when</em> you are busy. We do not read the titles, descriptions, attendees or locations of your existing events.</li>
  <li><strong>Events</strong> — we create, update and delete only the events that ${escapeHtml(o.brandName)} itself books. We do not modify events created elsewhere.</li>
  <li><strong>Calendar list</strong> — read-only, so you can choose which calendars to check and which one to write to.</li>
</ul>

<p><strong>Free/busy data is not stored.</strong> It is fetched when a booking
page is rendered, cached for at most 60 seconds to avoid hammering the
provider, and never written to our database.</p>

<p>${escapeHtml(o.brandName)}'s use of information received from Google APIs
adheres to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
including the Limited Use requirements. We do not transfer this data to others
except as needed to provide the service, do not use it for advertising, and do
not allow humans to read it except with your explicit consent, for security
purposes, or where required by law.</p>

<h2>Who we share with</h2>

<p>We do not sell personal data. We share only with processors required to run
the service: our hosting provider (Cloudflare) and our transactional email
provider. Booking details are shared with the other party to the meeting —
which is the point of a booking.</p>

<h2>How long we keep it</h2>

<ul>
  <li>Bookings are kept while your account exists, so you have a record of your meetings.</li>
  <li>Calendar tokens are deleted immediately when you disconnect a calendar.</li>
  <li>Deleting your account deletes your bookings, availability and connections.</li>
</ul>

<h2>Your rights</h2>

<p>You can export or delete your data, and revoke calendar access at any time —
from your ${escapeHtml(o.brandName)} settings, and independently from your
<a href="https://myaccount.google.com/permissions">Google account permissions</a>
page. If you are a guest and want your booking data removed, email us and we
will remove it.</p>

<p>Under GDPR you have the right of access, rectification, erasure, restriction,
portability and objection. Contact
<a href="mailto:${escapeHtml(o.supportEmail)}">${escapeHtml(o.supportEmail)}</a>.</p>

<h2>Security</h2>

<p>Calendar refresh tokens are encrypted with AES-GCM before storage. Session
identifiers and API keys are stored only as hashes. Links in emails that let a
guest reschedule or cancel are signed and expire.</p>

<h2>Self-hosting</h2>

<p>${escapeHtml(o.brandName)} is open source. If you run your own instance, you
are the data controller for it: your data stays in your own infrastructure and
this policy does not apply to it.</p>

<h2>Contact</h2>
<p><a href="mailto:${escapeHtml(o.supportEmail)}">${escapeHtml(o.supportEmail)}</a></p>`,
  )
}

export function termsPage(o: LegalPageOptions): string {
  const updated = o.lastUpdated ?? '2026-08-15'
  const operator = o.operator ?? o.brandName
  return shell(
    `<h1>Terms of service</h1>
<p class="pu-muted">Last updated ${escapeHtml(updated)}</p>

<p>These terms cover the hosted ${escapeHtml(o.brandName)} service at
${escapeHtml(o.baseUrl)}, operated by ${escapeHtml(operator)}. Using the service
means you accept them.</p>

<h2>The service</h2>
<p>${escapeHtml(o.brandName)} lets you publish a booking page, and lets other
people book time with you. It connects to your calendar to know when you are
busy and to record the meetings you accept.</p>

<h2>Your account</h2>
<ul>
  <li>You are responsible for what happens under your account and for keeping your sign-in email secure.</li>
  <li>You must be old enough to form a binding contract where you live.</li>
  <li>Do not use the service to send unsolicited messages, to impersonate someone, or for anything unlawful.</li>
</ul>

<h2>Availability</h2>
<p>We aim to keep the service running and will not pretend otherwise when it
breaks. It is provided as is, without warranty. We are not liable for meetings
missed, bookings lost, or business consequences arising from downtime or error,
to the extent the law allows.</p>

<h2>Your content</h2>
<p>Your bookings, availability and event descriptions remain yours. You grant us
only the permission needed to operate the service — to store that data, show it
to the people you are meeting, and send it to your calendar provider.</p>

<h2>Cancellation</h2>
<p>You can stop using the service and delete your account at any time. We may
suspend an account that abuses the service or puts other users at risk, and
will say why when we do.</p>

<h2>Open source</h2>
<p>The ${escapeHtml(o.brandName)} engine is released under the MIT licence and
you are free to run it yourself. These terms apply only to the hosted service —
not to your own deployment.</p>

<h2>Changes</h2>
<p>If we change these terms materially, we will say so before the change takes
effect.</p>

<h2>Contact</h2>
<p><a href="mailto:${escapeHtml(o.supportEmail)}">${escapeHtml(o.supportEmail)}</a></p>`,
  )
}
