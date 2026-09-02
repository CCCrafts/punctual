/**
 * The MCP server (spec §5.1), mounted at `/mcp`.
 *
 * Streamable HTTP, JSON-RPC 2.0 over a single POST. No SSE stream and no
 * session id: every method here is a request/response pair the server can
 * answer immediately, so a stream would add reconnection semantics to protect
 * nothing. GET and DELETE therefore answer 405, which the transport spec
 * explicitly allows for a server that offers neither.
 *
 * **Authority.** The agent's authority is exactly its API key's — the same
 * `authenticateApiRequest` the REST API uses, the same scopes. A second
 * authentication path would eventually disagree with the first, and the one
 * that drifts is the one nobody reads. An agent can therefore do nothing to a
 * calendar that the key's owner could not do themselves, which is the property
 * worth being able to state plainly.
 *
 * **Consistency (ADR-0007 §2).** The mode is chosen from the tool being
 * called, before authentication, so a booking runs bookmarked (read its own
 * write) while a slot listing reads the nearest replica. Listing stale slots is
 * safe here for the same reason it is safe on the booking page: `slot_locks`
 * arbitrates at commit, so the worst case is a `slot_taken` the agent can
 * recover from by picking another time.
 *
 * **Errors.** Malformed protocol → JSON-RPC error. A tool that ran and refused
 * — slot taken, unknown booking — → `isError: true` with a readable message,
 * because that is the outcome the model must reason about rather than a
 * transport failure.
 */

import { Hono } from 'hono'
import { isValidEmail } from '../../core/domain/booking-service.js'
import { notifyBookingCancelled } from '../../adapters/notify.js'
import { dispatchConfirmation } from '../../adapters/queue/consumer.js'
import { z } from 'zod'
import type { EnginePorts, RequestScope } from '../../ports.js'
import type { SlotService } from '../../engine.js'
import type { Booking, EventType, User } from '../../core/domain/types.js'
import { effectiveQuestions, pickDeclaredAnswers, validateAnswers } from '../../core/domain/booking-service.js'
import { formatInZone, isValidTimeZone, localDateString } from '../../core/time/zone.js'
import { resolveHosts as resolveEventTypeHosts } from '../../core/domain/hosts.js'
import {
  API_SCOPE_READ,
  API_SCOPE_WRITE,
  MAX_SLOT_RANGE_MS,
  authenticateApiRequest,
  hasScope,
  ownsEventType,
  isHost,
  resolveHosts,
  toInstant,
  type ApiAuth,
} from '../api/rest.js'

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/**
 * Versions we speak, newest first.
 *
 * The handshake echoes the client's version when we know it and answers with
 * our newest when we do not — a client that asked for something older and gets
 * our latest back is expected to disconnect rather than guess.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

/** Absent `MCP-Protocol-Version` means the pre-header revision, per the transport spec. */
const ASSUMED_PROTOCOL_VERSION = '2025-03-26'

const SERVER_INFO = { name: 'punctual', title: 'Punctual scheduling', version: '0.1.0' }

/**
 * Shown to the model once, at connect time. Two facts it cannot infer and will
 * otherwise get wrong: slot starts are not free-form, and times are instants.
 */
const INSTRUCTIONS = [
  'Punctual is a scheduling engine. Use list_event_types to find what can be booked,',
  'get_available_slots to see when, then create_booking with a `start` copied exactly',
  'from a slot — an arbitrary time will be refused even if it looks free.',
  'All times are UTC instants; a timezone parameter only affects how they are rendered.',
].join(' ')

// JSON-RPC 2.0 reserved codes, plus two of our own above the reserved range.
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const UNAUTHORIZED = -32001
const RATE_LIMITED = -32002
const INSUFFICIENT_SCOPE = -32003

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  /** Hints, not enforcement — the scope check below is the enforcement. */
  annotations: {
    readOnlyHint: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint: boolean
  }
  /** Which API-key scope the caller must hold. */
  scope: typeof API_SCOPE_READ | typeof API_SCOPE_WRITE
}

const ISO_HINT = 'ISO-8601 with an explicit offset, e.g. "2026-08-20T14:30:00Z", or epoch milliseconds as a number.'

const TOOLS: ToolDefinition[] = [
  {
    name: 'list_event_types',
    title: 'List event types',
    description:
      'List the bookable event types owned by the API key holder — id, title, duration, and public booking URL. Start here: every other tool needs an eventTypeId from this list.',
    inputSchema: {
      type: 'object',
      properties: {
        includeInactive: {
          type: 'boolean',
          description: 'Include event types that are switched off and cannot currently be booked. Defaults to false.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    scope: API_SCOPE_READ,
  },
  {
    name: 'get_available_slots',
    title: 'Get available slots',
    description:
      'List bookable start times for an event type in a window. Each slot is a UTC instant plus a rendering in the requested timezone. A slot is advisory until booked — it can be taken by someone else in the meantime, so create_booking may still refuse it.',
    inputSchema: {
      type: 'object',
      properties: {
        eventTypeId: { type: 'string', description: 'The `id` of an event type from list_event_types.' },
        from: { type: 'string', description: `Start of the search window. ${ISO_HINT} Defaults to now.` },
        to: {
          type: 'string',
          description: `End of the search window, exclusive. ${ISO_HINT} Defaults to 7 days after \`from\`; at most 62 days after it.`,
        },
        timezone: {
          type: 'string',
          description:
            'IANA timezone name used to render `localDate` and `localTime`, e.g. "Europe/Berlin" or "America/New_York". Does not change which slots exist. Defaults to the host\'s timezone.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of slots to return, 1–200. Defaults to 50, earliest first.',
          minimum: 1,
          maximum: 200,
        },
      },
      required: ['eventTypeId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    scope: API_SCOPE_READ,
  },
  {
    name: 'create_booking',
    title: 'Create a booking',
    description:
      'Book a slot for a guest. `start` must be exactly a slot start returned by get_available_slots. Returns the confirmed booking, or an error saying the time was taken — in which case call get_available_slots again and pick another.',
    inputSchema: {
      type: 'object',
      properties: {
        eventTypeId: { type: 'string', description: 'The `id` of an event type from list_event_types.' },
        start: { type: 'string', description: `The slot start, copied from get_available_slots. ${ISO_HINT}` },
        guestName: { type: 'string', description: "The guest's full name, as it should appear on the invitation." },
        guestEmail: { type: 'string', description: "The guest's email address. The confirmation and calendar invite go here." },
        guestTimezone: {
          type: 'string',
          description: 'IANA timezone name the guest lives in, e.g. "Asia/Tokyo". Used to render their confirmation email. Defaults to the host\'s timezone.',
        },
        answers: {
          type: 'object',
          description:
            'Answers to the event type\'s intake questions, keyed by question `id` as returned in `questions`. Required questions must be present and non-empty.',
          additionalProperties: { type: 'string' },
        },
        idempotencyKey: {
          type: 'string',
          description:
            'Optional. Pass the SAME value when retrying a call you are unsure completed: the retry returns the original booking instead of creating a second one.',
        },
      },
      required: ['eventTypeId', 'start', 'guestName', 'guestEmail'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scope: API_SCOPE_WRITE,
  },
  {
    name: 'reschedule_booking',
    title: 'Reschedule a booking',
    description:
      'Move a confirmed booking to a new time. The new time must be a slot start from get_available_slots. The original booking is marked rescheduled and a new booking id is returned; links in the guest\'s earlier email stop working.',
    inputSchema: {
      type: 'object',
      properties: {
        bookingId: { type: 'string', description: 'The `id` of the booking to move.' },
        newStart: { type: 'string', description: `The new slot start, copied from get_available_slots. ${ISO_HINT}` },
        reason: { type: 'string', description: 'Optional short reason, included in the notification to the guest.' },
      },
      required: ['bookingId', 'newStart'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    scope: API_SCOPE_WRITE,
  },
  {
    name: 'cancel_booking',
    title: 'Cancel a booking',
    description:
      'Cancel a confirmed booking, free its time, and notify the guest. Cannot be undone — book a new time instead of un-cancelling.',
    inputSchema: {
      type: 'object',
      properties: {
        bookingId: { type: 'string', description: 'The `id` of the booking to cancel.' },
        reason: { type: 'string', description: 'Optional short reason, included in the notification to the guest.' },
      },
      required: ['bookingId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scope: API_SCOPE_WRITE,
  },
]

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

const instantArg = z.union([z.string(), z.number()])

const listEventTypesArgs = z.object({ includeInactive: z.boolean().default(false) })

const getSlotsArgs = z.object({
  eventTypeId: z.string().min(1).max(128),
  from: instantArg.optional(),
  to: instantArg.optional(),
  timezone: z.string().refine(isValidTimeZone, 'not an IANA timezone name').optional(),
  limit: z.number().int().min(1).max(200).default(50),
})

const createBookingArgs = z.object({
  eventTypeId: z.string().min(1).max(128),
  start: instantArg,
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().min(3).max(254).refine(isValidEmail, 'must be a valid email address'),
  guestTimezone: z.string().refine(isValidTimeZone, 'not an IANA timezone name').optional(),
  answers: z.record(z.string(), z.string().max(2000)).default({}),
  idempotencyKey: z.string().min(1).max(200).optional(),
})

const rescheduleArgs = z.object({
  bookingId: z.string().min(1).max(128),
  newStart: instantArg,
  reason: z.string().max(500).optional(),
})

const cancelArgs = z.object({
  bookingId: z.string().min(1).max(128),
  reason: z.string().max(500).optional(),
})

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

interface ToolContent {
  type: 'text'
  text: string
}

interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

function rpcResult(id: JsonRpcId, result: unknown, status = 200): Response {
  return json({ jsonrpc: '2.0', id, result }, status)
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200, data?: unknown): Response {
  const error: Record<string, unknown> = { code, message }
  if (data !== undefined) error['data'] = data
  return json({ jsonrpc: '2.0', id, error }, status)
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

function text(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

/** A refusal the model should reason about, not a transport failure. */
function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

export function buildMcpRoutes(ports: EnginePorts, slots: SlotService): Hono<{ Bindings: Record<string, unknown> }> {
  const app = new Hono<{ Bindings: Record<string, unknown> }>()

  // No server-initiated stream and no session to terminate; 405 is the
  // transport spec's prescribed answer for both.
  const methodNotAllowed = () =>
    json({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Use POST for MCP requests.' } }, 405, {
      allow: 'POST',
    })
  app.get('/', methodNotAllowed)
  app.delete('/', methodNotAllowed)

  app.post('/', async (c) => {
    const negotiated = c.req.header('mcp-protocol-version')
    if (negotiated !== undefined && !isSupportedVersion(negotiated)) {
      return rpcError(
        null,
        INVALID_REQUEST,
        `Unsupported MCP-Protocol-Version "${negotiated}". This server speaks ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
        400,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(await c.req.raw.text()) as unknown
    } catch {
      return rpcError(null, PARSE_ERROR, 'Request body is not valid JSON.', 400)
    }

    // Batching was removed from MCP in 2025-06-18; accepting it would mean
    // supporting a framing the current spec forbids.
    if (Array.isArray(parsed)) {
      return rpcError(null, INVALID_REQUEST, 'Batched JSON-RPC messages are not supported.', 400)
    }

    const message = asRequest(parsed)
    if (!message) {
      return rpcError(null, INVALID_REQUEST, 'Not a JSON-RPC 2.0 message.', 400)
    }

    // A notification carries no id and expects no body — including
    // `notifications/initialized`, which is the only one a client sends us.
    if (message.id === undefined || message.id === null) {
      return new Response(null, { status: 202 })
    }
    const id = message.id

    // The consistency mode is a property of what is about to happen, so it is
    // decided before the session exists (ADR-0007 §2).
    const scope: RequestScope = writesFor(message) ? { consistency: 'bookmark' } : { consistency: 'unconstrained' }

    const authResult = await authenticateApiRequest(ports, c.req.header('authorization'), scope)
    if (!authResult.ok) {
      const status = authResult.response.status
      // Re-shaped as JSON-RPC: an MCP client parses the body as a message and
      // would otherwise see a problem document it cannot interpret.
      return rpcError(
        id,
        status === 429 ? RATE_LIMITED : UNAUTHORIZED,
        status === 429
          ? 'Rate limit exceeded for this API key. Retry shortly.'
          : 'Provide a Punctual API key as `Authorization: Bearer pk_…`.',
        status,
        { httpStatus: status },
      )
    }
    const auth = authResult.auth

    switch (message.method) {
      case 'initialize':
        return rpcResult(id, initializeResult(message.params))

      case 'ping':
        return rpcResult(id, {})

      case 'tools/list':
        return rpcResult(id, {
          // Only the tools this key may actually call. An agent shown a tool it
          // is not allowed to use will call it and report a failure to the user;
          // omitting it is the honest description of its authority.
          tools: TOOLS.filter((t) => hasScope(auth.key, t.scope)).map(publicTool),
        })

      case 'tools/call':
        return await handleToolCall(id, message.params, { ports, slots, auth })

      default:
        return rpcError(id, METHOD_NOT_FOUND, `Unknown method "${message.method}".`)
    }
  })

  return app
}

function initializeResult(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const requested = typeof params?.['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : null
  return {
    protocolVersion: requested && isSupportedVersion(requested) ? requested : LATEST_PROTOCOL_VERSION,
    // `listChanged: false` is the truth: the tool set is a constant in this
    // file, so a client that subscribes to changes would wait forever.
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  }
}

function publicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }
}

function isSupportedVersion(version: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version) || version === ASSUMED_PROTOCOL_VERSION
}

function asRequest(value: unknown): JsonRpcRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record['jsonrpc'] !== '2.0') return null
  if (typeof record['method'] !== 'string') return null
  const rawId = record['id']
  const id: JsonRpcId | undefined =
    rawId === undefined ? undefined : typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null
  const params = typeof record['params'] === 'object' && record['params'] !== null
    ? (record['params'] as Record<string, unknown>)
    : undefined
  return { jsonrpc: '2.0', method: record['method'], ...(id === undefined ? {} : { id }), ...(params ? { params } : {}) }
}

/** True when this message will write — which picks the D1 consistency mode. */
function writesFor(message: JsonRpcRequest): boolean {
  if (message.method !== 'tools/call') return false
  const name = message.params?.['name']
  if (typeof name !== 'string') return false
  return TOOLS_BY_NAME.get(name)?.scope === API_SCOPE_WRITE
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

interface ToolDeps {
  ports: EnginePorts
  slots: SlotService
  auth: ApiAuth
}

async function handleToolCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  deps: ToolDeps,
): Promise<Response> {
  const name = params?.['name']
  if (typeof name !== 'string') {
    return rpcError(id, INVALID_PARAMS, '`name` is required and must be a tool name.')
  }
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) {
    return rpcError(id, METHOD_NOT_FOUND, `Unknown tool "${name}".`)
  }
  if (!hasScope(deps.auth.key, tool.scope)) {
    // Authority, not outcome: the host application should surface this to a
    // human who can issue a better key, rather than the model retrying.
    return rpcError(
      id,
      INSUFFICIENT_SCOPE,
      `This API key does not carry the \`${tool.scope}\` scope required by ${name}.`,
      403,
    )
  }

  const args = (params?.['arguments'] ?? {}) as unknown

  try {
    switch (name) {
      case 'list_event_types':
        return await run(id, listEventTypesArgs, args, (input) => listEventTypes(deps, input))
      case 'get_available_slots':
        return await run(id, getSlotsArgs, args, (input) => getAvailableSlots(deps, input))
      case 'create_booking':
        return await run(id, createBookingArgs, args, (input) => createBooking(deps, input))
      case 'reschedule_booking':
        return await run(id, rescheduleArgs, args, (input) => rescheduleBooking(deps, input))
      case 'cancel_booking':
        return await run(id, cancelArgs, args, (input) => cancelBooking(deps, input))
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Unknown tool "${name}".`)
    }
  } catch (err) {
    // An unexpected throw is ours, not the model's; it gets a protocol error
    // rather than an `isError` result the model would try to work around.
    console.error('[punctual] mcp tool failed', err)
    return rpcError(id, INTERNAL_ERROR, 'The tool failed unexpectedly.')
  }
}

/**
 * Validate then execute.
 *
 * Schema-invalid arguments are a protocol error (-32602) per the MCP spec, not
 * an `isError` result: the call never happened, and the message names the exact
 * field so the model can correct it on the next attempt.
 */
async function run<T extends z.ZodTypeAny>(
  id: JsonRpcId,
  schema: T,
  args: unknown,
  execute: (input: z.infer<T>) => Promise<ToolResult>,
): Promise<Response> {
  const parsed = schema.safeParse(args)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ')
    return rpcError(id, INVALID_PARAMS, `Invalid arguments — ${detail}`)
  }
  return rpcResult(id, await execute(parsed.data as z.infer<T>))
}

// ---------------------------------------------------------------------------
// The five tools
// ---------------------------------------------------------------------------

async function listEventTypes(
  deps: ToolDeps,
  input: z.infer<typeof listEventTypesArgs>,
): Promise<ToolResult> {
  const { repos, user } = deps.auth
  // Personal rows first, then each team's — `listForUser` selects WHERE
  // owner_user_id = ?, which never returns a team-owned row (owner_team_id
  // is set instead), so a team event type was invisible here even though
  // get/reschedule/cancel already authorize it by id for any team member.
  const ownerSlugs = new Map<string, string>()
  const all = await repos.eventTypes.listForUser(user.id)
  for (const et of all) ownerSlugs.set(et.id, user.slug)
  for (const membership of await repos.teams.memberships(user.id)) {
    const team = await repos.teams.byId(membership.teamId)
    if (!team) continue
    for (const et of await repos.eventTypes.listForTeam(membership.teamId)) {
      all.push(et)
      ownerSlugs.set(et.id, team.slug)
    }
  }
  const visible = input.includeInactive ? all : all.filter((et) => et.active)
  if (visible.length === 0) {
    return text('This account has no bookable event types yet.')
  }
  // Who the guest meets, so an agent can say so: every host for a
  // collective (required or joining when free), the pool for round robin.
  const hostsByType = new Map<string, Array<{ name: string; required: boolean }>>()
  for (const et of visible) {
    if (!et.ownerTeamId) continue
    const hosts = await resolveEventTypeHosts(repos, et, user)
    hostsByType.set(et.id, hosts.map((h) => ({ name: h.user.name || h.user.slug, required: h.required })))
  }
  return text({
    host: { name: user.name, timezone: user.tz },
    eventTypes: visible.map((et) => ({
      id: et.id,
      title: et.title,
      description: et.description,
      durationMinutes: et.durationMinutes,
      schedulingType: et.schedulingType,
      ...(hostsByType.has(et.id) ? { hosts: hostsByType.get(et.id) } : {}),
      locationType: et.locationType,
      minNoticeMinutes: et.minNoticeMinutes,
      maxHorizonDays: et.maxHorizonDays,
      active: et.active,
      // Effective, not declared: an agent filling the booking form needs to
      // see the built-in agenda question too, or it can never answer it.
      questions: effectiveQuestions(et).map((q) => ({ id: q.id, label: q.label, type: q.type, required: q.required, options: q.options })),
      // The OWNER's slug — the team's for a team-owned event type, never the
      // calling user's, whose personal slug would print a dead link.
      bookingUrl: `${trimSlash(deps.ports.config.baseUrl)}/${ownerSlugs.get(et.id) ?? user.slug}/${et.slug}`,
    })),
  })
}

async function getAvailableSlots(
  deps: ToolDeps,
  input: z.infer<typeof getSlotsArgs>,
): Promise<ToolResult> {
  const { repos, user, scope } = deps.auth
  const eventType = await repos.eventTypes.byId(input.eventTypeId)
  if (!eventType || !(await ownsEventType(repos, user, eventType))) {
    return toolError(`No event type with id "${input.eventTypeId}". Call list_event_types for valid ids.`)
  }

  const now = deps.ports.clock.now()
  const from = input.from === undefined ? now : toInstant(input.from)
  if (from === null) return toolError('`from` is not a valid time. Use ISO-8601 with an offset, or epoch milliseconds.')
  const to = input.to === undefined ? from + 7 * 24 * 3_600_000 : toInstant(input.to)
  if (to === null) return toolError('`to` is not a valid time. Use ISO-8601 with an offset, or epoch milliseconds.')
  if (to <= from) return toolError('`to` must be after `from`.')
  if (to - from > MAX_SLOT_RANGE_MS) return toolError('Ask for at most 62 days at a time.')

  const timezone = input.timezone ?? user.tz
  const hostUsers = await resolveHosts(repos, eventType, user)
  const found = await deps.slots.forEventType({ eventType, hostUsers, range: { start: from, end: to }, scope })

  if (found.length === 0) {
    return text(
      `No slots available for "${eventType.title}" between ${new Date(from).toISOString()} and ${new Date(to).toISOString()}. Try a later window.`,
    )
  }

  const shown = found.slice(0, input.limit)
  return text({
    eventTypeId: eventType.id,
    eventTitle: eventType.title,
    durationMinutes: eventType.durationMinutes,
    timezone,
    totalFound: found.length,
    returned: shown.length,
    truncated: found.length > shown.length,
    slots: shown.map((slot) => ({
      start: new Date(slot.start).toISOString(),
      startEpochMs: slot.start,
      end: new Date(slot.end).toISOString(),
      localDate: localDateString(slot.start, timezone),
      localTime: formatInZone(slot.start, timezone, { hour: '2-digit', minute: '2-digit' }),
    })),
  })
}

async function createBooking(
  deps: ToolDeps,
  input: z.infer<typeof createBookingArgs>,
): Promise<ToolResult> {
  const { repos, user } = deps.auth
  const start = toInstant(input.start)
  if (start === null) return toolError('`start` is not a valid time. Copy it from get_available_slots.')

  const eventType = await repos.eventTypes.byId(input.eventTypeId)
  if (!eventType || !(await ownsEventType(repos, user, eventType))) {
    return toolError(`No event type with id "${input.eventTypeId}". Call list_event_types for valid ids.`)
  }

  // Normalized to today's question ids before validating and storing — see
  // the identical comment in rest.ts's POST /bookings.
  const declaredAnswers = pickDeclaredAnswers(eventType, input.answers)
  const answerErrors = validateAnswers(eventType, declaredAnswers)
  if (Object.keys(answerErrors).length > 0) {
    const detail = Object.entries(answerErrors)
      .map(([field, message]) => `${field}: ${message}`)
      .join('; ')
    return toolError(`The intake answers are incomplete — ${detail}`)
  }

  const hostUsers = await resolveHosts(repos, eventType, user)
  const outcome = await deps.ports.coordinator.book(hostUsers[0]?.id ?? user.id, {
    eventTypeId: eventType.id,
    hostUserIds: hostUsers.map((u) => u.id),
    start,
    end: start + eventType.durationMinutes * 60_000,
    guestName: input.guestName,
    guestEmail: input.guestEmail,
    guestTimezone: input.guestTimezone ?? user.tz,
    answers: declaredAnswers,
    idempotencyKey: input.idempotencyKey,
  })

  if (!outcome.ok) return toolError(failureMessage(outcome.reason, outcome.detail))
  // Resolved from the booking that actually committed, not the caller:
  // round-robin/collective re-pick the host at commit time, so for a team
  // event type the two can differ and the summary named the wrong person.
  const bookedHost = (await repos.users.byId(outcome.booking.hostUserId)) ?? user
  // Everyone who actually attends — the round-robin pick, or the required
  // hosts plus the optional ones that were free — not the pool.
  const attending = outcome.booking.hostUserIds
    .map((id) => hostUsers.find((u) => u.id === id))
    .filter((u): u is User => u !== undefined)
    .map((u) => u.name || u.slug)
  return text({
    booked: true,
    ...bookingSummary(outcome.booking, eventType, bookedHost, input.guestTimezone ?? user.tz),
    ...(eventType.ownerTeamId ? { hosts: attending } : {}),
  })
}

async function rescheduleBooking(
  deps: ToolDeps,
  input: z.infer<typeof rescheduleArgs>,
): Promise<ToolResult> {
  const { repos, user } = deps.auth
  const start = toInstant(input.newStart)
  if (start === null) return toolError('`newStart` is not a valid time. Copy it from get_available_slots.')

  const original = await repos.bookings.byId(input.bookingId)
  if (!original || !isHost(original, user)) return toolError(`No booking with id "${input.bookingId}".`)
  if (original.status !== 'confirmed') {
    return toolError(`That booking is already ${original.status} and cannot be moved.`)
  }

  const eventType = await repos.eventTypes.byId(original.eventTypeId)
  if (!eventType) return toolError('The event type for that booking no longer exists.')

  const hostUsers = await resolveHosts(repos, eventType, user)
  // New time first, old time released only once it succeeded — see the same
  // reasoning in the REST reschedule handler.
  const outcome = await deps.ports.coordinator.book(hostUsers[0]?.id ?? user.id, {
    eventTypeId: eventType.id,
    hostUserIds: hostUsers.map((u) => u.id),
    start,
    end: start + eventType.durationMinutes * 60_000,
    guestName: original.guestName,
    guestEmail: original.guestEmail,
    guestTimezone: original.guestTimezone,
    answers: original.answers,
    rescheduleOf: original.id,
  })
  if (!outcome.ok) return toolError(failureMessage(outcome.reason, outcome.detail))

  // Conditional on the current status: a concurrent request against the same
  // original booking can win between the read above and here. If it did, the
  // booking `coordinator.book` just created is a real, confirmed, but
  // orphaned duplicate — release it rather than leave it live.
  const moved = await repos.bookings.markRescheduled(original.id, outcome.booking.id)
  if (!moved) {
    await repos.bookings.cancelWithLockRelease(outcome.booking.id, deps.ports.clock.now())
    await deps.ports.queue
      .send({ kind: 'calendar.sync', bookingId: outcome.booking.id, action: 'delete' })
      .catch(() => {})
    return toolError('That booking was already updated elsewhere. Fetch it again before retrying.')
  }
  await deps.ports.queue
    .send({ kind: 'calendar.sync', bookingId: original.id, action: 'delete' })
    .catch(() => {})

  // An agent moving a meeting must not do it silently — the humans involved
  // learn about it only from this mail. Host resolved from the NEW booking,
  // since round-robin re-picks at commit time.
  const newHost = (await repos.users.byId(outcome.booking.hostUserId)) ?? user
    // The replacement's calendar sync is enqueued HERE, not by the
    // coordinator, so it runs after `markRescheduled` has landed.
    // Dispatch requires `previous.rescheduledTo` to point back at this
    // booking, which is only true once the line above has run. One message
    // rather than two: Cloudflare Queues guarantees no ordering between
    // independent messages, so a separate notify could claim and send before
    // the calendar write recorded the new Meet link — permanently omitting
    // it from the very email this work exists to put it in.
    // Exactly one create-sync per replacement booking, so nothing races the
    // read-then-act guard on `externalEventIds`.
    await deps.ports.queue
      .send({
        kind: 'calendar.sync',
        bookingId: outcome.booking.id,
        action: 'create',
        ...(outcome.manageToken ? { manageToken: outcome.manageToken } : {}),
      })
      .catch(async (err) => {
        // This is the ONLY message for a replacement booking, so losing it
        // costs the guest both the calendar event and the "Rescheduled"
        // email. Notify directly instead — without a conference link, since
        // no calendar work will run, which is the honest outcome. The claim
        // inside makes this and any later redelivery mutually exclusive.
        console.error('[punctual] reschedule sync enqueue failed', err)
        await dispatchConfirmation(
          outcome.booking.id,
          deps.ports,
          outcome.manageToken,
        ).catch((e) => console.error('[punctual] reschedule fallback failed', e))
      })

    // The "Rescheduled" mail for the NEW leg is dispatched by the
    // calendar-sync handler, not here: the new booking's Meet link
    // does not exist until its calendar event does, and the email body is
    // rendered at enqueue time. The handler branches on `rescheduleOf` to
    // send the rescheduled copy rather than a fresh confirmation.

  return text({
    rescheduled: true,
    previousBookingId: original.id,
    previousStart: new Date(original.startUtc).toISOString(),
    reason: input.reason,
    // Same `newHost` used for the notification above, not the caller.
    ...bookingSummary(outcome.booking, eventType, newHost, original.guestTimezone),
  })
}

async function cancelBooking(deps: ToolDeps, input: z.infer<typeof cancelArgs>): Promise<ToolResult> {
  const { repos, user } = deps.auth
  const booking = await repos.bookings.byId(input.bookingId)
  if (!booking || !isHost(booking, user)) return toolError(`No booking with id "${input.bookingId}".`)
  if (booking.status !== 'confirmed') {
    return toolError(`That booking is already ${booking.status}; nothing to cancel.`)
  }

  const cancelledAt = deps.ports.clock.now()
  const cancelled = await repos.bookings.cancelWithLockRelease(booking.id, cancelledAt)
  if (!cancelled) return toolError('That booking was already updated elsewhere. Fetch it again before retrying.')
  await deps.ports.queue
    .send({ kind: 'calendar.sync', bookingId: booking.id, action: 'delete' })
    .catch(() => {})

  // The tool description promises "notify the guest", and nothing was sending
  // anything — an agent could cancel a real meeting and the guest would find
  // out by turning up to it.
  const cancelEt = await repos.eventTypes.byId(booking.eventTypeId)
  const cancelHost = await repos.users.byId(booking.hostUserId)
  if (cancelEt && cancelHost) {
    await notifyBookingCancelled({
      ports: deps.ports,
      // Patched, not the pre-write booking: notifyWebhooks serializes
      // `booking.status` straight into the payload, which would otherwise
      // report "confirmed" on a `booking.cancelled` event.
      booking: { ...booking, status: 'cancelled', cancelledAt },
      eventType: cancelEt,
      host: cancelHost,
      cancelledBy: 'host',
      // The tool's own description promises this lands in the guest's
      // notification; it was being collected and echoed back to the caller
      // but never actually passed through.
      ...(input.reason ? { reason: input.reason } : {}),
    }).catch((err) => console.error('[punctual] mcp cancellation emails failed', err))
  }

  return text({
    cancelled: true,
    bookingId: booking.id,
    start: new Date(booking.startUtc).toISOString(),
    guestEmail: booking.guestEmail,
    reason: input.reason,
  })
}

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

function bookingSummary(
  booking: Booking,
  eventType: EventType,
  host: User,
  timezone: string,
): Record<string, unknown> {
  return {
    bookingId: booking.id,
    eventTitle: eventType.title,
    hostName: host.name || host.slug,
    guestName: booking.guestName,
    guestEmail: booking.guestEmail,
    start: new Date(booking.startUtc).toISOString(),
    startEpochMs: booking.startUtc,
    end: new Date(booking.endUtc).toISOString(),
    localTime: formatInZone(booking.startUtc, timezone),
    timezone,
    status: booking.status,
  }
}

/** Phrased for a model that has to decide what to do next, not for a log. */
function failureMessage(
  reason: 'slot_taken' | 'outside_availability' | 'policy' | 'lease_failed',
  detail?: string,
): string {
  switch (reason) {
    case 'slot_taken':
      return 'That time was taken while this request was in flight. Call get_available_slots again and choose another slot.'
    case 'outside_availability':
      return 'That time is not bookable — it is outside the host\'s availability, too soon, or past the booking horizon. Use a start returned by get_available_slots.'
    case 'lease_failed':
      return 'Another booking is being committed for these hosts right now. Retry this call in a moment.'
    case 'policy':
      return `The booking was refused: ${detail ?? 'it does not satisfy this event type\'s rules.'}`
  }
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}
