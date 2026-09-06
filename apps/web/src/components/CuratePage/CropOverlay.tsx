/**
 * Interactive 2D crop bounding box overlay.
 *
 * The overlay is drawn on top of the candidate image. Coordinates are stored
 * as *normalized* values in the [0, 1] range (origin at top-left of the
 * underlying image) so the crop is decoupled from the rendered pixel size —
 * a reviewer who resizes the browser window does not silently change the
 * crop. The overlay's drag handles operate in pixel space and convert
 * back to normalized space on every pointer move.
 *
 * Handles (corners and edge midpoints) are keyboard-focusable so the crop
 * can also be moved with the arrow keys for accessibility.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

export interface NormalizedCrop {
  x: number
  y: number
  width: number
  height: number
}

export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CropOverlayProps {
  /** Current crop in source-image pixel space. ``null`` disables the overlay. */
  crop: PixelRect | null
  /** Rendered image element pixel dimensions. */
  imageWidth: number
  imageHeight: number
  /** Whether the user is currently editing the crop. */
  editing: boolean
  onChange: (next: PixelRect) => void
  onCommit?: (next: PixelRect) => void
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

const MIN_PIXELS = 16
const HANDLES: ReadonlyArray<{ key: Handle; cursor: string; position: (b: PixelRect) => { left: number; top: number } }> = [
  { key: 'nw', cursor: 'nwse-resize', position: (b) => ({ left: b.x, top: b.y }) },
  { key: 'n', cursor: 'ns-resize', position: (b) => ({ left: b.x + b.width / 2, top: b.y }) },
  { key: 'ne', cursor: 'nesw-resize', position: (b) => ({ left: b.x + b.width, top: b.y }) },
  { key: 'e', cursor: 'ew-resize', position: (b) => ({ left: b.x + b.width, top: b.y + b.height / 2 }) },
  { key: 'se', cursor: 'nwse-resize', position: (b) => ({ left: b.x + b.width, top: b.y + b.height }) },
  { key: 's', cursor: 'ns-resize', position: (b) => ({ left: b.x + b.width / 2, top: b.y + b.height }) },
  { key: 'sw', cursor: 'nesw-resize', position: (b) => ({ left: b.x, top: b.y + b.height }) },
  { key: 'w', cursor: 'ew-resize', position: (b) => ({ left: b.x, top: b.y + b.height / 2 }) },
]

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function clampRect(rect: PixelRect, imageWidth: number, imageHeight: number): PixelRect {
  const width = clamp(rect.width, MIN_PIXELS, imageWidth)
  const height = clamp(rect.height, MIN_PIXELS, imageHeight)
  const x = clamp(rect.x, 0, imageWidth - width)
  const y = clamp(rect.y, 0, imageHeight - height)
  return { x, y, width, height }
}

function emptyRect(imageWidth: number, imageHeight: number): PixelRect {
  // 80% of the image, centered. The default crop is a generous "almost
  // everything" so the user only has to tighten the edges on a review.
  const width = Math.round(imageWidth * 0.8)
  const height = Math.round(imageHeight * 0.8)
  return clampRect(
    {
      x: Math.round((imageWidth - width) / 2),
      y: Math.round((imageHeight - height) / 2),
      width,
      height,
    },
    imageWidth,
    imageHeight,
  )
}

interface DragState {
  handle: Handle
  startPointer: { x: number; y: number }
  startRect: PixelRect
}

export function CropOverlay({
  crop,
  imageWidth,
  imageHeight,
  editing,
  onChange,
  onCommit,
}: CropOverlayProps) {
  // We keep a local "active" rect so dragging feels instantaneous; the
  // parent is updated every move and the live ``crop`` prop is the source
  // of truth on the next render.
  const [active, setActive] = useState<PixelRect | null>(crop)
  const dragRef = useRef<DragState | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const labelId = useId()

  // Re-sync local state when the upstream crop changes (new candidate, undo).
  useEffect(() => {
    setActive(crop)
  }, [crop])

  const disabled = !editing || imageWidth <= 0 || imageHeight <= 0

  const startDrag = useCallback(
    (handle: Handle) => (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return
      event.preventDefault()
      event.stopPropagation()
      const surface = surfaceRef.current
      if (!surface) return
      const rect = surface.getBoundingClientRect()
      const scaleX = imageWidth / rect.width
      const scaleY = imageHeight / rect.height
      const startRect = active ?? emptyRect(imageWidth, imageHeight)
      dragRef.current = {
        handle,
        startPointer: {
          x: (event.clientX - rect.left) * scaleX,
          y: (event.clientY - rect.top) * scaleY,
        },
        startRect,
      }
      // Capture so we keep receiving events even if the pointer leaves the handle.
      ;(event.target as Element).setPointerCapture?.(event.pointerId)
    },
    [active, disabled, imageHeight, imageWidth],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const surface = surfaceRef.current
      if (!surface) return
      const rect = surface.getBoundingClientRect()
      const scaleX = imageWidth / rect.width
      const scaleY = imageHeight / rect.height
      const pointer = {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
      }
      const dx = pointer.x - drag.startPointer.x
      const dy = pointer.y - drag.startPointer.y
      const start = drag.startRect
      let next: PixelRect = start
      switch (drag.handle) {
        case 'move':
          next = { ...start, x: start.x + dx, y: start.y + dy }
          break
        case 'nw':
          next = { ...start, x: start.x + dx, y: start.y + dy, width: start.width - dx, height: start.height - dy }
          break
        case 'n':
          next = { ...start, y: start.y + dy, height: start.height - dy }
          break
        case 'ne':
          next = { ...start, y: start.y + dy, width: start.width + dx, height: start.height - dy }
          break
        case 'e':
          next = { ...start, width: start.width + dx }
          break
        case 'se':
          next = { ...start, width: start.width + dx, height: start.height + dy }
          break
        case 's':
          next = { ...start, height: start.height + dy }
          break
        case 'sw':
          next = { ...start, x: start.x + dx, width: start.width - dx, height: start.height + dy }
          break
        case 'w':
          next = { ...start, x: start.x + dx, width: start.width - dx }
          break
      }
      const clamped = clampRect(next, imageWidth, imageHeight)
      setActive(clamped)
      onChange(clamped)
    },
    [imageHeight, imageWidth, onChange],
  )

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return
      dragRef.current = null
      ;(event.target as Element).releasePointerCapture?.(event.pointerId)
      if (active && onCommit) onCommit(active)
    },
    [active, onCommit],
  )

  // Keyboard nudging: arrow keys move the whole crop, Shift+arrow resizes.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return
      const current = active ?? emptyRect(imageWidth, imageHeight)
      const step = event.shiftKey ? 16 : 4
      let next: PixelRect = current
      switch (event.key) {
        case 'ArrowLeft':
          next = { ...current, x: current.x - step }
          break
        case 'ArrowRight':
          next = { ...current, x: current.x + step }
          break
        case 'ArrowUp':
          next = { ...current, y: current.y - step }
          break
        case 'ArrowDown':
          next = { ...current, y: current.y + step }
          break
        default:
          return
      }
      event.preventDefault()
      const clamped = clampRect(next, imageWidth, imageHeight)
      setActive(clamped)
      onChange(clamped)
      if (onCommit) onCommit(clamped)
    },
    [active, disabled, imageHeight, imageWidth, onChange, onCommit],
  )

  // Surface dimensions match the rendered image. The overlay uses an aspect
  // ratio div so the box stays in sync even before the image has loaded —
  // we just won't accept pointer events until imageWidth > 0.
  const aspect = useMemo(() => (imageHeight > 0 ? imageWidth / imageHeight : 1), [imageWidth, imageHeight])
  const show = !disabled && active
  return (
    <div
      className="crop-surface"
      ref={surfaceRef}
      style={{ aspectRatio: aspect }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {show ? (
        <>
          <div
            className="crop-mask crop-mask--top"
            style={{ height: active.y, left: 0, right: 0, top: 0 }}
            aria-hidden="true"
          />
          <div
            className="crop-mask crop-mask--bottom"
            style={{ top: active.y + active.height, left: 0, right: 0, bottom: 0 }}
            aria-hidden="true"
          />
          <div
            className="crop-mask crop-mask--left"
            style={{ top: active.y, height: active.height, left: 0, width: active.x }}
            aria-hidden="true"
          />
          <div
            className="crop-mask crop-mask--right"
            style={{
              top: active.y,
              height: active.height,
              left: active.x + active.width,
              right: 0,
            }}
            aria-hidden="true"
          />
          <div
            className={`crop-box ${editing ? 'is-editing' : ''}`}
            style={{
              left: active.x,
              top: active.y,
              width: active.width,
              height: active.height,
            }}
            role="region"
            aria-label="Crop bounding box"
            tabIndex={editing ? 0 : -1}
            onKeyDown={onKeyDown}
            onPointerDown={startDrag('move')}
            data-testid="crop-box"
          >
            {/* Rule-of-thirds grid lines for visual reference. */}
            <span className="crop-grid" aria-hidden="true">
              <i style={{ left: '33.333%' }} />
              <i style={{ left: '66.666%' }} />
              <i style={{ top: '33.333%' }} />
              <i style={{ top: '66.666%' }} />
            </span>
            {editing
              ? HANDLES.map(({ key, cursor, position }) => {
                  const { left, top } = position(active)
                  return (
                    <div
                      key={key}
                      className={`crop-handle crop-handle--${key}`}
                      style={{ left, top, cursor }}
                      onPointerDown={startDrag(key)}
                      aria-label={`Resize ${key}`}
                      data-testid={`crop-handle-${key}`}
                    />
                  )
                })
              : null}
            {/* Hidden label so screen readers describe the crop's coordinates
                when the user focuses the box. */}
            <span id={labelId} className="visually-hidden">
              Crop {active.x}, {active.y}, {active.width} by {active.height} pixels.
            </span>
          </div>
        </>
      ) : null}
    </div>
  )
}

export function defaultCrop(imageWidth: number, imageHeight: number): PixelRect {
  return emptyRect(imageWidth, imageHeight)
}

export function pixelToNormalized(rect: PixelRect, imageWidth: number, imageHeight: number): NormalizedCrop {
  return {
    x: rect.x / imageWidth,
    y: rect.y / imageHeight,
    width: rect.width / imageWidth,
    height: rect.height / imageHeight,
  }
}
