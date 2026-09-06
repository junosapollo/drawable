export interface DocumentLease {
  acquired: boolean
  release: () => void
}

interface LockMessage {
  type: 'probe' | 'held' | 'claim'
  documentId: string
  ownerId: string
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

async function acquireNavigatorLease(documentId: string): Promise<DocumentLease> {
  let releaseHold: (() => void) | null = null
  let reportAcquired: ((acquired: boolean) => void) | null = null
  const acquired = new Promise<boolean>((resolve) => { reportAcquired = resolve })
  void navigator.locks.request(`drawable-document:${documentId}`, { ifAvailable: true }, async (lock) => {
    reportAcquired?.(Boolean(lock))
    if (!lock) return
    await new Promise<void>((resolve) => { releaseHold = resolve })
  }).catch(() => reportAcquired?.(false))
  const available = await acquired
  return { acquired: available, release: () => { releaseHold?.(); releaseHold = null } }
}

async function acquireBroadcastLease(documentId: string): Promise<DocumentLease> {
  if (typeof BroadcastChannel === 'undefined') return { acquired: true, release: () => undefined }
  const channel = new BroadcastChannel('drawable-document-leases')
  const ownerId = crypto.randomUUID()
  const competingClaims = new Set<string>([ownerId])
  let held = false
  let conflict = false
  channel.onmessage = (event: MessageEvent<LockMessage>) => {
    const message = event.data
    if (message.documentId !== documentId || message.ownerId === ownerId) return
    if (message.type === 'probe' && held) channel.postMessage({ type: 'held', documentId, ownerId } satisfies LockMessage)
    if (message.type === 'held') conflict = true
    if (message.type === 'claim') competingClaims.add(message.ownerId)
  }
  channel.postMessage({ type: 'probe', documentId, ownerId } satisfies LockMessage)
  await delay(80)
  if (conflict) {
    channel.close()
    return { acquired: false, release: () => undefined }
  }
  channel.postMessage({ type: 'claim', documentId, ownerId } satisfies LockMessage)
  await delay(50)
  if ([...competingClaims].sort()[0] !== ownerId) {
    channel.close()
    return { acquired: false, release: () => undefined }
  }
  held = true
  return { acquired: true, release: () => { held = false; channel.close() } }
}

export function acquireDocumentLease(documentId: string) {
  return 'locks' in navigator ? acquireNavigatorLease(documentId) : acquireBroadcastLease(documentId)
}
