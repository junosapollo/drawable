import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import type { JSX, ReactNode } from 'react'
import { CurateStage } from './CurateStage'
import type { CurationCandidate } from './types'

function wrapWith({ children }: { children: ReactNode }): JSX.Element {
  return <TooltipProvider delayDuration={500}>{children}</TooltipProvider>
}

function makeCandidate(overrides: Partial<CurationCandidate> = {}): CurationCandidate {
  return {
    asset_id: 'ls_test_ac1f55b7390698a7',
    primary_style: 'manga_anime',
    scopes: ['eye'],
    width: 256,
    height: 256,
    thumbnail_url: '/api/v1/assets/ls_test_ac1f55b7390698a7/thumbnail',
    line_art_url: '/api/v1/assets/ls_test_ac1f55b7390698a7/line-art',
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

const baseProps = {
  editingCrop: false,
  onToggleCrop: vi.fn(),
  crop: null,
  onCropChange: vi.fn(),
  onCropCommit: vi.fn(),
  onPrev: vi.fn(),
  onNext: vi.fn(),
  onReset: vi.fn(),
  hasPrev: false,
  hasNext: true,
  position: null,
  busy: false,
} as const

describe('CurateStage', () => {
  it('renders the candidate thumbnail by default', () => {
    render(
      <CurateStage candidate={makeCandidate()} {...baseProps} />,
      { wrapper: wrapWith },
    )
    const img = screen.getByTestId('candidate-img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/v1/assets/ls_test_ac1f55b7390698a7/thumbnail')
  })

  it('swaps to the line-art URL when the user clicks the line-art toggle', () => {
    render(
      <CurateStage candidate={makeCandidate()} {...baseProps} />,
      { wrapper: wrapWith },
    )
    fireEvent.click(screen.getByLabelText('Show line art'))
    const img = screen.getByTestId('candidate-img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/v1/assets/ls_test_ac1f55b7390698a7/line-art')
  })

  it('invokes onToggleCrop when Edit crop is clicked', () => {
    const onToggle = vi.fn()
    render(
      <CurateStage
        candidate={makeCandidate()}
        editingCrop={false}
        onToggleCrop={onToggle}
        crop={null}
        onCropChange={vi.fn()}
        onCropCommit={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onReset={vi.fn()}
        hasPrev={false}
        hasNext
        position={null}
        busy={false}
      />,
      { wrapper: wrapWith },
    )
    fireEvent.click(screen.getByTestId('toggle-crop'))
    expect(onToggle).toHaveBeenCalled()
  })

  it('shows the empty placeholder when no candidate is loaded', () => {
    render(
      <CurateStage
        candidate={null}
        editingCrop={false}
        onToggleCrop={vi.fn()}
        crop={null}
        onCropChange={vi.fn()}
        onCropCommit={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onReset={vi.fn()}
        hasPrev={false}
        hasNext={false}
        position={null}
        busy={false}
      />,
      { wrapper: wrapWith },
    )
    expect(screen.getByText(/No candidate loaded/)).toBeInTheDocument()
  })

  it('disables the prev button when hasPrev is false', () => {
    render(
      <CurateStage candidate={makeCandidate()} {...baseProps} />,
      { wrapper: wrapWith },
    )
    expect(screen.getByTestId('prev-candidate')).toBeDisabled()
  })
})
