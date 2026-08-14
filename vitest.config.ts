import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Migrations are read at config time and handed to the pool, so every
// Workers-project test can call `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`
// against the real schema rather than a hand-maintained copy that drifts.
const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))

// Two projects on purpose (ADR-0003 §5):
//   core    — pure domain, zero Cloudflare imports, plain Node. Milliseconds,
//             which is what lets the DST matrix in ADR-0004 stay exhaustive.
//   workers — adapters, DO and HTTP, under the real Workers runtime.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          include: ['test/core/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.toml' },
            miniflare: {
              bindings: { TEST_MIGRATIONS: migrations },
            },
          }),
        ],
        test: {
          name: 'workers',
          include: ['test/workers/**/*.test.ts'],
          setupFiles: ['./test/workers/setup.ts'],
        },
      },
    ],
  },
})
