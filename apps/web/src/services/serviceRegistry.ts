/**
 * Chooses between the live API and the local fixture services.
 *
 * `VITE_LINESCOUT_SERVICES` forces a mode (`live` | `fixture`). Otherwise the
 * app probes `/api/v1/health` once at startup: a reachable API wins, anything
 * else (connection refused, proxy error, timeout) silently keeps the fixture
 * service so the canvas remains usable offline.
 */

import { create } from 'zustand'
import type { HealthResult } from '../lib/types'
import { fixtureServices, type FrontendServices } from './frontendServices'
import { liveServices } from './liveServices'

export type ServiceMode = 'probing' | 'live' | 'fixture'

interface ServiceState {
  mode: ServiceMode
  health: HealthResult | null
  services: FrontendServices
  sessionId: string
  probe: () => Promise<void>
}

const SESSION_KEY = 'linescout-session-id'

function sessionId(): string {
  const existing = sessionStorage.getItem(SESSION_KEY)
  if (existing) return existing
  const created = crypto.randomUUID()
  sessionStorage.setItem(SESSION_KEY, created)
  return created
}

const forced = import.meta.env.VITE_LINESCOUT_SERVICES as string | undefined

export const useServiceStore = create<ServiceState>((set) => ({
  mode: forced === 'fixture' ? 'fixture' : forced === 'live' ? 'live' : 'probing',
  health: null,
  services: forced === 'live' ? liveServices : fixtureServices,
  sessionId: sessionId(),
  probe: async () => {
    if (forced === 'fixture') {
      set({ mode: 'fixture', services: fixtureServices, health: await fixtureServices.health.get() })
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 2500)
    try {
      const health = await liveServices.health.get(controller.signal)
      set({ mode: 'live', services: liveServices, health })
    } catch {
      if (forced === 'live') {
        set({ mode: 'live', services: liveServices, health: { mode: 'cpu', ready: false, message: 'API unreachable', live: true } })
      } else {
        set({ mode: 'fixture', services: fixtureServices, health: await fixtureServices.health.get() })
      }
    } finally {
      window.clearTimeout(timer)
    }
  },
}))

export function currentServices(): FrontendServices {
  return useServiceStore.getState().services
}
