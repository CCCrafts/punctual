/// <reference types="@cloudflare/vitest-pool-workers/types" />
declare module '*.sql?raw' {
  const content: string
  export default content
}
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import schema from '../../migrations/0001_initial.sql?raw'

describe('probe', () => {
  it('applies schema', async () => {
    expect(typeof schema).toBe('string')
    expect(env).toBeTruthy()
  })
})
