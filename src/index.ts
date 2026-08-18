/**
 * The Worker entry point — the OSS deployment.
 *
 * This file is the ONLY place bindings are read. Everything below it receives
 * ports (ADR-0003), which is what lets `cloud/` reuse the identical engine with
 * tenant-scoped repositories and its own credentials.
 *
 * A self-hoster's whole setup is: create a D1 and a KV, put two secrets in,
 * `npm run migrate`, `wrangler deploy`.
 */

import { createEngine } from './engine.js'
import { createD1Repositories } from './adapters/d1/repositories.js'
import { createWebCrypto } from './adapters/crypto/webcrypto.js'
import { createKvCache } from './adapters/cache/kv.js'
import { createBrevoSender, createConsoleSender, createResendSender } from './adapters/email/index.js'
import { createEnvOAuthCredentials } from './adapters/oauth.js'
import { createCalendarProviders } from './adapters/providers.js'
import { createCoordinator } from './adapters/coordinator.js'
import { createQueueAdapter } from './adapters/queue/index.js'
import { createRateLimiterAdapter } from './adapters/rate-limiter.js'
import { handleOne, handleQueueBatch } from './adapters/queue/consumer.js'
import { runScheduledTasks } from './adapters/scheduled.js'
import type { EnginePorts, RequestScope } from './ports.js'

export { HostCalendar } from './do/host-calendar.js'
export { RateLimiter } from './do/rate-limiter.js'

export interface Env {
  DB: D1Database
  CACHE: KVNamespace
  HOST_CALENDAR: DurableObjectNamespace
  RATE_LIMITER: DurableObjectNamespace
  TASKS?: Queue
  BASE_URL: string
  BRAND_NAME?: string
  LEGAL_OPERATOR?: string
  DEMO_BOOKING_PATH?: string
  FROM_EMAIL?: string
  FROM_NAME?: string
  SUPPORT_EMAIL?: string
  TELEMETRY_ENABLED?: string
  ENCRYPTION_KEY_V1?: string
  ENCRYPTION_KEY_V2?: string
  SIGNING_KEY?: string
  RESEND_API_KEY?: string
  BREVO_API_KEY?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  MICROSOFT_CLIENT_ID?: string
  MICROSOFT_CLIENT_SECRET?: string
}

export function buildPorts(env: Env): EnginePorts {
  const baseUrl = env.BASE_URL ?? 'http://localhost:8787'

  // Key material. A missing key is a hard failure rather than a silent
  // fallback: silently encrypting refresh tokens with a default key would be
  // worse than refusing to start.
  const keys: Record<number, string> = {}
  if (env.ENCRYPTION_KEY_V1) keys[1] = env.ENCRYPTION_KEY_V1
  if (env.ENCRYPTION_KEY_V2) keys[2] = env.ENCRYPTION_KEY_V2
  const currentVersion = env.ENCRYPTION_KEY_V2 ? 2 : 1

  const crypto_ = createWebCrypto({
    keys,
    currentVersion,
    signingKey: env.SIGNING_KEY ?? '',
  })

  const oauth = createEnvOAuthCredentials(env, baseUrl)
  const cache = createKvCache(env.CACHE)
  const clock = { now: () => Date.now() }

  const repositories = (scope: RequestScope) => createD1Repositories(env.DB, scope)

  const calendars = createCalendarProviders({
    oauth,
    crypto: crypto_,
    clock,
    // Persist rotated tokens immediately: Microsoft rotates the refresh token
    // on every refresh, so failing to store it strands the connection.
    onTokensRefreshed: async (connectionId: string, tokens) => {
      const repos = createD1Repositories(env.DB, { consistency: 'bookmark' })
      const conn = await repos.connections.byId(connectionId)
      if (!conn) return
      const { ciphertext, keyVersion } = await crypto_.encrypt(
        JSON.stringify(tokens),
        `${conn.userId}|${conn.provider}|${conn.id}`,
      )
      await repos.connections.updateTokens(connectionId, ciphertext, keyVersion)
    },
  })

  // A self-hoster with no email provider still gets a working product; the
  // emails land in `wrangler tail` rather than nowhere.
  // Whichever provider is configured. Neither is required: with no key the
  // sender logs, so a self-hoster has a working product on day one and can
  // add deliverability later (ADR-0003 — the port exists so this is a choice,
  // not a gate).
  const emailFrom = env.FROM_EMAIL ?? 'hello@example.com'
  const emailFromName = env.FROM_NAME ?? 'Punctual'
  const email = env.RESEND_API_KEY
    ? createResendSender({ apiKey: env.RESEND_API_KEY, from: emailFrom, fromName: emailFromName })
    : env.BREVO_API_KEY
      ? createBrevoSender({ apiKey: env.BREVO_API_KEY, from: emailFrom, fromName: emailFromName })
      : createConsoleSender()

  // Queues is not on the free tier, and docs/self-hosting.md promises inline
  // delivery without it. The handler was never passed, so an unbound TASKS
  // meant bookings committed and nothing else EVER happened — no email, no
  // calendar sync. Late-bound because handleOne needs the finished ports.
  let portsRef: EnginePorts
  const queue = createQueueAdapter(env.TASKS, async (message) => {
    await handleOne(message, portsRef)
  })
  const rateLimiter = createRateLimiterAdapter(env.RATE_LIMITER)

  const ports: EnginePorts = {
    repositories,
    calendars,
    oauth,
    email,
    crypto: crypto_,
    cache,
    clock,
    queue,
    rateLimiter,
    config: {
      baseUrl,
      brandName: env.BRAND_NAME ?? 'Punctual',
      ...(env.LEGAL_OPERATOR ? { legalOperator: env.LEGAL_OPERATOR } : {}),
      ...(env.DEMO_BOOKING_PATH ? { demoBookingPath: env.DEMO_BOOKING_PATH } : {}),
      supportEmail: env.SUPPORT_EMAIL ?? 'hello@example.com',
      fromEmail: env.FROM_EMAIL ?? 'hello@example.com',
      fromName: env.FROM_NAME ?? 'Punctual',
      telemetryEnabled: env.TELEMETRY_ENABLED === '1',
    },
    // Constructed last: it needs the other ports.
    coordinator: undefined as never,
  }

  portsRef = ports
  ports.coordinator = createCoordinator({
    ports,
    hostCalendarNamespace: env.HOST_CALENDAR,
    repositories: () => createD1Repositories(env.DB, { consistency: 'bookmark' }),
  })

  return ports
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const engine = createEngine(buildPorts(env))
    return engine.fetch(request, env, ctx)
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    // A misconfigured deployment (no key material) must surface as a named
    // error and retried messages, not an unhandled rejection with no context.
    let ports: EnginePorts
    try {
      ports = buildPorts(env)
    } catch (err) {
      console.error('[punctual] cannot process queue: engine misconfigured', err)
      for (const m of batch.messages) m.retry()
      return
    }
    await handleQueueBatch(batch, ports)
  },

  /**
   * Every 5 minutes: expire holds, send due reminders, prune old locks.
   *
   * A 5-minute tick is deliberate — reminders are "24h before" and "1h
   * before", and finer granularity would cost Cron invocations to deliver an
   * email nobody notices arriving 4 minutes early.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      // The catch below only covers synchronous buildPorts; the task's own
      // rejection has to be caught on the promise handed to waitUntil.
      ctx.waitUntil(
        runScheduledTasks(buildPorts(env), event.scheduledTime).catch((err) =>
          console.error('[punctual] scheduled tasks failed', err),
        ),
      )
    } catch (err) {
      console.error('[punctual] cannot run scheduled tasks: engine misconfigured', err)
    }
  },
}
