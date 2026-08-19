# Contributing

Punctual is a small, focused project: one engine, one architecture. Ports
(`src/core`) hold the domain logic and take everything else — storage,
calendars, email, crypto, cache, clock, queue — as interfaces, so the same
code runs under real Cloudflare bindings and under fakes in tests.

## Running it locally

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # full suite: core + Workers runtime, via Miniflare
npm run test:core     # domain only, plain Node, no Workers runtime — fast
npm run test:watch    # vitest in watch mode
```

`npm run dev` starts `wrangler dev` against local simulations of D1, KV and
R2 — no Cloudflare account needed. On first run it copies
`.dev.vars.example` to `.dev.vars`, which carries a local `BASE_URL` and two
fixed dev-only keys; real deployments set their own as secrets (see
[docs/self-hosting.md](docs/self-hosting.md)).

CI (`.github/workflows/ci.yml`) runs `npm run typecheck` and `npm test` on
every push and pull request. Both must pass before a PR merges.

## Making a change

- **Keep it small and focused.** One change, one PR. A PR that mixes a bug
  fix with a refactor is harder to review and harder to revert if something's
  wrong.
- **Add tests.** Domain logic (`src/core`) belongs in `test/core` — pure
  Node, no Workers runtime, and that's what keeps the timezone and
  slot-engine suites fast enough to run exhaustively. Adapters, Durable
  Objects and HTTP belong in `test/workers`, against the real Workers
  runtime via Miniflare.
- **Respect the ports.** If your change needs something from the outside
  world (a new provider, a new side effect), add it as a port interface with
  a fake implementation for tests, rather than reaching for a Cloudflare
  binding directly from domain code.
- **Match the existing tone.** Comments and commit messages here are public
  and read by strangers deciding whether to trust the project. Precise and
  understated beats clever or promotional.

## Reporting bugs

Open a [GitHub issue](https://github.com/CCCrafts/punctual/issues). For
anything involving dates or times, include the host timezone, guest
timezone, and the date in question — that's usually enough to reproduce a
DST-adjacent bug.

## What this isn't

There's no formal governance process or code of conduct beyond the basics:
be respectful, keep discussion on-topic, assume good faith. This is a small
project maintained by a small team; if that changes, this file will too.
