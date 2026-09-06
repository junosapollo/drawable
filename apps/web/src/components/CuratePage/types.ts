/**
 * Shared types for the CuratePage subcomponents.
 *
 * These are tiny re-exports so the components only depend on this module
 * rather than the contracts package directly; that lets the component tree
 * be moved or extracted without touching ``@drawable/contracts``.
 */

export type { CurationCandidate, CurationProgress, LabelResponse, SnapshotResponse } from '@drawable/contracts'
export type { PrimaryStyle, ScopeLabel } from '@drawable/contracts'
