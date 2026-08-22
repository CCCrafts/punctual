/**
 * `punctual slots` — live availability from a running instance, over the
 * same REST API any integration uses. Needs an API key (dashboard → API
 * keys) because the engine has no unauthenticated JSON surface: the public
 * booking page is server-rendered HTML on purpose.
 */

import { Spinner, type TermInfo, bold, color, dayLabel, detectTerm, dim, table, timeLabel, wordmark } from './style.js'

interface EventTypeRow {
  id: string
  slug: string
  title: string
  durationMinutes: number
}

interface SlotRow {
  start: { epochMs: number }
  localDate: string
}

interface SlotsResponse {
  data: SlotRow[]
  meta: { timezone: string }
}

export function parseSlotsArgs(args: string[]): {
  url?: string
  key?: string
  event?: string
  days: number
  tz?: string
  error?: string
} {
  const out: { url?: string; key?: string; event?: string; days: number; tz?: string; error?: string } = { days: 7 }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => {
      const v = args[++i]
      if (v === undefined) out.error = `${a} needs a value`
      return v
    }
    if (a === '--url') out.url = next()
    else if (a === '--key') out.key = next()
    else if (a === '--event') out.event = next()
    else if (a === '--tz') out.tz = next()
    else if (a === '--days') {
      const v = Number(next())
      if (!Number.isInteger(v) || v < 1 || v > 31) out.error = '--days must be a whole number from 1 to 31'
      else out.days = v
    } else if (!a.startsWith('-') && out.url === undefined) out.url = a
    else out.error = `Unknown option: ${a}`
    if (out.error) break
  }
  return out
}

export type EventTypePick =
  | { kind: 'ok'; match: EventTypeRow }
  | { kind: 'empty' }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; matches: EventTypeRow[] }
  | { kind: 'unspecified'; all: EventTypeRow[] }

/**
 * Resolve `--event` against the instance's event types. Slugs are unique per
 * OWNER, not globally — a personal `/alice/30min` and a team `/sales/30min`
 * can coexist — so a slug that matches twice is ambiguous, never
 * first-match-wins: silently showing the wrong calendar's availability is
 * the worst outcome this command has.
 */
export function pickEventType(all: EventTypeRow[], requested: string | undefined): EventTypePick {
  if (all.length === 0) return { kind: 'empty' }
  if (requested === undefined) {
    return all.length === 1 ? { kind: 'ok', match: all[0]! } : { kind: 'unspecified', all }
  }
  const byId = all.find((e) => e.id === requested)
  if (byId) return { kind: 'ok', match: byId }
  const bySlug = all.filter((e) => e.slug === requested)
  if (bySlug.length === 1) return { kind: 'ok', match: bySlug[0]! }
  if (bySlug.length > 1) return { kind: 'ambiguous', matches: bySlug }
  return { kind: 'not-found' }
}

/** Group into `date → aligned time cells`, ready for tabular printing. */
export function groupByDay(slots: SlotRow[], timezone: string): Array<{ day: string; times: string[] }> {
  const byDate = new Map<string, { day: string; times: string[] }>()
  for (const slot of slots) {
    const entry = byDate.get(slot.localDate) ?? {
      day: dayLabel(slot.start.epochMs, timezone),
      times: [],
    }
    entry.times.push(timeLabel(slot.start.epochMs, timezone))
    byDate.set(slot.localDate, entry)
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry)
}

async function api<T>(base: string, key: string, path: string): Promise<T> {
  const res = await fetch(`${base}/api/v1${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  })
  if (res.status === 401) {
    throw new Error('The API key was rejected (401). Create one in your dashboard under API keys.')
  }
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} from ${path}: ${body.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

function usage(term: TermInfo): string {
  return [
    `Usage: ${bold('punctual slots', term)} --url https://your-instance [--event slug] [--days 7] [--tz Zone]`,
    '',
    'The API key comes from --key or the PUNCTUAL_API_KEY environment variable',
    '(create one in your dashboard under API keys).',
  ].join('\n')
}

export async function slots(args: string[]): Promise<number> {
  const term = detectTerm()
  const out = process.stdout
  const parsed = parseSlotsArgs(args)
  const key = parsed.key ?? process.env['PUNCTUAL_API_KEY']

  if (parsed.error) {
    out.write(`${parsed.error}\n\n${usage(term)}\n`)
    return 1
  }
  if (!parsed.url || !key) {
    out.write(`${usage(term)}\n`)
    return 1
  }
  const base = parsed.url.replace(/\/+$/, '')

  const spinner = new Spinner(term, out)
  try {
    spinner.start('Loading event types')
    const eventTypes = await api<{ data: EventTypeRow[] }>(base, key, '/event-types')
    const picked = pickEventType(eventTypes.data, parsed.event)

    if (picked.kind !== 'ok') {
      const listing = (rows: EventTypeRow[]) =>
        `\n${table(
          rows.map((e) => [e.slug, e.title, `${e.durationMinutes} min`, e.id]),
          [{ paint: (c, t) => color(c, 'green', t) }, {}, { align: 'right' }, { paint: (c, t) => dim(c, t) }],
          term,
        )}\n`
      switch (picked.kind) {
        case 'empty':
          spinner.stop('failed', 'No event types yet — create one in the dashboard first')
          return 1
        case 'not-found':
          spinner.stop('failed', `No event type "${parsed.event}"`)
          out.write(listing(eventTypes.data))
          return 1
        case 'ambiguous':
          spinner.stop('failed', `"${parsed.event}" matches more than one event type — use its id`)
          out.write(listing(picked.matches))
          return 1
        case 'unspecified':
          spinner.stop('held', 'Several event types — pick one with --event')
          out.write(listing(picked.all))
          return 0
      }
    }
    const match = picked.match

    spinner.update(`Loading slots for ${match.title}`)
    const from = new Date()
    const to = new Date(from.getTime() + parsed.days * 24 * 3_600_000)
    const tzParam = parsed.tz ? `&tz=${encodeURIComponent(parsed.tz)}` : ''
    const found = await api<SlotsResponse>(
      base,
      key,
      `/slots?eventTypeId=${encodeURIComponent(match.id)}&from=${from.toISOString()}&to=${to.toISOString()}${tzParam}`,
    )

    spinner.stop(
      'booked',
      `${match.title} ${dim(`— ${found.data.length} open slots over ${parsed.days} days, times in ${found.meta.timezone}`, term)}`,
    )

    if (found.data.length === 0) return 0

    out.write('\n')
    const days = groupByDay(found.data, found.meta.timezone)
    for (const { day, times } of days) {
      out.write(`${bold(day, term)}\n`)
      for (let i = 0; i < times.length; i += 8) {
        out.write(`  ${times.slice(i, i + 8).join('  ')}\n`)
      }
    }
    return 0
  } catch (e) {
    spinner.stop('failed', e instanceof Error ? e.message : String(e))
    return 1
  }
}

export { wordmark }
