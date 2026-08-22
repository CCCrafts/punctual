import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  classifyLookup,
  commentOutQueues,
  findD1IdInList,
  findKvIdInList,
  hasBaseUrlPlaceholder,
  hasD1Placeholder,
  hasKvPlaceholder,
  isPunctualToml,
  isQueuePlanLimited,
  parseAccountIds,
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

describe('half-finished-run recovery', () => {
  it('finds an already-created D1 database by name in `d1 list --json`', () => {
    const json = JSON.stringify([
      { name: 'other-db', uuid: '99999999-9999-9999-9999-999999999999' },
      { name: 'punctual', uuid: 'f8254c85-0fb2-4fea-b604-e20486799be6' },
    ])
    expect(findD1IdInList(json, 'punctual')).toBe('f8254c85-0fb2-4fea-b604-e20486799be6')
    expect(findD1IdInList(json, 'missing')).toBeNull()
    expect(findD1IdInList('not json', 'punctual')).toBeNull()
  })

  it('finds the cache namespace by its exact titles only — never a suffix match on someone else\'s', () => {
    const json = JSON.stringify([
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'punctual-CACHE' },
      { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'blog-CACHE' },
    ])
    expect(findKvIdInList(json, 'CACHE')).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(findKvIdInList(JSON.stringify([{ id: 'cc', title: 'CACHE' }]), 'CACHE')).toBe('cc')
    expect(findKvIdInList(JSON.stringify([{ id: 'bb', title: 'blog-CACHE' }]), 'CACHE')).toBeNull()
  })
})

describe('parseAccountIds', () => {
  it('normalises whoami output to a stable account fingerprint', () => {
    const output = `┌─────────────┬──────────────────────────────────┐
│ Account     │ 7538f7fc7c28e0d52b013f2b2945b6f1 │
│ Second      │ 00000000000000000000000000000abc │
└─────────────┴──────────────────────────────────┘`
    expect(parseAccountIds(output)).toBe('00000000000000000000000000000abc,7538f7fc7c28e0d52b013f2b2945b6f1')
    // Order and duplicates don't change the fingerprint.
    expect(parseAccountIds(`${output}\n7538f7fc7c28e0d52b013f2b2945b6f1`)).toBe(
      '00000000000000000000000000000abc,7538f7fc7c28e0d52b013f2b2945b6f1',
    )
    expect(parseAccountIds('You are not authenticated')).toBe('')
  })
})

describe('resume-target guard', () => {
  it('accepts the real template and rejects an unrelated Worker toml', () => {
    expect(isPunctualToml(template)).toBe(true)
    expect(isPunctualToml('name = "my-api"\nmain = "src/index.ts"')).toBe(false)
  })
})

describe('worker-lookup classification (fail closed)', () => {
  it('an explicit not-found is the ONLY output that reads as clear', () => {
    expect(classifyLookup(false, 'X [code: 10007] workers.api.error.service_not_found')).toBe('clear')
    expect(classifyLookup(false, 'Worker not found')).toBe('clear')
  })

  it('a successful listing means the name is taken', () => {
    expect(classifyLookup(true, 'Created: 2026-08-01 Version: abc')).toBe('exists')
  })

  it('any other failure is unknown — never treated as a free name', () => {
    expect(classifyLookup(false, 'fetch failed: socket hang up')).toBe('unknown')
    expect(classifyLookup(false, 'Too many requests [code: 10429]')).toBe('unknown')
  })
})

describe('queue-failure classification', () => {
  it('a plan limitation disables queues; a transient error must surface and retry', () => {
    expect(isQueuePlanLimited('Queues is not available on the free plan [code: 10023]')).toBe(true)
    expect(isQueuePlanLimited('please upgrade to a paid plan')).toBe(true)
    expect(isQueuePlanLimited('fetch failed: socket hang up')).toBe(false)
    expect(isQueuePlanLimited('Internal error occurred [code: 10013]')).toBe(false)
  })
})
