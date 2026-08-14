/**
 * Workers-project test setup.
 *
 * Applies the real migrations to the isolated per-test D1 before anything
 * runs, so tests exercise the schema that actually ships rather than a
 * hand-maintained copy that drifts away from `migrations/`.
 */

import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
