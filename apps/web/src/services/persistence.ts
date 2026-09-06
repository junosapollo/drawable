import type { DrawingDocument, PreparedImport, StoredRasterAsset } from '../lib/types'

const DB_NAME = 'drawable-documents'
const DB_VERSION = 2
const DOCUMENT_STORE = 'documents'
const ASSET_STORE = 'assets'
const IMPORT_STORE = 'imports'
const LEGACY_CURRENT_KEY = 'current'
const LEGACY_PREVIOUS_KEY = 'previous'
const LAST_DOCUMENT_KEY = 'last-document'
const IMPORT_LIFETIME_MS = 30 * 60 * 1000

interface SavedRecord {
  key: string
  schemaVersion: 1 | 2
  savedAt: number
  document: DrawingDocument
  activeLayerId?: string
}

interface PointerRecord {
  key: typeof LAST_DOCUMENT_KEY
  documentId: string
  savedAt: number
}

interface StagedImportRecord extends PreparedImport {
  token: string
  createdAt: number
  expiresAt: number
}

export interface LoadedDocument {
  document: DrawingDocument
  activeLayerId: string
}

function documentKey(documentId: string, generation: 'current' | 'previous') {
  return `document:${documentId}:${generation}`
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DOCUMENT_STORE)) db.createObjectStore(DOCUMENT_STORE, { keyPath: 'key' })
      if (!db.objectStoreNames.contains(ASSET_STORE)) db.createObjectStore(ASSET_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(IMPORT_STORE)) db.createObjectStore(IMPORT_STORE, { keyPath: 'token' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readDocumentRecord(db: IDBDatabase, key: string) {
  return requestValue(db.transaction(DOCUMENT_STORE).objectStore(DOCUMENT_STORE).get(key)) as Promise<SavedRecord | undefined>
}

function asLoaded(record: SavedRecord | undefined): LoadedDocument | null {
  if (!record || (record.schemaVersion !== 1 && record.schemaVersion !== 2)) return null
  return { document: record.document, activeLayerId: record.activeLayerId ?? record.document.layers[0]?.id ?? 'layer-1' }
}

async function loadKeyedDocument(db: IDBDatabase, documentId: string) {
  const current = asLoaded(await readDocumentRecord(db, documentKey(documentId, 'current')))
  if (current) return current
  return asLoaded(await readDocumentRecord(db, documentKey(documentId, 'previous')))
}

export async function loadDocument(documentId?: string): Promise<LoadedDocument | null> {
  const db = await openDatabase()
  try {
    if (documentId) return await loadKeyedDocument(db, documentId)
    const pointer = await requestValue(db.transaction(DOCUMENT_STORE).objectStore(DOCUMENT_STORE).get(LAST_DOCUMENT_KEY)) as PointerRecord | undefined
    if (pointer?.documentId) {
      const pointed = await loadKeyedDocument(db, pointer.documentId)
      if (pointed) return pointed
    }
    const legacyCurrent = asLoaded(await readDocumentRecord(db, LEGACY_CURRENT_KEY))
    if (legacyCurrent) return legacyCurrent
    return asLoaded(await readDocumentRecord(db, LEGACY_PREVIOUS_KEY))
  } finally {
    db.close()
  }
}

export async function saveDocument(document: DrawingDocument, activeLayerId: string) {
  const db = await openDatabase()
  try {
    const currentKey = documentKey(document.id, 'current')
    const current = await readDocumentRecord(db, currentKey)
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(DOCUMENT_STORE, 'readwrite')
      const store = transaction.objectStore(DOCUMENT_STORE)
      if (current) store.put({ ...current, key: documentKey(document.id, 'previous') })
      store.put({ key: currentKey, schemaVersion: 2, savedAt: Date.now(), document, activeLayerId } satisfies SavedRecord)
      store.put({ key: LAST_DOCUMENT_KEY, documentId: document.id, savedAt: Date.now() } satisfies PointerRecord)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

export async function loadRasterAsset(assetId: string): Promise<StoredRasterAsset | null> {
  const db = await openDatabase()
  try {
    return await requestValue(db.transaction(ASSET_STORE).objectStore(ASSET_STORE).get(assetId)) as StoredRasterAsset | null
  } finally {
    db.close()
  }
}

export async function stageImport(prepared: PreparedImport) {
  const db = await openDatabase()
  const token = crypto.randomUUID()
  const createdAt = Date.now()
  try {
    await requestValue(db.transaction(IMPORT_STORE, 'readwrite').objectStore(IMPORT_STORE).put({
      ...prepared,
      token,
      createdAt,
      expiresAt: createdAt + IMPORT_LIFETIME_MS,
    } satisfies StagedImportRecord))
    return token
  } finally {
    db.close()
  }
}

export async function materializeStagedImport(token: string): Promise<LoadedDocument | null> {
  const db = await openDatabase()
  try {
    const staged = await requestValue(db.transaction(IMPORT_STORE).objectStore(IMPORT_STORE).get(token)) as StagedImportRecord | undefined
    if (!staged || staged.expiresAt <= Date.now()) return null
    const document = structuredClone(staged.document)
    document.id = `document-${crypto.randomUUID()}`
    document.revision = 0
    document.updatedAt = Date.now()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([DOCUMENT_STORE, ASSET_STORE], 'readwrite')
      const documents = transaction.objectStore(DOCUMENT_STORE)
      const assets = transaction.objectStore(ASSET_STORE)
      for (const asset of staged.assets) assets.put(asset)
      documents.put({ key: documentKey(document.id, 'current'), schemaVersion: 2, savedAt: Date.now(), document, activeLayerId: staged.activeLayerId } satisfies SavedRecord)
      documents.put({ key: LAST_DOCUMENT_KEY, documentId: document.id, savedAt: Date.now() } satisfies PointerRecord)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    return { document, activeLayerId: staged.activeLayerId }
  } finally {
    db.close()
  }
}

export async function cleanupExpiredImports() {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(IMPORT_STORE, 'readwrite')
      const request = transaction.objectStore(IMPORT_STORE).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        if ((cursor.value as StagedImportRecord).expiresAt <= Date.now()) cursor.delete()
        cursor.continue()
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}
