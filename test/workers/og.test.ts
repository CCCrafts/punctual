/**
 * `GET /og/:userSlug/:eventSlug.png`, under the real Workers
 * runtime — the part that cannot be checked by reading the code: satori and
 * resvg-wasm actually instantiate and produce real PNG bytes under workerd,
 * not just under Node.
 */

import { env, createExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

async function seedHost(opts: { id: string; slug: string; name: string; eventSlug: string }): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)').bind(
      opts.id,
      `${opts.id}@example.com`,
      opts.name,
      'Europe/Kyiv',
      opts.slug,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO event_types
       (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
        slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
        max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      `et_${opts.id}`,
      opts.id,
      null,
      'personal',
      opts.eventSlug,
      '30 min call',
      '',
      30,
      null,
      0,
      0,
      0,
      60,
      null,
      'google_meet',
      null,
      '[]',
      1,
      now,
    ),
  ])
}

async function getOg(path: string): Promise<Response> {
  const { default: worker } = await import('../../src/index.js')
  return worker.fetch(new Request(`https://punctual.test${path}`), env, createExecutionContext())
}

describe('the dynamic OG card', () => {
  it('renders a real PNG for an ordinary host and event, and caches it', async () => {
    await seedHost({ id: 'usr_og_a', slug: 'og-host-a', name: 'Serge', eventSlug: 'thirty' })

    const res = await getOg('/og/og-host-a/thirty.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')

    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.slice(0, 4))).toEqual(PNG_MAGIC)

    // Cached under the documented key/prefix (route.ts, ADR-0006 §1 split) —
    // a second request must not need to re-render.
    // The key is the page plus a hash of the host/avatar list (KV caps keys at 512 bytes).
    const keys = (await env.CACHE.list({ prefix: 'og:v2:og-host-a:thirty:' })).keys
    expect(keys).toHaveLength(1)
    expect(keys[0]!.name.length).toBeLessThan(200)
  })

  it('a collective with long names still gets a real card: first names, then a count, then the team', async () => {
    const now = Date.now()
    const ids = ['usr_og_l1', 'usr_og_l2', 'usr_og_l3']
    const names = ['Alexandra Konstantinova', 'Bartholomew Fitzgerald', 'Christabel Montgomery']
    await env.DB.batch([
      ...ids.map((id, i) =>
        env.DB.prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)').bind(id, `${id}@example.com`, names[i], 'UTC', id.replace('usr_', ''), now),
      ),
      env.DB.prepare('INSERT INTO teams (id,name,slug,logo_key,created_at) VALUES (?,?,?,?,?)').bind('team_og_long', 'Long Names', 'og-long', null, now),
      ...ids.map((id) => env.DB.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind('team_og_long', id, 'member', 1)),
      env.DB.prepare(
        `INSERT INTO event_types (id,owner_user_id,owner_team_id,scheduling_type,slug,title,duration_minutes,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind('et_og_long', null, 'team_og_long', 'collective', 'long', 'Long call', 30, now),
    ])
    const res = await getOg('/og/og-long/long.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('renders a team card naming the hosts, and one with a real avatar', async () => {
    const now = Date.now()
    // A 1x1 PNG — photon decodes it, so the thumbnail path is exercised for real.
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0))
    const key = `${'a'.repeat(64)}-thumb.webp`
    await env.AVATARS.put(key, png, { httpMetadata: { contentType: 'image/webp' } })
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id,email,name,tz,slug,avatar_key,created_at) VALUES (?,?,?,?,?,?,?)').bind('usr_og_t1', 'og-t1@example.com', 'Alice Host', 'UTC', 'og-alice', key, now),
      env.DB.prepare('INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)').bind('usr_og_t2', 'og-t2@example.com', 'Bob Host', 'UTC', 'og-bob', now),
      env.DB.prepare('INSERT INTO teams (id,name,slug,logo_key,created_at) VALUES (?,?,?,?,?)').bind('team_og', 'OG Crew', 'og-crew', null, now),
      env.DB.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind('team_og', 'usr_og_t1', 'admin', 1),
      env.DB.prepare('INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)').bind('team_og', 'usr_og_t2', 'member', 1),
      env.DB.prepare(
        `INSERT INTO event_types (id,owner_user_id,owner_team_id,scheduling_type,slug,title,duration_minutes,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind('et_og_team', null, 'team_og', 'collective', 'crew', 'Crew call', 30, now),
    ])

    const res = await getOg('/og/og-crew/crew.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.slice(0, 4))).toEqual(PNG_MAGIC)
    // The key hashes both hosts and Alice's avatar, so a new photo is a new card.
    const before = (await env.CACHE.list({ prefix: 'og:v2:og-crew:crew:' })).keys.map((k) => k.name)
    expect(before).toHaveLength(1)
    await env.DB.prepare('UPDATE users SET avatar_key = NULL WHERE id = ?').bind('usr_og_t1').run()
    expect((await getOg('/og/og-crew/crew.png')).status).toBe(200)
    const after = (await env.CACHE.list({ prefix: 'og:v2:og-crew:crew:' })).keys.map((k) => k.name)
    expect(after).toHaveLength(2)
    expect(after).toContain(before[0])
  })

  it('falls back to the static default card when the host name is not safely renderable', async () => {
    // Emoji: outside the printable-ASCII subset render.ts requires — the
    // exact case the OG card work calls out (also covers RTL/CJK/unusual-length by
    // the same guard).
    await seedHost({ id: 'usr_og_b', slug: 'og-host-b', name: '👋 Serge', eventSlug: 'thirty' })

    const res = await getOg('/og/og-host-b/thirty.png')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/og/default.png')

    // A failed render must never be cached under the real key — otherwise a
    // later fix to the renderer would stay masked by a stale fallback.
    const cached = await env.CACHE.get('og:v1:og-host-b:thirty', 'arrayBuffer')
    expect(cached).toBeNull()
  })

  it('404s for a booking page that does not exist', async () => {
    const res = await getOg('/og/nobody/nothing.png')
    expect(res.status).toBe(404)
  })

  it('joins concurrent requests for the same uncached card onto one render', async () => {
    // A freshly-shared link gets unfurled by several platforms within the
    // same second, all racing an empty cache — every one of them must still
    // get a valid PNG back, not just the request that wins the render.
    await seedHost({ id: 'usr_og_d', slug: 'og-host-d', name: 'Grace', eventSlug: 'sync' })

    const [a, b, c] = await Promise.all([
      getOg('/og/og-host-d/sync.png'),
      getOg('/og/og-host-d/sync.png'),
      getOg('/og/og-host-d/sync.png'),
    ])
    for (const res of [a, b, c]) {
      expect(res.status).toBe(200)
      const bytes = new Uint8Array(await res.arrayBuffer())
      expect(Array.from(bytes.slice(0, 4))).toEqual(PNG_MAGIC)
    }
  })

  it('the booking page itself links to the dynamic card, not the static default', async () => {
    await seedHost({ id: 'usr_og_c', slug: 'og-host-c', name: 'Ada', eventSlug: 'intro' })

    const res = await getOg('/og-host-c/intro')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('/og/og-host-c/intro.png')
    expect(html).not.toContain('/og/default.png')
  })
})
