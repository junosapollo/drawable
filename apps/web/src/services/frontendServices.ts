import type { EventRequest, PreferencesResponse, PreferencesUpdate } from '@drawable/contracts'
import { fixtureAssets, fixtureHealth, fixtureSearch } from './fixtures'
import type { HealthResult, SearchRequest, SearchResponse } from '../lib/types'

export interface SearchClient {
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>
}

export interface AssetClient {
  resolveTrace(assetId: string, signal?: AbortSignal): Promise<string | null>
}

export interface FrontendServices {
  health: { get(signal?: AbortSignal): Promise<HealthResult> }
  search: SearchClient
  assets: AssetClient
  events: { record(event: EventRequest): Promise<void> }
  preferences: {
    get(): Promise<PreferencesResponse | null>
    update(update: PreferencesUpdate): Promise<PreferencesResponse | null>
  }
  pins?: Record<string, never>
  curation?: Record<string, never>
  benchmarks?: Record<string, never>
}

export const fixtureServices: FrontendServices = {
  health: { get: async () => fixtureHealth },
  search: { search: fixtureSearch },
  assets: { resolveTrace: async (assetId) => fixtureAssets.find((asset) => asset.id === assetId)?.imageUrl ?? null },
  events: { record: async () => undefined },
  preferences: { get: async () => null, update: async () => null },
  pins: {},
  curation: {},
  benchmarks: {},
}
