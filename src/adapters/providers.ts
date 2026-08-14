/**
 * The calendar provider registry (ADR-0003).
 *
 * Availability is decided by credentials, not by code: a self-hoster who
 * configured only `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` gets a deployment
 * that offers exactly one provider, with no Microsoft button that leads to a
 * broken consent screen.
 */

import type { CalendarProvider, CalendarProviderName, CalendarProviders } from '../ports.js'
import { createGoogleProvider } from './google/provider.js'
import { createMicrosoftProvider } from './microsoft/provider.js'
import { CalendarApiError, type CalendarProviderDeps } from './oauth.js'

const ORDER: CalendarProviderName[] = ['google', 'microsoft']

export function createCalendarProviders(deps: CalendarProviderDeps): CalendarProviders {
  // Built eagerly — the factories only close over deps, so there is nothing to
  // defer and a lazy map would just add a branch to every call.
  const providers: Record<CalendarProviderName, CalendarProvider> = {
    google: createGoogleProvider(deps),
    microsoft: createMicrosoftProvider(deps),
  }

  const available = ORDER.filter((name) => deps.oauth.forProvider(name) !== null)

  return {
    get(name) {
      // Reachable with a stale connection row after an operator removes
      // credentials, so the message names the fix rather than the symptom.
      if (!available.includes(name)) {
        throw new CalendarApiError(
          name,
          `provider not available: set ${name.toUpperCase()}_CLIENT_ID and ${name.toUpperCase()}_CLIENT_SECRET`,
        )
      }
      return providers[name]
    },
    available() {
      // A copy: `available()` feeds the connect UI, and handing out the live
      // array invites a caller to sort it in place.
      return available.slice()
    },
  }
}
