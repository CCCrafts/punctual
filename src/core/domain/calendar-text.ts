/**
 * What a booking says about itself on a calendar.
 *
 * A calendar event titled "30 min call" tells the host nothing at a
 * glance, and the guest's own copy nothing about who they are meeting. The
 * title names the people and their companies; the description lists every
 * participant with role, title, company and email, then the guest's
 * answers. The same text goes to Google, Microsoft and the .ics the guest
 * is emailed, so the three copies of one meeting agree.
 */

import type { Booking, EventType, User } from './types.js'
import { answeredQuestions } from './booking-service.js'

export interface Participant {
  name: string
  email: string
  company: string | null
  jobTitle: string | null
  role: 'guest' | 'host' | 'optional host'
}

/**
 * A question whose label IS the guest's company — "Company", "Your
 * organisation", "Company name", "Компанія", "Организация" — not one that
 * merely mentions it: "Company size", "How did you hear about our
 * company?" and "Tell us about your company" are ordinary booking-form
 * questions whose answers must never become the company in a calendar
 * title (caught by review). Matched by label, in English, Ukrainian and
 * Russian — the languages this engine's hosts write their questions in
 * today — so a host who already asks "Company" gets the answer on the
 * calendar without a new setting to find. A textarea never qualifies: a
 * paragraph is not a company name.
 */
const COMPANY_QUESTION =
  /^\s*(?:(?:your|the|ваша|твоя)\s+)?(?:(?:company|organi[sz]ation|employer|firm|компанія|організація|компания|организация)(?:\s+name)?|(?:назва|название)\s+(?:компанії|організації|компании|организации))\s*[:?]?\s*$/i

/**
 * Mailbox providers whose domain says nothing about where a guest works.
 * Matched on the registrable domain, so `yahoo.co.uk` is caught by `yahoo`.
 */
const FREEMAIL = new Set([
  'gmail', 'googlemail', 'yahoo', 'ymail', 'hotmail', 'outlook', 'live', 'msn', 'icloud', 'me', 'mac', 'aol',
  'proton', 'protonmail', 'pm', 'gmx', 'mail', 'email', 'yandex', 'ya', 'ukr', 'i', 'meta', 'rambler', 'bk',
  'inbox', 'list', 'qq', '163', '126', 'sina', 'zoho', 'fastmail', 'hey', 'tutanota', 'tuta', 'mailbox',
  'posteo', 'web', 'free', 'orange', 'wanadoo', 'laposte', 'libero', 'virgilio', 't-online', 'seznam',
  'wp', 'o2', 'interia', 'onet', 'op', 'example',
])

/**
 * The guest's company: what they answered to a company-like question, else
 * the domain of a work email address, else nothing. "acme.com" is not a
 * company name, but on a calendar it is the fact that matters — who the
 * meeting is with — and a host reads it as one.
 */
export function guestCompany(eventType: EventType, booking: Pick<Booking, 'guestEmail' | 'answers'>): string | null {
  for (const { question, value } of answeredQuestions(eventType, booking.answers)) {
    if (question.type === 'textarea' || !COMPANY_QUESTION.test(question.label)) continue
    const name = value.replace(/\s+/g, ' ').trim()
    if (name !== '') return name
  }
  const domain = booking.guestEmail.split('@')[1]?.trim().toLowerCase() ?? ''
  if (domain === '' || !domain.includes('.')) return null
  const labels = domain.split('.')
  // `yahoo.co.uk` → `yahoo`; `mail.ru` → `mail`. Two-label country
  // suffixes are short, so the registrable label is the first one that
  // is not a public suffix of at most three letters after the TLD.
  const registrable = labels.length >= 3 && labels[labels.length - 2]!.length <= 3 ? labels[labels.length - 3]! : labels[labels.length - 2]!
  return FREEMAIL.has(registrable) ? null : domain
}

export function participantsFor(
  eventType: EventType,
  booking: Booking,
  hosts: Array<{ user: User; optional: boolean }>,
): Participant[] {
  const guest: Participant = {
    name: booking.guestName.trim() || booking.guestEmail,
    email: booking.guestEmail,
    company: guestCompany(eventType, booking),
    jobTitle: null,
    role: 'guest',
  }
  return [
    guest,
    ...hosts.map((h) => ({
      name: h.user.name || h.user.slug,
      email: h.user.email,
      company: h.user.company?.trim() || null,
      jobTitle: h.user.jobTitle?.trim() || null,
      role: h.optional ? ('optional host' as const) : ('host' as const),
    })),
  ]
}

function withCompany(p: Participant): string {
  return p.company ? `${p.name} (${p.company})` : p.name
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * "Intro call: Jane Doe (Acme) with Serge Bulaev (CCCrafts)". Hosts who
 * share one company are named together and the company once; optional
 * hosts are left to the description, so a big joint meeting's title stays
 * a title.
 */
export function calendarTitle(eventType: Pick<EventType, 'title'>, participants: Participant[]): string {
  const guest = participants.find((p) => p.role === 'guest')
  const hosts = participants.filter((p) => p.role === 'host')
  const parts: string[] = []
  if (guest) parts.push(withCompany(guest))
  if (hosts.length > 0) {
    const companies = new Set(hosts.map((h) => h.company ?? ''))
    const one = companies.size === 1 ? (hosts[0]!.company ?? null) : null
    const names = one ? `${joinNames(hosts.map((h) => h.name))} (${one})` : joinNames(hosts.map(withCompany))
    parts.push(parts.length > 0 ? `with ${names}` : names)
  }
  return parts.length > 0 ? `${eventType.title}: ${parts.join(' ')}` : eventType.title
}

function participantLine(p: Participant): string {
  const affiliation = [p.jobTitle, p.company].filter((s): s is string => Boolean(s)).join(', ')
  return `• ${p.name}${affiliation ? ` — ${affiliation}` : ''} — ${p.email} (${p.role})`
}

/**
 * The event type's description, the participants, then the guest's answers
 * by question label. Plain text with line breaks; each provider adapter
 * renders it as its API expects.
 */
export function calendarDescription(eventType: EventType, booking: Booking, participants: Participant[]): string {
  const blocks: string[] = []
  if (eventType.description.trim() !== '') blocks.push(eventType.description.trim())
  blocks.push(['Participants', ...participants.map(participantLine)].join('\n'))
  const answers = answeredQuestions(eventType, booking.answers).map(({ question, value }) => `${question.label}: ${value}`)
  if (answers.length > 0) blocks.push(answers.join('\n'))
  return blocks.join('\n\n')
}
