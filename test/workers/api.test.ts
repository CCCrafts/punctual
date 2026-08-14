/// <reference types="@cloudflare/vitest-pool-workers" />

/**
 * The REST API, the MCP server and the embed widget, under the real Workers
 * runtime (vitest.config.ts project `workers`).
 *
 * These cannot be plain-Node tests: the properties under test are the ones the
 * runtime owns. Idempotency is arbitrated by a real D1 batch against a real
 * unique index, and a fake `Repositories` that returned the same booking twice
 * would prove only that the fake was written to agree with the test.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { applyD1Migrations, env } from 'cloudflare:test'
import { Hono } from 'hono'
import { buildPorts, type Env } from '../../src/index.js'
import { createSlotService } from '../../src/engine.js'
import { buildApiRoutes } from '../../src/http/api/rest.js'
import { buildMcpRoutes } from '../../src/http/mcp/server.js'
import { buildEmbedRoutes, embedScript } from '../../src/http/embed.js'
import { createApiKey } from '../../src/core/domain/auth-flows.js'
import type { EnginePorts } from '../../src/ports.js'
import type { EventType, User } from '../../src/core/domain/types.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Deterministic key material. Test keys, never near a deployment. */
function keyMaterial(seed: number): string {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) & 0xff
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

/**
 * The real `migrations/` directory, not a copy.
 *
 * A hand-maintained schema in the test file is a schema that drifts, and the
 * drift shows up as a test suite that passes against a database no deployment
 * has. Idempotent, so it costs nothing that `test/workers/setup.ts` also runs
 * it — this file stays runnable on its own.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

function testPorts(): EnginePorts {
  return buildPorts({
    ...env,
    BASE_URL: 'https://punctual.test',
    ENCRYPTION_KEY_V1: keyMaterial(1),
    SIGNING_KEY: keyMaterial(9),
  } as Env)
}

/** The engine's own mounting: the API at /api/v1, MCP at /mcp, embed at the root. */
function buildApp(ports: EnginePorts): Hono {
  const slots = createSlotService(ports)
  const app = new Hono()
  app.route('/api/v1', buildApiRoutes(ports, slots))
  app.route('/mcp', buildMcpRoutes(ports, slots))
  app.route('/', buildEmbedRoutes(ports))
  return app
}

interface Seeded {
  user: User
  eventType: EventType
  /** The raw `pk_…` key, which exists only at creation (ADR-0005 §7). */
  apiKey: string
}

let seedCounter = 0

/**
 * A host who can actually be booked: availability, one event type, one key.
 *
 * Weekdays 09:00–17:00 UTC, so any window of a week contains bookable days
 * without the test having to know today's date.
 */
async function seedHost(ports: EnginePorts, scopes: string[] = ['*']): Promise<Seeded> {
  const n = ++seedCounter
  const repos = ports.repositories({ consistency: 'bookmark' })
  const user = await repos.users.create({
    id: `usr_test_${n}`,
    email: `host${n}@punctual.test`,
    name: 'Test Host',
    tz: 'UTC',
    slug: `host${n}`,
  })

  const workday = [{ startMinute: 9 * 60, endMinute: 17 * 60 }]
  await repos.availability.save(user.id, {
    userId: user.id,
    timezone: 'UTC',
    weekly: [[], workday, workday, workday, workday, workday, []],
    overrides: [],
  })

  const eventType = await repos.eventTypes.create({
    id: `evt_test_${n}`,
    ownerUserId: user.id,
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: '30min',
    title: 'Thirty minutes',
    description: 'A test event type',
    durationMinutes: 30,
    slotIntervalMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxHorizonDays: 60,
    maxPerDay: null,
    locationType: 'custom_link',
    locationValue: 'https://meet.punctual.test/room',
    questions: [],
    active: true,
  })

  const { raw } = await createApiKey(
    { repos, crypto: ports.crypto },
    { userId: user.id, name: 'test key', scopes, now: Date.now() },
  )

  return { user, eventType, apiKey: raw }
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A window starting tomorrow, so "now" never lands mid-slot or past notice. */
function nextWeek(): { from: string; to: string } {
  const from = Date.now() + DAY_MS
  return { from: String(from), to: String(from + 7 * DAY_MS) }
}

interface SlotJson {
  start: { iso: string; epochMs: number }
  end: { iso: string; epochMs: number }
  localDate: string
  localTime: string
  eligibleHostIds: string[]
}

async function firstSlot(app: Hono, key: string, eventTypeId: string): Promise<SlotJson> {
  const { from, to } = nextWeek()
  const res = await app.request(
    `/api/v1/slots?eventTypeId=${eventTypeId}&from=${from}&to=${to}`,
    { headers: auth(key) },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: SlotJson[] }
  expect(body.data.length).toBeGreaterThan(0)
  return body.data[0]!
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('API key authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const app = buildApp(testPorts())
    const res = await app.request('/api/v1/event-types')

    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe(401)
    expect(body['title']).toBe('Unauthorized')
  })

  it('rejects a malformed key without touching the database', async () => {
    const app = buildApp(testPorts())
    const res = await app.request('/api/v1/event-types', { headers: auth('not-a-key') })
    expect(res.status).toBe(401)
  })

  it('rejects a well-formed key that does not exist', async () => {
    const app = buildApp(testPorts())
    const res = await app.request('/api/v1/event-types', {
      headers: auth('pk_abcdefgh_deadbeefdeadbeefdeadbeef'),
    })
    expect(res.status).toBe(401)
  })

  it('refuses a write to a read-only key', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports, ['read'])

    const res = await app.request('/api/v1/event-types', {
      method: 'POST',
      headers: { ...auth(seed.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'nope', title: 'Nope', durationMinutes: 30 }),
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

describe('event types', () => {
  it('lists the key owner’s event types', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)

    const res = await app.request('/api/v1/event-types', { headers: auth(seed.apiKey) })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: Array<Record<string, unknown>> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]!['id']).toBe(seed.eventType.id)
    expect(body.data[0]!['url']).toBe(`https://punctual.test/${seed.user.slug}/30min`)
  })

  it('returns problem JSON with field errors on an invalid body', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)

    const res = await app.request('/api/v1/event-types', {
      method: 'POST',
      headers: { ...auth(seed.apiKey), 'content-type': 'application/json' },
      // 7 minutes cannot exist on the 5-minute bucket grid (ADR-0002 §1), and
      // the slug is not a slug.
      body: JSON.stringify({ slug: 'Not A Slug', title: '', durationMinutes: 7 }),
    })

    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = (await res.json()) as {
      type: string
      title: string
      status: number
      detail: string
      errors: Array<{ field: string; message: string }>
    }
    expect(body.type).toMatch(/^urn:punctual:problem:/)
    expect(body.title).toBe('Invalid request')
    expect(body.status).toBe(400)
    expect(typeof body.detail).toBe('string')
    expect(body.errors.map((e) => e.field).sort()).toEqual(['durationMinutes', 'slug', 'title'])
  })

  it('creates, patches and deletes on a bookmarked session', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)
    const headers = { ...auth(seed.apiKey), 'content-type': 'application/json' }

    const created = await app.request('/api/v1/event-types', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        slug: 'intro',
        title: 'Intro call',
        description: 'Fifteen minutes to say hello',
        durationMinutes: 15,
        bufferAfterMinutes: 10,
        minNoticeMinutes: 120,
      }),
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { data: { id: string } }

    const patched = await app.request(`/api/v1/event-types/${createdBody.data.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: 'Intro chat' }),
    })
    expect(patched.status).toBe(200)
    // The response is a read-after-write: it must show the stored row, not the
    // patch echoed back (ADR-0007 §2).
    const patchedBody = (await patched.json()) as {
      data: { title: string; description: string; bufferAfterMinutes: number; minNoticeMinutes: number }
    }
    expect(patchedBody.data.title).toBe('Intro chat')
    // A PATCH names what changes. Fields it does not name must survive it —
    // the failure mode being guarded is a schema whose absent keys quietly
    // materialise their defaults and wipe the host's settings.
    expect(patchedBody.data.description).toBe('Fifteen minutes to say hello')
    expect(patchedBody.data.bufferAfterMinutes).toBe(10)
    expect(patchedBody.data.minNoticeMinutes).toBe(120)

    const deleted = await app.request(`/api/v1/event-types/${createdBody.data.id}`, {
      method: 'DELETE',
      headers: auth(seed.apiKey),
    })
    expect(deleted.status).toBe(204)

    const gone = await app.request(`/api/v1/event-types/${createdBody.data.id}`, {
      headers: auth(seed.apiKey),
    })
    expect(gone.status).toBe(404)
  })

  it('answers 404 rather than 403 for someone else’s event type', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const mine = await seedHost(ports)
    const theirs = await seedHost(ports)

    const res = await app.request(`/api/v1/event-types/${theirs.eventType.id}`, {
      headers: auth(mine.apiKey),
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Availability and slots
// ---------------------------------------------------------------------------

describe('availability', () => {
  it('round-trips a weekly schedule', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)

    const put = await app.request('/api/v1/availability', {
      method: 'PUT',
      headers: { ...auth(seed.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({
        timezone: 'Europe/Kyiv',
        weekly: [[], [{ startMinute: 600, endMinute: 1080 }], [], [], [], [], []],
        overrides: [{ date: '2026-12-24', windows: [] }],
      }),
    })
    expect(put.status).toBe(200)

    const get = await app.request('/api/v1/availability', { headers: auth(seed.apiKey) })
    const body = (await get.json()) as { data: { timezone: string; weekly: unknown[][] } }
    expect(body.data.timezone).toBe('Europe/Kyiv')
    expect(body.data.weekly[1]).toHaveLength(1)
  })

  it('rejects an unknown timezone with problem JSON', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)

    const res = await app.request('/api/v1/availability', {
      method: 'PUT',
      headers: { ...auth(seed.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'Mars/Olympus', weekly: [[], [], [], [], [], [], []] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { errors: Array<{ field: string }> }
    expect(body.errors[0]!.field).toBe('timezone')
  })
})

describe('GET /slots', () => {
  it('returns bookable slots inside the host’s working hours', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)

    const { from, to } = nextWeek()
    const res = await app.request(
      `/api/v1/slots?eventTypeId=${seed.eventType.id}&from=${from}&to=${to}&tz=Europe/Berlin`,
      { headers: auth(seed.apiKey) },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: SlotJson[]; meta: { timezone: string } }
    expect(body.meta.timezone).toBe('Europe/Berlin')
    expect(body.data.length).toBeGreaterThan(0)

    const slot = body.data[0]!
    expect(slot.end.epochMs - slot.start.epochMs).toBe(30 * 60_000)
    expect(slot.eligibleHostIds).toEqual([seed.user.id])
    expect(new Date(slot.start.iso).getTime()).toBe(slot.start.epochMs)
  })

  it('refuses an unbounded range', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)

    const from = Date.now()
    const res = await app.request(
      `/api/v1/slots?eventTypeId=${seed.eventType.id}&from=${from}&to=${from + 400 * DAY_MS}`,
      { headers: auth(seed.apiKey) },
    )
    expect(res.status).toBe(400)
    expect((await res.json() as { title: string }).title).toBe('Range too large')
  })
})

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

describe('POST /bookings', () => {
  it('books a slot and lists it back', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)
    const slot = await firstSlot(app, seed.apiKey, seed.eventType.id)

    const res = await app.request('/api/v1/bookings', {
      method: 'POST',
      headers: { ...auth(seed.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({
        eventTypeId: seed.eventType.id,
        start: slot.start.iso,
        guestName: 'Ada Lovelace',
        guestEmail: 'ada@example.com',
        guestTimezone: 'Europe/London',
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { id: string; start: { epochMs: number }; status: string } }
    expect(body.data.status).toBe('confirmed')
    expect(body.data.start.epochMs).toBe(slot.start.epochMs)

    const { from, to } = nextWeek()
    const list = await app.request(`/api/v1/bookings?from=${from}&to=${to}`, { headers: auth(seed.apiKey) })
    const listBody = (await list.json()) as { data: Array<{ id: string }> }
    expect(listBody.data.map((b) => b.id)).toEqual([body.data.id])
  })

  it('returns the SAME booking for a repeated Idempotency-Key', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)
    const slot = await firstSlot(app, seed.apiKey, seed.eventType.id)

    const payload = JSON.stringify({
      eventTypeId: seed.eventType.id,
      start: slot.start.epochMs,
      guestName: 'Grace Hopper',
      guestEmail: 'grace@example.com',
    })
    const headers = {
      ...auth(seed.apiKey),
      'content-type': 'application/json',
      'idempotency-key': 'retry-me-once',
    }

    const first = await app.request('/api/v1/bookings', { method: 'POST', headers, body: payload })
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as { data: { id: string } }

    // The retry a flaky network produces: same key, same body. It must return
    // the original booking rather than a second meeting at the same time
    // (ADR-0002 §4) — and it must not 409 either, which is what a naive
    // "already locked" implementation would do.
    const second = await app.request('/api/v1/bookings', { method: 'POST', headers, body: payload })
    expect(second.status).toBe(201)
    const secondBody = (await second.json()) as { data: { id: string } }
    expect(secondBody.data.id).toBe(firstBody.data.id)

    const { from, to } = nextWeek()
    const list = await app.request(`/api/v1/bookings?from=${from}&to=${to}`, { headers: auth(seed.apiKey) })
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1)
  })

  it('409s when the slot is already taken by someone else', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)
    const slot = await firstSlot(app, seed.apiKey, seed.eventType.id)
    const headers = { ...auth(seed.apiKey), 'content-type': 'application/json' }

    const body = (guest: string) =>
      JSON.stringify({
        eventTypeId: seed.eventType.id,
        start: slot.start.epochMs,
        guestName: guest,
        guestEmail: `${guest}@example.com`,
      })

    expect((await app.request('/api/v1/bookings', { method: 'POST', headers, body: body('first') })).status).toBe(201)

    const clash = await app.request('/api/v1/bookings', { method: 'POST', headers, body: body('second') })
    expect(clash.status).toBe(409)
    expect(clash.headers.get('content-type')).toContain('application/problem+json')
  })

  it('cancels a booking and frees its time', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)
    const slot = await firstSlot(app, seed.apiKey, seed.eventType.id)
    const headers = { ...auth(seed.apiKey), 'content-type': 'application/json' }

    const created = await app.request('/api/v1/bookings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        eventTypeId: seed.eventType.id,
        start: slot.start.epochMs,
        guestName: 'Ada',
        guestEmail: 'ada@example.com',
      }),
    })
    const id = ((await created.json()) as { data: { id: string } }).data.id

    const cancelled = await app.request(`/api/v1/bookings/${id}/cancel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'Something came up' }),
    })
    expect(cancelled.status).toBe(200)
    expect(((await cancelled.json()) as { data: { status: string } }).data.status).toBe('cancelled')

    // Cancelling releases the slot_locks rows in the same batch, so the time is
    // immediately offered again.
    const again = await firstSlot(app, seed.apiKey, seed.eventType.id)
    expect(again.start.epochMs).toBe(slot.start.epochMs)

    const twice = await app.request(`/api/v1/bookings/${id}/cancel`, { method: 'POST', headers, body: '{}' })
    expect(twice.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

describe('webhooks', () => {
  it('returns the signing secret exactly once', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)
    const headers = { ...auth(seed.apiKey), 'content-type': 'application/json' }

    const created = await app.request('/api/v1/webhooks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://hooks.example.com/punctual', events: ['booking.created'] }),
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { data: { id: string; secret?: string } }
    expect(body.data.secret).toBeTruthy()

    const listed = await app.request('/api/v1/webhooks', { headers: auth(seed.apiKey) })
    const list = (await listed.json()) as { data: Array<{ id: string; secret?: string }> }
    expect(list.data).toHaveLength(1)
    expect(list.data[0]!.secret).toBeUndefined()
  })

  it('refuses a plain http endpoint', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)

    const res = await app.request('/api/v1/webhooks', {
      method: 'POST',
      headers: { ...auth(seed.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://hooks.example.com/punctual', events: ['booking.created'] }),
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

interface RpcResponse {
  jsonrpc: string
  id: number | string | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

async function rpc(
  app: Hono,
  key: string | null,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; body: RpcResponse }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? auth(key) : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  })
  return { status: res.status, body: (await res.json()) as RpcResponse }
}

describe('MCP server', () => {
  it('requires an API key, as a JSON-RPC error', async () => {
    const app = buildApp(testPorts())
    const { status, body } = await rpc(app, null, 'initialize', { protocolVersion: '2025-06-18' })
    expect(status).toBe(401)
    expect(body.error?.code).toBe(-32001)
  })

  it('negotiates the protocol version and advertises tools', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)

    const init = await rpc(app, seed.apiKey, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.status).toBe(200)
    // The client asked for a version we speak, so it is echoed rather than
    // silently upgraded.
    expect(init.body.result?.['protocolVersion']).toBe('2025-06-18')
    expect(init.body.result?.['serverInfo']).toMatchObject({ name: 'punctual' })

    const list = await rpc(app, seed.apiKey, 'tools/list')
    const tools = list.body.result?.['tools'] as Array<{ name: string; inputSchema: { required?: string[] } }>
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_booking',
      'create_booking',
      'get_available_slots',
      'list_event_types',
      'reschedule_booking',
    ])
    expect(tools.find((t) => t.name === 'create_booking')!.inputSchema.required).toContain('start')
  })

  it('hides write tools from a read-only key', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports, ['read'])

    const list = await rpc(app, seed.apiKey, 'tools/list')
    const tools = list.body.result?.['tools'] as Array<{ name: string }>
    expect(tools.map((t) => t.name).sort()).toEqual(['get_available_slots', 'list_event_types'])

    const denied = await rpc(app, seed.apiKey, 'tools/call', {
      name: 'cancel_booking',
      arguments: { bookingId: 'anything' },
    })
    expect(denied.status).toBe(403)
    expect(denied.body.error?.code).toBe(-32003)
  })

  it('runs the slot and booking tools end to end', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)

    const slots = await rpc(app, seed.apiKey, 'tools/call', {
      name: 'get_available_slots',
      arguments: { eventTypeId: seed.eventType.id, from: Date.now() + DAY_MS, limit: 5 },
    })
    const content = slots.body.result?.['content'] as Array<{ type: string; text: string }>
    expect(content[0]!.type).toBe('text')
    const payload = JSON.parse(content[0]!.text) as { slots: Array<{ start: string }> }
    expect(payload.slots.length).toBeGreaterThan(0)

    const booked = await rpc(app, seed.apiKey, 'tools/call', {
      name: 'create_booking',
      arguments: {
        eventTypeId: seed.eventType.id,
        start: payload.slots[0]!.start,
        guestName: 'Agent Guest',
        guestEmail: 'agent@example.com',
      },
    })
    expect(booked.body.result?.['isError']).toBeUndefined()
    const bookedText = JSON.parse((booked.body.result?.['content'] as Array<{ text: string }>)[0]!.text) as {
      booked: boolean
      bookingId: string
    }
    expect(bookedText.booked).toBe(true)

    // The same slot again is a refusal the MODEL must handle, so it arrives as
    // an isError result rather than a protocol error.
    const clash = await rpc(app, seed.apiKey, 'tools/call', {
      name: 'create_booking',
      arguments: {
        eventTypeId: seed.eventType.id,
        start: payload.slots[0]!.start,
        guestName: 'Second Guest',
        guestEmail: 'second@example.com',
      },
    })
    expect(clash.body.result?.['isError']).toBe(true)

    const cancelled = await rpc(app, seed.apiKey, 'tools/call', {
      name: 'cancel_booking',
      arguments: { bookingId: bookedText.bookingId },
    })
    expect(cancelled.body.result?.['isError']).toBeUndefined()
  })

  it('reports protocol faults with JSON-RPC error codes', async () => {
    const ports = testPorts()
    const app = buildApp(ports)
    const seed = await seedHost(ports)

    const unknown = await rpc(app, seed.apiKey, 'tools/call', { name: 'delete_everything', arguments: {} })
    expect(unknown.body.error?.code).toBe(-32601)

    const badArgs = await rpc(app, seed.apiKey, 'tools/call', {
      name: 'get_available_slots',
      arguments: { eventTypeId: seed.eventType.id, timezone: 'Mars/Olympus' },
    })
    expect(badArgs.body.error?.code).toBe(-32602)

    const badMethod = await rpc(app, seed.apiKey, 'resources/list')
    expect(badMethod.body.error?.code).toBe(-32601)

    const notification = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(seed.apiKey) },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(notification.status).toBe(202)
  })
})

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

describe('embed widget', () => {
  it('serves a script under the 2 KB budget', async () => {
    const app = buildApp(testPorts())
    const res = await app.request('/embed.js')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    const body = await res.text()
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(2048)
    expect(body).toContain('punctual.test')
    expect(body).toContain('createElement')
  })

  it('embeds the configured origin rather than a relative URL', () => {
    // A relative src would resolve against the CUSTOMER's origin, which is the
    // one failure mode of this widget that looks fine in local development.
    expect(embedScript('https://punctual.test/')).toContain('"https://punctual.test"')
  })
})
