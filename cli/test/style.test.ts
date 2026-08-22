import { describe, expect, it } from 'vitest'
import {
  Spinner,
  type TermInfo,
  color,
  dayLabel,
  detectTerm,
  glyph,
  table,
  timeLabel,
  wordmark,
} from '../src/style.js'

const tty = { isTTY: true, write: () => true }
const pipe = { isTTY: false, write: () => true }

describe('detectTerm', () => {
  it('is plain when piped, whatever TERM claims', () => {
    expect(detectTerm(pipe, { TERM: 'xterm-256color', COLORTERM: 'truecolor' })).toEqual({
      level: 'none',
      tty: false,
    })
  })

  it('is plain when NO_COLOR is set, even to an empty string', () => {
    expect(detectTerm(tty, { NO_COLOR: '', COLORTERM: 'truecolor' }).level).toBe('none')
  })

  it('FORCE_COLOR wins over a pipe — colour without animation', () => {
    expect(detectTerm(pipe, { FORCE_COLOR: '3' })).toEqual({ level: 'truecolor', tty: false })
  })

  it('FORCE_COLOR wins over NO_COLOR (the more specific instruction)', () => {
    expect(detectTerm(tty, { NO_COLOR: '1', FORCE_COLOR: '1' }).level).toBe('basic')
  })

  it('COLORTERM=truecolor → truecolor', () => {
    expect(detectTerm(tty, { COLORTERM: 'truecolor', TERM: 'xterm-256color' }).level).toBe('truecolor')
  })

  it('TERM with 256color and no COLORTERM → ansi256', () => {
    expect(detectTerm(tty, { TERM: 'screen-256color' }).level).toBe('ansi256')
  })

  it('a dumb terminal gets plain text', () => {
    expect(detectTerm(tty, { TERM: 'dumb' }).level).toBe('none')
  })

  it('an ordinary TTY falls back to basic 16-colour', () => {
    expect(detectTerm(tty, { TERM: 'xterm' }).level).toBe('basic')
  })
})

describe('wordmark', () => {
  const at = (level: TermInfo['level']): TermInfo => ({ level, tty: true })

  it('renders the exact brand green per level: truecolor #1FC16B, 256-colour 41, basic green', () => {
    expect(wordmark(at('truecolor'))).toContain('\x1b[38;2;31;193;107m:')
    expect(wordmark(at('ansi256'))).toContain('\x1b[38;5;41m:')
    expect(wordmark(at('basic'))).toContain('\x1b[32m:')
  })

  it('is exactly `punctual:` with zero escapes when colour is off', () => {
    expect(wordmark(at('none'))).toBe('punctual:')
  })
})

describe('glyphs', () => {
  it('differ by shape, so state survives colourblindness and plain logs', () => {
    const plain: TermInfo = { level: 'none', tty: false }
    const chars = [glyph('booked', plain), glyph('held', plain), glyph('failed', plain)]
    expect(chars).toEqual(['●', '◐', '✕'])
    expect(new Set(chars).size).toBe(3)
  })
})

describe('Spinner on a non-TTY stream', () => {
  it('never animates: start writes nothing, stop writes one final line', () => {
    const written: string[] = []
    const stream = { isTTY: false, write: (s: string) => (written.push(s), true) }
    const spinner = new Spinner({ level: 'none', tty: false }, stream)
    spinner.start('Loading slots')
    expect(written).toEqual([])
    spinner.stop('booked', 'Loading slots')
    expect(written).toEqual(['● Loading slots\n'])
  })

  it('carriage returns and cursor codes never reach a pipe', () => {
    const written: string[] = []
    const stream = { isTTY: false, write: (s: string) => (written.push(s), true) }
    const spinner = new Spinner({ level: 'none', tty: false }, stream)
    spinner.start('x')
    spinner.stop('failed')
    expect(written.join('')).not.toMatch(/[\r\x1b]/)
  })
})

describe('table', () => {
  const plain: TermInfo = { level: 'none', tty: false }

  it('aligns columns by the widest cell, measured before colour', () => {
    const rendered = table(
      [
        ['Mon 25 Aug', '9'],
        ['Tue 2 Sep', '140'],
      ],
      [{}, { align: 'right' }],
      plain,
    )
    expect(rendered).toBe('Mon 25 Aug    9\nTue 2 Sep   140')
  })

  it('colour wraps the padded cell so escape codes never affect width', () => {
    const term: TermInfo = { level: 'basic', tty: true }
    const rendered = table([['ab', 'x'], ['a', 'y']], [{ paint: (c, t) => color(c, 'green', t) }], term)
    const lines = rendered.split('\n')
    // Both first-column cells are padded to the same visible width.
    expect(lines[0]).toContain('\x1b[32mab\x1b[39m')
    expect(lines[1]).toContain('\x1b[32ma \x1b[39m')
  })
})

describe('timestamps stay tabular', () => {
  it('every time is 5 chars, every day label the same width pattern', () => {
    const zone = 'Europe/Kyiv'
    const times = [
      timeLabel(Date.UTC(2026, 7, 25, 6, 0), zone),
      timeLabel(Date.UTC(2026, 7, 25, 20, 30), zone),
    ]
    expect(times).toEqual(['09:00', '23:30'])
    for (const t of times) expect(t).toHaveLength(5)
    expect(dayLabel(Date.UTC(2026, 7, 25, 12, 0), zone)).toBe('Tue 25 Aug')
  })
})
