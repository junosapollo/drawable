import { useCallback, useEffect, useRef } from 'react'
import { makeStrokeOperation, renderLayer, renderOperation } from '../lib/drawing'
import { LOGICAL_SIZE, type DrawPoint, type StrokeOperation } from '../lib/types'
import { useDocumentStore } from '../state/documentStore'
import { useSearchStore } from '../state/searchStore'
import { useViewStore } from '../state/viewStore'
import { resolveRasterImages } from '../services/rasterAssets'

interface PanGesture {
  pointerId: number
  startX: number
  startY: number
  panX: number
  panY: number
}

interface PinchGesture {
  distance: number
  centerX: number
  centerY: number
  zoom: number
  panX: number
  panY: number
}

export function CanvasStage() {
  const stageRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLDivElement>(null)
  const activeCanvasRef = useRef<HTMLCanvasElement>(null)
  const layerCanvasRefs = useRef(new Map<string, HTMLCanvasElement>())
  const activePoints = useRef<DrawPoint[]>([])
  const activeOperation = useRef<StrokeOperation | null>(null)
  const drawingPointer = useRef<number | null>(null)
  const panGesture = useRef<PanGesture | null>(null)
  const pinchGesture = useRef<PinchGesture | null>(null)
  const touchPointers = useRef(new Map<number, { x: number; y: number }>())
  const spacePressed = useRef(false)
  const fitLocked = useRef(true)

  const document = useDocumentStore((state) => state.document)
  const activeLayerId = useDocumentStore((state) => state.activeLayerId)
  const activeTool = useDocumentStore((state) => state.activeTool)
  const brushSize = useDocumentStore((state) => state.brushSize)
  const stabilization = useDocumentStore((state) => state.stabilization)
  const simulatePressure = useDocumentStore((state) => state.simulatePressure)
  const commitOperation = useDocumentStore((state) => state.commitOperation)
  const setTool = useDocumentStore((state) => state.setTool)
  const setBrushSize = useDocumentStore((state) => state.setBrushSize)
  const setActiveLayer = useDocumentStore((state) => state.setActiveLayer)
  const traceVisible = useDocumentStore((state) => state.document.trace.visible)
  const updateTrace = useDocumentStore((state) => state.updateTrace)
  const undo = useDocumentStore((state) => state.undo)
  const redo = useDocumentStore((state) => state.redo)
  const zoom = useViewStore((state) => state.zoom)
  const panX = useViewStore((state) => state.panX)
  const panY = useViewStore((state) => state.panY)
  const fitRequest = useViewStore((state) => state.fitRequest)
  const setView = useViewStore((state) => state.setView)
  const invalidateSearch = useSearchStore((state) => state.invalidate)
  const setSearchDrawing = useSearchStore((state) => state.setDrawing)

  const fitCanvas = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const { width, height } = stage.getBoundingClientRect()
    const nextZoom = Math.min((width - 56) / LOGICAL_SIZE, (height - 56) / LOGICAL_SIZE, 1)
    setView(Math.max(0.1, nextZoom), 0, 0)
    fitLocked.current = true
  }, [setView])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(() => {
      if (fitLocked.current) fitCanvas()
    })
    observer.observe(stage)
    fitCanvas()
    return () => observer.disconnect()
  }, [fitCanvas])

  useEffect(() => { fitCanvas() }, [fitCanvas, fitRequest])

  useEffect(() => {
    let active = true
    resolveRasterImages(document).catch(() => new Map<string, CanvasImageSource>()).then((rasterAssets) => {
      if (!active) return
      for (const layer of document.layers) {
        const canvas = layerCanvasRefs.current.get(layer.id)
        const context = canvas?.getContext('2d')
        if (context) renderLayer(context, layer, rasterAssets)
      }
    })
    return () => { active = false }
  }, [document.layers])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.code === 'Space') {
        spacePressed.current = true
        event.preventDefault()
      }
      const key = event.key.toLowerCase()
      if (key === 'b') setTool('pressure')
      if (key === 'm') setTool('monoline')
      if (key === 'e') setTool('eraser')
      if (key === 'h') updateTrace({ visible: !traceVisible })
      if (key === '[') setBrushSize(brushSize - 1)
      if (key === ']') setBrushSize(brushSize + 1)
      if (/^[1-4]$/.test(key)) {
        const layer = document.layers[Number(key) - 1]
        if (layer) setActiveLayer(layer.id)
      }
      if (key === '0') fitCanvas()
      if (key === '+' || key === '=') {
        fitLocked.current = false
        setView(Math.min(8, zoom * 1.1), panX, panY)
      }
      if (key === '-') {
        fitLocked.current = false
        setView(Math.max(0.1, zoom / 1.1), panX, panY)
      }
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault()
        event.shiftKey ? redo() : undo()
      }
      if ((event.ctrlKey || event.metaKey) && key === 'y') {
        event.preventDefault()
        redo()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spacePressed.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [brushSize, document.layers, fitCanvas, panX, panY, redo, setActiveLayer, setBrushSize, setTool, setView, traceVisible, undo, updateTrace, zoom])

  const logicalPoint = (event: PointerEvent | React.PointerEvent): DrawPoint | null => {
    const paper = paperRef.current
    if (!paper) return null
    const rect = paper.getBoundingClientRect()
    return {
      x: Math.min(LOGICAL_SIZE, Math.max(0, ((event.clientX - rect.left) / rect.width) * LOGICAL_SIZE)),
      y: Math.min(LOGICAL_SIZE, Math.max(0, ((event.clientY - rect.top) / rect.height) * LOGICAL_SIZE)),
      pressure: event.pointerType === 'mouse' ? 0.5 : Math.max(0.01, event.pressure || 0.5),
      time: performance.now(),
    }
  }

  const paintActive = () => {
    const canvas = activeCanvasRef.current
    const operation = activeOperation.current
    if (!canvas || !operation) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, LOGICAL_SIZE, LOGICAL_SIZE)
    renderOperation(context, operation, operation.tool === 'eraser')
  }

  const updateActiveOperation = (event: React.PointerEvent) => {
    const nativeEvent = event.nativeEvent
    const samples = typeof nativeEvent.getCoalescedEvents === 'function' ? nativeEvent.getCoalescedEvents() : [nativeEvent]
    for (const sample of samples) {
      const point = logicalPoint(sample)
      if (point) activePoints.current.push(point)
    }
    if (activeTool !== 'hand') {
      activeOperation.current = makeStrokeOperation(
        activeTool,
        activePoints.current,
        brushSize,
        stabilization,
        event.pointerType === 'mouse' ? simulatePressure : false,
      )
      paintActive()
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    if (event.pointerType === 'touch') {
      touchPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touchPointers.current.size === 2) {
        const [first, second] = [...touchPointers.current.values()]
        if (first && second) {
          pinchGesture.current = {
            distance: Math.hypot(second.x - first.x, second.y - first.y),
            centerX: (first.x + second.x) / 2,
            centerY: (first.y + second.y) / 2,
            zoom,
            panX,
            panY,
          }
        }
      }
      return
    }

    if (activeTool === 'hand' || event.button === 1 || spacePressed.current) {
      panGesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX, panY }
      return
    }
    if (event.button !== 0) return
    const layer = document.layers.find((item) => item.id === activeLayerId)
    if (!layer?.visible || layer.opacity <= 0) return
    drawingPointer.current = event.pointerId
    activePoints.current = []
    invalidateSearch(true)
    setSearchDrawing(true)
    updateActiveOperation(event)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      if (!touchPointers.current.has(event.pointerId)) return
      touchPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const points = [...touchPointers.current.values()]
      if (points.length === 2 && pinchGesture.current) {
        const first = points[0]
        const second = points[1]
        if (!first || !second) return
        const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
        const centerX = (first.x + second.x) / 2
        const centerY = (first.y + second.y) / 2
        const nextZoom = Math.min(8, Math.max(0.1, pinchGesture.current.zoom * (distance / pinchGesture.current.distance)))
        setView(
          nextZoom,
          pinchGesture.current.panX + centerX - pinchGesture.current.centerX,
          pinchGesture.current.panY + centerY - pinchGesture.current.centerY,
        )
        fitLocked.current = false
      }
      return
    }
    if (panGesture.current?.pointerId === event.pointerId) {
      setView(zoom, panGesture.current.panX + event.clientX - panGesture.current.startX, panGesture.current.panY + event.clientY - panGesture.current.startY)
      fitLocked.current = false
      return
    }
    if (drawingPointer.current === event.pointerId) updateActiveOperation(event)
  }

  const clearActive = () => {
    const context = activeCanvasRef.current?.getContext('2d')
    if (context) context.clearRect(0, 0, LOGICAL_SIZE, LOGICAL_SIZE)
    activePoints.current = []
    activeOperation.current = null
    drawingPointer.current = null
    setSearchDrawing(false)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      touchPointers.current.delete(event.pointerId)
      if (touchPointers.current.size < 2) pinchGesture.current = null
      return
    }
    if (panGesture.current?.pointerId === event.pointerId) {
      panGesture.current = null
      return
    }
    if (drawingPointer.current !== event.pointerId) return
    updateActiveOperation(event)
    const operation = activeOperation.current
    if (operation && operation.points.length > 0) commitOperation(operation)
    clearActive()
  }

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    touchPointers.current.delete(event.pointerId)
    if (drawingPointer.current === event.pointerId) clearActive()
    if (panGesture.current?.pointerId === event.pointerId) panGesture.current = null
  }

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const factor = Math.exp(-event.deltaY * 0.0015)
    const nextZoom = Math.min(8, Math.max(0.1, zoom * factor))
    const stageCenterX = rect.left + rect.width / 2
    const stageCenterY = rect.top + rect.height / 2
    const paperCenterX = stageCenterX + panX
    const paperCenterY = stageCenterY + panY
    const scaleRatio = nextZoom / zoom
    setView(
      nextZoom,
      event.clientX - stageCenterX - (event.clientX - paperCenterX) * scaleRatio,
      event.clientY - stageCenterY - (event.clientY - paperCenterY) * scaleRatio,
    )
    fitLocked.current = false
  }

  return (
    <section
      ref={stageRef}
      className="canvas-stage"
      data-tool={activeTool}
      aria-label="Drawing canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
    >
      <div className="paper-position" style={{ transform: `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px))` }}>
        <div ref={paperRef} className="paper" style={{ transform: `scale(${zoom})` }}>
          {document.trace.imageUrl ? (
            <img
              className="trace-image"
              src={document.trace.imageUrl}
              alt=""
              draggable={false}
              style={{ opacity: document.trace.visible ? document.trace.opacity : 0, transform: `translate(-50%, -50%) scale(${document.trace.scale})` }}
            />
          ) : null}
          {[...document.layers].reverse().map((layer) => (
            <canvas
              key={layer.id}
              ref={(node) => { if (node) layerCanvasRefs.current.set(layer.id, node); else layerCanvasRefs.current.delete(layer.id) }}
              className="drawing-surface"
              width={LOGICAL_SIZE}
              height={LOGICAL_SIZE}
              style={{ opacity: layer.visible ? layer.opacity : 0 }}
            />
          ))}
          <canvas ref={activeCanvasRef} className="drawing-surface active-surface" width={LOGICAL_SIZE} height={LOGICAL_SIZE} />
        </div>
      </div>
      <output className="zoom-hud" aria-live="polite">{Math.round(zoom * 100)}%</output>
    </section>
  )
}
