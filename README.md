# Punctual

**Scheduling that shows up on time.**

Punctual is an open, edge-native scheduler — a full single-team alternative to
Calendly that runs entirely on Cloudflare Workers. Booking pages render at the
edge in under 100 ms anywhere in the world; self-hosting is one
`wrangler deploy` into your own Cloudflare account, $0 on the free tier.

> **Status:** pre-M0, under active development. Not usable yet.

## The pledge

The open-source version is complete for a single team — forever. No seat
limits, no gated scheduling features, no "non-production use" clauses.
MIT makes this promise irrevocable: what we ship can never be taken back.

## Planned for v1

- Booking pages rendered at the edge (<100 ms TTFB worldwide)
- Google Calendar + Microsoft 365 sync (bring your own OAuth credentials)
- Event types with buffers, notice windows, custom questions
- Teams: round-robin and collective scheduling
- Emails with .ics invites, reschedule/cancel links
- REST API, webhooks, embed widget
- Built-in MCP server — let your AI agent find slots and book meetings

## License

[MIT](LICENSE). The hosted cloud version (managed OAuth apps, custom domains,
zero setup) is a separate commercial service — it runs on this same engine.
