/**
 * Google Calendar adapter (ADR-0003 ports, ADR-0005 §6 for tokens).
 *
 * Two rules shape everything here:
 *
 *  1. `getBusy` returns RAW busy intervals. Buffers are the slot engine's job
 *     (ADR-0004 §3) — expanding them here would double-apply them and quietly
 *     shrink availability for every host.
 *  2. A calendar we could not read is never treated as free. Google reports
 *     per-calendar failures inside a 200 response, and swallowing those is the
 *     shortest path to a double booking, so they throw.
 *
 * Verified against the Calendar API v3 reference on 2026-08-14: freeBusy takes
 * `items[].id` and returns `calendars` keyed by calendar id; Meet links have
 * required an explicit `conferenceData.createRequest` plus
 * `conferenceDataVersion=1` since the September 2020 change that stopped
 * auto-populating them.
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

const API = 'https://www.googleapis.com/calendar/v3'

/** Google's documented ceiling for a single freeBusy query. */
const MAX_CALENDARS_PER_QUERY = 50

export function createGoogleProvider(deps: CalendarProviderDeps): CalendarProvider {
  return {
    name: 'google',

    async getBusy(conn, range) {
      if (range.end <= range.start) return []
      // An empty read list means the account's default calendar. `primary` is
      // an alias Google resolves per-account, so it survives a mailbox rename.
      const ids = conn.calendarIdsRead.length > 0 ? conn.calendarIdsRead : ['primary']

      const busy: Interval[] = []
      for (let i = 0; i < ids.length; i += MAX_CALENDARS_PER_QUERY) {
        const chunk = ids.slice(i, i + MAX_CALENDARS_PER_QUERY)
        const res = await providerFetch(deps, conn, `${API}/freeBusy`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            timeMin: new Date(range.start).toISOString(),
            timeMax: new Date(range.end).toISOString(),
            // Explicit even though UTC is the default: the response timestamps
            // are what the whole engine's arithmetic rests on (ADR-0004 §1).
            timeZone: 'UTC',
            calendarExpansionMax: MAX_CALENDARS_PER_QUERY,
            items: chunk.map((id) => ({ id })),
          }),
        })
        const json = await readJson<unknown>(conn, res, 'freeBusy query')
        busy.push(...parseGoogleFreeBusy(json))
      }

      return clampToRange(busy, range)
    },

    async createEvent(conn, event) {
      const calendarId = writeCalendar(conn.calendarIdWrite, conn.id)
      // A fresh requestId per event: reusing one returns the SAME conference,
      // which would put unrelated guests into each other's meeting.
      const requestId = event.createConference ? `punctual-${deps.crypto.randomToken(12)}` : undefined

      const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`)
      url.searchParams.set('conferenceDataVersion', '1')
      // Punctual sends the confirmation email itself; letting Google send one
      // too gives the guest two invitations that disagree about branding.
      url.searchParams.set('sendUpdates', 'none')

      const res = await providerFetch(deps, conn, url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toGoogleEvent(event, requestId)),
      })
      const created = await readJson<unknown>(conn, res, 'events.insert')
      if (!isRecord(created) || typeof created['id'] !== 'string') {
        throw new CalendarApiError('google', 'events.insert returned no event id', {
          body: JSON.stringify(created).slice(0, 500),
        })
      }
      return created['id']
    },

    async updateEvent(conn, externalId, event) {
      const calendarId = writeCalendar(conn.calendarIdWrite, conn.id)
      const url = new URL(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
      )
      // Version 1 on writes too: at version 0 Google assumes the client cannot
      // represent conferenceData and drops the Meet link from the event.
      url.searchParams.set('conferenceDataVersion', '1')
      url.searchParams.set('sendUpdates', 'none')

      // PATCH, not PUT, and no `createRequest` — a reschedule must move the
      // existing conference, not mint a second one and invalidate the link
      // already sitting in the guest's inbox.
      const res = await providerFetch(deps, conn, url.toString(), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toGoogleEvent(event)),
      })
      await expectOk(conn, res, 'events.patch')
    },

    async deleteEvent(conn, externalId) {
      const calendarId = writeCalendar(conn.calendarIdWrite, conn.id)
      const url = new URL(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
      )
      url.searchParams.set('sendUpdates', 'none')

      const res = await providerFetch(deps, conn, url.toString(), { method: 'DELETE' })
      // Already gone is the desired state. A host who deleted the event by hand
      // must still be able to cancel the booking.
      if (res.status === 404 || res.status === 410) return
      await expectOk(conn, res, 'events.delete')
    },

    async listCalendars(conn) {
      const url = new URL(`${API}/users/me/calendarList`)
      url.searchParams.set('maxResults', '250')
      url.searchParams.set('minAccessRole', 'reader')
      url.searchParams.set('showDeleted', 'false')

      const res = await providerFetch(deps, conn, url.toString(), { method: 'GET' })
      const json = await readJson<unknown>(conn, res, 'calendarList.list')
      const items = isRecord(json) && Array.isArray(json['items']) ? json['items'] : []

      const out: Array<{ id: string; name: string; primary: boolean }> = []
      for (const item of items) {
        if (!isRecord(item) || typeof item['id'] !== 'string') continue
        out.push({
          id: item['id'],
          name: typeof item['summary'] === 'string' ? item['summary'] : item['id'],
          primary: item['primary'] === true,
        })
      }
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// Pure mapping — no network, unit-tested in test/core/calendar-parsing.test.ts
// ---------------------------------------------------------------------------

/**
 * freeBusy response to intervals.
 *
 * Google's own docs disagree about the shape of `calendars` — the v3 reference
 * documents a map keyed by calendar id, another page shows an array of
 * `{id, busy}`. Both are accepted here: guessing wrong would report a busy
 * calendar as free, and that failure is invisible until someone is
 * double-booked.
 */
export function parseGoogleFreeBusy(json: unknown): Interval[] {
  const out: Interval[] = []
  if (!isRecord(json)) return out

  const calendars = json['calendars']
  if (calendars === undefined || calendars === null) return out

  const entries: Array<[string, unknown]> = Array.isArray(calendars)
    ? calendars.map((value, i) => [
        isRecord(value) && typeof value['id'] === 'string' ? value['id'] : String(i),
        value,
      ])
    : isRecord(calendars)
      ? Object.entries(calendars)
      : []

  for (const [id, value] of entries) {
    if (!isRecord(value)) continue

    const errors = value['errors']
    if (Array.isArray(errors) && errors.length > 0) {
      // A calendar that failed to compute is NOT a calendar with no busy time.
      // Fail loudly so the caller can mark sync_status and prompt, per
      // ADR-0005 §6, rather than offer a slot that is actually taken.
      throw new CalendarApiError('google', `freeBusy failed for calendar ${id}`, {
        body: JSON.stringify(errors).slice(0, 500),
      })
    }

    const busy = value['busy']
    if (!Array.isArray(busy)) continue
    for (const entry of busy) {
      if (!isRecord(entry)) continue
      const start = parseGoogleInstant(entry['start'], id)
      const end = parseGoogleInstant(entry['end'], id)
      // Half-open [start, end) everywhere; a degenerate range blocks nothing.
      if (end <= start) continue
      out.push({ start, end })
    }
  }
  return out
}

/**
 * RFC3339 to epoch ms, refusing anything without an explicit zone.
 *
 * `Date.parse` reads a zone-less date-time as *local* time, which on a Worker
 * happens to be UTC and would therefore pass every test while being wrong the
 * moment the runtime changes. Rejecting is the only safe reading.
 */
function parseGoogleInstant(value: unknown, calendarId: string): number {
  if (typeof value !== 'string' || !/(?:Z|z|[+-]\d{2}:?\d{2})$/.test(value.trim())) {
    throw new CalendarApiError('google', `freeBusy timestamp for ${calendarId} has no timezone`, {
      body: String(value),
    })
  }
  const ms = Date.parse(value.trim())
  if (Number.isNaN(ms)) {
    throw new CalendarApiError('google', `freeBusy timestamp for ${calendarId} is unparseable`, {
      body: String(value),
    })
  }
  return ms
}

/** The Events resource body. `conferenceRequestId` is set only when minting a new Meet. */
export function toGoogleEvent(event: ExternalEvent, conferenceRequestId?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: event.title,
    description: event.description,
    // Instants are already UTC; `timeZone` travels alongside so Google renders
    // and expands the event in the host's zone rather than the viewer's guess.
    start: { dateTime: new Date(event.start).toISOString(), timeZone: event.timezone },
    end: { dateTime: new Date(event.end).toISOString(), timeZone: event.timezone },
    attendees: event.attendees.map((a) => (a.name ? { email: a.email, displayName: a.name } : { email: a.email })),
  }

  if (event.location !== undefined) body['location'] = event.location

  if (conferenceRequestId !== undefined) {
    body['conferenceData'] = {
      createRequest: {
        requestId: conferenceRequestId,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    }
  }

  return body
}

// ---------------------------------------------------------------------------

function writeCalendar(calendarIdWrite: string | null, connId: string): string {
  if (calendarIdWrite === null) {
    // Read-only by the host's own choice — the caller should not have asked.
    throw new CalendarApiError('google', `connection ${connId} has no write calendar configured`)
  }
  return calendarIdWrite
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
