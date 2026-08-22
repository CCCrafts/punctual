/**
 * Entry point: command dispatch and help. The identity rule for every
 * surface here — the wordmark appears once at the top of help and of each
 * command's run; no ASCII-art banner, ever (ticket: "no giant ASCII art
 * banner on every command, no animation when piping to a file").
 */

import { createRequire } from 'node:module'
import { init } from './init.js'
import { slots } from './slots.js'
import { Spinner, bold, color, detectTerm, dim, glyph, table, wordmark } from './style.js'

const require = createRequire(import.meta.url)
const VERSION: string = require('../package.json').version

function help(): string {
  const term = detectTerm()
  return [
    `${wordmark(term)}  ${dim('scheduling that shows up on time', term)}`,
    '',
    `  ${bold('Usage', term)}`,
    '    npx punctual-sh <command> [options]',
    '',
    `  ${bold('Commands', term)}`,
    '    init [dir]     Deploy your own Punctual to your Cloudflare account',
    '    slots <url>    Live availability from your instance, in your terminal',
    '',
    `  ${bold('Options', term)}`,
    '    -h, --help     Show this help',
    '    -v, --version  Print the version',
    '',
    `  ${bold('Environment', term)}`,
    '    PUNCTUAL_API_KEY   API key for `slots` (dashboard → API keys)',
    '    NO_COLOR           Plain output; also automatic when piped',
    '',
    `  ${dim('MIT-licensed engine: https://github.com/CCCrafts/punctual', term)}`,
    `  ${dim('Hosted, if you would rather not run it: https://punctual.sh', term)}`,
    '',
  ].join('\n')
}

/**
 * Hidden verification screen for the identity itself — every element the
 * style module renders, on one screen, so a terminal (Terminal.app, iTerm2,
 * VS Code, a CI log) can be checked with a single command.
 */
async function demo(): Promise<number> {
  const term = detectTerm()
  const out = process.stdout
  out.write(`${wordmark(term)}  ${dim('scheduling that shows up on time', term)}\n\n`)
  out.write(`color level: ${term.level}   tty: ${term.tty}\n\n`)
  out.write(`${glyph('booked', term)} booked   ${glyph('held', term)} held   ${glyph('failed', term)} failed\n\n`)

  const spinner = new Spinner(term, out)
  spinner.start('A dot travelling the clock face')
  await new Promise((r) => setTimeout(r, term.tty ? 1500 : 0))
  spinner.stop('booked', 'A dot travelling the clock face')

  out.write('\n')
  out.write(
    table(
      [
        ['Mon 25 Aug', '09:00', '09:30', '10:00'],
        ['Tue 26 Aug', '14:00', '15:30', ''],
        ['Wed 27 Aug', '09:00', '', ''],
      ],
      [{ paint: (c, t) => bold(c, t) }, {}, {}, {}],
      term,
    ),
  )
  out.write('\n\n')
  out.write(`${color('#1FC16B', 'green', term)} truecolor · 41 in 256-colour · plain when NO_COLOR or piped\n`)
  return 0
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(help())
    return 0
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (command === 'init') return init(rest)
  if (command === 'slots') return slots(rest)
  if (command === 'demo') return demo()

  process.stdout.write(`Unknown command: ${command}\n\n`)
  process.stdout.write(help())
  return 1
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
