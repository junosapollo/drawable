import { useEffect, useRef, useState } from 'react'
import { countDocumentStrokes } from '../lib/drawing'
import type { DrawingDocument } from '../lib/types'
import { useDocumentStore } from '../state/documentStore'
import { useSearchStore } from '../state/searchStore'
import { useUiStore } from '../state/uiStore'
import { fixtureServices } from './frontendServices'
import { loadDocument, saveDocument } from './persistence'
import { prepareSnapshot } from './snapshotClient'

export function useWorkspaceLifecycle() {
  const document = useDocumentStore((state) => state.document)
  const hasHydrated = useDocumentStore((state) => state.hasHydrated)
  const setHydrated = useDocumentStore((state) => state.setHydrated)
  const replaceDocument = useDocumentStore((state) => state.replaceDocument)
  const generation = useSearchStore((state) => state.generation)
  const drawing = useSearchStore((state) => state.drawing)
  const textHint = useSearchStore((state) => state.textHint)
  const invalidate = useSearchStore((state) => state.invalidate)
  const setLoading = useSearchStore((state) => state.setLoading)
  const setResponse = useSearchStore((state) => state.setResponse)
  const setError = useSearchStore((state) => state.setError)
  const theme = useUiStore((state) => state.theme)
  const [restoreCandidate, setRestoreCandidate] = useState<DrawingDocument | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const previousRevision = useRef(document.revision)

  useEffect(() => {
    let active = true
    loadDocument().then((saved) => {
      if (!active) return
      const hasInk = saved?.layers.some((layer) => layer.operations.length)
      if (saved && hasInk) setRestoreCandidate(saved)
      else setHydrated(true)
    }).catch(() => setHydrated(true))
    return () => { active = false }
  }, [setHydrated])

  useEffect(() => {
    if (!hasHydrated) return
    setSaveState('saving')
    const timer = window.setTimeout(() => {
      saveDocument(document).then(() => setSaveState('saved')).catch(() => setSaveState('error'))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [document, hasHydrated])

  useEffect(() => {
    if (previousRevision.current !== document.revision) {
      previousRevision.current = document.revision
      invalidate(false)
    }
  }, [document.revision, invalidate])

  useEffect(() => {
    if (drawing || !hasHydrated) return
    const controller = new AbortController()
    const requestRevision = document.revision
    const requestGeneration = generation
    const timer = window.setTimeout(() => {
      setLoading(true)
      prepareSnapshot(document, requestGeneration, controller.signal).then((snapshot) => {
        if (snapshot.revision !== requestRevision || snapshot.generation !== requestGeneration) throw new DOMException('Snapshot superseded', 'AbortError')
        return fixtureServices.search.search({
          revision: requestRevision,
          generation: requestGeneration,
          strokeCount: countDocumentStrokes(document.layers),
          textHint,
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
  }, [document.revision, drawing, generation, hasHydrated, setError, setLoading, setResponse, textHint])

  useEffect(() => {
    if (theme !== 'system') return
    const query = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { globalThis.document.documentElement.dataset.theme = query.matches ? 'dark' : 'light' }
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [theme])

  const restore = () => {
    if (restoreCandidate) replaceDocument(restoreCandidate)
    setRestoreCandidate(null)
    setHydrated(true)
  }
  const discard = () => {
    setRestoreCandidate(null)
    setHydrated(true)
  }

  return { saveState, restoreCandidate, restore, discard }
}
