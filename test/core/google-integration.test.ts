import { describe, expect, it } from 'vitest'
import { createGoogleProvider } from '../../src/adapters/google/provider.js'
import { createEnvOAuthCredentials } from '../../src/adapters/oauth.js'
import { computeSlots } from '../../src/core/slots/engine.js'
import { combineBusy } from '../../src/core/domain/booking-service.js'
import { localTimeToInstant } from '../../src/core/time/zone.js'
import type { CalendarConnection, EventType, WeeklySchedule } from '../../src/core/domain/types.js'
import type { OAuthTokens } from '../../src/core/domain/types.js'

/**
 * The Google path end to end, against a scripted Google.
 *
 * The existing suite covers the PARSERS in isolation. This covers the wiring
 * that sits between them and is where integrations actually break: the request
 * we send, the token refresh we perform first, what the parsed busy time does
 * to the slot list, and how a revoked grant surfaces.
 *
 * It cannot prove Google's real responses match these fixtures — only a live
 * connection does that. The fixtures are taken from Google's
 * documented response shapes, and the parsers already accept both variants the
 * docs disagree on.
 */

const HOUR = 3_600_000
const DAY = 86_400_000
const TZ = 'Europe/Kyiv'

interface Call {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
}

/** A scripted Google. Records what we sent, replies with what Google would. */
function scriptGoogle(routes: Array<[RegExp, (body: unknown) => { status?: number; json: unknown }]>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    let body: unknown = undefined
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = Object.fromEntries(new URLSearchParams(init.body))
      }
    }
    calls.push({ url, method, body, headers: (init?.headers ?? {}) as Record<string, string> })

    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) {
        const { status = 200, json } = handler(body)
        return new Response(JSON.stringify(json), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    return new Response(JSON.stringify({ error: 'no route', url }), { status: 501 })
  }) as typeof globalThis.fetch

  return { fetchImpl, calls }
}

const VALID_TOKENS: OAuthTokens = {
  accessToken: 'ya29.valid',
  refreshToken: '1//refresh',
  expiresAt: Date.now() + HOUR,
  scope: 'https://www.googleapis.com/auth/calendar.events',
}

function connection(over: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 'conn_1',
    userId: 'u1',
    provider: 'google',
    providerAccountEmail: 'serge@example.com',
    encryptedTokens: 'unused-in-these-tests',
    keyVersion: 1,
    calendarIdsRead: ['primary'],
    calendarIdWrite: 'primary',
    syncStatus: 'ok',
    createdAt: 0,
    ...over,
  }
}

/** Deps with the token layer stubbed: these tests are about the wiring above it. */
function deps(
  fetchImpl: typeof globalThis.fetch,
  tokens: OAuthTokens = VALID_TOKENS,
  onRefresh: (id: string, t: OAuthTokens) => Promise<void> = async () => {},
) {
  return {
    oauth: createEnvOAuthCredentials(
      { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' },
      'https://punctual.sh',
    ),
    crypto: {
      decrypt: async () => JSON.stringify(tokens),
      randomToken: (n = 16) => 'r'.repeat(n),
    },
    clock: { now: () => Date.now() },
    onTokensRefreshed: onRefresh,
    fetch: fetchImpl,
  }
}

describe('Google freeBusy → busy intervals', () => {
  it('sends the range Google expects and parses the reply', async () => {
    const start = localTimeToInstant('2026-06-15', 0, TZ)
    const end = start + DAY
    const busyStart = localTimeToInstant('2026-06-15', 10 * 60, TZ)

    const { fetchImpl, calls } = scriptGoogle([
      [
        /freeBusy/,
        () => ({
          json: {
            kind: 'calendar#freeBusy',
            calendars: {
              primary: {
                busy: [
                  {
                    start: new Date(busyStart).toISOString(),
                    end: new Date(busyStart + HOUR).toISOString(),
                  },
                ],
              },
            },
          },
        }),
      ],
    ])

    const provider = createGoogleProvider(deps(fetchImpl) as never)
    const busy = await provider.getBusy(connection(), { start, end })

    // The request carried the window and the calendar we asked about.
    expect(calls).toHaveLength(1)
    const sent = calls[0]!.body as { timeMin: string; timeMax: string; items: Array<{ id: string }> }
    expect(new Date(sent.timeMin).getTime()).toBe(start)
    expect(new Date(sent.timeMax).getTime()).toBe(end)
    expect(sent.items).toEqual([{ id: 'primary' }])

    // And the reply became exactly one busy interval, unbuffered.
    expect(busy).toEqual([{ start: busyStart, end: busyStart + HOUR }])
  })

  it('an empty calendar yields no busy time rather than throwing', async () => {
    const { fetchImpl } = scriptGoogle([
      [/freeBusy/, () => ({ json: { calendars: { primary: { busy: [] } } } })],
    ])
    const provider = createGoogleProvider(deps(fetchImpl) as never)
    const start = localTimeToInstant('2026-06-15', 0, TZ)
    expect(await provider.getBusy(connection(), { start, end: start + DAY })).toEqual([])
  })

  it('a per-calendar error is NOT silently treated as free', async () => {
    // Google reports per-calendar failures inside a 200. Treating that as "no
    // busy time" is the shortest path to a double booking.
    const { fetchImpl } = scriptGoogle([
      [
        /freeBusy/,
        () => ({
          json: {
            calendars: {
              primary: { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] },
            },
          },
        }),
      ],
    ])
    const provider = createGoogleProvider(deps(fetchImpl) as never)
    const start = localTimeToInstant('2026-06-15', 0, TZ)
    await expect(provider.getBusy(connection(), { start, end: start + DAY })).rejects.toThrow()
  })
})

describe('busy time actually removes slots', () => {
  it('a Google event takes its slots out of the booking page', async () => {
    const start = localTimeToInstant('2026-06-15', 0, TZ)
    const dayEnd = localTimeToInstant('2026-06-16', 0, TZ)
    const meeting = localTimeToInstant('2026-06-15', 10 * 60, TZ)

    const { fetchImpl } = scriptGoogle([
      [
        /freeBusy/,
        () => ({
          json: {
            calendars: {
              primary: {
                busy: [
                  {
                    start: new Date(meeting).toISOString(),
                    end: new Date(meeting + HOUR).toISOString(),
                  },
                ],
              },
            },
          },
        }),
      ],
    ])

    const provider = createGoogleProvider(deps(fetchImpl) as never)
    const external = await provider.getBusy(connection(), { start, end: dayEnd })

    const weekly = [
      [],
      [{ startMinute: 540, endMinute: 1020 }],
      [{ startMinute: 540, endMinute: 1020 }],
      [{ startMinute: 540, endMinute: 1020 }],
      [{ startMinute: 540, endMinute: 1020 }],
      [{ startMinute: 540, endMinute: 1020 }],
      [],
    ] as WeeklySchedule

    const et: EventType = {
      id: 'et1', ownerUserId: 'u1', ownerTeamId: null, schedulingType: 'personal',
      slug: '30min', title: '30 min', description: '', durationMinutes: 30,
      slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
      minNoticeMinutes: 0, maxHorizonDays: 365, maxPerDay: null,
      locationType: 'google_meet', locationValue: null, questions: [],
      active: true, createdAt: 0,
    }

    const hosts = [
      {
        hostUserId: 'u1',
        availability: { userId: 'u1', timezone: TZ, weekly, overrides: [] },
        busy: combineBusy([], [], external),
      },
    ]

    const withBusy = computeSlots({ eventType: et, hosts, range: { start, end: dayEnd }, now: start - DAY })
    const withoutBusy = computeSlots({
      eventType: et,
      hosts: [{ ...hosts[0]!, busy: [] }],
      range: { start, end: dayEnd },
      now: start - DAY,
    })

    // Monday 09:00-17:00 is 16 slots; the Google meeting removes two.
    expect(withoutBusy).toHaveLength(16)
    expect(withBusy).toHaveLength(14)
    expect(withBusy.some((s) => s.start >= meeting && s.start < meeting + HOUR)).toBe(false)
  })
})

describe('creating the event on the host calendar', () => {
  it('posts the meeting and requests a Meet link', async () => {
    const { fetchImpl, calls } = scriptGoogle([
      [/events\?|events$/, () => ({ json: { id: 'evt_123', hangoutLink: 'https://meet.google.com/abc' } })],
    ])
    const provider = createGoogleProvider(deps(fetchImpl) as never)
    const start = localTimeToInstant('2026-06-15', 10 * 60, TZ)

    const id = await provider.createEvent(connection(), {
      title: '30 min intro',
      description: 'Booked via Punctual',
      start,
      end: start + 30 * 60_000,
      attendees: [{ email: 'guest@example.com', name: 'Guest' }],
      timezone: TZ,
      createConference: true,
    })

    expect(id).toBe('evt_123')
    const call = calls[0]!
    // conferenceDataVersion=1 is REQUIRED or Google silently drops the Meet
    // link, which is the whole point of the location type.
    expect(call.url).toContain('conferenceDataVersion=1')
    const body = call.body as {
      summary: string
      start: { dateTime: string }
      attendees: Array<{ email: string }>
      conferenceData?: { createRequest?: { requestId?: string } }
    }
    expect(body.summary).toBe('30 min intro')
    expect(new Date(body.start.dateTime).getTime()).toBe(start)
    expect(body.attendees.map((a) => a.email)).toContain('guest@example.com')
    expect(body.conferenceData?.createRequest?.requestId).toBeTruthy()
  })

  it('does not request a conference when the event type does not want one', async () => {
    const { fetchImpl, calls } = scriptGoogle([[/events/, () => ({ json: { id: 'evt_2' } })]])
    const provider = createGoogleProvider(deps(fetchImpl) as never)
    const start = localTimeToInstant('2026-06-15', 10 * 60, TZ)
    await provider.createEvent(connection(), {
      title: 'Phone call',
      description: '',
      start,
      end: start + 30 * 60_000,
      attendees: [{ email: 'g@example.com' }],
      timezone: TZ,
      createConference: false,
    })
    const body = calls[0]!.body as { conferenceData?: unknown }
    expect(body.conferenceData).toBeUndefined()
  })
})

describe('token lifecycle', () => {
  it('refreshes an expired access token before calling, and persists the result', async () => {
    const expired: OAuthTokens = { ...VALID_TOKENS, accessToken: 'ya29.stale', expiresAt: Date.now() - HOUR }
    const persisted: OAuthTokens[] = []

    const { fetchImpl, calls } = scriptGoogle([
      [/oauth2.*token|token$/, () => ({ json: { access_token: 'ya29.fresh', expires_in: 3600 } })],
      [/freeBusy/, () => ({ json: { calendars: { primary: { busy: [] } } } })],
    ])

    const provider = createGoogleProvider(
      deps(fetchImpl, expired, async (_id: string, t: OAuthTokens) => {
        persisted.push(t)
      }) as never,
    )
    const start = localTimeToInstant('2026-06-15', 0, TZ)
    await provider.getBusy(connection(), { start, end: start + DAY })

    // Refresh first, then the actual call — and with the NEW token.
    expect(calls[0]!.url).toMatch(/token/)
    expect(calls[1]!.url).toMatch(/freeBusy/)
    expect(JSON.stringify(calls[1]!.headers)).toContain('ya29.fresh')

    // Persisted before use: Google does not return a new refresh token, so the
    // old one must be carried forward rather than dropped.
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.accessToken).toBe('ya29.fresh')
    expect(persisted[0]!.refreshToken).toBe('1//refresh')
  })

  it('a revoked grant surfaces as needs-reconnect, not a generic failure', async () => {
    const expired: OAuthTokens = { ...VALID_TOKENS, expiresAt: Date.now() - HOUR }
    const { fetchImpl } = scriptGoogle([
      [/token/, () => ({ status: 400, json: { error: 'invalid_grant' } })],
    ])
    const provider = createGoogleProvider(deps(fetchImpl, expired) as never)
    const start = localTimeToInstant('2026-06-15', 0, TZ)

    // The caller distinguishes this to set sync_status='needs_reconnect' and
    // prompt the host, rather than failing bookings silently (ADR-0005 §6).
    await expect(provider.getBusy(connection(), { start, end: start + DAY })).rejects.toMatchObject({
      needsReconnect: true,
    })
  })
})

describe('OAuth configuration', () => {
  it('separates identity from calendar consent (ADR-0005 §1)', () => {
    const oauth = createEnvOAuthCredentials(
      { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' },
      'https://punctual.sh',
    )
    const identity = oauth.redirectUri('google', 'identity')
    const calendar = oauth.redirectUri('google', 'calendar')
    expect(identity).not.toBe(calendar)
    expect(identity).toContain('punctual.sh')
    // Purpose is inside the registered URI, so a code issued for one flow is
    // useless at the other endpoint.
    expect(identity).toContain('identity')
    expect(calendar).toContain('calendar')
  })

  it('reports a provider as unavailable when its credentials are absent', () => {
    const oauth = createEnvOAuthCredentials({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'c' }, 'https://punctual.sh')
    expect(oauth.forProvider('google')).not.toBeNull()
    // A self-hoster may configure only one provider; the other must not throw.
    expect(oauth.forProvider('microsoft')).toBeNull()
  })
})
