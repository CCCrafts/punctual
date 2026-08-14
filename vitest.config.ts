import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

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
          }),
        ],
        test: {
          name: 'workers',
          include: ['test/workers/**/*.test.ts'],
        },
      },
    ],
  },
})
