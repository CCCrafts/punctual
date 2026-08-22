# punctual-sh

[Punctual](https://punctual.sh) in your terminal — scheduling that shows up
on time. The engine is MIT-licensed and lives at
[CCCrafts/punctual](https://github.com/CCCrafts/punctual); this CLI deploys
it into **your** Cloudflare account and reads live availability back out.

```
npx punctual-sh init
```

walks the whole self-host setup: clones the engine, creates the D1 database,
KV namespace, R2 bucket and task queues, writes their ids into
`wrangler.toml` for you, generates secrets, applies migrations and deploys —
twice, so emailed links point at your real URL. Every step is idempotent:
if anything fails, run it again and it resumes.

```
npx punctual-sh slots https://your-instance.workers.dev --event 30min
```

prints the next week of open slots, grouped by day, in your host timezone.
Needs an API key (dashboard → API keys) via `--key` or `PUNCTUAL_API_KEY`.

## Terminal manners

- Plain text when piped or when `NO_COLOR` is set; truecolor where the
  terminal offers it, 256-colour or 16-colour where it doesn't.
- No animation outside a TTY — a CI log gets one line per step.
- Status glyphs differ by shape, not just colour: `●` done, `◐` waiting,
  `✕` failed.
- The binary installs as `punctual`: `npm i -g punctual-sh`, then `punctual --help`.
