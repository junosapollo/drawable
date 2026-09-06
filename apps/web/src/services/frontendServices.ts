import type { EventRequest, PreferencesResponse, PreferencesUpdate } from '@drawable/contracts'
import { fixtureHealth, fixtureSearch } from './fixtures'
import type { HealthResult, SearchRequest, SearchResponse } from '../lib/types'

export interface SearchClient {
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>
}

export interface FrontendServices {
  health: { get(signal?: AbortSignal): Promise<HealthResult> }
  search: SearchClient
  events: { record(event: EventRequest): Promise<void> }
  preferences: {
    get(): Promise<PreferencesResponse | null>
    update(update: PreferencesUpdate): Promise<PreferencesResponse | null>
  }
}

export const fixtureServices: FrontendServices = {
  health: { get: async () => fixtureHealth },
  search: { search: fixtureSearch },
  events: { record: async () => undefined },
  preferences: { get: async () => null, update: async () => null },
}
