import { fixtureHealth, fixtureSearch } from './fixtures'
import type { HealthResult, SearchRequest, SearchResponse } from '../lib/types'

export interface SearchClient {
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>
}

export interface FrontendServices {
  health: { get(): Promise<HealthResult> }
  search: SearchClient
  assets: Record<string, never>
  preferences: Record<string, never>
  pins: Record<string, never>
  events: Record<string, never>
  curation: Record<string, never>
  benchmarks: Record<string, never>
}

export const fixtureServices: FrontendServices = {
  health: { get: async () => fixtureHealth },
  search: { search: fixtureSearch },
  assets: {},
  preferences: {},
  pins: {},
  events: {},
  curation: {},
  benchmarks: {},
}
