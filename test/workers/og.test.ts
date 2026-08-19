/**
 * `GET /og/:userSlug/:eventSlug.png` (CCC-496), under the real Workers
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
    const cached = await env.CACHE.get('og:v1:og-host-a:thirty', 'arrayBuffer')
    expect(cached).not.toBeNull()
  })

  it('falls back to the static default card when the host name is not safely renderable', async () => {
    // Emoji: outside the printable-ASCII subset render.ts requires — the
    // exact case CCC-496 calls out (also covers RTL/CJK/unusual-length by
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

  it('the booking page itself links to the dynamic card, not the static default', async () => {
    await seedHost({ id: 'usr_og_c', slug: 'og-host-c', name: 'Ada', eventSlug: 'intro' })

    const res = await getOg('/og-host-c/intro')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('/og/og-host-c/intro.png')
    expect(html).not.toContain('/og/default.png')
  })
})
