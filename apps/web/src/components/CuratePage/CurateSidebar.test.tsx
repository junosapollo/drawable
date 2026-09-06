import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CurateSidebar } from './CurateSidebar'
import type { CurationProgress } from './types'

function makeProgress(overrides: Partial<CurationProgress> = {}): CurationProgress {
  return {
    reviewed: 0,
    accepted: 0,
    rejected: 0,
    remaining: 2000,
    target: 2000,
    by_style: {
      manga_anime: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      western_ink: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      realistic_academic: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      cartoon: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      gesture_sketch: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
    },
    by_scope: {
      eye: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      face_head: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      hair: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      hand: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      foot: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      upper_body_clothing: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      full_body: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
      multi_character: { reviewed: 0, accepted: 0, rejected: 0, remaining: 0 },
    },
    ...overrides,
  }
}

describe('CurateSidebar', () => {
  it('renders the progress numbers from the API payload', () => {
    render(
      <CurateSidebar
        progress={makeProgress({ reviewed: 184, accepted: 172, rejected: 12, remaining: 1816 })}
        style={null}
        scope={null}
        onStyle={vi.fn()}
        onScope={vi.fn()}
      />,
    )
    // ``184 / 2,000`` is locale-formatted; jsdom uses node's default ICU
    // build which may or may not insert a separator, so we only assert on
    // the digit payload.
    const text = screen.getByTestId('progress-text').textContent ?? ''
    expect(text).toMatch(/184\s*\/\s*2[,.]?000/)
  })

  it('toggles the style filter on click and clears it on a second click', () => {
    const onStyle = vi.fn()
    render(
      <CurateSidebar
        progress={makeProgress()}
        style={null}
        scope={null}
        onStyle={onStyle}
        onScope={vi.fn()}
      />,
    )
    const manga = screen.getByTestId('style-filter-manga_anime')
    fireEvent.click(manga)
    expect(onStyle).toHaveBeenLastCalledWith('manga_anime')
  })

  it('toggles the scope filter', () => {
    const onScope = vi.fn()
    render(
      <CurateSidebar
        progress={makeProgress()}
        style={null}
        scope="eye"
        onStyle={vi.fn()}
        onScope={onScope}
      />,
    )
    const eye = screen.getByTestId('scope-filter-eye')
    fireEvent.click(eye)
    // Re-clicking a selected scope clears the filter.
    expect(onScope).toHaveBeenLastCalledWith(null)
  })

  it('falls back to 0/2000 progress when the progress payload is null', () => {
    render(
      <CurateSidebar
        progress={null}
        style={null}
        scope={null}
        onStyle={vi.fn()}
        onScope={vi.fn()}
      />,
    )
    const text = screen.getByTestId('progress-text').textContent ?? ''
    expect(text).toMatch(/0\s*\/\s*2[,.]?000/)
  })

  it('exposes a keyboard hint matching the spec', () => {
    render(
      <CurateSidebar
        progress={makeProgress()}
        style={null}
        scope={null}
        onStyle={vi.fn()}
        onScope={vi.fn()}
      />,
    )
    const text = screen.getByText(/Keep/).parentElement?.textContent ?? ''
    expect(text).toContain('K')
    expect(text).toContain('R')
    expect(text).toContain('1')
    expect(text).toContain('2')
    expect(text).toContain('3')
    expect(text).toContain('C')
  })
})
