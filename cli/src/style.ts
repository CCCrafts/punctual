/**
 * The terminal identity module. Everything the CLI prints goes through here,
 * so the rules from the brand live in exactly one place:
 *
 * - The wordmark is `punctual:` with the colon in signal green — the same
 *   mark the web dashboard sets in a monospace face, which is why it belongs
 *   in a terminal at all.
 * - Signal green is #1FC16B (truecolor), xterm 41 (256-colour), plain
 *   green (16-colour). Amber and red follow the web palette's --pu-warn and
 *   --pu-danger the same way.
 * - Colour is OFF when NO_COLOR is set (any value, per no-color.org) or when
 *   the stream is not a TTY; FORCE_COLOR overrides both, because CI systems
 *   that render ANSI set it on purpose.
 * - Animation is TTY-only, separately from colour: FORCE_COLOR in a piped
 *   CI log means coloured *lines*, never a spinner rewriting them.
 * - Status glyphs differ by SHAPE, not just colour — booked ● / held ◐ /
 *   failed ✕ read the same to colourblind eyes and in a plain log.
 */

export type ColorLevel = 'none' | 'basic' | 'ansi256' | 'truecolor'

export interface TermInfo {
  level: ColorLevel
  /** Whether rewriting lines (spinner) is acceptable — colour aside. */
  tty: boolean
}

interface StreamLike {
  isTTY?: boolean | undefined
  write(chunk: string): unknown
}

export function detectTerm(
  stream: StreamLike = process.stdout,
  env: Record<string, string | undefined> = process.env,
): TermInfo {
  const tty = stream.isTTY === true

  // FORCE_COLOR wins over everything including NO_COLOR: it is the more
  // specific instruction, and the only reason to set it is to overrule a
  // default that guessed wrong.
  const force = env['FORCE_COLOR']
  if (force !== undefined && force !== '' && force !== '0') {
    const level: ColorLevel = force === '1' ? 'basic' : force === '2' ? 'ansi256' : 'truecolor'
    return { level, tty }
  }

  if (env['NO_COLOR'] !== undefined || !tty || env['TERM'] === 'dumb') {
    return { level: 'none', tty }
  }

  const colorterm = env['COLORTERM'] ?? ''
  if (colorterm === 'truecolor' || colorterm === '24bit') return { level: 'truecolor', tty }
  if ((env['TERM'] ?? '').includes('256color')) return { level: 'ansi256', tty }
  return { level: 'basic', tty }
}

/** Web palette → ANSI, one row per --pu token the CLI borrows. */
const PALETTE = {
  green: { truecolor: '38;2;31;193;107', ansi256: '38;5;41', basic: '32' }, // --pu-signal #1FC16B
  amber: { truecolor: '38;2;245;166;35', ansi256: '38;5;214', basic: '33' }, // --pu-warn #F5A623
  red: { truecolor: '38;2;217;45;32', ansi256: '38;5;160', basic: '31' }, // --pu-danger #D92D20
} as const

export type PaletteColor = keyof typeof PALETTE

export function color(text: string, name: PaletteColor, term: TermInfo): string {
  if (term.level === 'none') return text
  return `\x1b[${PALETTE[name][term.level]}m${text}\x1b[39m`
}

export function bold(text: string, term: TermInfo): string {
  if (term.level === 'none') return text
  return `\x1b[1m${text}\x1b[22m`
}

export function dim(text: string, term: TermInfo): string {
  if (term.level === 'none') return text
  return `\x1b[2m${text}\x1b[22m`
}

/** `punctual:` — the mark itself. Never boxed, never bannered. */
export function wordmark(term: TermInfo): string {
  return bold('punctual', term) + color(':', 'green', term)
}

// ---------------------------------------------------------------------------
// Status glyphs
// ---------------------------------------------------------------------------

export type Status = 'booked' | 'held' | 'failed'

const GLYPHS: Record<Status, { char: string; paint: PaletteColor }> = {
  booked: { char: '●', paint: 'green' }, // ● solid — committed
  held: { char: '◐', paint: 'amber' }, // ◐ half — reserved, not final
  failed: { char: '✕', paint: 'red' }, // ✕ — distinct from ● / ◐ by shape
}

export function glyph(status: Status, term: TermInfo): string {
  const g = GLYPHS[status]
  return color(g.char, g.paint, term)
}

// ---------------------------------------------------------------------------
// Spinner — the dot at twelve
// ---------------------------------------------------------------------------

/**
 * A single braille dot travelling clockwise around the cell, starting at the
 * top — the wordmark's "dot at twelve" motif at terminal scale. On a
 * non-TTY stream nothing animates: `start` is silent and `stop` prints the
 * one final line a CI log actually wants.
 */
const FRAMES = ['⠁', '⠈', '⠐', '⠠', '⢀', '⡀', '⠄', '⠂']
const FRAME_MS = 90

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private label = ''
  private readonly term: TermInfo
  private readonly out: StreamLike

  constructor(term: TermInfo, out: StreamLike = process.stdout) {
    this.term = term
    this.out = out
  }

  start(label: string): void {
    this.label = label
    if (!this.term.tty) return
    this.out.write('\x1b[?25l') // hide cursor; restored in stop() and on exit
    restoreCursorOnExit(this.out)
    this.render()
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length
      this.render()
    }, FRAME_MS)
  }

  update(label: string): void {
    this.label = label
    if (this.timer) this.render()
  }

  /** Replaces the spinner line with a final glyph + label. */
  stop(status: Status, label?: string): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const finalLabel = label ?? this.label
    if (this.term.tty) {
      this.out.write(`\r\x1b[2K${glyph(status, this.term)} ${finalLabel}\n\x1b[?25h`)
    } else {
      this.out.write(`${glyph(status, this.term)} ${finalLabel}\n`)
    }
  }

  private render(): void {
    const frame = color(FRAMES[this.frame]!, 'green', this.term)
    this.out.write(`\r\x1b[2K${frame} ${this.label}`)
  }
}

let exitHookInstalled = false
function restoreCursorOnExit(out: StreamLike): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const restore = () => out.write('\x1b[?25h')
  process.on('exit', restore)
  process.on('SIGINT', () => {
    restore()
    process.exit(130)
  })
}

// ---------------------------------------------------------------------------
// Tabular output
// ---------------------------------------------------------------------------

/**
 * Column alignment with widths measured BEFORE colour: pass plain cells and
 * an optional per-column painter, so escape codes never count as width.
 */
export interface Column {
  align?: 'left' | 'right'
  paint?: (cell: string, term: TermInfo) => string
}

export function table(rows: string[][], columns: Column[] = [], term: TermInfo = detectTerm()): string {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => {
          const col = columns[i] ?? {}
          const padded = col.align === 'right' ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)
          return col.paint ? col.paint(padded, term) : padded
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

/**
 * Timestamps stay tabular by construction: 2-digit fields everywhere, so
 * every time is exactly as wide as every other and columns never wander.
 */
export function timeLabel(epochMs: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(epochMs)
}

export function dayLabel(epochMs: number, timezone: string): string {
  // Assembled from parts, not Intl's own joining — ICU versions disagree
  // about the comma after the weekday, and a label that changes shape
  // between Node releases is exactly what "timestamps stay tabular" forbids.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  }).formatToParts(epochMs)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('weekday')} ${get('day')} ${get('month')}`
}
