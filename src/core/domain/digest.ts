/**
 * The morning digest: one email, at an hour the host picks in their own
 * timezone, listing today's confirmed meetings. Nothing on an empty day.
 *
 * Driven by the five-minute cron. "Due" is: the host opted in, it is the
 * chosen hour locally and the first five minutes of it, and today's digest
 * has not gone out yet — the last point is what makes a repeated or late
 * tick harmless, and it is recorded BEFORE the send so two overlapping
 * ticks cannot both pass the check.
 */

import type { Booking, User } from './types.js'
import { localDateString, localTimeToInstant } from '../time/zone.js'

export const DIGEST_HOURS: readonly number[] = [5, 6, 7, 8, 9, 10, 11, 12]

export function parseDigestHour(raw: string | null | undefined): number | null | 'invalid' {
  const v = (raw ?? '').trim()
  if (v === '' || v === 'off') return null
  const n = Number(v)
  return Number.isInteger(n) && DIGEST_HOURS.includes(n) ? n : 'invalid'
}

/** The host-local date a digest is due for right now, or null. */
export function digestDue(user: Pick<User, 'tz' | 'digestHour' | 'digestSentOn'>, now: number): string | null {
  if (user.digestHour === null || user.digestHour === undefined) return null
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: user.tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now))
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  if (hour !== user.digestHour || minute >= 5) return null
  const today = localDateString(now, user.tz)
  return user.digestSentOn === today ? null : today
}

/** The host-local calendar day `date` as a UTC interval — midnight to the next midnight in `tz`. */
export function digestRange(date: string, tz: string): { start: number; end: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
  return { start: localTimeToInstant(date, 0, tz), end: localTimeToInstant(nextDate, 0, tz) }
}

/** Today's confirmed meetings, in order — the ones the email lists. */
export function digestBookings(bookings: Booking[]): Booking[] {
  return bookings.filter((b) => b.status === 'confirmed').sort((a, b) => a.startUtc - b.startUtc)
}
