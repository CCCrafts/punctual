declare module 'cloudflare:test' {
  import type { D1Migration } from '@cloudflare/vitest-pool-workers'
  import type { Env as WorkerEnv } from '../../src/index.js'

  interface ProvidedEnv extends WorkerEnv {
    TEST_MIGRATIONS: D1Migration[]
  }
}
