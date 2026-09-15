import { describe, expect, it } from 'vitest'
import { selectEmailDelivery } from '../../src/adapters/email/select.js'

describe('choosing the email sender', () => {
  it('infers from what is set: a key first, then the binding, else the console', () => {
    expect(selectEmailDelivery({})).toEqual({ delivery: 'console', problem: null })
    expect(selectEmailDelivery({ EMAIL: {} })).toEqual({ delivery: 'cloudflare', problem: null })
    expect(selectEmailDelivery({ EMAIL: {}, BREVO_API_KEY: 'b' })).toEqual({ delivery: 'brevo', problem: null })
    expect(selectEmailDelivery({ EMAIL: {}, BREVO_API_KEY: 'b', RESEND_API_KEY: 'r' })).toEqual({ delivery: 'resend', problem: null })
  })

  it('uses the named provider when its credential is there, whatever else is set', () => {
    expect(selectEmailDelivery({ EMAIL_PROVIDER: 'cloudflare', EMAIL: {}, RESEND_API_KEY: 'r' })).toEqual({ delivery: 'cloudflare', problem: null })
    expect(selectEmailDelivery({ EMAIL_PROVIDER: ' Brevo ', BREVO_API_KEY: 'b', RESEND_API_KEY: 'r' })).toEqual({ delivery: 'brevo', problem: null })
    expect(selectEmailDelivery({ EMAIL_PROVIDER: 'console', RESEND_API_KEY: 'r' })).toEqual({ delivery: 'console', problem: null })
  })

  it('reports a named provider it cannot use, and logs instead of sending through another', () => {
    const noKey = selectEmailDelivery({ EMAIL_PROVIDER: 'resend', BREVO_API_KEY: 'b' })
    expect(noKey.delivery).toBe('console')
    expect(noKey.problem).toBe('EMAIL_PROVIDER=resend but the RESEND_API_KEY secret is not set — emails are logged, not sent')
    const noBinding = selectEmailDelivery({ EMAIL_PROVIDER: 'cloudflare' })
    expect(noBinding.problem).toContain('no [[send_email]] binding')
    const unknown = selectEmailDelivery({ EMAIL_PROVIDER: 'sendgrid', RESEND_API_KEY: 'r' })
    expect(unknown.delivery).toBe('resend')
    expect(unknown.problem).toBe('EMAIL_PROVIDER="sendgrid" is not one of cloudflare, resend, brevo, console; using resend')
  })
})
