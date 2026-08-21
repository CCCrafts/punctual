/**
 * `Team.logoKey` and `TeamRepository.updateLogo` — the storage
 * layer for team logos, kept tested even though no dashboard route calls it
 * yet (see the doc comment on `updateLogo` in `ports.ts`: team self-service
 * management has no UI at all today, so wiring an upload page ahead of it
 * would have nowhere real to live).
 */

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'

const db = env.DB
const scope = { consistency: 'bookmark' as const }

describe('TeamRepository.logoKey', () => {
  it('is null on a freshly created team', async () => {
    const repos = createD1Repositories(db, scope)
    const team = await repos.teams.create({
      id: 'team_logo_1',
      name: 'Logo Test Team',
      slug: 'logo-test-team',
      logoKey: null,
    })
    expect(team).not.toBeNull()
    expect(team?.logoKey).toBeNull()

    const fetched = await repos.teams.byId('team_logo_1')
    expect(fetched?.logoKey).toBeNull()
  })

  it('updateLogo sets it, and leaves name/slug untouched', async () => {
    const repos = createD1Repositories(db, scope)
    await repos.teams.create({
      id: 'team_logo_2',
      name: 'Another Team',
      slug: 'another-team',
      logoKey: null,
    })

    await repos.teams.updateLogo('team_logo_2', 'a'.repeat(64) + '-thumb.webp')

    const fetched = await repos.teams.byId('team_logo_2')
    expect(fetched?.logoKey).toBe('a'.repeat(64) + '-thumb.webp')
    expect(fetched?.name).toBe('Another Team')
    expect(fetched?.slug).toBe('another-team')
  })

  it('updateLogo(null) clears it', async () => {
    const repos = createD1Repositories(db, scope)
    await repos.teams.create({
      id: 'team_logo_3',
      name: 'Third Team',
      slug: 'third-team',
      logoKey: 'b'.repeat(64) + '-thumb.webp',
    })

    await repos.teams.updateLogo('team_logo_3', null)

    const fetched = await repos.teams.byId('team_logo_3')
    expect(fetched?.logoKey).toBeNull()
  })
})
