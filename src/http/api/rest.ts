/**
 * The REST API (spec §5.1), mounted at `/api/v1`.
 *
 * Two rules shape every handler here.
 *
 * **Consistency (ADR-0007 §2).** A GET is served from the nearest replica —
 * `unconstrained` — because an API listing is advisory in exactly the way a
 * booking page listing is: `slot_locks` plus the DO re-check arbitrate at
 * commit, so staleness degrades to a 409 rather than a wrong calendar. Anything
 * that writes, or reads back what it just wrote, runs on a `bookmark` session,
 * because a caller must never be told "created" and then be handed a replica
 * that has not seen it. The mode is chosen once per request, in the auth
 * middleware, so a handler cannot accidentally mix two D1 sessions.
 *
 * **Errors are problem documents (RFC 7807).** One shape, always
 * `{type,title,status,detail}`, `application/problem+json`. The `type` is a URN
 * rather than a URL: a dereferenceable type URI would mean publishing and
 * keeping a documentation host alive forever, and a self-hoster's error
 * payloads should not point at our domain.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type {
  ApiKey,
  Availability,
  Booking,
  EventType,
  EventTypeQuestion,
  Schedule,
  Interval,
  Slot,
  User,
  Webhook,
  WebhookEvent,
  WeeklySchedule,
} from '../../core/domain/types.js'
import { canManageTeam } from '../../core/domain/teams.js'
import { currentHostIds, notifyNewHosts } from '../host-notifications.js'
import { hostUsers, resolveHosts as resolveEventTypeHosts, type ResolvedHost } from '../../core/domain/hosts.js'
import type { EnginePorts, Repositories, RequestScope } from '../../ports.js'
import type { SlotService } from '../../engine.js'
import { authenticateApiKey } from '../../core/domain/auth-flows.js'
import { parseApiKey } from '../../core/domain/auth-service.js'
import { effectiveQuestions, isValidEmail, pickDeclaredAnswers, validateAnswers } from '../../core/domain/booking-service.js'
import { notifyBookingCancelled } from '../../adapters/notify.js'
import { dispatchConfirmation } from '../../adapters/queue/consumer.js'
import { formatInZone, isValidTimeZone, localDateString } from '../../core/time/zone.js'

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * The whole scope vocabulary: read and write.
 *
 * Two scopes, not twenty. A key's scopes are the authority of whatever holds
 * it — including an LLM agent over MCP — so the model has to be small enough
 * that a host can predict it from the name alone. `*` is full authority.
 */
export const API_SCOPE_READ = 'read'
export const API_SCOPE_WRITE = 'write'

/** Fails closed: a key with no scopes has no authority, rather than all of it. */
export function hasScope(key: ApiKey, scope: string): boolean {
  return key.scopes.includes('*') || key.scopes.includes(scope)
}

// ---------------------------------------------------------------------------
// Problem documents
// ---------------------------------------------------------------------------

export interface ProblemFieldError {
  field: string
  message: string
}

export interface ProblemOptions {
  errors?: ProblemFieldError[]
  headers?: Record<string, string>
}

/**
 * RFC 7807 problem JSON.
 *
 * Built as a plain `Response` rather than through `c.json` so the media type
 * and the body shape are decided in exactly one place — a handler that reaches
 * for `c.json({error: …})` is the drift this function exists to prevent.
 */
export function problem(
  status: number,
  title: string,
  detail?: string,
  opts: ProblemOptions = {},
): Response {
  const body: Record<string, unknown> = {
    type: `urn:punctual:problem:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    title,
    status,
  }
  if (detail !== undefined) body['detail'] = detail
  if (opts.errors && opts.errors.length > 0) body['errors'] = opts.errors
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json; charset=utf-8', ...opts.headers },
  })
}

function zodProblem(error: z.ZodError): Response {
  return problem(400, 'Invalid request', 'The request body did not validate.', {
    errors: error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
      message: issue.message,
    })),
  })
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface ApiAuth {
  key: ApiKey
  user: User
  /** The request's single D1 session. Handlers MUST reuse it (ADR-0007 §1). */
  repos: Repositories
  scope: RequestScope
}

export type ApiAuthResult = { ok: true; auth: ApiAuth } | { ok: false; response: Response }

/** ADR-0006 §3 default: an abuse limit, not a plan quota. Operator-tunable. */
export const API_KEY_RATE_LIMIT = { limit: 600, windowSeconds: 60 }

const UNAUTHORIZED_HEADERS = { 'www-authenticate': 'Bearer realm="punctual"' }

/**
 * `Authorization: Bearer pk_…` → the key, its user, and the request's session.
 *
 * Shared with the MCP server, because an agent's authority must be *exactly* an
 * API key's authority — two authentication paths would eventually disagree, and
 * the one that drifts is the one nobody looks at.
 *
 * The rate limit is checked on the clear-text prefix BEFORE the database read:
 * an attacker guessing secrets must not buy an unlimited number of lookups. The
 * prefix is public-ish by design (ADR-0005 §7), so it is the right identifier.
 */
export async function authenticateApiRequest(
  ports: EnginePorts,
  authorization: string | undefined,
  scope: RequestScope,
): Promise<ApiAuthResult> {
  const raw = bearerToken(authorization)
  if (!raw) {
    return {
      ok: false,
      response: problem(401, 'Unauthorized', 'Provide an API key as `Authorization: Bearer pk_…`.', {
        headers: UNAUTHORIZED_HEADERS,
      }),
    }
  }

  const parsed = parseApiKey(raw)
  if (!parsed) {
    // Malformed is safe to distinguish from unknown: the *format* is something
    // the caller can compute themselves. Key existence is not.
    return {
      ok: false,
      response: problem(401, 'Unauthorized', 'That is not a well-formed API key.', {
        headers: UNAUTHORIZED_HEADERS,
      }),
    }
  }

  const limit = limitFor(ports, 'api:key', API_KEY_RATE_LIMIT)
  const check = await ports.rateLimiter.check('api:key', parsed.prefix, limit.limit, limit.windowSeconds)
  if (!check.allowed) {
    const retryAfter = Math.max(1, Math.ceil((check.resetAt - ports.clock.now()) / 1000))
    return {
      ok: false,
      response: problem(429, 'Too many requests', `Retry in ${retryAfter} seconds.`, {
        headers: { 'retry-after': String(retryAfter) },
      }),
    }
  }

  // One session per request (ADR-0007 §1). Authentication touches
  // `last_used_at`, which is a write even on a GET — harmless on an
  // unconstrained session, because the mode constrains reads, not writes.
  const repos = ports.repositories(scope)
  const authed = await authenticateApiKey({ repos, crypto: ports.crypto }, raw, ports.clock.now())
  if (!authed) {
    return {
      ok: false,
      response: problem(401, 'Unauthorized', 'That API key is not valid.', {
        headers: UNAUTHORIZED_HEADERS,
      }),
    }
  }

  return { ok: true, auth: { key: authed.key, user: authed.user, repos, scope } }
}

/** Scope enforcement as a response, so REST and MCP refuse for the same reason. */
export function requireScope(key: ApiKey, scope: string): Response | null {
  if (hasScope(key, scope)) return null
  return problem(
    403,
    'Insufficient scope',
    `This API key does not carry the \`${scope}\` scope.`,
  )
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

function limitFor(
  ports: EnginePorts,
  scope: string,
  fallback: { limit: number; windowSeconds: number },
): { limit: number; windowSeconds: number } {
  const override = ports.config.rateLimits?.[scope]
  return {
    limit: override?.limit ?? fallback.limit,
    windowSeconds: override?.windowSeconds ?? fallback.windowSeconds,
  }
}

// ---------------------------------------------------------------------------
// Shared parsing
// ---------------------------------------------------------------------------

/**
 * ISO-8601 or epoch milliseconds, because callers reach for both.
 *
 * An ISO string without an offset is interpreted as UTC by the runtime, which
 * is a footgun in every other environment — so the API documents an offset as
 * required and this function simply does not try to guess a zone.
 */
export function toInstant(value: string | number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^-?\d{1,15}$/.test(trimmed)) return Number(trimmed)
  // Every caller's error message promises "ISO-8601 with an offset, or epoch
  // milliseconds" — but `Date.parse` accepts an offsetless string too,
  // silently reading it as UTC per spec. A client that sent their own
  // wall-clock time expecting rejection gets a booking at the wrong instant
  // instead, hours off from what they meant.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) return null
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

const instantSchema = z.union([z.number(), z.string()])

/** A listing may not ask for an unbounded computation; 62 days covers two months. */
export const MAX_SLOT_RANGE_MS = 62 * 24 * 60 * 60 * 1000

function parseRange(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  now: number,
  defaultSpanMs: number,
): { ok: true; range: Interval } | { ok: false; response: Response } {
  const from = fromRaw === undefined ? now : toInstant(fromRaw)
  if (from === null) {
    return {
      ok: false,
      // `toInstant` requires an offset on any ISO-8601 string it's given —
      // this message used to promise a weaker contract than the function
      // actually enforced, so an offsetless `from`/`to` 400ed with a message
      // that didn't explain why. Same fix as `start`'s message, for the same
      // reason: an offsetless string is a client's own wall-clock time, and
      // reading it as UTC silently returns the wrong window.
      response: problem(400, 'Invalid request', '`from` must be ISO-8601 with an offset, or epoch milliseconds.'),
    }
  }
  const to = toRaw === undefined ? from + defaultSpanMs : toInstant(toRaw)
  if (to === null) {
    return {
      ok: false,
      response: problem(400, 'Invalid request', '`to` must be ISO-8601 with an offset, or epoch milliseconds.'),
    }
  }
  if (to <= from) {
    return { ok: false, response: problem(400, 'Invalid request', '`to` must be after `from`.') }
  }
  if (to - from > MAX_SLOT_RANGE_MS) {
    return {
      ok: false,
      response: problem(400, 'Range too large', 'Ask for at most 62 days at a time.'),
    }
  }
  return { ok: true, range: { start: from, end: to } }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens only')

const questionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  type: z.enum(['text', 'textarea', 'select']),
  required: z.boolean().default(false),
  options: z.array(z.string().min(1).max(200)).max(50).optional(),
})

/**
 * The field validators, without defaults.
 *
 * Kept separate because `z.object({…}).partial()` does NOT strip a `.default()`
 * — an absent key still materialises its default value. Deriving the PATCH
 * schema from a create schema that carries defaults would therefore turn
 * "rename this event type" into "rename it and reset its buffers, questions and
 * notice period", silently.
 */
const eventTypeFields = {
  slug: slugSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(5000),
  // A multiple of 5 is not a style preference: bookings claim 5-minute buckets
  // in `slot_locks`, and a 7-minute meeting cannot be expressed on that grid
  // (ADR-0002 §1).
  durationMinutes: z.number().int().min(5).max(1440).multipleOf(5),
  slotIntervalMinutes: z.number().int().min(5).max(1440).multipleOf(5).nullable(),
  // Multiples of 5, like duration and interval above. Buffers extend the
  // footprint that gets bucketed, so an off-grid buffer lets two adjacent
  // offered slots claim the same bucket and 409 each other (ADR-0004 §4 and
  // its Consequences section).
  bufferBeforeMinutes: z.number().int().min(0).max(720).multipleOf(5),
  bufferAfterMinutes: z.number().int().min(0).max(720).multipleOf(5),
  minNoticeMinutes: z.number().int().min(0).max(60 * 24 * 365),
  maxHorizonDays: z.number().int().min(1).max(730),
  maxPerDay: z.number().int().min(1).max(100).nullable(),
  locationType: z.enum(['google_meet', 'custom_link', 'phone', 'in_person']),
  locationValue: z.string().max(500).nullable(),
  questions: z.array(questionSchema).max(20),
  active: z.boolean(),
  // Null = the owner's default schedule. Every event type POST /event-types
  // creates is personal (schedulingType is hardcoded 'personal' below), so
  // it's always meaningful there; PATCH can also reach a team-owned event
  // type via team membership (see `ownsEventType`) and rejects this field
  // for one — a team event type has multiple hosts and no single schedule
  // fits all of them (engine.ts's forEventType). Existence/ownership is
  // checked at each call site with `repos.availability.byId(user.id, ...)`,
  // not by this schema.
  scheduleId: z.string().min(1).max(64).nullable(),
}

/** One host of a team event type, as the API accepts and returns it. */
const hostInput = z.object({
  userId: z.string().min(1).max(64),
  required: z.boolean().default(true),
  scheduleId: z.string().min(1).max(64).nullable().default(null),
  weight: z.number().int().min(1).max(100).nullable().default(null),
})

const eventTypeBody = z.object({
  ...eventTypeFields,
  // Team ownership: the key's user must be an admin of the team (or the
  // instance admin). Absent = a personal event type, as before.
  ownerTeamId: z.string().min(1).max(64).nullable().default(null),
  schedulingType: z.enum(['round_robin', 'collective']).default('round_robin'),
  // The explicit host set (see EventTypeHost). Absent or empty = every
  // member, required, on their default schedules.
  hosts: z.array(hostInput).max(100).default([]),
  description: eventTypeFields.description.default(''),
  slotIntervalMinutes: eventTypeFields.slotIntervalMinutes.default(null),
  bufferBeforeMinutes: eventTypeFields.bufferBeforeMinutes.default(0),
  bufferAfterMinutes: eventTypeFields.bufferAfterMinutes.default(0),
  minNoticeMinutes: eventTypeFields.minNoticeMinutes.default(0),
  maxHorizonDays: eventTypeFields.maxHorizonDays.default(60),
  maxPerDay: eventTypeFields.maxPerDay.default(null),
  locationType: eventTypeFields.locationType.default('google_meet'),
  locationValue: eventTypeFields.locationValue.default(null),
  questions: eventTypeFields.questions.default([]),
  active: eventTypeFields.active.default(true),
  scheduleId: eventTypeFields.scheduleId.default(null),
})

const eventTypePatchBody = z.object({ ...eventTypeFields, hosts: z.array(hostInput).max(100) }).partial()

const hostScheduleBody = z.object({ scheduleId: z.string().min(1).max(64).nullable() })

const dayWindowSchema = z
  .object({
    // Also multiples of 5: an availability window beginning at 09:07 anchors
    // the slot grid off the bucket grid, with the same consequence.
    startMinute: z.number().int().min(0).max(1440).multipleOf(5),
    endMinute: z.number().int().min(0).max(1440).multipleOf(5),
  })
  .refine((w) => w.endMinute > w.startMinute, 'endMinute must be after startMinute')

const overridesSchema = z
  .array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      windows: z.array(dayWindowSchema).max(12),
    }),
  )
  .max(370)

const availabilityBody = z.object({
  timezone: z.string().refine(isValidTimeZone, 'not an IANA timezone'),
  // Index 0 is Sunday, matching `Date.getUTCDay()` — stated in the schema so a
  // client cannot discover it by writing to the wrong day.
  weekly: z.array(z.array(dayWindowSchema).max(12)).length(7),
  overrides: overridesSchema.default([]),
})

const bookingCreateBody = z.object({
  eventTypeId: z.string().min(1).max(128),
  start: instantSchema,
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().max(254).refine(isValidEmail, 'not a valid email address'),
  guestTimezone: z.string().refine(isValidTimeZone, 'not an IANA timezone').optional(),
  answers: z.record(z.string(), z.string().max(2000)).default({}),
})

const rescheduleBody = z.object({
  start: instantSchema,
  reason: z.string().max(500).optional(),
})

const cancelBody = z.object({
  reason: z.string().max(500).optional(),
})

const webhookCreateBody = z.object({
  url: z
    .string()
    .max(2000)
    .refine((value) => {
      try {
        // https only: a webhook carries booking details including guest email,
        // and http would put them on the wire in the clear.
        return new URL(value).protocol === 'https:'
      } catch {
        return false
      }
    }, 'must be an absolute https URL'),
  events: z
    .array(z.enum(['booking.created', 'booking.rescheduled', 'booking.cancelled']))
    .min(1)
    .max(3),
})

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

type ApiEnv = {
  Bindings: Record<string, unknown>
  Variables: { auth: ApiAuth }
}

export function buildApiRoutes(ports: EnginePorts, slots: SlotService): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>()

  /**
   * Authentication, rate limiting and — the load-bearing part — the choice of
   * consistency mode for the whole request (ADR-0007 §2).
   *
   * Safe methods read the nearest replica. Everything else runs bookmarked, so
   * a handler that writes and then re-reads (create → return the row) cannot
   * see a replica that is behind its own write.
   */
  app.use('*', async (c, next) => {
    const safe = c.req.method === 'GET' || c.req.method === 'HEAD'
    const scope: RequestScope = safe ? { consistency: 'unconstrained' } : { consistency: 'bookmark' }
    const result = await authenticateApiRequest(ports, c.req.header('authorization'), scope)
    if (!result.ok) return result.response
    const scopeNeeded = safe ? API_SCOPE_READ : API_SCOPE_WRITE
    const denied = requireScope(result.auth.key, scopeNeeded)
    if (denied) return denied
    c.set('auth', result.auth)
    await next()
  })

  // -------------------------------------------------------------------------
  // Event types
  // -------------------------------------------------------------------------

  /**
   * Resolve the slug an event type's public URL hangs off. Team lookups are
   * memoised per request — the list endpoint serialises many rows that
   * usually share a team.
   */
  const ownerSlugCache = new WeakMap<object, Map<string, string>>()
  async function ownerSlugFor(
    repos: Repositories,
    user: User,
    et: EventType,
  ): Promise<string> {
    if (!et.ownerTeamId) return user.slug
    let cache = ownerSlugCache.get(repos)
    if (!cache) ownerSlugCache.set(repos, (cache = new Map()))
    const hit = cache.get(et.ownerTeamId)
    if (hit !== undefined) return hit
    const team = await repos.teams.byId(et.ownerTeamId)
    const slug = team?.slug ?? user.slug
    cache.set(et.ownerTeamId, slug)
    return slug
  }

  app.get('/event-types', async (c) => {
    const { repos, user } = c.get('auth')
    // Personal rows first, then each team's — `listForUser` selects
    // WHERE owner_user_id = ?, which by construction never returns a
    // team-owned row (owner_team_id is set instead). Without this, an API
    // key could GET/PATCH/DELETE a team event type by id (ownsEventType
    // grants any team member access) but never discover it existed.
    const list = await repos.eventTypes.listForUser(user.id)
    for (const membership of await repos.teams.memberships(user.id)) {
      list.push(...(await repos.eventTypes.listForTeam(membership.teamId)))
    }
    const data = []
    for (const et of list) data.push(await eventTypeWithHosts(repos, user, et))
    return c.json({ data })
  })

  /** `eventTypeJson` plus the resolved host list — what every event-type response returns. */
  async function eventTypeWithHosts(repos: Repositories, user: User, et: EventType): Promise<Record<string, unknown>> {
    const hosts = await resolveEventTypeHosts(repos, et, user)
    return eventTypeJson(et, ports, await ownerSlugFor(repos, user, et), hosts)
  }

  /** The key's user may manage this team: a team admin, or the instance admin (core/domain/teams.ts). */
  async function managesTeam(repos: Repositories, user: User, teamId: string): Promise<boolean> {
    const memberships = await repos.teams.memberships(user.id)
    return canManageTeam(user, memberships.find((m) => m.teamId === teamId))
  }

  app.post('/event-types', async (c) => {
    const { repos, user } = c.get('auth')
    const parsed = await readBody(c.req.raw, eventTypeBody)
    if (!parsed.ok) return parsed.response
    const body = parsed.data

    // A team event type: the key's user must be one of that team's admins —
    // the same rule as the dashboard, since a key carries exactly one
    // user's authority.
    const team = body.ownerTeamId ? await repos.teams.byId(body.ownerTeamId) : null
    if (body.ownerTeamId) {
      if (!team) return problem(404, 'Not found', 'No team with that id.')
      if (!(await managesTeam(repos, user, team.id))) {
        return problem(403, 'Forbidden', 'Only an admin of that team can create an event type under it.')
      }
      if (body.scheduleId) {
        return problem(400, 'Invalid request', 'scheduleId only applies to a personal event type; set each host\'s schedule in `hosts`.')
      }
    } else if (body.hosts.length > 0) {
      return problem(400, 'Invalid request', '`hosts` only applies to a team event type (set ownerTeamId).')
    }

    const ownerSlug = team ? team.slug : user.slug
    const clash = await repos.eventTypes.bySlug(ownerSlug, body.slug)
    if (clash) return problem(409, 'Slug taken', `There is already an event type at /${ownerSlug}/${body.slug}.`)

    if (body.scheduleId && !(await repos.availability.byId(user.id, body.scheduleId))) {
      return problem(400, 'Invalid request', 'scheduleId does not exist or is not yours.')
    }
    if (team) {
      // Checked BEFORE the row is written, so a mistyped host never leaves
      // a live event type behind; the SQL guard in `replace` stays as the
      // backstop for a member removed or a schedule deleted in between.
      const rejected = await validateHosts(repos, team.id, body.schedulingType, body.hosts)
      if (rejected) return rejected
    }

    const created = await repos.eventTypes.create({
      id: `evt_${ports.crypto.randomToken(12)}`,
      ownerUserId: team ? null : user.id,
      ownerTeamId: team ? team.id : null,
      schedulingType: team ? body.schedulingType : 'personal',
      slug: body.slug,
      title: body.title,
      description: body.description,
      durationMinutes: body.durationMinutes,
      slotIntervalMinutes: body.slotIntervalMinutes,
      bufferBeforeMinutes: body.bufferBeforeMinutes,
      bufferAfterMinutes: body.bufferAfterMinutes,
      minNoticeMinutes: body.minNoticeMinutes,
      maxHorizonDays: body.maxHorizonDays,
      maxPerDay: body.maxPerDay,
      locationType: body.locationType,
      locationValue: body.locationValue,
      questions: body.questions as EventTypeQuestion[],
      active: body.active,
      scheduleId: body.scheduleId,
    })

    if (team) {
      if (body.hosts.length > 0) {
        const ok = await repos.eventTypeHosts.replace(created.id, body.hosts.map(hostRow))
        if (!ok) {
          // Lost the race the pre-check cannot cover. The row exists with
          // every member hosting it; say so, with the id, rather than
          // leave the caller to find it.
          return problem(
            422,
            'Hosts not accepted',
            `A host left the team or a schedule was deleted while creating. Event type ${created.id} exists with every member hosting it; PATCH its \`hosts\` to fix the list.`,
          )
        }
      }
      await notifyNewHosts(
        ports,
        repos,
        user,
        created,
        new Set(),
        body.hosts.length > 0
          ? body.hosts.map((h) => ({ userId: h.userId, required: h.required, scheduleId: h.scheduleId }))
          : (await repos.teams.members(team.id)).map((m) => ({ userId: m.userId, required: true, scheduleId: null })),
      )
    }

    return c.json({ data: await eventTypeWithHosts(repos, user, created) }, 201)
  })

  /**
   * The checks the dashboard's Hosts block makes, for the API: every host on
   * the team, every scheduleId that host's own, and a collective set with at
   * least one required host — an all-optional collective is accepted by the
   * engine and then never offers a slot (computeSlots returns nothing
   * without a required host), which is a 400 here, not a silent dead page.
   */
  async function validateHosts(
    repos: Repositories,
    teamId: string,
    schedulingType: EventType['schedulingType'],
    hosts: Array<z.infer<typeof hostInput>>,
  ): Promise<Response | null> {
    if (hosts.length === 0) return null
    const members = new Set((await repos.teams.members(teamId)).map((m) => m.userId))
    const seen = new Set<string>()
    for (const h of hosts) {
      if (seen.has(h.userId)) return problem(400, 'Invalid request', `hosts lists ${h.userId} twice.`)
      seen.add(h.userId)
      if (!members.has(h.userId)) return problem(400, 'Invalid request', `${h.userId} is not a member of the team.`)
      if (h.scheduleId && !(await repos.availability.byId(h.userId, h.scheduleId))) {
        return problem(400, 'Invalid request', `scheduleId ${h.scheduleId} does not exist or is not ${h.userId}'s.`)
      }
    }
    if (schedulingType === 'collective' && !hosts.some((h) => h.required)) {
      return problem(400, 'Invalid request', 'A collective event type needs at least one required host.')
    }
    return null
  }

  /** `hosts[]` from the API to the repository's shape. */
  function hostRow(h: z.infer<typeof hostInput>): { userId: string; required: boolean; scheduleId: string | null; rrWeight: number | null } {
    return { userId: h.userId, required: h.required, scheduleId: h.scheduleId, rrWeight: h.weight }
  }

  app.get('/event-types/:id', async (c) => {
    const { repos, user } = c.get('auth')
    const et = await repos.eventTypes.byId(c.req.param('id'))
    if (!et || !(await ownsEventType(repos, user, et))) return notFound('event type')
    return c.json({ data: await eventTypeWithHosts(repos, user, et) })
  })

  app.patch('/event-types/:id', async (c) => {
    const { repos, user } = c.get('auth')
    const id = c.req.param('id')
    const et = await repos.eventTypes.byId(id)
    if (!et || !(await ownsEventType(repos, user, et))) return notFound('event type')
    if (!(await canEditEventType(repos, user, et))) {
      return problem(403, 'Forbidden', "Only an admin of the team that owns this event type can change it.")
    }

    const parsed = await readBody(c.req.raw, eventTypePatchBody)
    if (!parsed.ok) return parsed.response

    if (parsed.data.scheduleId !== undefined) {
      // A team event type (round_robin/collective) has multiple hosts and no
      // single schedule fits all of them — each host's is set in `hosts`.
      // Reject rather than silently ignore: the caller explicitly asked for
      // something this event type cannot express.
      if (et.ownerTeamId) {
        return problem(400, 'Invalid request', 'scheduleId only applies to a personal event type; set each host\'s schedule in `hosts`.')
      }
      if (parsed.data.scheduleId && !(await repos.availability.byId(user.id, parsed.data.scheduleId))) {
        return problem(400, 'Invalid request', 'scheduleId does not exist or is not yours.')
      }
    }
    const { hosts, ...fields } = parsed.data
    if (hosts !== undefined && !et.ownerTeamId) {
      return problem(400, 'Invalid request', '`hosts` only applies to a team event type.')
    }
    if (hosts !== undefined && et.ownerTeamId) {
      // Validated before ANY write, so a bad host list does not save the
      // other fields and then 422 (review).
      const rejected = await validateHosts(repos, et.ownerTeamId, et.schedulingType, hosts)
      if (rejected) return rejected
    }
    const before = hosts !== undefined ? await currentHostIds(repos, et) : new Set<string>()

    if (Object.keys(fields).length > 0) await repos.eventTypes.update(id, fields as Partial<EventType>)
    if (hosts !== undefined && et.ownerTeamId) {
      // Atomic, SQL-guarded replace — same as the dashboard's Hosts block.
      const ok = await repos.eventTypeHosts.replace(id, hosts.map(hostRow))
      if (!ok) {
        return problem(422, 'Hosts not accepted', 'A host left the team or a schedule was deleted meanwhile; the other fields were saved. Reload and retry `hosts`.')
      }
      const after =
        hosts.length > 0
          ? hosts.map((h) => ({ userId: h.userId, required: h.required, scheduleId: h.scheduleId }))
          : (await repos.teams.members(et.ownerTeamId)).map((m) => ({ userId: m.userId, required: true, scheduleId: null }))
      await notifyNewHosts(ports, repos, user, { ...et, ...(fields as Partial<EventType>) }, before, after)
    }
    // Read-after-write on the same bookmarked session, so the response is the
    // row as stored rather than the patch echoed back.
    const updated = await repos.eventTypes.byId(id)
    if (!updated) return notFound('event type')
    return c.json({ data: await eventTypeWithHosts(repos, user, updated) })
  })

  /**
   * One host's per-event schedule: the host themselves (any key of theirs)
   * or a team admin may set it — the same two people the dashboard lets.
   * A plain co-host gets a 403 that says who can.
   */
  app.patch('/event-types/:id/hosts/:userId', async (c) => {
    const { repos, user } = c.get('auth')
    const et = await repos.eventTypes.byId(c.req.param('id'))
    if (!et || !(await ownsEventType(repos, user, et))) return notFound('event type')
    if (!et.ownerTeamId) return problem(400, 'Invalid request', 'A personal event type has one host; use `scheduleId` on the event type.')
    const targetId = c.req.param('userId')
    const hosts = await resolveEventTypeHosts(repos, et, user)
    const target = hosts.find((h) => h.user.id === targetId)
    if (!target) return notFound('host')
    if (targetId !== user.id && !(await managesTeam(repos, user, et.ownerTeamId))) {
      return problem(403, 'Forbidden', `Only ${target.user.name || target.user.slug} or an admin of the team can change their schedule for this event type.`)
    }

    const parsed = await readBody(c.req.raw, hostScheduleBody)
    if (!parsed.ok) return parsed.response
    const scheduleId = parsed.data.scheduleId
    if (scheduleId && !(await repos.availability.byId(targetId, scheduleId))) {
      return problem(400, 'Invalid request', 'scheduleId does not exist or is not that host\'s.')
    }
    // No explicit set yet: this choice makes it explicit, insert-if-absent
    // so a concurrent choice by another host keeps theirs (dashboard rule).
    if ((await repos.eventTypeHosts.forEventType(et.id)).length === 0) {
      const members = await repos.teams.members(et.ownerTeamId)
      await repos.eventTypeHosts.ensure(
        et.id,
        members.map((m) => ({ userId: m.userId, required: true, scheduleId: null, rrWeight: null })),
      )
    }
    const ok = await repos.eventTypeHosts.setSchedule(et.id, targetId, scheduleId)
    if (!ok) return problem(409, 'Conflict', 'That host is no longer on the event type, or the schedule was deleted. Reload and retry.')
    return c.json({ data: await eventTypeWithHosts(repos, user, et) })
  })

  // ---------------------------------------------------------------------------
  // Team member schedules — managed availability, for a team admin's key
  // ---------------------------------------------------------------------------

  const scheduleBody = z.object({
    name: z.string().min(1).max(120),
    timezone: availabilityBody.shape.timezone,
    weekly: availabilityBody.shape.weekly,
    overrides: availabilityBody.shape.overrides,
  })
  // Built field by field rather than `.partial()` of the above: `overrides`
  // carries `.default([])` for creates, and a partial keeps the default —
  // so a rename that omitted `overrides` would silently blank the member's
  // date overrides (review). Optional here means "not sent", nothing else.
  const schedulePatchBody = z.object({
    name: z.string().min(1).max(120).optional(),
    timezone: availabilityBody.shape.timezone.optional(),
    weekly: availabilityBody.shape.weekly.optional(),
    overrides: overridesSchema.optional(),
  })

  /** The member, if the key's user manages the team and the member is on it. Anything else is the same 404. */
  async function managedMember(
    repos: Repositories,
    user: User,
    teamId: string,
    memberId: string,
  ): Promise<{ ok: true; member: User } | { ok: false; response: Response }> {
    const team = await repos.teams.byId(teamId)
    if (!team) return { ok: false, response: notFound('team') }
    if (!(await managesTeam(repos, user, teamId))) {
      return { ok: false, response: problem(403, 'Forbidden', 'Only an admin of the team can manage its members\' schedules.') }
    }
    if (!(await repos.teams.members(teamId)).some((m) => m.userId === memberId)) return { ok: false, response: notFound('member') }
    const member = await repos.users.byId(memberId)
    if (!member) return { ok: false, response: notFound('member') }
    return { ok: true, member }
  }

  function scheduleJson(s: Schedule): Record<string, unknown> {
    return {
      id: s.id,
      name: s.name,
      isDefault: s.isDefault,
      timezone: s.timezone,
      weekly: s.weekly,
      overrides: s.overrides,
      createdBy: s.createdBy ?? null,
    }
  }

  app.get('/teams/:id/members/:userId/schedules', async (c) => {
    const { repos, user } = c.get('auth')
    const found = await managedMember(repos, user, c.req.param('id'), c.req.param('userId'))
    if (!found.ok) return found.response
    return c.json({ data: (await repos.availability.listForUser(found.member.id)).map(scheduleJson) })
  })

  app.post('/teams/:id/members/:userId/schedules', async (c) => {
    const { repos, user } = c.get('auth')
    const found = await managedMember(repos, user, c.req.param('id'), c.req.param('userId'))
    if (!found.ok) return found.response
    const parsed = await readBody(c.req.raw, scheduleBody)
    if (!parsed.ok) return parsed.response
    // Created BY the admin FOR the member: the member's own row, badged with
    // who set it up, editable by them.
    const created = await repos.availability.create(
      found.member.id,
      {
        id: `sch_${ports.crypto.randomToken(12)}`,
        userId: found.member.id,
        name: parsed.data.name,
        isDefault: false,
        timezone: parsed.data.timezone,
        weekly: parsed.data.weekly as unknown as WeeklySchedule,
        overrides: parsed.data.overrides,
      },
      user.id,
    )
    return c.json({ data: scheduleJson(created) }, 201)
  })

  app.patch('/teams/:id/members/:userId/schedules/:sid', async (c) => {
    const { repos, user } = c.get('auth')
    const found = await managedMember(repos, user, c.req.param('id'), c.req.param('userId'))
    if (!found.ok) return found.response
    const existing = await repos.availability.byId(found.member.id, c.req.param('sid'))
    if (!existing) return notFound('schedule')
    const parsed = await readBody(c.req.raw, schedulePatchBody)
    if (!parsed.ok) return parsed.response
    const patch = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.timezone !== undefined ? { timezone: parsed.data.timezone } : {}),
      ...(parsed.data.weekly !== undefined ? { weekly: parsed.data.weekly as unknown as WeeklySchedule } : {}),
      ...(parsed.data.overrides !== undefined ? { overrides: parsed.data.overrides } : {}),
    }
    await repos.availability.update(found.member.id, existing.id, patch, user.id)
    // The member's default schedule's zone drives their booking page's
    // calendar — same mirror the dashboard keeps.
    if (existing.isDefault && patch.timezone && patch.timezone !== found.member.tz) {
      await repos.users.update(found.member.id, { tz: patch.timezone })
    }
    const updated = await repos.availability.byId(found.member.id, existing.id)
    return c.json({ data: updated ? scheduleJson(updated) : null })
  })

  app.delete('/event-types/:id', async (c) => {
    const { repos, user } = c.get('auth')
    const et = await repos.eventTypes.byId(c.req.param('id'))
    if (!et || !(await ownsEventType(repos, user, et))) return notFound('event type')
    if (!(await canEditEventType(repos, user, et))) {
      return problem(403, 'Forbidden', "Only an admin of the team that owns this event type can delete it.")
    }
    const deleted = await repos.eventTypes.delete(et.id, ports.clock.now())
    if (!deleted) {
      return problem(
        409,
        'Event type in use',
        'This event type still has upcoming confirmed bookings. Cancel or let them pass first, ' +
          'or set `active: false` to stop taking new ones while keeping the existing meetings intact.',
      )
    }
    return c.body(null, 204)
  })

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------
  app.get('/availability', async (c) => {
    const { repos, user } = c.get('auth')
    const availability = await repos.availability.forUser(user.id)
    // An unset schedule is "never available", not an error: a host who has not
    // configured hours has a well-defined answer, and a 404 here would make
    // every client special-case first use.
    return c.json({ data: availabilityJson(availability ?? emptyAvailability(user)) })
  })

  app.put('/availability', async (c) => {
    const { repos, user } = c.get('auth')
    const parsed = await readBody(c.req.raw, availabilityBody)
    if (!parsed.ok) return parsed.response

    const patch = {
      timezone: parsed.data.timezone,
      weekly: parsed.data.weekly as unknown as WeeklySchedule,
      overrides: parsed.data.overrides,
    }
    // This endpoint's contract is unchanged: it always writes the
    // caller's DEFAULT schedule, never a specific one — schedule CRUD is
    // dashboard-only for now. `forUser` should never be null for an
    // authenticated caller (the login backfill guarantees a default
    // schedule exists), but a fresh `create` covers it defensively rather
    // than throwing.
    const existing = await repos.availability.forUser(user.id)
    if (existing) {
      await repos.availability.update(user.id, existing.id, patch)
    } else {
      await repos.availability.create(user.id, {
        id: `sch_${ports.crypto.randomToken(12)}`,
        userId: user.id,
        name: 'Working hours',
        isDefault: true,
        ...patch,
      })
    }
    // GET /slots (and the public booking page) default their render
    // timezone to `users.tz` when the caller doesn't pass one explicitly —
    // leaving the two to drift means every unqualified request after this
    // still renders in the OLD timezone. Same fix as the dashboard's
    // availability route.
    if (patch.timezone !== user.tz) {
      await repos.users.update(user.id, { tz: patch.timezone })
    }
    const stored = await repos.availability.forUser(user.id)
    return c.json({ data: availabilityJson(stored ?? { userId: user.id, ...patch }) })
  })

  // -------------------------------------------------------------------------
  // Slots
  // -------------------------------------------------------------------------
  app.get('/slots', async (c) => {
    const { repos, user, scope } = c.get('auth')
    const eventTypeId = c.req.query('eventTypeId')
    if (!eventTypeId) return problem(400, 'Invalid request', '`eventTypeId` is required.')

    const eventType = await repos.eventTypes.byId(eventTypeId)
    if (!eventType || !(await ownsEventType(repos, user, eventType))) return notFound('event type')

    const range = parseRange(c.req.query('from'), c.req.query('to'), ports.clock.now(), 7 * 24 * 3_600_000)
    if (!range.ok) return range.response

    const tz = c.req.query('tz')
    if (tz !== undefined && !isValidTimeZone(tz)) {
      return problem(400, 'Invalid request', '`tz` must be an IANA timezone name, e.g. Europe/Berlin.')
    }
    const renderZone = tz ?? user.tz

    const hostUsers = await resolveHosts(repos, eventType, user)
    // The listing rides the same unconstrained session as the rest of this GET:
    // a slot list is advisory and the commit path arbitrates (ADR-0007 §2).
    const found = await slots.forEventType({ eventType, hostUsers, range: range.range, scope })

    return c.json({
      data: found.map((slot) => slotJson(slot, renderZone)),
      meta: {
        eventTypeId: eventType.id,
        timezone: renderZone,
        from: new Date(range.range.start).toISOString(),
        to: new Date(range.range.end).toISOString(),
      },
    })
  })

  // -------------------------------------------------------------------------
  // Bookings
  // -------------------------------------------------------------------------
  app.get('/bookings', async (c) => {
    const { repos, user } = c.get('auth')
    const range = parseRange(c.req.query('from'), c.req.query('to'), ports.clock.now(), 30 * 24 * 3_600_000)
    if (!range.ok) return range.response

    const status = c.req.query('status')
    // The host+range query returns confirmed bookings only — that is the shape
    // the port offers (ADR-0003 keeps it minimal), and it is the shape the slot
    // engine needs. Accepting `cancelled`/`rescheduled` here used to validate
    // as an allowed value and then always return an empty list — indistinguishable
    // from "you have none in this range" from the caller's side. Rejecting them
    // outright is the honest response; a cancelled/rescheduled booking is still
    // reachable by id.
    if (status !== undefined && status !== 'confirmed') {
      return problem(
        400,
        'Invalid request',
        'This endpoint only lists confirmed bookings in a range; `status` may only be `confirmed`. Fetch a cancelled or rescheduled booking by id instead.',
      )
    }

    const bookings = await repos.bookings.listForHost(user.id, range.range)
    return c.json({ data: bookings.map(bookingJson) })
  })

  app.get('/bookings/:id', async (c) => {
    const { repos, user } = c.get('auth')
    const booking = await repos.bookings.byId(c.req.param('id'))
    if (!booking || !isHost(booking, user)) return notFound('booking')
    return c.json({ data: bookingJson(booking) })
  })

  app.post('/bookings', async (c) => {
    const { repos, user } = c.get('auth')
    const parsed = await readBody(c.req.raw, bookingCreateBody)
    if (!parsed.ok) return parsed.response
    const body = parsed.data

    const start = toInstant(body.start)
    if (start === null) {
      return problem(400, 'Invalid request', '`start` must be ISO-8601 with an offset, or epoch milliseconds.')
    }

    const eventType = await repos.eventTypes.byId(body.eventTypeId)
    if (!eventType || !(await ownsEventType(repos, user, eventType))) return notFound('event type')

    // Normalized to today's question ids (also the same-labeled-question
    // legacy-key fallback) BEFORE validating and storing — a raw pass-through
    // would both let undeclared keys reach the host's calendar event
    // unfiltered and, once validated via the fallback, persist an answer
    // under a stale id that no longer matches any current question.
    const declaredAnswers = pickDeclaredAnswers(eventType, body.answers)
    const answerErrors = validateAnswers(eventType, declaredAnswers)
    if (Object.keys(answerErrors).length > 0) {
      return problem(400, 'Invalid request', 'One or more answers are invalid.', {
        errors: Object.entries(answerErrors).map(([field, message]) => ({ field: `answers.${field}`, message })),
      })
    }

    const hostUsers = await resolveHosts(repos, eventType, user)
    const outcome = await ports.coordinator.book(hostUsers[0]?.id ?? user.id, {
      eventTypeId: eventType.id,
      hostUserIds: hostUsers.map((u) => u.id),
      start,
      end: start + eventType.durationMinutes * 60_000,
      guestName: body.guestName,
      guestEmail: body.guestEmail,
      guestTimezone: body.guestTimezone ?? user.tz,
      answers: declaredAnswers,
      // Passed straight through: the coordinator owns deduplication (ADR-0002
      // §4), so a retried POST returns the booking it already made instead of
      // making a second one.
      idempotencyKey: c.req.header('idempotency-key') ?? undefined,
    })

    if (!outcome.ok) return bookingFailure(outcome.reason, outcome.detail)
    return c.json({ data: bookingJson(outcome.booking) }, 201)
  })

  app.post('/bookings/:id/cancel', async (c) => {
    const { repos, user } = c.get('auth')
    const parsed = await readBody(c.req.raw, cancelBody)
    if (!parsed.ok) return parsed.response

    const booking = await repos.bookings.byId(c.req.param('id'))
    if (!booking || !isHost(booking, user)) return notFound('booking')
    if (booking.status !== 'confirmed') {
      return problem(409, 'Not cancellable', `This booking is already ${booking.status}.`)
    }

    const now = ports.clock.now()
    // Conditional on the current status: a concurrent request (a racing
    // reschedule, a retried cancel) can change the booking between the read
    // above and this write.
    const cancelled = await repos.bookings.cancelWithLockRelease(booking.id, now)
    if (!cancelled) {
      const fresh = await repos.bookings.byId(booking.id)
      return problem(409, 'Not cancellable', `This booking is already ${fresh?.status ?? 'no longer confirmed'}.`)
    }

    const eventType = await repos.eventTypes.byId(booking.eventTypeId)
    if (eventType) {
      // Shared with the guest-manage and dashboard cancel paths: sends to
      // BOTH parties with the .ics METHOD:CANCEL, and fires the
      // `booking.cancelled` webhook. The REST route used to have its own
      // guest-only, no-webhook, no-.ics helper — this is the same class of
      // gap already fixed on the other two paths.
      await notifyBookingCancelled({
        ports,
        // Patched, not the pre-write `booking`: notifyWebhooks serializes
        // `booking.status` straight into the payload, so a `booking.cancelled`
        // event would otherwise report status "confirmed" — the value it had
        // before this same request just cancelled it.
        booking: { ...booking, status: 'cancelled', cancelledAt: now },
        eventType,
        host: user,
        cancelledBy: 'host',
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      }).catch((err) => console.error('[punctual] rest cancellation notify failed', err))
    }
    // After the commit, deliberately: a calendar API failing must not undo a
    // cancellation the caller has already been told about.
    await ports.queue
      .send({ kind: 'calendar.sync', bookingId: booking.id, action: 'delete' })
      .catch(() => {})

    const updated = await repos.bookings.byId(booking.id)
    return c.json({ data: bookingJson(updated ?? { ...booking, status: 'cancelled', cancelledAt: now }) })
  })

  app.post('/bookings/:id/reschedule', async (c) => {
    const { repos, user } = c.get('auth')
    const parsed = await readBody(c.req.raw, rescheduleBody)
    if (!parsed.ok) return parsed.response

    const start = toInstant(parsed.data.start)
    if (start === null) {
      return problem(400, 'Invalid request', '`start` must be ISO-8601 with an offset, or epoch milliseconds.')
    }

    const original = await repos.bookings.byId(c.req.param('id'))
    if (!original || !isHost(original, user)) return notFound('booking')
    if (original.status !== 'confirmed') {
      return problem(409, 'Not reschedulable', `This booking is already ${original.status}.`)
    }

    const eventType = await repos.eventTypes.byId(original.eventTypeId)
    if (!eventType) return notFound('event type')

    const hostUsers = await resolveHosts(repos, eventType, user)
    // Book the new time BEFORE releasing the old one. The invariant worth
    // protecting is that a confirmed booking always holds its `slot_locks`
    // rows; releasing first would open a window where the old meeting exists
    // with nothing defending its time, and nothing in the ports can put those
    // locks back if the new time turns out to be taken. The cost is that a
    // move into the old booking's own buffered footprint 409s — callers who
    // need that cancel and rebook.
    const outcome = await ports.coordinator.book(hostUsers[0]?.id ?? user.id, {
      eventTypeId: eventType.id,
      hostUserIds: hostUsers.map((u) => u.id),
      start,
      end: start + eventType.durationMinutes * 60_000,
      guestName: original.guestName,
      guestEmail: original.guestEmail,
      guestTimezone: original.guestTimezone,
      answers: original.answers,
      rescheduleOf: original.id,
      idempotencyKey: c.req.header('idempotency-key') ?? undefined,
    })
    if (!outcome.ok) return bookingFailure(outcome.reason, outcome.detail)

    // Conditional on the current status: a concurrent request against the
    // same original booking can win between the read above and here. If it
    // did, the booking `coordinator.book` just created is a real, confirmed,
    // but orphaned duplicate — release it rather than leave it live.
    const moved = await repos.bookings.markRescheduled(original.id, outcome.booking.id)
    if (!moved) {
      await repos.bookings.cancelWithLockRelease(outcome.booking.id, ports.clock.now())
      await ports.queue
        .send({ kind: 'calendar.sync', bookingId: outcome.booking.id, action: 'delete' })
        .catch(() => {})
      const fresh = await repos.bookings.byId(original.id)
      return problem(409, 'Not reschedulable', `This booking is already ${fresh?.status ?? 'no longer confirmed'}.`)
    }
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
    await ports.queue
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
          ports,
          outcome.manageToken,
        ).catch((e) => console.error('[punctual] reschedule fallback failed', e))
      })

    // The "Rescheduled" mail for the NEW leg is dispatched by the
    // calendar-sync handler, not here: the new booking's Meet link
    // does not exist until its calendar event does, and the email body is
    // rendered at enqueue time. The handler branches on `rescheduleOf` to
    // send the rescheduled copy rather than a fresh confirmation.
    await ports.queue
      .send({ kind: 'calendar.sync', bookingId: original.id, action: 'delete' })
      .catch(() => {})

    return c.json({ data: bookingJson(outcome.booking), meta: { rescheduledFrom: original.id } }, 201)
  })

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------
  app.get('/webhooks', async (c) => {
    const { repos, user } = c.get('auth')
    const list = await repos.webhooks.listForUser(user.id)
    return c.json({ data: list.map(webhookJson) })
  })

  app.post('/webhooks', async (c) => {
    const { repos, user } = c.get('auth')
    const parsed = await readBody(c.req.raw, webhookCreateBody)
    if (!parsed.ok) return parsed.response

    const webhook: Webhook = {
      id: `whk_${ports.crypto.randomToken(12)}`,
      userId: user.id,
      secret: ports.crypto.randomToken(24),
      url: parsed.data.url,
      events: parsed.data.events as WebhookEvent[],
      active: true,
      createdAt: ports.clock.now(),
    }
    await repos.webhooks.create(webhook)

    // The secret is returned exactly once, here — it is what the receiver
    // verifies the HMAC with, and it is never listed again.
    return c.json({ data: { ...webhookJson(webhook), secret: webhook.secret } }, 201)
  })

  app.delete('/webhooks/:id', async (c) => {
    const { repos, user } = c.get('auth')
    const webhook = await repos.webhooks.byId(c.req.param('id'))
    if (!webhook || webhook.userId !== user.id) return notFound('webhook')
    await repos.webhooks.delete(webhook.id)
    return c.body(null, 204)
  })

  app.notFound(() => problem(404, 'Not found', 'No such API endpoint.'))

  return app
}

// ---------------------------------------------------------------------------
// Shared helpers — also used by the MCP server
// ---------------------------------------------------------------------------

/** Hosts for an event type — the shared resolver, as users (core/domain/hosts.ts). */
export async function resolveHosts(repos: Repositories, eventType: EventType, fallback: User): Promise<User[]> {
  return hostUsers(await resolveEventTypeHosts(repos, eventType, fallback))
}

/**
 * Whether this key's user may act on this event type.
 *
 * Answered as "not found" rather than "forbidden" at call sites: telling an
 * arbitrary key holder that an id exists but is someone else's is an
 * enumeration oracle over every host on the deployment.
 */
export async function ownsEventType(
  repos: Repositories,
  user: User,
  eventType: EventType,
): Promise<boolean> {
  if (eventType.ownerUserId === user.id) return true
  if (eventType.ownerTeamId) {
    const memberships = await repos.teams.memberships(user.id)
    return memberships.some((m) => m.teamId === eventType.ownerTeamId)
  }
  return false
}

/**
 * Whether `user` may CHANGE an event type — stricter than `ownsEventType`
 * for a team's: reading, listing and booking a team event type is every
 * member's, editing and deleting it is its admins' (core/domain/teams.ts),
 * the same split the dashboard makes.
 */
export async function canEditEventType(
  repos: Repositories,
  user: User,
  eventType: EventType,
): Promise<boolean> {
  if (eventType.ownerUserId === user.id) return true
  if (eventType.ownerTeamId) {
    const memberships = await repos.teams.memberships(user.id)
    return canManageTeam(user, memberships.find((m) => m.teamId === eventType.ownerTeamId))
  }
  return false
}

export function isHost(booking: Booking, user: User): boolean {
  return booking.hostUserId === user.id || booking.hostUserIds.includes(user.id)
}

export function notFound(what: string): Response {
  return problem(404, 'Not found', `No such ${what}.`)
}

/** One mapping from a coordinator refusal to a status code, for REST and MCP. */
export function bookingFailure(
  reason: 'slot_taken' | 'outside_availability' | 'policy' | 'lease_failed',
  detail?: string,
): Response {
  switch (reason) {
    case 'slot_taken':
      return problem(409, 'Slot taken', detail ?? 'That time was booked while this request was in flight.')
    case 'outside_availability':
      return problem(409, 'Outside availability', detail ?? 'That time is not bookable for this event type.')
    case 'lease_failed':
      // Retryable, unlike the two above: nothing is wrong with the request.
      return problem(503, 'Busy', 'Another booking is being committed for these hosts. Retry shortly.', {
        headers: { 'retry-after': '1' },
      })
    case 'policy':
      return problem(422, 'Rejected by policy', detail ?? 'This booking is not allowed.')
  }
}

/**
 * A malformed body is a 400 that says so, never a thrown 500 and never a
 * confusing list of "required field missing" errors about a body that was
 * simply not JSON. An EMPTY body is `{}`, so endpoints whose fields are all
 * optional work without one.
 */
async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  let raw: string
  try {
    raw = await request.text()
  } catch {
    return { ok: false, response: problem(400, 'Invalid request', 'The request body could not be read.') }
  }
  if (raw.trim() === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false, response: problem(400, 'Invalid request', 'The request body is not valid JSON.') }
  }
}

/** Read + validate in one step, since every write endpoint does exactly this. */
async function readBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: Response }> {
  const body = await readJson(request)
  if (!body.ok) return body
  const parsed = schema.safeParse(body.value)
  if (!parsed.success) return { ok: false, response: zodProblem(parsed.error) }
  return { ok: true, data: parsed.data as z.infer<T> }
}

function emptyAvailability(user: User): Availability {
  return {
    userId: user.id,
    timezone: user.tz,
    weekly: [[], [], [], [], [], [], []],
    overrides: [],
  }
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Instants are rendered as ISO-8601 AND epoch milliseconds.
 *
 * Redundant on purpose: the ISO string is what a human reads in a log, the
 * number is what survives a round trip through a client that reformats dates.
 */
function instantJson(ts: number): { iso: string; epochMs: number } {
  return { iso: new Date(ts).toISOString(), epochMs: ts }
}

/**
 * The public URL's first segment is the OWNER's slug — the team's for a
 * team-owned event type, never the calling user's, whose personal slug would
 * make a dead link for anything a team owns.
 */
export function eventTypeJson(
  et: EventType,
  ports: EnginePorts,
  ownerSlug: string,
  hosts: ResolvedHost[] = [],
): Record<string, unknown> {
  return {
    id: et.id,
    slug: et.slug,
    url: `${trimSlash(ports.config.baseUrl)}/${ownerSlug}/${et.slug}`,
    title: et.title,
    description: et.description,
    schedulingType: et.schedulingType,
    ownerTeamId: et.ownerTeamId,
    // Who hosts it, in display order (core/domain/hosts.ts): the owner for
    // a personal event type; the explicit set, or every member, for a
    // team's. `required` only matters for collective; `weight` only for
    // round robin; `scheduleId` is that host's per-event schedule (null =
    // their default) and is theirs or an admin's to change via
    // PATCH /event-types/:id/hosts/:userId.
    hosts: hosts.map((h) => ({
      userId: h.user.id,
      name: h.user.name || h.user.slug,
      required: h.required,
      weight: h.rrWeight,
      scheduleId: h.scheduleId,
    })),
    durationMinutes: et.durationMinutes,
    slotIntervalMinutes: et.slotIntervalMinutes,
    bufferBeforeMinutes: et.bufferBeforeMinutes,
    bufferAfterMinutes: et.bufferAfterMinutes,
    minNoticeMinutes: et.minNoticeMinutes,
    maxHorizonDays: et.maxHorizonDays,
    maxPerDay: et.maxPerDay,
    locationType: et.locationType,
    locationValue: et.locationValue,
    // Effective, not declared — same reasoning as the MCP listing: a client
    // rendering a booking form from this resource can only ask questions it
    // can see, and POST /bookings already validates an `agenda` answer. The
    // update round-trip this creates is benign: echoing the builtin back
    // declares an identical copy, and `effectiveQuestions` then returns
    // exactly that.
    questions: effectiveQuestions(et),
    active: et.active,
    createdAt: instantJson(et.createdAt),
    // Null = the owner's default schedule; only ever non-null for a
    // personal event type (see EventType.scheduleId's doc comment).
    scheduleId: et.scheduleId,
  }
}

export function availabilityJson(availability: Availability): Record<string, unknown> {
  return {
    timezone: availability.timezone,
    weekly: availability.weekly,
    overrides: availability.overrides,
  }
}

export function bookingJson(booking: Booking): Record<string, unknown> {
  return {
    id: booking.id,
    eventTypeId: booking.eventTypeId,
    hostUserId: booking.hostUserId,
    hostUserIds: booking.hostUserIds,
    guestName: booking.guestName,
    guestEmail: booking.guestEmail,
    guestTimezone: booking.guestTimezone,
    start: instantJson(booking.startUtc),
    end: instantJson(booking.endUtc),
    localDate: booking.localDate,
    status: booking.status,
    answers: booking.answers,
    rescheduleOf: booking.rescheduleOf,
    rescheduledTo: booking.rescheduledTo,
    cancelledAt: booking.cancelledAt === null ? null : instantJson(booking.cancelledAt),
    createdAt: instantJson(booking.createdAt),
  }
}

export function slotJson(slot: Slot, timezone: string): Record<string, unknown> {
  return {
    start: instantJson(slot.start),
    end: instantJson(slot.end),
    localDate: localDateString(slot.start, timezone),
    localTime: formatInZone(slot.start, timezone, { hour: '2-digit', minute: '2-digit' }),
    eligibleHostIds: slot.eligibleHostIds,
  }
}

export function webhookJson(webhook: Webhook): Record<string, unknown> {
  return {
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    active: webhook.active,
    createdAt: instantJson(webhook.createdAt),
  }
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}
