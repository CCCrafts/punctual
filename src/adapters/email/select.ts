/**
 * Which email sender a deployment uses.
 *
 * Inferred from what is configured — a Resend key, a Brevo key, the
 * Cloudflare `send_email` binding, else the console — unless the operator
 * names one with `EMAIL_PROVIDER`. Naming one turns a quiet fallback into
 * a loud one: a provider chosen on purpose whose key or binding is missing
 * is reported on /health, in the boot log and on the dashboard, instead of
 * the deployment silently sending through whatever else happened to be
 * set. (Suggested on the pull request that added the Cloudflare sender.)
 */

import type { EmailDelivery } from '../../ports.js'

export const EMAIL_PROVIDERS: readonly EmailDelivery[] = ['cloudflare', 'resend', 'brevo', 'console']

export interface EmailSelection {
  delivery: EmailDelivery
  /** What is wrong with the operator's choice, in one sentence, or null. */
  problem: string | null
}

export interface EmailEnv {
  EMAIL_PROVIDER?: string
  RESEND_API_KEY?: string
  BREVO_API_KEY?: string
  /** The `send_email` binding, when bound. */
  EMAIL?: unknown
}

const CREDENTIAL: Record<Exclude<EmailDelivery, 'console'>, { has: (env: EmailEnv) => boolean; missing: string }> = {
  resend: { has: (env) => Boolean(env.RESEND_API_KEY), missing: 'the RESEND_API_KEY secret is not set' },
  brevo: { has: (env) => Boolean(env.BREVO_API_KEY), missing: 'the BREVO_API_KEY secret is not set' },
  cloudflare: { has: (env) => Boolean(env.EMAIL), missing: 'no [[send_email]] binding is configured in wrangler.toml' },
}

function inferred(env: EmailEnv): EmailDelivery {
  // A key outranks the binding: set on purpose, for one deployment, and a
  // deployment already sending through Resend or Brevo must keep doing so
  // when the binding shows up in the template.
  return env.RESEND_API_KEY ? 'resend' : env.BREVO_API_KEY ? 'brevo' : env.EMAIL ? 'cloudflare' : 'console'
}

export function selectEmailDelivery(env: EmailEnv): EmailSelection {
  const chosen = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase()
  if (chosen === '') return { delivery: inferred(env), problem: null }
  if (!(EMAIL_PROVIDERS as readonly string[]).includes(chosen)) {
    const fallback = inferred(env)
    return {
      delivery: fallback,
      problem: `EMAIL_PROVIDER="${env.EMAIL_PROVIDER}" is not one of ${EMAIL_PROVIDERS.join(', ')}; using ${fallback}`,
    }
  }
  const provider = chosen as EmailDelivery
  if (provider === 'console') return { delivery: 'console', problem: null }
  const credential = CREDENTIAL[provider]
  if (credential.has(env)) return { delivery: provider, problem: null }
  return {
    delivery: 'console',
    problem: `EMAIL_PROVIDER=${provider} but ${credential.missing} — emails are logged, not sent`,
  }
}
