/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('probe', () => {
  it('has DB', async () => {
    const db = (env as unknown as { DB: D1Database }).DB
    await db.exec('CREATE TABLE IF NOT EXISTS probe (id TEXT)')
    expect(db).toBeTruthy()
  })
})
