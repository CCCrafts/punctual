/**
 * Cron work: reminders, hold expiry, lock pruning, telemetry.
 *
 * Runs every 5 minutes. Each task is independent and failure-isolated —
 * a telemetry ping that cannot reach the internet must not stop reminders
 * going out.
 */

import type { EnginePorts } from '../ports.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

export async function runScheduledTasks(ports: EnginePorts, now: number): Promise<void> {
  const tasks: Array<[string, Promise<unknown>]> = [
    ['expire-holds', expireHolds(ports, now)],
    ['prune-locks', pruneLocks(ports, now)],
    ['reminders', sendReminders(ports, now)],
  ]
  if (ports.config.telemetryEnabled) tasks.push(['telemetry', sendTelemetry(ports, now)])

  for (const [name, task] of tasks) {
    try {
      await task
    } catch (err) {
      console.error(`[punctual] scheduled task ${name} failed`, err)
    }
  }
}

/**
 * Sweep expired holds.
 *
 * Belt and braces: holds are already filtered on read by `expires_at > now`,
 * and each DO clears its own via alarm. This catches rows whose DO alarm was
 * lost, so the table cannot grow without bound.
 */
async function expireHolds(ports: EnginePorts, now: number): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  await repos.slotLocks.expireHolds(now)
}

/**
 * Prune slot_locks for past bookings.
 *
 * A 7-day trailing window is kept deliberately: locks are the record of what
 * occupied a calendar, and having a week of history makes "why was I not
 * offered that slot?" answerable.
 */
async function pruneLocks(ports: EnginePorts, now: number): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  await repos.slotLocks.pruneLocksBefore(now - 7 * DAY)
}

/**
 * Reminders at 24 h and 1 h before the meeting.
 *
 * The window is the cron interval, so a booking is picked up exactly once:
 * we look for meetings starting within [target, target + 5 min). Widening it
 * would double-send; narrowing it would drop reminders on a slow tick.
 */
async function sendReminders(ports: EnginePorts, now: number): Promise<void> {
  const repos = ports.repositories({ consistency: 'unconstrained' })
  const windows: Array<{ label: '24h' | '1h'; from: number; to: number }> = [
    { label: '24h', from: now + DAY, to: now + DAY + 5 * MINUTE },
    { label: '1h', from: now + HOUR, to: now + HOUR + 5 * MINUTE },
  ]

  const { bookingReminder } = await import('../core/email-templates.js')

  for (const w of windows) {
    // Reminders are a cross-host query, which is exactly why bookings live in
    // D1 rather than in per-host DO storage (ADR-0002).
    const due = await repos.bookings.dueBetween(w.from, w.to)
    for (const booking of due) {
      const [eventType, host] = await Promise.all([
        repos.eventTypes.byId(booking.eventTypeId),
        repos.users.byId(booking.hostUserId),
      ])
      if (!eventType || !host) continue

      // Rendered for the GUEST, so times appear in the guest's timezone.
      const mail = bookingReminder({
        booking,
        eventType,
        host,
        audience: 'guest',
        when: w.label,
        brandName: ports.config.brandName,
        supportEmail: ports.config.supportEmail,
      })

      await ports.queue.send({
        kind: 'email',
        message: {
          to: booking.guestEmail,
          toName: booking.guestName,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        },
      })
    }
  }
}

/**
 * Opt-in telemetry (ADR-0006 §5).
 *
 * Counts only. No emails, names, slugs, URLs or calendar content — the payload
 * is small enough to read in full here, which is the point: the claim is
 * auditable rather than trusted.
 */
async function sendTelemetry(ports: EnginePorts, now: number): Promise<void> {
  // Once a day, not every 5 minutes.
  const hourOfDay = new Date(now).getUTCHours()
  const minute = new Date(now).getUTCMinutes()
  if (hourOfDay !== 3 || minute >= 5) return

  const repos = ports.repositories({ consistency: 'unconstrained' })
  const counts = await repos.telemetryCounts()

  await fetch('https://telemetry.punctual.sh/v1/ping', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: '0.1.1',
      users: counts.users,
      eventTypes: counts.eventTypes,
      bookings: counts.bookings,
    }),
  }).catch(() => {})
}
