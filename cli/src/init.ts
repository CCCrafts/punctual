/**
 * `punctual init [dir]` — the README quick start as a guided, resumable run.
 *
 * Every step is idempotent: it checks whether its outcome already exists
 * (directory cloned, id already patched into wrangler.toml, secret already
 * set) and skips if so. A failed run therefore resumes from where it stopped
 * by simply running `init` again — there is no state file to corrupt.
 *
 * The one thing this automates that the README cannot: the "put the id in
 * wrangler.toml" steps. Wrangler prints ids; humans mistype them.
 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Spinner, bold, color, detectTerm, dim, glyph, wordmark } from './style.js'

const REPO_URL = 'https://github.com/CCCrafts/punctual.git'

// ---------------------------------------------------------------------------
// Pure parsing/patching — unit-tested; the bugs live here, not in spawn()
// ---------------------------------------------------------------------------

/** `wrangler d1 create` prints a config snippet with the new database id. */
export function parseD1Id(output: string): string | null {
  return /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(output)?.[1] ?? null
}

/** `wrangler kv namespace create` prints an `id = "<32 hex>"` line. */
export function parseKvId(output: string): string | null {
  return /"?id"?\s*[=:]\s*"([0-9a-f]{32})"/.exec(output)?.[1] ?? null
}

/** `wrangler deploy` prints the live URL on its own line. */
export function parseDeployUrl(output: string): string | null {
  return /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/.exec(output)?.[0] ?? null
}

/**
 * `wrangler d1 list --json` → the id of the database with this name.
 * The recovery path for a half-finished run: the database was created but
 * the process died before its id reached wrangler.toml.
 */
export function findD1IdInList(json: string, name: string): string | null {
  try {
    const rows = JSON.parse(json) as Array<{ name?: string; uuid?: string }>
    return rows.find((r) => r.name === name)?.uuid ?? null
  } catch {
    return null
  }
}

/** `wrangler kv namespace list` → the id of the namespace whose title ends with the binding name. */
export function findKvIdInList(json: string, binding: string): string | null {
  try {
    const rows = JSON.parse(json) as Array<{ id?: string; title?: string }>
    return rows.find((r) => r.title === binding || r.title?.endsWith(`-${binding}`))?.id ?? null
  } catch {
    return null
  }
}

/** Only resume in a directory that really is a Punctual checkout. */
export function isPunctualToml(toml: string): boolean {
  return /^name\s*=\s*"punctual"$/m.test(toml) && /^database_name\s*=\s*"punctual"$/m.test(toml)
}

export function patchD1Id(toml: string, id: string): string {
  return toml.replace(/^(database_id\s*=\s*)".*"$/m, `$1"${id}"`)
}

export function patchKvId(toml: string, id: string): string {
  // The KV block is the only `id = ...` line in the template (D1 uses
  // database_id); anchor to line start so `database_id` can never match.
  return toml.replace(/^(id\s*=\s*)".*"$/m, `$1"${id}"`)
}

export function patchBaseUrl(toml: string, url: string): string {
  return toml.replace(/^(BASE_URL\s*=\s*)".*"$/m, `$1"${url}"`)
}

export function hasD1Placeholder(toml: string): boolean {
  return /^database_id\s*=\s*"<.*"$/m.test(toml)
}

export function hasKvPlaceholder(toml: string): boolean {
  return /^id\s*=\s*"<.*"$/m.test(toml)
}

export function hasBaseUrlPlaceholder(toml: string): boolean {
  return /^BASE_URL\s*=\s*".*YOUR-SUBDOMAIN.*"$/m.test(toml)
}

/**
 * Comment out both `[[queues.*]]` blocks — the fallback when queue creation
 * fails (Queues needs a paid feature on some accounts). The engine degrades
 * gracefully: emails and webhooks deliver inline instead.
 */
export function commentOutQueues(toml: string): string {
  const lines = toml.split('\n')
  let inQueueBlock = false
  return lines
    .map((line) => {
      const isHeader = /^\[\[?[a-z_.]+/.test(line.trim())
      if (isHeader) inQueueBlock = line.includes('queues.')
      if (inQueueBlock && line.trim() !== '' && !line.trim().startsWith('#')) return `# ${line}`
      return line
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

class StepFailed extends Error {}

interface RunResult {
  ok: boolean
  output: string
}

/**
 * Windows can only execute npm.cmd/npx.cmd through a shell (and Node
 * refuses to spawn .cmd files without one since the CVE-2024-27980 fix).
 * Every npm/npx invocation here uses static, space-free arguments, so the
 * shell's word splitting cannot misparse anything; git ships as a real
 * executable and never needs it.
 */
function needsShell(cmd: string): boolean {
  return process.platform === 'win32' && cmd !== 'git'
}

function run(cmd: string, args: string[], cwd: string): RunResult {
  const child = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: needsShell(cmd),
  })
  return {
    ok: child.status === 0,
    // child.error is the spawn-level failure (ENOENT and friends) that
    // produces no stdout/stderr at all — without it, a step would die blank.
    output: `${child.stdout ?? ''}${child.stderr ?? ''}${child.error ? child.error.message : ''}`,
  }
}

/** For wrangler login / migration confirms: the user sees and answers. */
function runInteractive(cmd: string, args: string[], cwd: string): boolean {
  return spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: needsShell(cmd) }).status === 0
}

/**
 * `wrangler whoami` exits 0 even when nobody is signed in — it *prints*
 * "You are not authenticated" and returns normally. Gate on the output,
 * not the exit code, or the guided login never triggers for exactly the
 * fresh-machine user this installer exists for.
 */
function loggedIn(dir: string): boolean {
  const r = run('npx', ['wrangler', 'whoami'], dir)
  return r.ok && !/not authenticated/i.test(r.output)
}

export async function init(args: string[]): Promise<number> {
  const term = detectTerm()
  const out = process.stdout
  const dir = resolve(args.find((a) => !a.startsWith('-')) ?? 'punctual')
  const tomlPath = join(dir, 'wrangler.toml')

  out.write(`${wordmark(term)} ${dim('self-host setup — your Cloudflare account, your data', term)}\n\n`)

  const step = (label: string, fn: () => string | void): void => {
    const spinner = new Spinner(term, out)
    spinner.start(label)
    try {
      const note = fn()
      spinner.stop('booked', note ? `${label} ${dim(`— ${note}`, term)}` : label)
    } catch (e) {
      spinner.stop('failed', label)
      if (e instanceof StepFailed && e.message) {
        out.write(`\n${e.message.trimEnd()}\n`)
      }
      throw new StepFailed('')
    }
  }

  const fail = (message: string): never => {
    throw new StepFailed(message)
  }

  try {
    step('Checking prerequisites', () => {
      if (!run('git', ['--version'], '.').ok) fail('git is required — install it and re-run.')
      const major = Number(process.versions.node.split('.')[0])
      if (major < 20) fail(`Node 20+ is required (you have ${process.versions.node}).`)
    })

    step('Fetching the engine', () => {
      if (existsSync(tomlPath)) {
        // Never resume into some OTHER Worker's checkout — the later steps
        // patch its wrangler.toml, put secrets on it and deploy it.
        if (!isPunctualToml(readFileSync(tomlPath, 'utf8'))) {
          fail(`${dir} contains a wrangler.toml that is not Punctual's — pick another directory.`)
        }
        return 'already cloned, resuming'
      }
      if (existsSync(dir)) fail(`${dir} exists but is not a Punctual checkout — pick another directory.`)
      const r = run('git', ['clone', '--depth', '1', REPO_URL, dir], '.')
      if (!r.ok) fail(r.output)
    })

    step('Installing dependencies', () => {
      if (existsSync(join(dir, 'node_modules'))) return 'already installed'
      const r = run('npm', ['install', '--no-fund', '--no-audit'], dir)
      if (!r.ok) fail(r.output)
    })

    // Login is the one step that must be interactive — it opens a browser.
    if (!loggedIn(dir)) {
      out.write(`${glyph('held', term)} Signing in to Cloudflare — a browser window will open\n`)
      runInteractive('npx', ['wrangler', 'login'], dir)
      // Re-check whoami rather than trusting login's exit code — wrangler
      // login exits 0 on some failures (e.g. a broken CLOUDFLARE_API_TOKEN
      // blocking the OAuth flow).
      if (!loggedIn(dir)) {
        out.write(`${glyph('failed', term)} Cloudflare sign-in failed\n`)
        return 1
      }
      out.write(`${glyph('booked', term)} Signed in to Cloudflare\n`)
    }

    step('Creating the database (D1)', () => {
      let toml = readFileSync(tomlPath, 'utf8')
      if (!hasD1Placeholder(toml)) return 'already configured'
      const r = run('npx', ['wrangler', 'd1', 'create', 'punctual'], dir)
      let id = parseD1Id(r.output)
      if (!id) {
        // The database may exist from a run that died before patching the
        // toml — recover its id from the list instead of dead-ending.
        const listed = run('npx', ['wrangler', 'd1', 'list', '--json'], dir)
        id = listed.ok ? findD1IdInList(listed.output, 'punctual') : null
        if (!id) fail(r.output)
      }
      toml = patchD1Id(toml, id!)
      writeFileSync(tomlPath, toml)
    })

    step('Creating the cache (KV)', () => {
      let toml = readFileSync(tomlPath, 'utf8')
      if (!hasKvPlaceholder(toml)) return 'already configured'
      const r = run('npx', ['wrangler', 'kv', 'namespace', 'create', 'CACHE'], dir)
      let id = parseKvId(r.output)
      if (!id) {
        // Same recovery as D1: created earlier, never written to the toml.
        const listed = run('npx', ['wrangler', 'kv', 'namespace', 'list'], dir)
        id = listed.ok ? findKvIdInList(listed.output, 'CACHE') : null
        if (!id) fail(r.output)
      }
      toml = patchKvId(toml, id!)
      writeFileSync(tomlPath, toml)
    })

    step('Creating the avatar bucket (R2)', () => {
      const r = run('npx', ['wrangler', 'r2', 'bucket', 'create', 'punctual-avatars'], dir)
      if (!r.ok && !/already (exists|owned)/i.test(r.output)) fail(r.output)
      if (!r.ok) return 'already exists'
    })

    step('Creating the task queues', () => {
      const main = run('npx', ['wrangler', 'queues', 'create', 'punctual-tasks'], dir)
      const dlq = run('npx', ['wrangler', 'queues', 'create', 'punctual-tasks-dlq'], dir)
      const exists = (o: string) => /already exists/i.test(o)
      if ((main.ok || exists(main.output)) && (dlq.ok || exists(dlq.output))) return
      // Queues unavailable on this account/plan: the engine's documented
      // degradation is inline email/webhook delivery. Disable the bindings
      // rather than fail the whole install.
      writeFileSync(tomlPath, commentOutQueues(readFileSync(tomlPath, 'utf8')))
      return 'unavailable — emails will send inline instead'
    })

    out.write(`${glyph('held', term)} Applying database migrations — confirm when asked\n`)
    if (!runInteractive('npx', ['wrangler', 'd1', 'migrations', 'apply', 'punctual', '--remote'], dir)) {
      out.write(`${glyph('failed', term)} Migrations failed\n`)
      return 1
    }
    out.write(`${glyph('booked', term)} Database migrated\n`)

    let deployUrl = ''
    step('Deploying to Cloudflare', () => {
      const r = run('npx', ['wrangler', 'deploy'], dir)
      if (!r.ok) fail(r.output)
      deployUrl = parseDeployUrl(r.output) ?? ''
      if (!deployUrl) fail(`Deploy succeeded but no workers.dev URL found in output:\n${r.output}`)
      return deployUrl
    })

    step('Generating secrets', () => {
      const listed = run('npx', ['wrangler', 'secret', 'list'], dir)
      // "Couldn't check" is NOT "doesn't exist": ENCRYPTION_KEY_V1 encrypts
      // stored calendar refresh tokens and SIGNING_KEY signs manage links —
      // regenerating either on a live install orphans both. If the list
      // fails, stop rather than guess.
      if (!listed.ok) fail(listed.output)
      const have = new Set<string>()
      for (const m of listed.output.matchAll(/"name":\s*"([A-Z0-9_]+)"/g)) have.add(m[1]!)
      for (const name of ['ENCRYPTION_KEY_V1', 'SIGNING_KEY']) {
        if (have.has(name)) continue
        const value = randomBytes(32).toString('base64')
        const child = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
          cwd: dir,
          input: value,
          encoding: 'utf8',
        })
        if (child.status !== 0) fail(`${child.stdout ?? ''}${child.stderr ?? ''}`)
      }
    })

    step('Pointing emailed links at the live URL', () => {
      const toml = readFileSync(tomlPath, 'utf8')
      if (!hasBaseUrlPlaceholder(toml)) return 'already configured'
      writeFileSync(tomlPath, patchBaseUrl(toml, deployUrl))
      const r = run('npx', ['wrangler', 'deploy'], dir)
      if (!r.ok) fail(r.output)
    })

    out.write(`\nYour Punctual is live: ${bold(deployUrl || 'see wrangler.toml BASE_URL', term)}\n\n`)
    out.write(`Next steps\n`)
    out.write(`  1. Open the URL and sign in with your email. Until you configure an email\n`)
    out.write(`     provider, sign-in links print to the Worker log: ${color('npx wrangler tail', 'green', term)}\n`)
    out.write(`  2. Connect Google or Microsoft calendars: ${dim('docs/self-hosting.md', term)} in ${dir}\n`)
    out.write(`  3. Set FROM_EMAIL and SUPPORT_EMAIL in wrangler.toml, then redeploy.\n`)
    return 0
  } catch {
    process.stdout.write(`\nRe-run ${bold('npx punctual-sh init', term)} to resume from this step.\n`)
    return 1
  }
}
