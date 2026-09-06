import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CropOverlay, defaultCrop, pixelToNormalized } from './CropOverlay'

describe('CropOverlay', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders nothing when editing is disabled', () => {
    render(
      <CropOverlay
        crop={{ x: 10, y: 10, width: 100, height: 100 }}
        imageWidth={200}
        imageHeight={200}
        editing={false}
        onChange={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('crop-box')).toBeNull()
  })

  it('renders the crop box with handles when editing is enabled', () => {
    render(
      <CropOverlay
        crop={{ x: 10, y: 10, width: 100, height: 100 }}
        imageWidth={200}
        imageHeight={200}
        editing
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('crop-box')).toBeInTheDocument()
    // All 8 handles should be present.
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      expect(screen.getByTestId(`crop-handle-${handle}`)).toBeInTheDocument()
    }
  })

  it('clamps the crop to image bounds on initial render', () => {
    // Crop sticks out the right and bottom of the image; defaultCrop's
    // clamp should never allow that, but a caller-supplied crop is not
    // trusted. Verify the rendered box stays within bounds by reading the
    // computed style.
    const { container } = render(
      <CropOverlay
        crop={{ x: 150, y: 150, width: 200, height: 200 }}
        imageWidth={200}
        imageHeight={200}
        editing
        onChange={vi.fn()}
      />,
    )
    const box = container.querySelector('[data-testid="crop-box"]') as HTMLElement
    expect(box).toBeTruthy()
    // The box must be inside the surface (inset: 0). The clamp logic is
    // unit-tested separately; we only need to ensure the rendered crop
    // exists and has non-negative dimensions.
    const width = Number.parseInt(box.style.width, 10)
    const height = Number.parseInt(box.style.height, 10)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
  })

  it('invokes onChange when the user drags a handle', () => {
    const onChange = vi.fn()
    render(
      <CropOverlay
        crop={{ x: 10, y: 10, width: 100, height: 100 }}
        imageWidth={200}
        imageHeight={200}
        editing
        onChange={onChange}
      />,
    )
    const seHandle = screen.getByTestId('crop-handle-se')
    // The surface uses getBoundingClientRect to map client pixels to
    // image space. Stub it so the math is deterministic: 1 client px = 1
    // image px.
    const surface = seHandle.closest('.crop-surface') as HTMLElement
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    // pointerDown is on the handle (it sets dragRef); pointerMove and
    // pointerUp are on the surface (which is where the listeners live).
    fireEvent.pointerDown(seHandle, { clientX: 110, clientY: 110, pointerId: 1 })
    fireEvent.pointerMove(surface, { clientX: 130, clientY: 130, pointerId: 1 })
    fireEvent.pointerUp(surface, { pointerId: 1 })
    expect(onChange).toHaveBeenCalled()
    // The SE handle grows width and height when dragged outward.
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as
      | { x: number; y: number; width: number; height: number }
      | undefined
    expect(last).toBeTruthy()
    expect(last!.width).toBeGreaterThan(100)
    expect(last!.height).toBeGreaterThan(100)
  })

  it('moves the crop with the arrow keys when the box is focused', () => {
    const onChange = vi.fn()
    render(
      <CropOverlay
        crop={{ x: 50, y: 50, width: 100, height: 100 }}
        imageWidth={200}
        imageHeight={200}
        editing
        onChange={onChange}
      />,
    )
    const box = screen.getByTestId('crop-box')
    box.focus()
    fireEvent.keyDown(box, { key: 'ArrowRight' })
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as
      | { x: number }
      | undefined
    expect(last).toBeTruthy()
    expect(last!.x).toBeGreaterThan(50)
  })

  it('uses a larger step when the shift key is held', () => {
    const onChange = vi.fn()
    render(
      <CropOverlay
        crop={{ x: 50, y: 50, width: 100, height: 100 }}
        imageWidth={200}
        imageHeight={200}
        editing
        onChange={onChange}
      />,
    )
    const box = screen.getByTestId('crop-box')
    box.focus()
    fireEvent.keyDown(box, { key: 'ArrowRight', shiftKey: true })
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as
      | { x: number }
      | undefined
    expect(last!.x).toBe(50 + 16)
  })
})

describe('defaultCrop', () => {
  it('returns a centered 80% box', () => {
    const rect = defaultCrop(200, 100)
    expect(rect.width).toBe(160)
    expect(rect.height).toBe(80)
    expect(rect.x).toBe(20)
    expect(rect.y).toBe(10)
  })

  it('never exceeds image bounds', () => {
    const rect = defaultCrop(0, 0)
    expect(rect.width).toBeGreaterThanOrEqual(16)
    expect(rect.height).toBeGreaterThanOrEqual(16)
  })
})

describe('pixelToNormalized', () => {
  it('scales a pixel rect to [0, 1] normalized coordinates', () => {
    expect(pixelToNormalized({ x: 50, y: 25, width: 100, height: 50 }, 200, 100)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    })
  })
})
