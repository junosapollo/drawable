import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CurateInspector, type ReviewFormState } from './CurateInspector'
import type { CurationCandidate } from './types'

function makeCandidate(overrides: Partial<CurationCandidate> = {}): CurationCandidate {
  return {
    asset_id: 'ls_synthetic_ac1f55b7390698a7',
    primary_style: 'manga_anime',
    scopes: ['eye'],
    width: 256,
    height: 256,
    thumbnail_url: '/api/v1/assets/ls_synthetic_ac1f55b7390698a7/thumbnail',
    line_art_url: '/api/v1/assets/ls_synthetic_ac1f55b7390698a7/line-art',
    origin: 'native_line_art',
    crop: null,
    review_state: 'unreviewed',
    quality_score: 0.85,
    sfw_safe: true,
    sfw_confidence: 0.99,
    source_work_id: 'synthetic-work-000',
    ...overrides,
  }
}

const baseForm: ReviewFormState = {
  primaryStyle: 'manga_anime',
  scopes: ['eye'],
  quality: null,
  note: '',
  malformedAnatomy: false,
  poorExtraction: false,
}

describe('CurateInspector', () => {
  it('shows the candidate asset id as the heading', () => {
    render(
      <CurateInspector
        candidate={makeCandidate()}
        pendingForm={baseForm}
        onFormChange={vi.fn()}
        onKeep={vi.fn()}
        onReject={vi.fn()}
        onSnapshot={vi.fn()}
        busy={false}
        snapshotPending={false}
      />,
    )
    expect(screen.getByTestId('inspector-asset-id').textContent).toBe('ls_synthetic_ac1f55b7390698a7')
  })

  it('disables the Keep button until a quality is selected', () => {
    const onKeep = vi.fn()
    render(
      <CurateInspector
        candidate={makeCandidate()}
        pendingForm={{ ...baseForm, quality: null }}
        onFormChange={vi.fn()}
        onKeep={onKeep}
        onReject={vi.fn()}
        onSnapshot={vi.fn()}
        busy={false}
        snapshotPending={false}
      />,
    )
    fireEvent.click(screen.getByTestId('keep-button'))
    expect(onKeep).not.toHaveBeenCalled()
  })

  it('enables Keep after a quality is set and invokes it on click', () => {
    const onKeep = vi.fn()
    render(
      <CurateInspector
        candidate={makeCandidate()}
        pendingForm={{ ...baseForm, quality: 2 }}
        onFormChange={vi.fn()}
        onKeep={onKeep}
        onReject={vi.fn()}
        onSnapshot={vi.fn()}
        busy={false}
        snapshotPending={false}
      />,
    )
    fireEvent.click(screen.getByTestId('keep-button'))
    expect(onKeep).toHaveBeenCalled()
  })

  it('invokes Reject regardless of quality', () => {
    const onReject = vi.fn()
    render(
      <CurateInspector
        candidate={makeCandidate()}
        pendingForm={baseForm}
        onFormChange={vi.fn()}
        onKeep={vi.fn()}
        onReject={onReject}
        onSnapshot={vi.fn()}
        busy={false}
        snapshotPending={false}
      />,
    )
    fireEvent.click(screen.getByTestId('reject-button'))
    expect(onReject).toHaveBeenCalled()
  })

  it('toggles a scope chip and notifies the parent', () => {
    const onFormChange = vi.fn()
    render(
      <CurateInspector
        candidate={makeCandidate()}
        pendingForm={baseForm}
        onFormChange={onFormChange}
        onKeep={vi.fn()}
        onReject={vi.fn()}
        onSnapshot={vi.fn()}
        busy={false}
        snapshotPending={false}
      />,
    )
    fireEvent.click(screen.getByTestId('scope-chip-full_body'))
    const last = onFormChange.mock.calls.at(-1)?.[0] as ReviewFormState | undefined
    expect(last).toBeTruthy()
    expect(last?.scopes).toEqual(['eye', 'full_body'])
  })

  it('changes the primary style via the select', () => {
    const onFormChange = vi.fn()
    render(
      <CurateInspector
        candidate={makeCandidate()}
        pendingForm={baseForm}
        onFormChange={onFormChange}
        onKeep={vi.fn()}
        onReject={vi.fn()}
        onSnapshot={vi.fn()}
        busy={false}
        snapshotPending={false}
      />,
    )
    fireEvent.change(screen.getByTestId('style-select'), { target: { value: 'cartoon' } })
    const last = onFormChange.mock.calls.at(-1)?.[0] as ReviewFormState | undefined
    expect(last?.primaryStyle).toBe('cartoon')
  })

  it('reflects quality selection in the form state', () => {
    const onFormChange = vi.fn()
    render(
      <CurateInspector
        candidate={makeCandidate()}
        pendingForm={baseForm}
        onFormChange={onFormChange}
        onKeep={vi.fn()}
        onReject={vi.fn()}
        onSnapshot={vi.fn()}
        busy={false}
        snapshotPending={false}
      />,
    )
    fireEvent.click(screen.getByTestId('quality-3'))
    const last = onFormChange.mock.calls.at(-1)?.[0] as ReviewFormState | undefined
    expect(last?.quality).toBe(3)
  })

  it('toggles malformed_anatomy and poor_extraction flags', () => {
    const onFormChange = vi.fn()
    render(
      <CurateInspector
        candidate={makeCandidate()}
        pendingForm={baseForm}
        onFormChange={onFormChange}
        onKeep={vi.fn()}
        onReject={vi.fn()}
        onSnapshot={vi.fn()}
        busy={false}
        snapshotPending={false}
      />,
    )
    fireEvent.click(screen.getByTestId('flag-malformed'))
    const last = onFormChange.mock.calls.at(-1)?.[0] as ReviewFormState | undefined
    expect(last?.malformedAnatomy).toBe(true)
  })

  it('disables the action buttons while a mutation is busy', () => {
    render(
      <CurateInspector
        candidate={makeCandidate()}
        pendingForm={{ ...baseForm, quality: 3 }}
        onFormChange={vi.fn()}
        onKeep={vi.fn()}
        onReject={vi.fn()}
        onSnapshot={vi.fn()}
        busy
        snapshotPending={false}
      />,
    )
    expect(screen.getByTestId('keep-button')).toBeDisabled()
    expect(screen.getByTestId('reject-button')).toBeDisabled()
  })

  it('shows an empty-state body when no candidate is loaded', () => {
    render(
      <CurateInspector
        candidate={null}
        pendingForm={null}
        onFormChange={vi.fn()}
        onKeep={vi.fn()}
        onReject={vi.fn()}
        onSnapshot={vi.fn()}
        busy={false}
        snapshotPending={false}
      />,
    )
    expect(screen.getByText(/curation queue is empty/i)).toBeInTheDocument()
  })
})
