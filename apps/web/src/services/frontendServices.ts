import { fixtureAssets, fixtureHealth, fixtureSearch } from './fixtures'
import type { HealthResult, SearchRequest, SearchResponse } from '../lib/types'

export interface SearchClient {
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>
}

export interface AssetClient {
  resolveTrace(assetId: string, signal?: AbortSignal): Promise<string | null>
}

export interface FrontendServices {
  health: { get(): Promise<HealthResult> }
  search: SearchClient
  assets: AssetClient
  preferences: Record<string, never>
  pins: Record<string, never>
  events: Record<string, never>
  curation: Record<string, never>
  benchmarks: Record<string, never>
}

export const fixtureServices: FrontendServices = {
  health: { get: async () => fixtureHealth },
  search: { search: fixtureSearch },
  assets: { resolveTrace: async (assetId) => fixtureAssets.find((asset) => asset.id === assetId)?.imageUrl ?? null },
  preferences: {},
  pins: {},
  events: {},
  curation: {},
  benchmarks: {},
}
