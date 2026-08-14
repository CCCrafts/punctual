/**
 * Microsoft Graph calendar adapter (ADR-0003 ports, ADR-0005 §6 for tokens).
 *
 * The hazard that defines this file: Graph returns times as
 * `{ dateTime: "2026-08-14T09:00:00.0000000", timeZone: "Pacific Standard Time" }`
 * — a wall-clock string with NO offset, in whatever zone the request asked for
 * (UTC only if you say so). `Date.parse` on such a string reads it as *local*
 * time, which on a Worker is UTC and therefore looks correct in every test
 * while being hours wrong for any host whose mailbox defaults elsewhere. So we
 * demand UTC via `Prefer: outlook.timezone` and refuse to parse anything that
 * comes back in another zone (ADR-0004 §1: instants everywhere, wall clock only
 * at the two edges).
 *
 * Verified against the Graph v1.0 reference on 2026-08-14: `getSchedule` posts
 * `schedules`/`startTime`/`endTime`/`availabilityViewInterval` and answers with
 * `value[].scheduleItems[]`; Teams links come from `isOnlineMeeting` plus
 * `onlineMeetingProvider: "teamsForBusiness"` on event creation.
 */

import type { Interval } from '../../core/domain/types.js'
import type { CalendarProvider, ExternalEvent } from '../../ports.js'
import {
  CalendarApiError,
  type CalendarProviderDeps,
  expectOk,
  isRecord,
  providerFetch,
  readJson,
} from '../oauth.js'

const GRAPH = 'https://graph.microsoft.com/v1.0'

/** Graph rejects a getSchedule request carrying more than 20 mailboxes. */
const MAX_SCHEDULES_PER_QUERY = 20

/**
 * Matches the 5-minute lock grid from ADR-0002 §1. It only matters on the
 * fallback path (see `parseGraphSchedule`), but an availabilityView sampled on
 * a coarser grid would round busy time off-grid, and rounding the wrong way
 * offers a slot that is taken.
 */
const AVAILABILITY_VIEW_INTERVAL_MINUTES = 5

/** Zone names Graph may hand back for UTC. Anything else we refuse to guess at. */
const UTC_ZONE_NAMES = new Set(['UTC', 'GMT', 'ETC/UTC', 'ETC/GMT', 'Z'])

export function createMicrosoftProvider(deps: CalendarProviderDeps): CalendarProvider {
  return {
    name: 'microsoft',

    async getBusy(conn, range) {
      if (range.end <= range.start) return []
      // Unlike Google, getSchedule keys on the mailbox SMTP address rather than
      // on a calendar id, so `calendarIdsRead` holds addresses for this
      // provider. The connected account is the sane default.
      const schedules = conn.calendarIdsRead.length > 0 ? conn.calendarIdsRead : [conn.providerAccountEmail]

      const busy: Interval[] = []
      for (let i = 0; i < schedules.length; i += MAX_SCHEDULES_PER_QUERY) {
        const chunk = schedules.slice(i, i + MAX_SCHEDULES_PER_QUERY)
        const res = await providerFetch(deps, conn, `${GRAPH}/me/calendar/getSchedule`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Without this the response comes back in the mailbox's own zone.
            prefer: 'outlook.timezone="UTC"',
          },
          body: JSON.stringify({
            schedules: chunk,
            startTime: toGraphDateTimeZone(range.start),
            endTime: toGraphDateTimeZone(range.end),
            availabilityViewInterval: AVAILABILITY_VIEW_INTERVAL_MINUTES,
          }),
        })
        const json = await readJson<unknown>(conn, res, 'calendar.getSchedule')
        busy.push(
          ...parseGraphSchedule(json, {
            start: range.start,
            intervalMinutes: AVAILABILITY_VIEW_INTERVAL_MINUTES,
          }),
        )
      }

      return clampToRange(busy, range)
    },

    async createEvent(conn, event) {
      const path = writeEventsPath(conn.calendarIdWrite, conn.id)
      // Graph's own idempotency key: a retried POST carrying the same
      // transactionId returns the original event instead of creating a twin.
      const transactionId = `punctual-${deps.crypto.randomToken(12)}`

      const res = await providerFetch(deps, conn, `${GRAPH}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toGraphEvent(event, transactionId)),
      })
      const created = await readJson<unknown>(conn, res, 'events.create')
      if (!isRecord(created) || typeof created['id'] !== 'string') {
        throw new CalendarApiError('microsoft', 'events.create returned no event id', {
          body: JSON.stringify(created).slice(0, 500),
        })
      }
      return created['id']
    },

    async updateEvent(conn, externalId, event) {
      // `/me/events/{id}` resolves across every calendar in the mailbox, so an
      // event stays updatable even if the host later repoints the write target.
      const res = await providerFetch(deps, conn, `${GRAPH}/me/events/${encodeURIComponent(externalId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        // No transactionId: it is a create-time key and Graph rejects it on PATCH.
        body: JSON.stringify(toGraphEvent(event)),
      })
      await expectOk(conn, res, 'events.update')
    },

    async deleteEvent(conn, externalId) {
      const res = await providerFetch(deps, conn, `${GRAPH}/me/events/${encodeURIComponent(externalId)}`, {
        method: 'DELETE',
      })
      // Already gone is the desired state — a host who deleted the event by
      // hand must still be able to cancel the booking.
      if (res.status === 404 || res.status === 410) return
      await expectOk(conn, res, 'events.delete')
    },

    async listCalendars(conn) {
      const res = await providerFetch(deps, conn, `${GRAPH}/me/calendars?$top=100&$select=id,name,isDefaultCalendar`, {
        method: 'GET',
      })
      const json = await readJson<unknown>(conn, res, 'calendars.list')
      const items = isRecord(json) && Array.isArray(json['value']) ? json['value'] : []

      const out: Array<{ id: string; name: string; primary: boolean }> = []
      for (const item of items) {
        if (!isRecord(item) || typeof item['id'] !== 'string') continue
        out.push({
          id: item['id'],
          name: typeof item['name'] === 'string' ? item['name'] : item['id'],
          primary: item['isDefaultCalendar'] === true,
        })
      }
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// Pure mapping — no network, unit-tested in test/core/calendar-parsing.test.ts
// ---------------------------------------------------------------------------

export interface GraphScheduleWindow {
  /** Instant the availabilityView string is anchored at. */
  start: number
  /** The `availabilityViewInterval` sent with the request. */
  intervalMinutes: number
}

/**
 * getSchedule response to intervals.
 *
 * `scheduleItems` is the precise answer, but Graph omits it for mailboxes whose
 * free/busy detail the caller may not see, leaving only the `availabilityView`
 * bitmap. Returning `[]` in that case would report a full calendar as wide
 * open, so the bitmap is the fallback — coarser, never emptier.
 *
 * An empty `scheduleItems` array is a real answer ("nothing booked") and does
 * NOT trigger the fallback; only an absent one does.
 */
export function parseGraphSchedule(json: unknown, window?: GraphScheduleWindow): Interval[] {
  const out: Interval[] = []
  if (!isRecord(json)) return out
  const value = json['value']
  if (!Array.isArray(value)) return out

  for (const info of value) {
    if (!isRecord(info)) continue
    const scheduleId = typeof info['scheduleId'] === 'string' ? info['scheduleId'] : '(unknown)'

    const error = info['error']
    if (isRecord(error)) {
      // Same reasoning as the Google adapter: a mailbox we could not read is
      // not a mailbox with nothing on it (ADR-0005 §6).
      throw new CalendarApiError('microsoft', `getSchedule failed for ${scheduleId}`, {
        body: JSON.stringify(error).slice(0, 500),
      })
    }

    const items = info['scheduleItems']
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!isRecord(item)) continue
        if (!isBusyStatus(item['status'])) continue
        const start = parseGraphDateTime(item['start'], scheduleId)
        const end = parseGraphDateTime(item['end'], scheduleId)
        if (end <= start) continue
        out.push({ start, end })
      }
      continue
    }

    const view = info['availabilityView']
    if (window && typeof view === 'string') {
      out.push(...parseAvailabilityView(view, window))
    }
  }

  return out
}

/**
 * Graph's `dateTimeTimeZone` to epoch ms.
 *
 * Two traps: the fractional part carries seven digits (more than the ECMAScript
 * date grammar allows, so engines differ), and the string carries no offset. We
 * truncate to milliseconds and append `Z` only after confirming the payload
 * really is UTC — misreading the zone shifts busy time by whole hours and shows
 * up as a double booking, not as an exception.
 */
export function parseGraphDateTime(value: unknown, context = 'schedule'): number {
  const raw = isRecord(value) ? value['dateTime'] : undefined
  if (typeof raw !== 'string') {
    throw new CalendarApiError('microsoft', `${context}: missing dateTime`, { body: JSON.stringify(value) })
  }

  const trimmed = raw.trim()
  // ".0000000" -> ".000"; anything shorter is left alone.
  const normalised = trimmed.replace(/(\.\d{3})\d+/, '$1')

  let iso: string
  if (/(?:Z|z|[+-]\d{2}:?\d{2})$/.test(normalised)) {
    // Already self-describing; the timeZone field is then redundant.
    iso = normalised
  } else {
    const zone = isRecord(value) && typeof value['timeZone'] === 'string' ? value['timeZone'].trim() : ''
    if (!UTC_ZONE_NAMES.has(zone.toUpperCase())) {
      throw new CalendarApiError(
        'microsoft',
        `${context}: refusing to interpret "${trimmed}" in timeZone "${zone}" — ` +
          'expected UTC (is the Prefer: outlook.timezone="UTC" header set?)',
      )
    }
    iso = `${normalised}Z`
  }

  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new CalendarApiError('microsoft', `${context}: unparseable dateTime`, { body: trimmed })
  }
  return ms
}

/** The instant as Graph wants it on the way in: zone-less wall clock plus an explicit zone. */
export function toGraphDateTimeZone(ms: number): { dateTime: string; timeZone: string } {
  // Graph rejects the trailing `Z` when `timeZone` is also given, so send the
  // UTC wall clock and name the zone.
  return { dateTime: new Date(ms).toISOString().slice(0, 19), timeZone: 'UTC' }
}

/** The Graph Event body. `transactionId` is create-only. */
export function toGraphEvent(event: ExternalEvent, transactionId?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    subject: event.title,
    body: { contentType: 'HTML', content: event.description },
    // UTC rather than `event.timezone`: Outlook renders every event in the
    // viewer's own zone anyway, and Graph's IANA support varies by tenant, so
    // naming UTC is the reading that cannot be misinterpreted.
    start: toGraphDateTimeZone(event.start),
    end: toGraphDateTimeZone(event.end),
    attendees: event.attendees.map((a) => ({
      emailAddress: a.name ? { address: a.email, name: a.name } : { address: a.email },
      type: 'required',
    })),
    // Guests pick a time on the booking page; letting Outlook collect
    // counter-proposals would create bookings the engine never sees.
    allowNewTimeProposals: false,
    isOnlineMeeting: event.createConference === true,
  }

  if (event.createConference === true) body['onlineMeetingProvider'] = 'teamsForBusiness'
  if (event.location !== undefined) body['location'] = { displayName: event.location }
  if (transactionId !== undefined) body['transactionId'] = transactionId

  return body
}

// ---------------------------------------------------------------------------

/**
 * Graph statuses, lower-cased because the docs show both `Busy` and `busy`.
 *
 * `workingElsewhere` counts as free — it is what the availabilityView bitmap
 * reports as `0`, and disagreeing between the two paths would make busy-ness
 * depend on which one answered. `unknown` counts as busy: it means we were not
 * told, and the safe reading of "not told" is "do not offer this time".
 */
function isBusyStatus(status: unknown): boolean {
  if (typeof status !== 'string') return true
  switch (status.toLowerCase()) {
    case 'free':
    case 'workingelsewhere':
      return false
    default:
      return true
  }
}

/** `"0022000"` — one char per interval from the window start; anything but `0` is busy. */
function parseAvailabilityView(view: string, window: GraphScheduleWindow): Interval[] {
  const step = window.intervalMinutes * 60_000
  if (step <= 0) return []

  const out: Interval[] = []
  let runStart: number | null = null
  for (let i = 0; i < view.length; i++) {
    const busy = view[i] !== '0'
    if (busy && runStart === null) runStart = window.start + i * step
    if (!busy && runStart !== null) {
      out.push({ start: runStart, end: window.start + i * step })
      runStart = null
    }
  }
  if (runStart !== null) out.push({ start: runStart, end: window.start + view.length * step })
  return out
}

function writeEventsPath(calendarIdWrite: string | null, connId: string): string {
  if (calendarIdWrite === null) {
    throw new CalendarApiError('microsoft', `connection ${connId} has no write calendar configured`)
  }
  // `primary`/`default` are our sentinels for "the mailbox's default calendar";
  // Graph itself has no such alias, it just means the unqualified collection.
  if (calendarIdWrite === 'primary' || calendarIdWrite === 'default') return '/me/events'
  return `/me/calendars/${encodeURIComponent(calendarIdWrite)}/events`
}

/** Busy time outside the queried window cannot affect any slot in it. */
function clampToRange(intervals: Interval[], range: Interval): Interval[] {
  const out: Interval[] = []
  for (const i of intervals) {
    const start = Math.max(i.start, range.start)
    const end = Math.min(i.end, range.end)
    if (start < end) out.push({ start, end })
  }
  return out
}
