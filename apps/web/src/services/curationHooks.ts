/**
 * React Query bindings for the curation endpoints.
 *
 * The CuratePage composes these hooks; this module deliberately stays UI-free
 * so the same hooks can back tests, future bulk-review tools, or scripted
 * automation without a React tree.
 *
 * Query keys are kept stable: a re-render of the page must not invalidate a
 * candidate fetch simply because of an object identity change on the filter
 * inputs. We use a small ``stableKey`` helper that joins only the fields
 * the API actually filters on.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import type { CurationCandidate, CurationProgress, LabelRequest, LabelResponse, SnapshotResponse } from '@drawable/contracts'
import {
  exportSnapshot,
  fetchCurationProgress,
  fetchNextCandidate,
  writeLabel,
  type NextCandidateQuery,
} from './curationClient'

const queryKeys = {
  progress: ['curation', 'progress'] as const,
  next: (query: NextCandidateQuery) => ['curation', 'next', query.style ?? null, query.scope ?? null] as const,
}

function stableQuery(input: NextCandidateQuery): NextCandidateQuery {
  return { style: input.style, scope: input.scope }
}

/**
 * The currently displayed candidate. ``null`` means "queue empty" or
 * "no gallery" — both are first-class UI states, not errors.
 */
export function useCurationNext(
  query: NextCandidateQuery,
  options: { enabled?: boolean } = {},
): UseQueryResult<CurationCandidate | null, Error> {
  return useQuery({
    queryKey: queryKeys.next(stableQuery(query)),
    queryFn: ({ signal }) => fetchNextCandidate(stableQuery(query), signal),
    enabled: options.enabled ?? true,
  })
}

/** Review progress with per-style / per-scope breakdowns. */
export function useCurationProgress(options: { enabled?: boolean } = {}): UseQueryResult<CurationProgress, Error> {
  return useQuery({
    queryKey: queryKeys.progress,
    queryFn: ({ signal }) => fetchCurationProgress(signal),
    // Progress moves while the curator is working, so keep it live: refetch
    // every 5 seconds while the tab is visible. Refetch on focus is left to
    // React Query's default (off, set in main.tsx) — curators usually keep
    // the tab focused.
    refetchInterval: 5_000,
    enabled: options.enabled ?? true,
  })
}

/** Write a label. On success, invalidate progress and any cached candidate. */
export function useWriteLabel(): UseMutationResult<LabelResponse, Error, LabelRequest> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: writeLabel,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.progress })
      // Drop the cached "next" candidate: the queue advanced.
      void client.invalidateQueries({ queryKey: ['curation', 'next'] })
    },
  })
}

/** Export an immutable JSON snapshot. */
export function useExportSnapshot(): UseMutationResult<SnapshotResponse, Error, void> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: exportSnapshot,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.progress })
    },
  })
}
