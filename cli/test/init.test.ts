import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  commentOutQueues,
  hasBaseUrlPlaceholder,
  hasD1Placeholder,
  hasKvPlaceholder,
  parseD1Id,
  parseDeployUrl,
  parseKvId,
  patchBaseUrl,
  patchD1Id,
  patchKvId,
} from '../src/init.js'

// The REAL template this CLI patches — if the engine's wrangler.toml drifts
// from what these regexes expect, this file fails before a user ever does.
const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wrangler.toml'), 'utf8')

describe('against the engine wrangler.toml template', () => {
  it('recognises all three placeholders in the shipped template', () => {
    expect(hasD1Placeholder(template)).toBe(true)
    expect(hasKvPlaceholder(template)).toBe(true)
    expect(hasBaseUrlPlaceholder(template)).toBe(true)
  })

  it('patches the D1 id without touching the KV id line', () => {
    const patched = patchD1Id(template, '11111111-2222-3333-4444-555555555555')
    expect(patched).toContain('database_id = "11111111-2222-3333-4444-555555555555"')
    expect(hasKvPlaceholder(patched)).toBe(true)
    expect(hasD1Placeholder(patched)).toBe(false)
  })

  it('patches the KV id without touching the D1 line', () => {
    const patched = patchKvId(template, 'abcdefabcdefabcdefabcdefabcdefab')
    expect(patched).toContain('id = "abcdefabcdefabcdefabcdefabcdefab"')
    expect(hasD1Placeholder(patched)).toBe(true)
    expect(hasKvPlaceholder(patched)).toBe(false)
  })

  it('patches BASE_URL and leaves the other vars alone', () => {
    const patched = patchBaseUrl(template, 'https://punctual.example.workers.dev')
    expect(patched).toContain('BASE_URL = "https://punctual.example.workers.dev"')
    expect(patched).toContain('BRAND_NAME = "Punctual"')
    expect(hasBaseUrlPlaceholder(patched)).toBe(false)
  })

  it('comments out both queues blocks and nothing else', () => {
    const patched = commentOutQueues(template)
    expect(patched).not.toMatch(/^\[\[queues\.producers\]\]/m)
    expect(patched).not.toMatch(/^binding = "TASKS"/m)
    expect(patched).toMatch(/^# \[\[queues\.producers\]\]/m)
    expect(patched).toMatch(/^# \[\[queues\.consumers\]\]/m)
    // Neighbouring blocks stay live.
    expect(patched).toMatch(/^\[triggers\]/m)
    expect(patched).toMatch(/^\[\[r2_buckets\]\]/m)
    expect(patched).toMatch(/^\[vars\]/m)
  })
})

describe('wrangler output parsing', () => {
  it('finds the database id in a d1 create config snippet', () => {
    const output = `✅ Successfully created DB 'punctual'

[[d1_databases]]
binding = "DB"
database_name = "punctual"
database_id = "f8254c85-0fb2-4fea-b604-e20486799be6"
`
    expect(parseD1Id(output)).toBe('f8254c85-0fb2-4fea-b604-e20486799be6')
  })

  it('finds the namespace id in kv namespace create output (toml and json forms)', () => {
    expect(parseKvId('id = "78f8466dbace4d908d61cecff5f3ae58"')).toBe('78f8466dbace4d908d61cecff5f3ae58')
    expect(parseKvId('{ "id": "78f8466dbace4d908d61cecff5f3ae58" }')).toBe('78f8466dbace4d908d61cecff5f3ae58')
  })

  it('finds the workers.dev URL in deploy output', () => {
    const output = `Uploaded punctual (3.2 sec)
Deployed punctual triggers (1.1 sec)
  https://punctual.someone.workers.dev
Current Version ID: aaa`
    expect(parseDeployUrl(output)).toBe('https://punctual.someone.workers.dev')
  })

  it('returns null rather than guessing when the output has no id', () => {
    expect(parseD1Id('error: not authorized')).toBeNull()
    expect(parseKvId('error')).toBeNull()
    expect(parseDeployUrl('error')).toBeNull()
  })
})
