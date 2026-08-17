import { describe, expect, it } from 'vitest'
import type { ExternalEvent } from '../../src/ports.js'
import { parseGoogleFreeBusy, toGoogleEvent } from '../../src/adapters/google/provider.js'
import {
  parseGraphDateTime,
  parseGraphSchedule,
  toGraphDateTimeZone,
  toGraphEvent,
} from '../../src/adapters/microsoft/provider.js'
import { createEnvOAuthCredentials, GOOGLE_CALENDAR_SCOPES, GOOGLE_IDENTITY_SCOPES } from '../../src/adapters/oauth.js'
import { partitionConnections } from '../../src/core/domain/booking-service.js'
import type { CalendarConnection } from '../../src/core/domain/types.js'

/**
 * Parsing and mapping only — no network, no Workers runtime. These are the
 * functions where a wrong answer is silent: a mis-parsed busy interval does not
 * throw, it offers a slot that is already taken.
 */

const MINUTE = 60_000

describe('parseGoogleFreeBusy', () => {
  it('maps the documented map-keyed response to intervals', () => {
    const json = {
      kind: 'calendar#freeBusy',
      calendars: {
        'primary': {
          busy: [
            { start: '2026-08-14T09:00:00Z', end: '2026-08-14T10:00:00Z' },
            { start: '2026-08-14T13:30:00Z', end: '2026-08-14T14:00:00Z' },
          ],
        },
      },
    }
    expect(parseGoogleFreeBusy(json)).toEqual([
      { start: Date.UTC(2026, 7, 14, 9), end: Date.UTC(2026, 7, 14, 10) },
      { start: Date.UTC(2026, 7, 14, 13, 30), end: Date.UTC(2026, 7, 14, 14) },
    ])
  })

  it('merges busy across several calendars without deduplicating', () => {
    // Not merged here on purpose: merging is the slot engine's job, and this
    // adapter must not decide that two calendars agreeing is one busy block.
    const json = {
      calendars: {
        work: { busy: [{ start: '2026-08-14T09:00:00Z', end: '2026-08-14T10:00:00Z' }] },
        personal: { busy: [{ start: '2026-08-14T09:30:00Z', end: '2026-08-14T11:00:00Z' }] },
      },
    }
    expect(parseGoogleFreeBusy(json)).toHaveLength(2)
  })

  it('accepts the array-shaped response some Google docs show', () => {
    const json = {
      calendars: [{ id: 'primary', busy: [{ start: '2026-08-14T09:00:00Z', end: '2026-08-14T09:15:00Z' }] }],
    }
    expect(parseGoogleFreeBusy(json)).toEqual([
      { start: Date.UTC(2026, 7, 14, 9), end: Date.UTC(2026, 7, 14, 9, 15) },
    ])
  })

  it('honours a non-UTC offset rather than assuming Z', () => {
    const json = { calendars: { primary: { busy: [{ start: '2026-08-14T11:00:00+02:00', end: '2026-08-14T12:00:00+02:00' }] } } }
    expect(parseGoogleFreeBusy(json)).toEqual([
      { start: Date.UTC(2026, 7, 14, 9), end: Date.UTC(2026, 7, 14, 10) },
    ])
  })

  it('yields [] for an empty busy array', () => {
    expect(parseGoogleFreeBusy({ calendars: { primary: { busy: [] } } })).toEqual([])
  })

  it('yields [] when busy is missing entirely', () => {
    expect(parseGoogleFreeBusy({ calendars: { primary: {} } })).toEqual([])
  })

  it('yields [] for an empty, missing or non-object response', () => {
    expect(parseGoogleFreeBusy({ calendars: {} })).toEqual([])
    expect(parseGoogleFreeBusy({})).toEqual([])
    expect(parseGoogleFreeBusy(null)).toEqual([])
    expect(parseGoogleFreeBusy('nope')).toEqual([])
  })

  it('drops degenerate zero-length busy blocks', () => {
    const json = { calendars: { primary: { busy: [{ start: '2026-08-14T09:00:00Z', end: '2026-08-14T09:00:00Z' }] } } }
    expect(parseGoogleFreeBusy(json)).toEqual([])
  })

  it('throws on a per-calendar error instead of reporting it as free', () => {
    // The whole point: a 200 response can still mean "I could not read this
    // calendar", and free-by-default there is a double booking.
    const json = {
      calendars: {
        'stale@group.calendar.google.com': {
          errors: [{ domain: 'global', reason: 'notFound' }],
          busy: [],
        },
      },
    }
    expect(() => parseGoogleFreeBusy(json)).toThrow(/notFound/)
  })

  it('throws on a timestamp with no timezone rather than guessing local', () => {
    const json = { calendars: { primary: { busy: [{ start: '2026-08-14T09:00:00', end: '2026-08-14T10:00:00' }] } } }
    expect(() => parseGoogleFreeBusy(json)).toThrow(/no timezone/)
  })
})

describe('toGoogleEvent', () => {
  const base: ExternalEvent = {
    title: 'Intro call',
    description: 'Punctual booking',
    start: Date.UTC(2026, 7, 14, 9),
    end: Date.UTC(2026, 7, 14, 9, 30),
    attendees: [{ email: 'guest@example.com', name: 'Guest' }, { email: 'plain@example.com' }],
    timezone: 'Europe/Kyiv',
  }

  it('maps instants to RFC3339 UTC and keeps the host timezone alongside', () => {
    const body = toGoogleEvent(base)
    expect(body['start']).toEqual({ dateTime: '2026-08-14T09:00:00.000Z', timeZone: 'Europe/Kyiv' })
    expect(body['end']).toEqual({ dateTime: '2026-08-14T09:30:00.000Z', timeZone: 'Europe/Kyiv' })
    expect(body['summary']).toBe('Intro call')
  })

  it('maps attendees, omitting displayName when there is no name', () => {
    expect(toGoogleEvent(base)['attendees']).toEqual([
      { email: 'guest@example.com', displayName: 'Guest' },
      { email: 'plain@example.com' },
    ])
  })

  it('omits conferenceData when no request id is supplied', () => {
    expect(toGoogleEvent({ ...base, createConference: true })).not.toHaveProperty('conferenceData')
  })

  it('sets a hangoutsMeet createRequest when a request id is supplied', () => {
    // conferenceDataVersion=1 is a query parameter, so it is asserted by the
    // adapter's URL construction, not here; this covers the body half.
    expect(toGoogleEvent({ ...base, createConference: true }, 'req-123')['conferenceData']).toEqual({
      createRequest: {
        requestId: 'req-123',
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    })
  })

  it('includes location only when set', () => {
    expect(toGoogleEvent(base)).not.toHaveProperty('location')
    expect(toGoogleEvent({ ...base, location: "Harry's Bar" })['location']).toBe("Harry's Bar")
  })
})

describe('parseGraphDateTime', () => {
  it('parses the seven-digit fractional UTC form Graph actually returns', () => {
    expect(parseGraphDateTime({ dateTime: '2026-08-14T09:00:00.0000000', timeZone: 'UTC' })).toBe(
      Date.UTC(2026, 7, 14, 9),
    )
  })

  it('keeps sub-second precision to milliseconds', () => {
    expect(parseGraphDateTime({ dateTime: '2026-08-14T09:00:00.2500000', timeZone: 'UTC' })).toBe(
      Date.UTC(2026, 7, 14, 9, 0, 0, 250),
    )
  })

  it('parses a string with no fractional part', () => {
    expect(parseGraphDateTime({ dateTime: '2026-08-14T09:00:00', timeZone: 'UTC' })).toBe(Date.UTC(2026, 7, 14, 9))
  })

  it('accepts a self-describing offset regardless of the timeZone field', () => {
    expect(parseGraphDateTime({ dateTime: '2026-08-14T11:00:00+02:00', timeZone: 'Pacific Standard Time' })).toBe(
      Date.UTC(2026, 7, 14, 9),
    )
  })

  it('refuses a Windows zone name rather than silently reading it as UTC', () => {
    // This is the bug the whole helper exists to prevent: Date.parse would have
    // read this as local time and been eight hours wrong, without throwing.
    expect(() => parseGraphDateTime({ dateTime: '2026-08-14T09:00:00.0000000', timeZone: 'Pacific Standard Time' })).toThrow(
      /expected UTC/,
    )
  })

  it('throws when dateTime is missing', () => {
    expect(() => parseGraphDateTime({ timeZone: 'UTC' })).toThrow(/missing dateTime/)
  })
})

describe('parseGraphSchedule', () => {
  const item = (status: string, startHour: number, endHour: number) => ({
    status,
    start: { dateTime: `2026-08-14T${String(startHour).padStart(2, '0')}:00:00.0000000`, timeZone: 'UTC' },
    end: { dateTime: `2026-08-14T${String(endHour).padStart(2, '0')}:00:00.0000000`, timeZone: 'UTC' },
  })

  it('maps busy scheduleItems to epoch-ms intervals', () => {
    const json = { value: [{ scheduleId: 'host@contoso.com', availabilityView: '0220', scheduleItems: [item('busy', 9, 10)] }] }
    expect(parseGraphSchedule(json)).toEqual([{ start: Date.UTC(2026, 7, 14, 9), end: Date.UTC(2026, 7, 14, 10) }])
  })

  it('treats tentative and oof as busy, free and workingElsewhere as free', () => {
    const json = {
      value: [
        {
          scheduleId: 'host@contoso.com',
          scheduleItems: [item('Tentative', 9, 10), item('oof', 11, 12), item('free', 13, 14), item('workingElsewhere', 15, 16)],
        },
      ],
    }
    expect(parseGraphSchedule(json)).toEqual([
      { start: Date.UTC(2026, 7, 14, 9), end: Date.UTC(2026, 7, 14, 10) },
      { start: Date.UTC(2026, 7, 14, 11), end: Date.UTC(2026, 7, 14, 12) },
    ])
  })

  it('yields [] for an empty scheduleItems array', () => {
    expect(parseGraphSchedule({ value: [{ scheduleId: 'a@b.com', scheduleItems: [] }] })).toEqual([])
  })

  it('yields [] for an empty or missing value collection', () => {
    expect(parseGraphSchedule({ value: [] })).toEqual([])
    expect(parseGraphSchedule({})).toEqual([])
    expect(parseGraphSchedule(null)).toEqual([])
  })

  it('does not fall back to availabilityView when scheduleItems is present but empty', () => {
    const json = { value: [{ scheduleId: 'a@b.com', availabilityView: '222', scheduleItems: [] }] }
    const window = { start: Date.UTC(2026, 7, 14, 9), intervalMinutes: 5 }
    expect(parseGraphSchedule(json, window)).toEqual([])
  })

  it('falls back to availabilityView when scheduleItems is withheld', () => {
    // Graph omits scheduleItems for mailboxes whose detail we may not see.
    // Reporting [] there would show a full calendar as wide open.
    const json = { value: [{ scheduleId: 'a@b.com', availabilityView: '0221003' }] }
    const start = Date.UTC(2026, 7, 14, 9)
    expect(parseGraphSchedule(json, { start, intervalMinutes: 5 })).toEqual([
      { start: start + 5 * MINUTE, end: start + 20 * MINUTE },
      { start: start + 30 * MINUTE, end: start + 35 * MINUTE },
    ])
  })

  // Graph's availabilityView digit 4 is "working elsewhere" — the precise
  // scheduleItems path (isBusyStatus) already treats that status as NOT
  // busy, same as free. This fallback must agree, or the same mailbox reads
  // as busy or free purely depending on which shape Graph happened to return.
  it('treats availabilityView digit 4 (working elsewhere) as free, like scheduleItems does', () => {
    // '0242220': free, busy, free(4), busy, busy, busy, free.
    const json = { value: [{ scheduleId: 'a@b.com', availabilityView: '0242220' }] }
    const start = Date.UTC(2026, 7, 14, 9)
    expect(parseGraphSchedule(json, { start, intervalMinutes: 5 })).toEqual([
      { start: start + 5 * MINUTE, end: start + 10 * MINUTE },
      { start: start + 15 * MINUTE, end: start + 30 * MINUTE },
    ])
  })

  it('closes an availabilityView run that reaches the end of the window', () => {
    const start = Date.UTC(2026, 7, 14, 9)
    expect(parseGraphSchedule({ value: [{ availabilityView: '022' }] }, { start, intervalMinutes: 15 })).toEqual([
      { start: start + 15 * MINUTE, end: start + 45 * MINUTE },
    ])
  })

  it('ignores availabilityView with no window to anchor it to', () => {
    expect(parseGraphSchedule({ value: [{ availabilityView: '222' }] })).toEqual([])
  })

  it('throws on a per-mailbox error instead of reporting it as free', () => {
    const json = { value: [{ scheduleId: 'gone@contoso.com', error: { message: 'mailbox not found', responseCode: 'ErrorItemNotFound' } }] }
    expect(() => parseGraphSchedule(json)).toThrow(/ErrorItemNotFound/)
  })
})

describe('toGraphDateTimeZone', () => {
  it('sends a zone-less UTC wall clock with an explicit timeZone', () => {
    // The trailing Z is dropped on purpose: Graph rejects an offset in
    // dateTime when timeZone is also supplied.
    expect(toGraphDateTimeZone(Date.UTC(2026, 7, 14, 9, 30))).toEqual({
      dateTime: '2026-08-14T09:30:00',
      timeZone: 'UTC',
    })
  })
})

describe('toGraphEvent', () => {
  const base: ExternalEvent = {
    title: 'Intro call',
    description: '<p>Punctual booking</p>',
    start: Date.UTC(2026, 7, 14, 9),
    end: Date.UTC(2026, 7, 14, 9, 30),
    attendees: [{ email: 'guest@example.com', name: 'Guest' }, { email: 'plain@example.com' }],
    timezone: 'Europe/Kyiv',
  }

  it('maps start, end and attendees', () => {
    const body = toGraphEvent(base)
    expect(body['start']).toEqual({ dateTime: '2026-08-14T09:00:00', timeZone: 'UTC' })
    expect(body['end']).toEqual({ dateTime: '2026-08-14T09:30:00', timeZone: 'UTC' })
    expect(body['attendees']).toEqual([
      { emailAddress: { address: 'guest@example.com', name: 'Guest' }, type: 'required' },
      { emailAddress: { address: 'plain@example.com' }, type: 'required' },
    ])
    expect(body['subject']).toBe('Intro call')
  })

  it('round-trips through parseGraphDateTime — the pair must agree', () => {
    const body = toGraphEvent(base)
    expect(parseGraphDateTime(body['start'])).toBe(base.start)
    expect(parseGraphDateTime(body['end'])).toBe(base.end)
  })

  it('requests a Teams meeting only when conferencing is asked for', () => {
    expect(toGraphEvent(base)['isOnlineMeeting']).toBe(false)
    expect(toGraphEvent(base)).not.toHaveProperty('onlineMeetingProvider')

    const conf = toGraphEvent({ ...base, createConference: true })
    expect(conf['isOnlineMeeting']).toBe(true)
    expect(conf['onlineMeetingProvider']).toBe('teamsForBusiness')
  })

  it('includes location and transactionId only when supplied', () => {
    expect(toGraphEvent(base)).not.toHaveProperty('location')
    expect(toGraphEvent(base)).not.toHaveProperty('transactionId')

    const full = toGraphEvent({ ...base, location: 'Room 4' }, 'txn-1')
    expect(full['location']).toEqual({ displayName: 'Room 4' })
    expect(full['transactionId']).toBe('txn-1')
  })

  it('refuses counter-proposals, which would create bookings the engine never sees', () => {
    expect(toGraphEvent(base)['allowNewTimeProposals']).toBe(false)
  })
})

describe('createEnvOAuthCredentials', () => {
  it('returns null for a provider with no credentials — one-provider deployments are normal', () => {
    const creds = createEnvOAuthCredentials({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' }, 'https://book.example')
    expect(creds.forProvider('google')).toEqual({ clientId: 'gid', clientSecret: 'gsecret' })
    expect(creds.forProvider('microsoft')).toBeNull()
  })

  it('treats a blank secret as absent — that is what an unset Workers secret looks like', () => {
    const creds = createEnvOAuthCredentials({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: '  ' }, 'https://book.example')
    expect(creds.forProvider('google')).toBeNull()
  })

  it('separates identity and calendar redirect URIs (ADR-0005 §1)', () => {
    const creds = createEnvOAuthCredentials({}, 'https://book.example')
    expect(creds.redirectUri('google', 'identity')).toBe('https://book.example/auth/google/callback?purpose=identity')
    expect(creds.redirectUri('microsoft', 'calendar')).toBe('https://book.example/auth/microsoft/callback?purpose=calendar')
  })

  it('tolerates a trailing slash on baseUrl', () => {
    const creds = createEnvOAuthCredentials({}, 'https://book.example/')
    expect(creds.redirectUri('google', 'identity')).toBe('https://book.example/auth/google/callback?purpose=identity')
  })

  it('keeps sensitive calendar scopes out of the identity flow', () => {
    expect(GOOGLE_IDENTITY_SCOPES).toEqual(['openid', 'email', 'profile'])
    for (const scope of GOOGLE_IDENTITY_SCOPES) {
      expect(GOOGLE_CALENDAR_SCOPES).not.toContain(scope)
    }
  })
})

describe('partitionConnections', () => {
  function conn(overrides: Partial<CalendarConnection>): CalendarConnection {
    return {
      id: 'cal_1',
      userId: 'u1',
      provider: 'google',
      providerAccountEmail: 'host@example.com',
      encryptedTokens: 'x',
      keyVersion: 1,
      calendarIdsRead: [],
      calendarIdWrite: null,
      syncStatus: 'ok',
      createdAt: 0,
      ...overrides,
    }
  }

  // Microsoft's getBusy reads the whole mailbox (providerAccountEmail) by
  // default and only narrows to calendarIdsRead when it's non-empty — see
  // adapters/microsoft/provider.ts. Excluding an empty-calendarIdsRead
  // Microsoft connection here meant getBusy was never even called for it,
  // silently disabling conflict checking rather than reading the right thing.
  it('includes a Microsoft connection for reads even with an empty calendarIdsRead', () => {
    const { read } = partitionConnections([conn({ provider: 'microsoft', calendarIdsRead: [] })])
    expect(read).toHaveLength(1)
  })

  it('excludes a Google connection for reads when calendarIdsRead is empty', () => {
    const { read } = partitionConnections([conn({ provider: 'google', calendarIdsRead: [] })])
    expect(read).toHaveLength(0)
  })

  it('includes a Google connection once a calendar is selected', () => {
    const { read } = partitionConnections([conn({ provider: 'google', calendarIdsRead: ['primary'] })])
    expect(read).toHaveLength(1)
  })
})
