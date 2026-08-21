/**
 * D1 repository implementations (ADR-0003 §3, ADR-0007 §1).
 *
 * Two things make this file load-bearing:
 *
 * 1. Every read goes through a `D1DatabaseSession`, never `db.prepare()`
 *    directly. Cloudflare's docs are explicit that standard queries default to
 *    the primary instance, so a bare prepare() silently sends a Sydney guest's
 *    booking page to a US primary and quietly loses the <100 ms wedge.
 *
 * 2. `createWithLocks` is the anti-double-booking invariant. The booking row
 *    and its slot_locks rows go into ONE batch(), so a conflicting bucket
 *    fails the whole thing. Verified against production D1.
 *
 * Nothing here knows about tenants. The cloud control-plane wraps these with
 * an implementation that closes over tenant_id.
 */

import type {
  ApiKey,
  Booking,
  CalendarConnection,
  EventType,
  Schedule,
  Team,
  TeamMember,
  User,
  Webhook,
  WeeklySchedule,
} from '../../core/domain/types.js'
import type {
  ApiKeyRepository,
  AvailabilityRepository,
  BookingRepository,
  CalendarConnectionRepository,
  EventTypeRepository,
  IdempotencyRepository,
  Repositories,
  RequestScope,
  SessionRepository,
  SettingsRepository,
  SlotLockRepository,
  StoredIdempotentResponse,
  TeamRepository,
  UserRepository,
  WebhookRepository,
} from '../../ports.js'

/**
 * D1 session bookmark sentinels.
 *
 * `first-unconstrained` reads the nearest replica and accepts its freshness —
 * correct for the public booking page, because slot_locks plus the DO re-check
 * arbitrate at commit, so staleness degrades to a 409 rather than a wrong
 * calendar (ADR-0007 §2).
 */
const UNCONSTRAINED = 'first-unconstrained'
const PRIMARY = 'first-primary'

export function createD1Repositories(db: D1Database, scope: RequestScope): Repositories {
  // Three modes, and the middle one is the trap. Asking for `bookmark` without
  // having a bookmark yet must fall back to the PRIMARY, not to
  // `first-unconstrained` — which is the stalest mode there is. Getting this
  // backwards would mean session and API-key revocation stop being immediate
  // the moment read replication is enabled (ADR-0005 §2 rejects KV for
  // sessions precisely to avoid that).
  const session =
    scope.consistency === 'bookmark'
      ? db.withSession(scope.bookmark ?? PRIMARY)
      : db.withSession(UNCONSTRAINED)

  const q = (sql: string, ...binds: unknown[]) =>
    session.prepare(sql).bind(...binds) as D1PreparedStatement

  const all = async <T>(sql: string, ...binds: unknown[]): Promise<T[]> => {
    const r = await q(sql, ...binds).all<T>()
    return r.results ?? []
  }
  const first = async <T>(sql: string, ...binds: unknown[]): Promise<T | null> =>
    ((await q(sql, ...binds).first<T>()) ?? null)
  const run = async (sql: string, ...binds: unknown[]): Promise<void> => {
    await q(sql, ...binds).run()
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  const users: UserRepository = {
    async byId(id) {
      return mapUser(await first('SELECT * FROM users WHERE id = ?', id))
    },
    async byEmail(email) {
      return mapUser(await first('SELECT * FROM users WHERE email = ?', email.toLowerCase()))
    },
    async bySlug(slug) {
      return mapUser(await first('SELECT * FROM users WHERE slug = ?', slug))
    },
    async listAll() {
      const rows = await all<Record<string, unknown>>('SELECT * FROM users ORDER BY created_at')
      return rows.map((r) => mapUser(r)!).filter(Boolean)
    },
    async count() {
      const row = await first<{ n: number }>('SELECT COUNT(*) AS n FROM users')
      return row?.n ?? 0
    },
    async demoteAdmin(id) {
      // The subquery is evaluated inside the same statement as the write, so
      // D1 arbitrates the last-admin invariant — no interleaving between a
      // count and an update can slip past it.
      const res = await q(
        `UPDATE users SET role = 'member'
         WHERE id = ? AND role = 'admin'
           AND (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1`,
        id,
      ).run()
      return (res.meta.changes ?? 0) > 0
    },
    async create(user) {
      const row = { ...user, createdAt: Date.now() }
      // The slug claim goes in the SAME batch as the user row (CCC-559): the
      // caller (uniqueSlug in auth-flows.ts) already checked both users AND
      // teams for this slug, but that check and this write are two separate
      // round trips — only slug_claims' own PRIMARY KEY can arbitrate a
      // concurrent team creation claiming the identical slug in between.
      // Vanishingly rare (the precheck already tried a random suffix up to 5
      // times), but null-on-conflict rather than a throw, same as
      // `TeamRepository.createWithFirstMember`: `consumeMagicLink` has
      // already burned the guest's single-use link by the time it calls
      // this, so an uncaught exception here would surface as a bare 500 on
      // a link the guest can never use again, instead of a clean retry with
      // a fresh candidate.
      try {
        await session.batch([
          q(
            'INSERT INTO users (id,email,name,tz,slug,avatar_key,company,job_title,company_url,role,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            row.id, row.email.toLowerCase(), row.name, row.tz, row.slug,
            row.avatarKey, row.company, row.jobTitle, row.companyUrl, row.role, row.createdAt,
          ),
          q(
            'INSERT INTO slug_claims (slug,kind,owner_id,created_at) VALUES (?,?,?,?)',
            row.slug, 'user', row.id, row.createdAt,
          ),
        ])
        return row
      } catch (err) {
        if (isConstraintViolation(err)) return null
        throw err
      }
    },
    async update(id, patch) {
      const sets: string[] = []
      const binds: unknown[] = []
      if (patch.name !== undefined) (sets.push('name = ?'), binds.push(patch.name))
      if (patch.tz !== undefined) (sets.push('tz = ?'), binds.push(patch.tz))
      if (patch.slug !== undefined) (sets.push('slug = ?'), binds.push(patch.slug))
      if (patch.avatarKey !== undefined) (sets.push('avatar_key = ?'), binds.push(patch.avatarKey))
      if (patch.company !== undefined) (sets.push('company = ?'), binds.push(patch.company))
      if (patch.jobTitle !== undefined) (sets.push('job_title = ?'), binds.push(patch.jobTitle))
      if (patch.companyUrl !== undefined) (sets.push('company_url = ?'), binds.push(patch.companyUrl))
      if (patch.role !== undefined) (sets.push('role = ?'), binds.push(patch.role))
      if (sets.length === 0) return true
      binds.push(id)
      try {
        if (patch.slug !== undefined) {
          // Same reasoning as `create`: the caller already checked both
          // users AND teams for this slug (settings route, CCC-559), but
          // that read and this write are separate round trips. Re-claiming
          // in slug_claims — delete the old claim, insert the new one, in
          // the SAME batch as the users row — is what actually arbitrates a
          // concurrent team creation (or another user's slug change)
          // landing on the identical slug in between. Deleted by
          // (kind, owner_id), not by the old slug value, since a user has
          // at most one live claim and this needs no pre-read to find it.
          await session.batch([
            q(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...binds),
            q("DELETE FROM slug_claims WHERE kind = 'user' AND owner_id = ?", id),
            q(
              "INSERT INTO slug_claims (slug,kind,owner_id,created_at) VALUES (?,'user',?,?)",
              patch.slug, id, Date.now(),
            ),
          ])
        } else {
          await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...binds)
        }
        return true
      } catch (err) {
        // A slug collision losing a race against the caller's own
        // read-then-write uniqueness check hits `users_slug_idx` (same
        // table) or `slug_claims` (cross-table, CCC-559) here — the caller
        // turns either into the same form error, never an uncaught 500.
        if (isConstraintViolation(err)) return false
        throw err
      }
    },
  }

  // -------------------------------------------------------------------------
  // Event types
  // -------------------------------------------------------------------------
  const eventTypes: EventTypeRepository = {
    async byId(id) {
      return mapEventType(await first('SELECT * FROM event_types WHERE id = ?', id))
    },
    async bySlug(ownerSlug, eventSlug) {
      // Resolve owner (user or team) then the event type, in one round trip.
      const row = await first<Record<string, unknown>>(
        `SELECT et.* FROM event_types et
         LEFT JOIN users u ON u.id = et.owner_user_id
         LEFT JOIN teams t ON t.id = et.owner_team_id
         WHERE et.slug = ? AND (u.slug = ? OR t.slug = ?) AND et.active = 1
         LIMIT 1`,
        eventSlug,
        ownerSlug,
        ownerSlug,
      )
      return mapEventType(row)
    },
    async bookingPageContext(ownerSlug, eventSlug) {
      // One query instead of two awaits: round-trip count is what the booking
      // page's latency budget is actually spent on (see the port doc).
      //
      // `owner_user_id` is only set for personal event types — a team-owned
      // one (round_robin/collective) has `owner_team_id` instead, and an
      // INNER JOIN on `users` alone 404s every one of those pages. `ru`
      // resolves one representative member (admin first, then lowest id, for
      // a stable pick) so a team-owned row still has someone to serve as the
      // page's display name/timezone default — `resolveHosts` below pulls
      // the REAL host list for slot generation; this is display-only.
      const row = await first<Record<string, unknown>>(
        `SELECT
           COALESCE(u.id, ru.id) AS u_id,
           COALESCE(u.email, ru.email) AS u_email,
           COALESCE(u.name, ru.name) AS u_name,
           COALESCE(u.tz, ru.tz) AS u_tz,
           COALESCE(u.slug, ru.slug) AS u_slug,
           COALESCE(u.avatar_key, ru.avatar_key) AS u_avatar_key,
           COALESCE(u.company, ru.company) AS u_company,
           COALESCE(u.job_title, ru.job_title) AS u_job_title,
           COALESCE(u.company_url, ru.company_url) AS u_company_url,
           COALESCE(u.created_at, ru.created_at) AS u_created_at,
           et.*
         FROM event_types et
         LEFT JOIN users u ON u.id = et.owner_user_id
         LEFT JOIN teams t ON t.id = et.owner_team_id
         LEFT JOIN users ru ON ru.id = (
           SELECT tm.user_id FROM team_members tm
           WHERE tm.team_id = et.owner_team_id
           ORDER BY (tm.role = 'admin') DESC, tm.user_id
           LIMIT 1
         )
         WHERE (u.slug = ? OR t.slug = ?) AND et.slug = ? AND et.active = 1
         LIMIT 1`,
        ownerSlug,
        ownerSlug,
        eventSlug,
      )
      if (!row) return null
      const host = mapUser({
        id: row['u_id'],
        email: row['u_email'],
        name: row['u_name'],
        tz: row['u_tz'],
        slug: row['u_slug'],
        avatar_key: row['u_avatar_key'],
        company: row['u_company'],
        job_title: row['u_job_title'],
        company_url: row['u_company_url'],
        created_at: row['u_created_at'],
      })
      const eventType = mapEventType(row)
      return host && eventType ? { host, eventType } : null
    },

    async listForUser(userId) {
      const rows = await all<Record<string, unknown>>(
        'SELECT * FROM event_types WHERE owner_user_id = ? ORDER BY created_at',
        userId,
      )
      return rows.map((r) => mapEventType(r)!).filter(Boolean)
    },
    async listForTeam(teamId) {
      const rows = await all<Record<string, unknown>>(
        'SELECT * FROM event_types WHERE owner_team_id = ? ORDER BY created_at',
        teamId,
      )
      return rows.map((r) => mapEventType(r)!).filter(Boolean)
    },
    async create(et) {
      const row = { ...et, createdAt: Date.now() }
      await run(
        `INSERT INTO event_types
         (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
          slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
          max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at,
          schedule_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        row.id, row.ownerUserId, row.ownerTeamId, row.schedulingType, row.slug, row.title,
        row.description, row.durationMinutes, row.slotIntervalMinutes, row.bufferBeforeMinutes,
        row.bufferAfterMinutes, row.minNoticeMinutes, row.maxHorizonDays, row.maxPerDay,
        row.locationType, row.locationValue, JSON.stringify(row.questions), row.active ? 1 : 0,
        row.createdAt, row.scheduleId,
      )
      return row
    },
    async update(id, patch) {
      const map: Record<string, [string, unknown]> = {}
      const put = (col: string, v: unknown) => {
        map[col] = [col, v]
      }
      // Owner and scheduling move TOGETHER through the dashboard's edit form
      // (exactly one owner column non-null, scheduling forced to match) —
      // this method just persists what validation approved. Before these
      // three lines an edit that reassigned an event type to a team silently
      // kept the old owner.
      if (patch.ownerUserId !== undefined) put('owner_user_id', patch.ownerUserId)
      if (patch.ownerTeamId !== undefined) put('owner_team_id', patch.ownerTeamId)
      if (patch.schedulingType !== undefined) put('scheduling_type', patch.schedulingType)
      if (patch.title !== undefined) put('title', patch.title)
      if (patch.description !== undefined) put('description', patch.description)
      if (patch.slug !== undefined) put('slug', patch.slug)
      if (patch.durationMinutes !== undefined) put('duration_minutes', patch.durationMinutes)
      if (patch.slotIntervalMinutes !== undefined) put('slot_interval_minutes', patch.slotIntervalMinutes)
      if (patch.bufferBeforeMinutes !== undefined) put('buffer_before_minutes', patch.bufferBeforeMinutes)
      if (patch.bufferAfterMinutes !== undefined) put('buffer_after_minutes', patch.bufferAfterMinutes)
      if (patch.minNoticeMinutes !== undefined) put('min_notice_minutes', patch.minNoticeMinutes)
      if (patch.maxHorizonDays !== undefined) put('max_horizon_days', patch.maxHorizonDays)
      if (patch.maxPerDay !== undefined) put('max_per_day', patch.maxPerDay)
      if (patch.locationType !== undefined) put('location_type', patch.locationType)
      if (patch.locationValue !== undefined) put('location_value', patch.locationValue)
      if (patch.questions !== undefined) put('questions_json', JSON.stringify(patch.questions))
      if (patch.active !== undefined) put('active', patch.active ? 1 : 0)
      if (patch.scheduleId !== undefined) put('schedule_id', patch.scheduleId)
      const entries = Object.values(map)
      if (entries.length === 0) return
      await run(
        `UPDATE event_types SET ${entries.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`,
        ...entries.map(([, v]) => v),
        id,
      )
    },
    async delete(id) {
      await run('DELETE FROM event_types WHERE id = ?', id)
    },
  }

  // -------------------------------------------------------------------------
  // Availability — named schedules (CCC-581)
  // -------------------------------------------------------------------------
  const availability: AvailabilityRepository = {
    async forUser(userId) {
      return mapSchedule(
        await first<Record<string, unknown>>(
          'SELECT * FROM schedules WHERE user_id = ? AND is_default = 1',
          userId,
        ),
      )
    },
    async listForUser(userId) {
      const rows = await all<Record<string, unknown>>(
        'SELECT * FROM schedules WHERE user_id = ? ORDER BY is_default DESC, name',
        userId,
      )
      return rows.map((r) => mapSchedule(r)!).filter(Boolean)
    },
    async byId(userId, scheduleId) {
      return mapSchedule(
        await first<Record<string, unknown>>(
          'SELECT * FROM schedules WHERE id = ? AND user_id = ?',
          scheduleId,
          userId,
        ),
      )
    },
    async create(userId, schedule) {
      await run(
        `INSERT INTO schedules (id,user_id,name,is_default,timezone,weekly_json,overrides_json,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        schedule.id,
        userId,
        schedule.name,
        schedule.isDefault ? 1 : 0,
        schedule.timezone,
        JSON.stringify(schedule.weekly),
        JSON.stringify(schedule.overrides),
        Date.now(),
      )
      return schedule
    },
    async update(userId, scheduleId, patch) {
      const sets: string[] = []
      const binds: unknown[] = []
      if (patch.name !== undefined) (sets.push('name = ?'), binds.push(patch.name))
      if (patch.timezone !== undefined) (sets.push('timezone = ?'), binds.push(patch.timezone))
      if (patch.weekly !== undefined) (sets.push('weekly_json = ?'), binds.push(JSON.stringify(patch.weekly)))
      if (patch.overrides !== undefined) {
        sets.push('overrides_json = ?')
        binds.push(JSON.stringify(patch.overrides))
      }
      if (sets.length === 0) return
      sets.push('updated_at = ?')
      binds.push(Date.now())
      binds.push(scheduleId, userId)
      await run(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, ...binds)
    },
    async delete(userId, scheduleId) {
      // One statement, same discipline as `demoteAdmin`: refuses the
      // default, the user's last schedule, or one an event type still
      // points at — all evaluated inside the DELETE itself, so no
      // interleaving between a check and the write can slip past any of the
      // three.
      const res = await q(
        `DELETE FROM schedules
         WHERE id = ? AND user_id = ?
           AND is_default = 0
           AND (SELECT COUNT(*) FROM schedules WHERE user_id = ?) > 1
           AND NOT EXISTS (SELECT 1 FROM event_types WHERE schedule_id = ?)`,
        scheduleId,
        userId,
        userId,
        scheduleId,
      ).run()
      return (res.meta.changes ?? 0) > 0
    },
    async setDefault(userId, scheduleId) {
      // Two statements in one transaction, old default cleared BEFORE the
      // new one is set: the reverse order would momentarily create two
      // is_default=1 rows for this user mid-batch, which the partial unique
      // index (schedules_user_default_idx) would immediately reject. This
      // order instead passes through a safe "zero defaults" middle state.
      //
      // The clear is itself conditional on the target still existing
      // (EXISTS subquery): without it, a concurrent delete of `scheduleId`
      // landing between this call's ownership check and this batch clears
      // the real default in statement 1, then statement 2 matches nothing —
      // committing with the user's default flag cleared everywhere, no
      // schedule marked default at all, and every personal event type
      // unbookable until the next login's backfill. Conditioning statement 1
      // on the same existence the caller already implicitly assumed keeps
      // the old default intact when the target has vanished, so the
      // `changes === 0` this returns is the ONLY thing that changed.
      const results = await session.batch([
        session
          .prepare(
            `UPDATE schedules SET is_default = 0
             WHERE user_id = ? AND is_default = 1
               AND EXISTS (SELECT 1 FROM schedules WHERE id = ? AND user_id = ?)`,
          )
          .bind(userId, scheduleId, userId),
        session.prepare('UPDATE schedules SET is_default = 1 WHERE id = ? AND user_id = ?').bind(scheduleId, userId),
      ])
      return (results[1]?.meta.changes ?? 0) > 0
    },
    async saveIfAbsent(userId, schedule) {
      // ON CONFLICT DO NOTHING against the partial unique index, not a
      // forUser-then-create check from the caller: only the database can
      // arbitrate a concurrent real save landing in the same window (see
      // the port doc comment). The conflict target must repeat the index's
      // exact predicate — a bare `ON CONFLICT(user_id)` does not match a
      // partial index.
      await run(
        `INSERT INTO schedules (id,user_id,name,is_default,timezone,weekly_json,overrides_json,updated_at)
         VALUES (?,?,?,1,?,?,?,?)
         ON CONFLICT(user_id) WHERE is_default = 1 DO NOTHING`,
        schedule.id,
        userId,
        schedule.name,
        schedule.timezone,
        JSON.stringify(schedule.weekly),
        JSON.stringify(schedule.overrides),
        Date.now(),
      )
    },
  }

  // -------------------------------------------------------------------------
  // Bookings — including the invariant
  // -------------------------------------------------------------------------
  const bookings: BookingRepository = {
    async byId(id) {
      return mapBooking(await first('SELECT * FROM bookings WHERE id = ?', id))
    },
    async byManageToken(tokenHash) {
      return mapBooking(await first('SELECT * FROM bookings WHERE manage_token_hash = ?', tokenHash))
    },
    async listForHost(hostUserId, range) {
      // `host_user_id` is only the PRIMARY host. A collective booking's other
      // attendees live in `host_user_ids_json`, so matching on the column
      // alone hid a secondary host's own meetings from their dashboard and,
      // more importantly, undercounted them for the per-day cap (see
      // `countForHostOnDate`). The LIKE match is safe because ids are UUIDs
      // from `crypto.randomUUID()` — no quotes or backslashes to escape.
      const rows = await all<Record<string, unknown>>(
        `SELECT * FROM bookings
         WHERE (host_user_id = ? OR host_user_ids_json LIKE '%"' || ? || '"%')
           AND start_utc < ? AND end_utc > ? AND status = 'confirmed'
         ORDER BY start_utc`,
        hostUserId,
        hostUserId,
        range.end,
        range.start,
      )
      return rows.map((r) => mapBooking(r)!).filter(Boolean)
    },
    async countForHostOnDate(hostUserId, range) {
      // Matched against `start_utc` in the caller's resolved range, NOT the
      // stored `local_date` column. `local_date` is stamped once, in a
      // collective booking's PRIMARY host's timezone (booking-service.ts) —
      // string-matching it for a non-primary host silently missed rows near
      // a timezone boundary and undercounted their cap.
      //
      // Same fix as `listForHost`: without matching `host_user_ids_json`, a
      // collective event type's non-primary hosts never hit their own
      // per-day cap, at listing time OR at the commit-time re-check that is
      // the actual enforcement point.
      const row = await first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM bookings
         WHERE (host_user_id = ? OR host_user_ids_json LIKE '%"' || ? || '"%')
           AND status = 'confirmed' AND start_utc >= ? AND start_utc < ?`,
        hostUserId,
        hostUserId,
        range.start,
        range.end,
      )
      return row?.n ?? 0
    },

    /**
     * The atomic write (ADR-0002 §1).
     *
     * One batch: the booking row plus one slot_locks row per bucket per host.
     * A taken bucket violates the composite primary key, D1 rolls back the
     * whole batch, and we return null for the caller to turn into a 409.
     *
     * We deliberately do NOT pre-check for conflicts and then insert: that
     * read-then-write is the classic race this design exists to eliminate.
     * The constraint IS the check.
     */
    async createWithLocks(booking, buckets) {
      const statements: D1PreparedStatement[] = [
        session
          .prepare(
            `INSERT INTO bookings
             (id,event_type_id,host_user_id,host_user_ids_json,guest_name,guest_email,guest_timezone,
              start_utc,end_utc,local_date,status,answers_json,external_event_ids_json,reschedule_of,
              rescheduled_to,manage_token_hash,cancelled_at,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            booking.id, booking.eventTypeId, booking.hostUserId,
            JSON.stringify(booking.hostUserIds), booking.guestName, booking.guestEmail,
            booking.guestTimezone, booking.startUtc, booking.endUtc, booking.localDate, booking.status,
            JSON.stringify(booking.answers), JSON.stringify(booking.externalEventIds),
            booking.rescheduleOf, booking.rescheduledTo, booking.manageTokenHash,
            booking.cancelledAt, booking.createdAt,
          ),
      ]

      for (const b of buckets) {
        statements.push(
          session
            .prepare('INSERT INTO slot_locks (host_user_id,bucket_start,booking_id) VALUES (?,?,?)')
            .bind(b.hostUserId, b.bucketStart, booking.id),
        )
      }

      try {
        await session.batch(statements)
        return booking
      } catch (err) {
        // A UNIQUE/PK violation means someone else won the race for a bucket.
        // Anything else is a real failure and must not be silently swallowed.
        if (isConstraintViolation(err)) return null
        throw err
      }
    },

    async dueBetween(from, to) {
      const rows = await all<Record<string, unknown>>(
        `SELECT * FROM bookings
         WHERE status = 'confirmed' AND start_utc >= ? AND start_utc < ?
         ORDER BY start_utc`,
        from,
        to,
      )
      return rows.map((r) => mapBooking(r)!).filter(Boolean)
    },

    async cancelWithLockRelease(bookingId, at) {
      // Conditional on the CURRENT status, not just the id: a cancel racing a
      // concurrent reschedule (two guest tabs, a double-submitted form) must
      // not stomp a booking that a parallel request already moved. Releasing
      // locks in the same batch keeps "cancelled" and "slot free" from ever
      // disagreeing.
      const results = await session.batch([
        session
          .prepare(
            "UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'confirmed'",
          )
          .bind(at, bookingId),
        session.prepare('DELETE FROM slot_locks WHERE booking_id = ?').bind(bookingId),
      ])
      return (results[0]?.meta.changes ?? 0) > 0
    },

    async markRescheduled(bookingId, newBookingId) {
      // Same guard as cancel: without `status = 'confirmed'` here, two
      // concurrent reschedules of the same booking can each create a real,
      // confirmed replacement, and this UPDATE would just silently pick
      // whichever wrote last — leaving the other replacement live and
      // orphaned. The caller rolls back its new booking when this is false.
      const results = await session.batch([
        session
          .prepare(
            "UPDATE bookings SET status = 'rescheduled', rescheduled_to = ? WHERE id = ? AND status = 'confirmed'",
          )
          .bind(newBookingId, bookingId),
        session.prepare('DELETE FROM slot_locks WHERE booking_id = ?').bind(bookingId),
      ])
      return (results[0]?.meta.changes ?? 0) > 0
    },

    async setExternalEventIds(bookingId, ids) {
      await run(
        'UPDATE bookings SET external_event_ids_json = ? WHERE id = ?',
        JSON.stringify(ids),
        bookingId,
      )
    },

    async rotateManageToken(bookingId, tokenHash) {
      await run('UPDATE bookings SET manage_token_hash = ? WHERE id = ?', tokenHash, bookingId)
    },
  }

  // -------------------------------------------------------------------------
  // Slot locks and holds
  // -------------------------------------------------------------------------
  const slotLocks: SlotLockRepository = {
    async busyBuckets(hostUserIds, range) {
      if (hostUserIds.length === 0) return new Map()
      const placeholders = hostUserIds.map(() => '?').join(',')
      const rows = await all<{ host_user_id: string; bucket_start: number }>(
        `SELECT host_user_id, bucket_start FROM slot_locks
         WHERE host_user_id IN (${placeholders}) AND bucket_start >= ? AND bucket_start < ?`,
        ...hostUserIds,
        range.start,
        range.end,
      )
      return groupBuckets(rows)
    },

    async activeHolds(hostUserIds, range, now, excludeHoldId) {
      if (hostUserIds.length === 0) return new Map()
      const placeholders = hostUserIds.map(() => '?').join(',')
      // Filtering expired rows on read means a missed alarm degrades to a
      // slightly stale suppression, never a stuck calendar (ADR-0002 §2).
      //
      // `excludeHoldId` drops the caller's own hold from the result — see the
      // port doc comment for why that matters at commit time.
      const rows = await all<{ host_user_id: string; bucket_start: number }>(
        `SELECT host_user_id, bucket_start FROM slot_holds
         WHERE host_user_id IN (${placeholders}) AND bucket_start >= ? AND bucket_start < ?
           AND expires_at > ? AND hold_id != ?`,
        ...hostUserIds,
        range.start,
        range.end,
        now,
        excludeHoldId ?? '',
      )
      return groupBuckets(rows)
    },

    async createHold(hold, buckets) {
      if (buckets.length === 0) return false
      const stmts = buckets.map((b) =>
        session
          .prepare(
            `INSERT INTO slot_holds (host_user_id,bucket_start,hold_id,event_type_id,expires_at,created_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .bind(b.hostUserId, b.bucketStart, hold.id, hold.eventTypeId, hold.expiresAt, hold.createdAt),
      )
      try {
        await session.batch(stmts)
        return true
      } catch (err) {
        // Holds are advisory; failing to place one must never block a booking.
        if (isConstraintViolation(err)) return false
        throw err
      }
    },

    async releaseHold(holdId) {
      await run('DELETE FROM slot_holds WHERE hold_id = ?', holdId)
    },

    async expireHolds(before) {
      const r = await q('DELETE FROM slot_holds WHERE expires_at <= ?', before).run()
      return r.meta?.changes ?? 0
    },

    async pruneLocksBefore(cutoff) {
      const r = await q('DELETE FROM slot_locks WHERE bucket_start < ?', cutoff).run()
      return r.meta?.changes ?? 0
    },
  }

  // -------------------------------------------------------------------------
  // Teams
  // -------------------------------------------------------------------------
  const teams: TeamRepository = {
    async byId(id) {
      return mapTeam(await first('SELECT * FROM teams WHERE id = ?', id))
    },
    async bySlug(slug) {
      return mapTeam(await first('SELECT * FROM teams WHERE slug = ?', slug))
    },
    async members(teamId) {
      const rows = await all<Record<string, unknown>>(
        'SELECT * FROM team_members WHERE team_id = ?',
        teamId,
      )
      return rows.map(mapMember)
    },
    async memberships(userId) {
      const rows = await all<Record<string, unknown>>(
        'SELECT * FROM team_members WHERE user_id = ?',
        userId,
      )
      return rows.map(mapMember)
    },
    async create(team) {
      const row = { ...team, createdAt: Date.now() }
      // Same claim, same batch, as createWithFirstMember (CCC-559) — a bare
      // single-statement insert here would let this sibling method write a
      // team whose slug nothing in slug_claims holds, silently reopening the
      // exact cross-table race that table exists to close.
      try {
        await session.batch([
          q(
            'INSERT INTO teams (id,name,slug,logo_key,created_at) VALUES (?,?,?,?,?)',
            row.id, row.name, row.slug, row.logoKey, row.createdAt,
          ),
          q(
            'INSERT INTO slug_claims (slug,kind,owner_id,created_at) VALUES (?,?,?,?)',
            row.slug, 'team', row.id, row.createdAt,
          ),
        ])
        return row
      } catch (err) {
        if (isConstraintViolation(err)) return null
        throw err
      }
    },
    async createWithFirstMember(team, member) {
      const row = { ...team, createdAt: Date.now() }
      // One batch: D1 rolls the whole thing back if any insert fails, so a
      // memberless (unmanageable, slug-squatting) team can never exist. The
      // slug_claims insert is what actually arbitrates a concurrent signup
      // or slug change claiming this exact slug (CCC-559) — teams_slug_idx
      // alone only ever caught another team wanting the same slug.
      try {
        await session.batch([
          q(
            'INSERT INTO teams (id,name,slug,logo_key,created_at) VALUES (?,?,?,?,?)',
            row.id, row.name, row.slug, row.logoKey, row.createdAt,
          ),
          q(
            'INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)',
            row.id, member.userId, member.role, member.rrWeight,
          ),
          q(
            'INSERT INTO slug_claims (slug,kind,owner_id,created_at) VALUES (?,?,?,?)',
            row.slug, 'team', row.id, row.createdAt,
          ),
        ])
        return row
      } catch (err) {
        // The route's own precheck is read-then-write: a concurrent create of
        // the same slug (by another team, a signup, or a slug change) can
        // slip past it and hit teams_slug_idx or slug_claims here instead.
        // Without this catch that surfaced as a bare 500 rather than the
        // same "slug already taken" form error the precheck gives everyone
        // else.
        if (isConstraintViolation(err)) return null
        throw err
      }
    },
    async updateLogo(id, logoKey) {
      await run('UPDATE teams SET logo_key = ? WHERE id = ?', logoKey, id)
    },
    async addMember(m) {
      await run(
        `INSERT INTO team_members (team_id,user_id,role,rr_weight) VALUES (?,?,?,?)
         ON CONFLICT(team_id,user_id) DO UPDATE SET role = excluded.role, rr_weight = excluded.rr_weight`,
        m.teamId, m.userId, m.role, m.rrWeight,
      )
    },
    async removeMember(teamId, userId) {
      await run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId)
    },
    async removeMemberGuarded(teamId, userId) {
      // One statement, same discipline as `demoteAdmin`: the member count is
      // evaluated inside the delete, so concurrent removals cannot both pass
      // a separate check and leave the team with zero members.
      const res = await q(
        `DELETE FROM team_members
         WHERE team_id = ? AND user_id = ?
           AND (SELECT COUNT(*) FROM team_members WHERE team_id = ?) > 1`,
        teamId, userId, teamId,
      ).run()
      return (res.meta.changes ?? 0) > 0
    },
    async recordAssignment(teamId, userId, at) {
      await run(
        `INSERT INTO rr_assignments (team_id,user_id,last_assigned_at) VALUES (?,?,?)
         ON CONFLICT(team_id,user_id) DO UPDATE SET last_assigned_at = excluded.last_assigned_at`,
        teamId,
        userId,
        at,
      )
    },

    async lastAssignedAt(teamId, userIds) {
      if (userIds.length === 0) return new Map()
      const placeholders = userIds.map(() => '?').join(',')
      const rows = await all<{ user_id: string; last_assigned_at: number }>(
        `SELECT user_id, last_assigned_at FROM rr_assignments
         WHERE team_id = ? AND user_id IN (${placeholders})`,
        teamId,
        ...userIds,
      )
      const out = new Map<string, number>()
      for (const r of rows) out.set(r.user_id, r.last_assigned_at)
      return out
    },
  }

  // -------------------------------------------------------------------------
  // Calendar connections
  // -------------------------------------------------------------------------
  const connections: CalendarConnectionRepository = {
    async byId(id) {
      return mapConnection(await first('SELECT * FROM calendar_connections WHERE id = ?', id))
    },
    async listForUser(userId) {
      const rows = await all<Record<string, unknown>>(
        'SELECT * FROM calendar_connections WHERE user_id = ?',
        userId,
      )
      return rows.map((r) => mapConnection(r)!).filter(Boolean)
    },
    async create(conn) {
      await run(
        `INSERT INTO calendar_connections
         (id,user_id,provider,provider_account_email,encrypted_tokens,key_version,
          calendar_ids_read_json,calendar_id_write,sync_status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        conn.id, conn.userId, conn.provider, conn.providerAccountEmail, conn.encryptedTokens,
        conn.keyVersion, JSON.stringify(conn.calendarIdsRead), conn.calendarIdWrite,
        conn.syncStatus, conn.createdAt,
      )
      return conn
    },
    async updateTokens(id, encryptedTokens, keyVersion) {
      await run(
        'UPDATE calendar_connections SET encrypted_tokens = ?, key_version = ? WHERE id = ?',
        encryptedTokens, keyVersion, id,
      )
    },
    async updateSyncStatus(id, status) {
      await run('UPDATE calendar_connections SET sync_status = ? WHERE id = ?', status, id)
    },
    async updateCalendars(id, patch) {
      await run(
        'UPDATE calendar_connections SET calendar_ids_read_json = ?, calendar_id_write = ? WHERE id = ?',
        JSON.stringify(patch.read), patch.write, id,
      )
    },
    async delete(id) {
      await run('DELETE FROM calendar_connections WHERE id = ?', id)
    },
  }

  // -------------------------------------------------------------------------
  // Sessions and magic links
  // -------------------------------------------------------------------------
  const sessions: SessionRepository = {
    async byIdHash(idHash) {
      const row = await first<Record<string, unknown>>(
        'SELECT * FROM sessions WHERE id_hash = ?',
        idHash,
      )
      if (!row) return null
      return {
        idHash: String(row['id_hash']),
        userId: String(row['user_id']),
        expiresAt: Number(row['expires_at']),
        absoluteExpiresAt: Number(row['absolute_expires_at']),
        bookmark: row['bookmark'] == null ? null : String(row['bookmark']),
        createdAt: Number(row['created_at']),
      }
    },
    async create(s) {
      await run(
        `INSERT INTO sessions (id_hash,user_id,expires_at,absolute_expires_at,bookmark,created_at)
         VALUES (?,?,?,?,?,?)`,
        s.idHash, s.userId, s.expiresAt, s.absoluteExpiresAt, s.bookmark, s.createdAt,
      )
    },
    async touch(idHash, expiresAt, bookmark) {
      await run(
        'UPDATE sessions SET expires_at = ?, bookmark = COALESCE(?, bookmark) WHERE id_hash = ?',
        expiresAt, bookmark, idHash,
      )
    },
    async delete(idHash) {
      await run('DELETE FROM sessions WHERE id_hash = ?', idHash)
    },
    async deleteAllForUser(userId) {
      await run('DELETE FROM sessions WHERE user_id = ?', userId)
    },
    async createMagicLink(t) {
      await run(
        'INSERT INTO magic_link_tokens (token_hash,email,expires_at,created_at) VALUES (?,?,?,?)',
        t.tokenHash, t.email.toLowerCase(), t.expiresAt, t.createdAt,
      )
    },
    /**
     * Single-use by construction: DELETE … RETURNING is atomic, so a replay
     * finds nothing and fails closed. A read-then-delete would let two
     * concurrent redemptions of the same link both succeed.
     */
    async consumeMagicLink(tokenHash, now) {
      const row = await first<Record<string, unknown>>(
        'DELETE FROM magic_link_tokens WHERE token_hash = ? AND expires_at > ? RETURNING *',
        tokenHash, now,
      )
      if (!row) return null
      return {
        tokenHash: String(row['token_hash']),
        email: String(row['email']),
        expiresAt: Number(row['expires_at']),
        createdAt: Number(row['created_at']),
      }
    },
  }

  // -------------------------------------------------------------------------
  // API keys, webhooks, idempotency
  // -------------------------------------------------------------------------
  const apiKeys: ApiKeyRepository = {
    async byPrefix(prefix) {
      return mapApiKey(await first('SELECT * FROM api_keys WHERE prefix = ?', prefix))
    },
    async listForUser(userId) {
      const rows = await all<Record<string, unknown>>('SELECT * FROM api_keys WHERE user_id = ?', userId)
      return rows.map((r) => mapApiKey(r)!).filter(Boolean)
    },
    async create(k) {
      await run(
        `INSERT INTO api_keys (id,user_id,prefix,hash_sha256,name,scopes_json,last_used_at,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        k.id, k.userId, k.prefix, k.hashSha256, k.name, JSON.stringify(k.scopes), k.lastUsedAt, k.createdAt,
      )
    },
    async delete(id) {
      await run('DELETE FROM api_keys WHERE id = ?', id)
    },
    async touchLastUsed(id, at) {
      await run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', at, id)
    },
  }

  const webhooks: WebhookRepository = {
    async listForUser(userId) {
      const rows = await all<Record<string, unknown>>(
        'SELECT * FROM webhooks WHERE user_id = ? AND active = 1',
        userId,
      )
      return rows.map((r) => mapWebhook(r)!).filter(Boolean)
    },
    async byId(id) {
      return mapWebhook(await first('SELECT * FROM webhooks WHERE id = ?', id))
    },
    async create(w) {
      await run(
        'INSERT INTO webhooks (id,user_id,url,secret,events_json,active,created_at) VALUES (?,?,?,?,?,?,?)',
        w.id, w.userId, w.url, w.secret, JSON.stringify(w.events), w.active ? 1 : 0, w.createdAt,
      )
    },
    async delete(id) {
      await run('DELETE FROM webhooks WHERE id = ?', id)
    },
  }

  const idempotency: IdempotencyRepository = {
    async get(key, scope_) {
      const row = await first<Record<string, unknown>>(
        'SELECT * FROM idempotency_keys WHERE key = ? AND scope = ? AND expires_at > ?',
        key, scope_, Date.now(),
      )
      if (!row) return null
      return {
        key: String(row['key']),
        scope: String(row['scope']),
        requestHash: String(row['request_hash']),
        responseJson: String(row['response_json']),
        status: Number(row['status']),
        expiresAt: Number(row['expires_at']),
      }
    },
    async put(r: StoredIdempotentResponse) {
      // Must also update expires_at (and request_hash, for symmetry with
      // reserve() below): the coordinator's failure path calls this with
      // expiresAt = now to make a lost reservation immediately reclaimable.
      // Without expires_at in the SET list that release is a no-op — the row
      // keeps whatever TTL `reserve()` originally set, and every retry after
      // a failed booking attempt reads back the stale placeholder and gets
      // told to wait out the full 24h TTL instead of being allowed to retry.
      await run(
        `INSERT INTO idempotency_keys (key,scope,request_hash,response_json,status,expires_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(key,scope) DO UPDATE SET
           request_hash = excluded.request_hash,
           response_json = excluded.response_json,
           status = excluded.status,
           expires_at = excluded.expires_at`,
        r.key, r.scope, r.requestHash, r.responseJson, r.status, r.expiresAt,
      )
    },
    async reserve(r: StoredIdempotentResponse) {
      // The WHERE clause on the upsert is the compare-and-swap: it only lets
      // the insert "win" over an existing row once that row has expired, so a
      // still-live reservation stays untouched and `changes` comes back 0 —
      // that is how the loser of the race is told to back off.
      const res = await q(
        `INSERT INTO idempotency_keys (key,scope,request_hash,response_json,status,expires_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(key,scope) DO UPDATE SET
           request_hash = excluded.request_hash,
           response_json = excluded.response_json,
           status = excluded.status,
           expires_at = excluded.expires_at
         WHERE idempotency_keys.expires_at <= ?`,
        r.key, r.scope, r.requestHash, r.responseJson, r.status, r.expiresAt, Date.now(),
      ).run()
      if ((res.meta.changes ?? 0) > 0) return { reserved: true as const }

      const row = await first<Record<string, unknown>>(
        'SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?',
        r.key, r.scope,
      )
      // A row that raced us out of existence between the failed upsert and
      // this read is vanishingly unlikely (it would need a delete we never
      // issue) — reserved is the safe default rather than throwing.
      if (!row) return { reserved: true as const }
      return {
        reserved: false as const,
        existing: {
          key: String(row['key']),
          scope: String(row['scope']),
          requestHash: String(row['request_hash']),
          responseJson: String(row['response_json']),
          status: Number(row['status']),
          expiresAt: Number(row['expires_at']),
        },
      }
    },
  }

  const settings: SettingsRepository = {
    async get(key) {
      const row = await first<{ value: string }>(
        'SELECT value FROM instance_settings WHERE key = ?',
        key,
      )
      return row?.value ?? null
    },
    async set(key, value, now) {
      await run(
        `INSERT INTO instance_settings (key,value,updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key, value, now,
      )
    },
  }

  return {
    users, eventTypes, availability, bookings, slotLocks, teams, connections,
    sessions, apiKeys, webhooks, idempotency, settings,
    async telemetryCounts() {
      const row = await first<{ users: number; event_types: number; bookings: number }>(
        `SELECT
           (SELECT COUNT(*) FROM users)       AS users,
           (SELECT COUNT(*) FROM event_types) AS event_types,
           (SELECT COUNT(*) FROM bookings)    AS bookings`,
      )
      return {
        users: row?.users ?? 0,
        eventTypes: row?.event_types ?? 0,
        bookings: row?.bookings ?? 0,
      }
    },
    bookmark: () => session.getBookmark() ?? null,
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function groupBuckets(rows: Array<{ host_user_id: string; bucket_start: number }>): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const r of rows) {
    const list = out.get(r.host_user_id)
    if (list) list.push(r.bucket_start)
    else out.set(r.host_user_id, [r.bucket_start])
  }
  return out
}

/**
 * D1 surfaces constraint failures as a message string; there is no typed error
 * class. Matching on the SQLite text is the available signal, and the exact
 * wording was confirmed against production D1.
 */
export function isConstraintViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('UNIQUE constraint failed') ||
    msg.includes('SQLITE_CONSTRAINT') ||
    msg.includes('PRIMARY KEY')
  )
}

function mapSchedule(row: Record<string, unknown> | null): Schedule | null {
  if (!row) return null
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    name: String(row['name']),
    isDefault: Number(row['is_default']) === 1,
    timezone: String(row['timezone']),
    weekly: JSON.parse(String(row['weekly_json'])) as WeeklySchedule,
    overrides: JSON.parse(String(row['overrides_json'] ?? '[]')),
  }
}

function mapUser(row: Record<string, unknown> | null): User | null {
  if (!row) return null
  return {
    id: String(row['id']),
    email: String(row['email']),
    name: String(row['name'] ?? ''),
    tz: String(row['tz'] ?? 'UTC'),
    slug: String(row['slug']),
    avatarKey: row['avatar_key'] == null ? null : String(row['avatar_key']),
    company: row['company'] == null ? null : String(row['company']),
    jobTitle: row['job_title'] == null ? null : String(row['job_title']),
    companyUrl: row['company_url'] == null ? null : String(row['company_url']),
    role: row['role'] === 'admin' ? 'admin' : 'member',
    createdAt: Number(row['created_at']),
  }
}

function mapTeam(row: Record<string, unknown> | null): Team | null {
  if (!row) return null
  return {
    id: String(row['id']),
    name: String(row['name']),
    slug: String(row['slug']),
    logoKey: row['logo_key'] == null ? null : String(row['logo_key']),
    createdAt: Number(row['created_at']),
  }
}

function mapMember(row: Record<string, unknown>): TeamMember {
  return {
    teamId: String(row['team_id']),
    userId: String(row['user_id']),
    role: String(row['role']) as TeamMember['role'],
    rrWeight: Number(row['rr_weight'] ?? 1),
  }
}

function mapEventType(row: Record<string, unknown> | null): EventType | null {
  if (!row) return null
  return {
    id: String(row['id']),
    ownerUserId: row['owner_user_id'] == null ? null : String(row['owner_user_id']),
    ownerTeamId: row['owner_team_id'] == null ? null : String(row['owner_team_id']),
    schedulingType: String(row['scheduling_type']) as EventType['schedulingType'],
    slug: String(row['slug']),
    title: String(row['title']),
    description: String(row['description'] ?? ''),
    durationMinutes: Number(row['duration_minutes']),
    slotIntervalMinutes: row['slot_interval_minutes'] == null ? null : Number(row['slot_interval_minutes']),
    bufferBeforeMinutes: Number(row['buffer_before_minutes'] ?? 0),
    bufferAfterMinutes: Number(row['buffer_after_minutes'] ?? 0),
    minNoticeMinutes: Number(row['min_notice_minutes'] ?? 0),
    maxHorizonDays: Number(row['max_horizon_days'] ?? 60),
    maxPerDay: row['max_per_day'] == null ? null : Number(row['max_per_day']),
    locationType: String(row['location_type']) as EventType['locationType'],
    locationValue: row['location_value'] == null ? null : String(row['location_value']),
    questions: JSON.parse(String(row['questions_json'] ?? '[]')),
    active: Number(row['active']) === 1,
    createdAt: Number(row['created_at']),
    scheduleId: row['schedule_id'] == null ? null : String(row['schedule_id']),
  }
}

function mapBooking(row: Record<string, unknown> | null): Booking | null {
  if (!row) return null
  return {
    id: String(row['id']),
    eventTypeId: String(row['event_type_id']),
    hostUserId: String(row['host_user_id']),
    hostUserIds: JSON.parse(String(row['host_user_ids_json'] ?? '[]')),
    guestName: String(row['guest_name']),
    guestEmail: String(row['guest_email']),
    guestTimezone: String(row['guest_timezone'] ?? 'UTC'),
    startUtc: Number(row['start_utc']),
    endUtc: Number(row['end_utc']),
    localDate: String(row['local_date'] ?? ''),
    status: String(row['status']) as Booking['status'],
    answers: JSON.parse(String(row['answers_json'] ?? '{}')),
    externalEventIds: JSON.parse(String(row['external_event_ids_json'] ?? '{}')),
    rescheduleOf: row['reschedule_of'] == null ? null : String(row['reschedule_of']),
    rescheduledTo: row['rescheduled_to'] == null ? null : String(row['rescheduled_to']),
    manageTokenHash: String(row['manage_token_hash']),
    cancelledAt: row['cancelled_at'] == null ? null : Number(row['cancelled_at']),
    createdAt: Number(row['created_at']),
  }
}

function mapConnection(row: Record<string, unknown> | null): CalendarConnection | null {
  if (!row) return null
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    provider: String(row['provider']) as CalendarConnection['provider'],
    providerAccountEmail: String(row['provider_account_email'] ?? ''),
    encryptedTokens: String(row['encrypted_tokens']),
    keyVersion: Number(row['key_version'] ?? 1),
    calendarIdsRead: JSON.parse(String(row['calendar_ids_read_json'] ?? '[]')),
    calendarIdWrite: row['calendar_id_write'] == null ? null : String(row['calendar_id_write']),
    syncStatus: String(row['sync_status'] ?? 'ok') as CalendarConnection['syncStatus'],
    createdAt: Number(row['created_at']),
  }
}

function mapApiKey(row: Record<string, unknown> | null): ApiKey | null {
  if (!row) return null
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    prefix: String(row['prefix']),
    hashSha256: String(row['hash_sha256']),
    name: String(row['name'] ?? ''),
    scopes: JSON.parse(String(row['scopes_json'] ?? '[]')),
    lastUsedAt: row['last_used_at'] == null ? null : Number(row['last_used_at']),
    createdAt: Number(row['created_at']),
  }
}

function mapWebhook(row: Record<string, unknown> | null): Webhook | null {
  if (!row) return null
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    url: String(row['url']),
    secret: String(row['secret']),
    events: JSON.parse(String(row['events_json'] ?? '[]')),
    active: Number(row['active']) === 1,
    createdAt: Number(row['created_at']),
  }
}
