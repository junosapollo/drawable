import type { DrawingDocument } from '../lib/types'

const DB_NAME = 'drawable-documents'
const STORE_NAME = 'documents'
const CURRENT_KEY = 'current'
const PREVIOUS_KEY = 'previous'

interface SavedRecord {
  key: string
  schemaVersion: 1
  savedAt: number
  document: DrawingDocument
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readRecord(db: IDBDatabase, key: string) {
  return new Promise<SavedRecord | undefined>((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result as SavedRecord | undefined)
    request.onerror = () => reject(request.error)
  })
}

export async function loadDocument(): Promise<DrawingDocument | null> {
  const db = await openDatabase()
  try {
    const current = await readRecord(db, CURRENT_KEY)
    return current?.schemaVersion === 1 ? current.document : null
  } catch {
    const previous = await readRecord(db, PREVIOUS_KEY)
    return previous?.schemaVersion === 1 ? previous.document : null
  } finally {
    db.close()
  }
}

export async function saveDocument(document: DrawingDocument) {
  const db = await openDatabase()
  const current = await readRecord(db, CURRENT_KEY)
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    if (current) store.put({ ...current, key: PREVIOUS_KEY })
    store.put({ key: CURRENT_KEY, schemaVersion: 1, savedAt: Date.now(), document } satisfies SavedRecord)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}
