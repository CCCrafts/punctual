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
 *    fails the whole thing. Verified on production D1 (CCC-469).
 *
 * Nothing here knows about tenants. The cloud control-plane wraps these with
 * an implementation that closes over tenant_id.
 */

import type {
  ApiKey,
  Booking,
  CalendarConnection,
  EventType,
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

export function createD1Repositories(db: D1Database, scope: RequestScope): Repositories {
  const session =
    scope.consistency === 'bookmark' && scope.bookmark
      ? db.withSession(scope.bookmark)
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
    async create(user) {
      const row = { ...user, createdAt: Date.now() }
      await run(
        'INSERT INTO users (id,email,name,tz,slug,created_at) VALUES (?,?,?,?,?,?)',
        row.id,
        row.email.toLowerCase(),
        row.name,
        row.tz,
        row.slug,
        row.createdAt,
      )
      return row
    },
    async update(id, patch) {
      const sets: string[] = []
      const binds: unknown[] = []
      if (patch.name !== undefined) (sets.push('name = ?'), binds.push(patch.name))
      if (patch.tz !== undefined) (sets.push('tz = ?'), binds.push(patch.tz))
      if (patch.slug !== undefined) (sets.push('slug = ?'), binds.push(patch.slug))
      if (sets.length === 0) return
      binds.push(id)
      await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...binds)
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
          max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        row.id, row.ownerUserId, row.ownerTeamId, row.schedulingType, row.slug, row.title,
        row.description, row.durationMinutes, row.slotIntervalMinutes, row.bufferBeforeMinutes,
        row.bufferAfterMinutes, row.minNoticeMinutes, row.maxHorizonDays, row.maxPerDay,
        row.locationType, row.locationValue, JSON.stringify(row.questions), row.active ? 1 : 0,
        row.createdAt,
      )
      return row
    },
    async update(id, patch) {
      const map: Record<string, [string, unknown]> = {}
      const put = (col: string, v: unknown) => {
        map[col] = [col, v]
      }
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
  // Availability
  // -------------------------------------------------------------------------
  const availability: AvailabilityRepository = {
    async forUser(userId) {
      const row = await first<Record<string, unknown>>(
        'SELECT * FROM availability_schedules WHERE user_id = ?',
        userId,
      )
      if (!row) return null
      return {
        userId: String(row['user_id']),
        timezone: String(row['timezone']),
        weekly: JSON.parse(String(row['weekly_json'])) as WeeklySchedule,
        overrides: JSON.parse(String(row['overrides_json'] ?? '[]')),
      }
    },
    async save(userId, av) {
      await run(
        `INSERT INTO availability_schedules (user_id,timezone,weekly_json,overrides_json,updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           timezone = excluded.timezone,
           weekly_json = excluded.weekly_json,
           overrides_json = excluded.overrides_json,
           updated_at = excluded.updated_at`,
        userId,
        av.timezone,
        JSON.stringify(av.weekly),
        JSON.stringify(av.overrides),
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
      const rows = await all<Record<string, unknown>>(
        `SELECT * FROM bookings
         WHERE host_user_id = ? AND start_utc < ? AND end_utc > ? AND status = 'confirmed'
         ORDER BY start_utc`,
        hostUserId,
        range.end,
        range.start,
      )
      return rows.map((r) => mapBooking(r)!).filter(Boolean)
    },
    async countForHostOnDate(hostUserId, localDate) {
      // The caller resolves the local date to a UTC range, because only it
      // knows the host's timezone. This takes the resolved range.
      const row = await first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM bookings
         WHERE host_user_id = ? AND status = 'confirmed' AND local_date = ?`,
        hostUserId,
        localDate,
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
      // Releasing locks in the same batch keeps "cancelled" and "slot free"
      // from ever disagreeing.
      await session.batch([
        session
          .prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
          .bind(at, bookingId),
        session.prepare('DELETE FROM slot_locks WHERE booking_id = ?').bind(bookingId),
      ])
    },

    async markRescheduled(bookingId, newBookingId) {
      await session.batch([
        session
          .prepare("UPDATE bookings SET status = 'rescheduled', rescheduled_to = ? WHERE id = ?")
          .bind(newBookingId, bookingId),
        session.prepare('DELETE FROM slot_locks WHERE booking_id = ?').bind(bookingId),
      ])
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

    async activeHolds(hostUserIds, range, now) {
      if (hostUserIds.length === 0) return new Map()
      const placeholders = hostUserIds.map(() => '?').join(',')
      // Filtering expired rows on read means a missed alarm degrades to a
      // slightly stale suppression, never a stuck calendar (ADR-0002 §2).
      const rows = await all<{ host_user_id: string; bucket_start: number }>(
        `SELECT host_user_id, bucket_start FROM slot_holds
         WHERE host_user_id IN (${placeholders}) AND bucket_start >= ? AND bucket_start < ?
           AND expires_at > ?`,
        ...hostUserIds,
        range.start,
        range.end,
        now,
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
      await run('INSERT INTO teams (id,name,slug,created_at) VALUES (?,?,?,?)', row.id, row.name, row.slug, row.createdAt)
      return row
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
      await run(
        `INSERT INTO idempotency_keys (key,scope,request_hash,response_json,status,expires_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(key,scope) DO UPDATE SET
           response_json = excluded.response_json, status = excluded.status`,
        r.key, r.scope, r.requestHash, r.responseJson, r.status, r.expiresAt,
      )
    },
  }

  return {
    users, eventTypes, availability, bookings, slotLocks, teams, connections,
    sessions, apiKeys, webhooks, idempotency,
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
 * class. Matching on the SQLite text is the available signal — and the CCC-469
 * spike confirmed the exact wording on production D1.
 */
export function isConstraintViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('UNIQUE constraint failed') ||
    msg.includes('SQLITE_CONSTRAINT') ||
    msg.includes('PRIMARY KEY')
  )
}

function mapUser(row: Record<string, unknown> | null): User | null {
  if (!row) return null
  return {
    id: String(row['id']),
    email: String(row['email']),
    name: String(row['name'] ?? ''),
    tz: String(row['tz'] ?? 'UTC'),
    slug: String(row['slug']),
    createdAt: Number(row['created_at']),
  }
}

function mapTeam(row: Record<string, unknown> | null): Team | null {
  if (!row) return null
  return {
    id: String(row['id']),
    name: String(row['name']),
    slug: String(row['slug']),
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
