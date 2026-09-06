import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// React Testing Library mounts components into a shared document; without
// an explicit cleanup between tests the DOM accumulates and queries like
// ``getByTestId`` start matching nodes from previous renders. ``afterEach``
// runs after every test in the file, even ones that don't use the library.
afterEach(() => {
  cleanup()
})

// jsdom ships with MouseEvent and TouchEvent but not PointerEvent. The
// CropOverlay uses pointer events for the draggable crop handles, and
// reading ``clientX`` from a missing PointerEvent produces ``NaN`` and
// silently breaks every drag in tests. Polyfill before importing the
// application code so the components see a complete event surface.
if (typeof PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    public readonly pointerId: number
    public readonly pointerType: string
    public readonly isPrimary: boolean
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 1
      this.pointerType = params.pointerType ?? 'mouse'
      this.isPrimary = params.isPrimary ?? true
    }
  }
  // @ts-expect-error -- assign to the global PointerEvent so React's
  // synthetic event system can read clientX/clientY in tests.
  globalThis.PointerEvent = PointerEventPolyfill
}
