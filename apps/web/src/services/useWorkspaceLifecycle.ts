import { useEffect, useRef, useState } from 'react'
import { countDocumentStrokes } from '../lib/drawing'
import { buildStrokeSequence, countDocumentPoints } from '../lib/strokeSequence'
import type { DrawingDocument } from '../lib/types'
import { useDocumentStore } from '../state/documentStore'
import { useSearchStore } from '../state/searchStore'
import { useUiStore } from '../state/uiStore'
import { fixtureServices } from './frontendServices'
import { cleanupExpiredImports, loadDocument, materializeStagedImport, saveDocument, type LoadedDocument } from './persistence'
import { useServiceStore } from './serviceRegistry'
import { prepareSnapshot } from './snapshotClient'
import { acquireDocumentLease, type DocumentLease } from './documentLock'

export function useWorkspaceLifecycle() {
  const document = useDocumentStore((state) => state.document)
  const hasHydrated = useDocumentStore((state) => state.hasHydrated)
  const setHydrated = useDocumentStore((state) => state.setHydrated)
  const replaceDocument = useDocumentStore((state) => state.replaceDocument)
  const activeLayerId = useDocumentStore((state) => state.activeLayerId)
  const setResolvedTraceImage = useDocumentStore((state) => state.setResolvedTraceImage)
  const generation = useSearchStore((state) => state.generation)
  const drawing = useSearchStore((state) => state.drawing)
  const textHint = useSearchStore((state) => state.textHint)
  const selectedStyle = useSearchStore((state) => state.selectedStyle)
  const invalidate = useSearchStore((state) => state.invalidate)
  const setLoading = useSearchStore((state) => state.setLoading)
  const setResponse = useSearchStore((state) => state.setResponse)
  const setError = useSearchStore((state) => state.setError)
  const theme = useUiStore((state) => state.theme)
  const serviceMode = useServiceStore((state) => state.mode)
  const services = useServiceStore((state) => state.services)
  const sessionId = useServiceStore((state) => state.sessionId)
  const probeServices = useServiceStore((state) => state.probe)
  const [restoreCandidate, setRestoreCandidate] = useState<LoadedDocument | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [notice, setNotice] = useState<string | null>(null)
  const previousRevision = useRef(document.revision)
  const lease = useRef<DocumentLease | null>(null)
  const activationVersion = useRef(0)

  const setDocumentUrl = (documentId: string) => {
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('document', documentId)
    window.history.replaceState(null, '', `${url.pathname}${url.search}`)
  }

  const activateDocument = async (loaded: LoadedDocument) => {
    const activation = ++activationVersion.current
    let next = loaded
    let nextLease = await acquireDocumentLease(next.document.id)
    if (activation !== activationVersion.current) {
      nextLease.release()
      return
    }
    if (!nextLease.acquired) {
      nextLease.release()
      next = {
        ...next,
        document: { ...structuredClone(next.document), id: `document-${crypto.randomUUID()}`, updatedAt: Date.now() },
      }
      nextLease = await acquireDocumentLease(next.document.id)
      setNotice('This drawing was already open, so drawable created an independent copy.')
    }
    if (activation !== activationVersion.current) {
      nextLease.release()
      return
    }
    lease.current?.release()
    lease.current = nextLease
    replaceDocument(next.document, next.activeLayerId)
    setDocumentUrl(next.document.id)
    setHydrated(true)
  }

  useEffect(() => { void probeServices() }, [probeServices])

  useEffect(() => {
    let active = true
    const load = async () => {
      void cleanupExpiredImports().catch(() => undefined)
      const parameters = new URLSearchParams(window.location.search)
      const importToken = parameters.get('import')
      const requestedDocument = parameters.get('document') ?? undefined
      const saved = importToken ? await materializeStagedImport(importToken) : await loadDocument(requestedDocument)
      if (!active) return
      if (importToken && !saved) {
        setNotice('This import link has expired. Return to the original tab and choose the file again.')
        const blank = useDocumentStore.getState().document
        await activateDocument({ document: blank, activeLayerId: 'layer-1' })
        return
      }
      const hasInk = saved?.document.layers.some((layer) => layer.operations.length)
      if (saved && hasInk && !importToken) setRestoreCandidate(saved)
      else if (saved) {
        await activateDocument(saved)
        if (importToken) setNotice('Imported sketch opened as a new local drawing.')
      } else {
        const blank = useDocumentStore.getState().document
        await activateDocument({ document: blank, activeLayerId: 'layer-1' })
      }
    }
    void load().catch(() => {
      if (active) {
        setNotice('Local recovery storage could not be opened. Drawing remains available, but autosave may be unavailable.')
        setHydrated(true)
      }
    })
    return () => { active = false; activationVersion.current += 1; lease.current?.release(); lease.current = null }
    // Startup must run once per mounted workspace; store changes are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHydrated])

  useEffect(() => {
    if (!hasHydrated) return
    setSaveState('saving')
    const timer = window.setTimeout(() => {
      saveDocument(document, activeLayerId).then(() => setSaveState('saved')).catch(() => setSaveState('error'))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [activeLayerId, document, hasHydrated])

  useEffect(() => {
    if (!hasHydrated || !document.trace.assetId || document.trace.imageUrl) return
    const controller = new AbortController()
    const assetClient = services.assets ?? fixtureServices.assets
    assetClient.resolveTrace(document.trace.assetId, controller.signal).then((imageUrl) => {
      if (imageUrl) setResolvedTraceImage(imageUrl)
      else setNotice('The saved trace reference is unavailable; the drawing opened without it.')
    }).catch(() => setNotice('The saved trace reference is unavailable; the drawing opened without it.'))
    return () => controller.abort()
  }, [document.trace.assetId, document.trace.imageUrl, hasHydrated, setResolvedTraceImage])

  useEffect(() => {
    if (previousRevision.current !== document.revision) {
      previousRevision.current = document.revision
      invalidate(false)
    }
  }, [document.revision, invalidate])

  useEffect(() => {
    if (drawing || !hasHydrated || serviceMode === 'probing') return
    const controller = new AbortController()
    const requestRevision = document.revision
    const requestGeneration = generation
    const timer = window.setTimeout(() => {
      setLoading(true)
      prepareSnapshot(document, requestGeneration, controller.signal).then((snapshot) => {
        if (snapshot.revision !== requestRevision || snapshot.generation !== requestGeneration) throw new DOMException('Snapshot superseded', 'AbortError')
        return services.search.search({
          sessionId,
          revision: requestRevision,
          generation: requestGeneration,
          strokeCount: countDocumentStrokes(document.layers),
          pointCount: countDocumentPoints(document.layers),
          textHint,
          selectedStyle,
          image: snapshot.image,
          strokes: buildStrokeSequence(document.layers),
        }, controller.signal)
      }).then((response) => {
        const current = useSearchStore.getState()
        const currentDocument = useDocumentStore.getState().document
        if (!current.drawing && current.generation === response.generation && currentDocument.revision === response.revision) setResponse(response)
      }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setError(error instanceof Error ? error.message : 'Reference search failed.')
      })
    }, 350)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [document.revision, drawing, generation, hasHydrated, selectedStyle, serviceMode, services, sessionId, setError, setLoading, setResponse, textHint])

  useEffect(() => {
    if (theme !== 'system') return
    const query = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { globalThis.document.documentElement.dataset.theme = query.matches ? 'dark' : 'light' }
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [theme])

  const restore = () => {
    if (restoreCandidate) void activateDocument(restoreCandidate)
    setRestoreCandidate(null)
  }
  const discard = () => {
    setRestoreCandidate(null)
    const blank = useDocumentStore.getState().document
    void activateDocument({ document: blank, activeLayerId: 'layer-1' })
  }

  return { saveState, restoreCandidate: restoreCandidate?.document ?? null, restore, discard, notice, dismissNotice: () => setNotice(null) }
}
