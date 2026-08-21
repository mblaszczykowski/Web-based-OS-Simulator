import type { FilesystemState } from './engine'

// Real filesystem persistence — roadmap.md §1.5. Deliberately the *only*
// engine that persists: scheduler and memory still reset on every reload
// (plan.md §2.5, unchanged by this). All I/O here is best-effort — a
// failure (quota, private browsing, an old browser, corrupt data) falls
// back to a fresh empty disk rather than breaking the app; see
// hydrateAndBootstrap() in app/engines.ts for that fallback.

const DB_NAME = 'os-sim'
const DB_VERSION = 1
const STORE_NAME = 'filesystem'
const RECORD_KEY = 'disk'

function isSupported(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error as Error)
  })
}

export async function loadFilesystemState(): Promise<FilesystemState | null> {
  if (!isSupported()) return null
  try {
    const db = await openDb()
    const state = await new Promise<FilesystemState | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(RECORD_KEY)
      request.onsuccess = () => resolve((request.result as FilesystemState | undefined) ?? null)
      request.onerror = () => reject(request.error as Error)
    })
    db.close()
    return state
  } catch {
    return null
  }
}

export async function saveFilesystemState(state: FilesystemState): Promise<void> {
  if (!isSupported()) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(state, RECORD_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error as Error)
    })
    db.close()
  } catch {
    // best-effort — see file header
  }
}

export async function clearFilesystemState(): Promise<void> {
  if (!isSupported()) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(RECORD_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error as Error)
    })
    db.close()
  } catch {
    // best-effort — see file header
  }
}

// Cross-tab consistency (roadmap-v3.md §2.5): opening this app in two tabs
// means two independent FilesystemEngine instances, each unaware of the
// other, both writing to the same IndexedDB record. Without this, the last
// tab to save always silently wins and the other's edits vanish. A
// BroadcastChannel lets every tab announce "I just persisted a change";
// app/engines.ts reacts by re-hydrating its live engine from the new
// record — the simpler of the two options the roadmap calls out (the other
// being a "disk changed elsewhere" warning), chosen to keep this a
// same-page correctness fix rather than new UI surface. It's still
// best-effort: a save already in flight when another tab's change arrives
// can't be cancelled, so a narrow last-write-wins window remains — the
// same category of limitation ADR-0005 accepts for crash recovery.
const CHANNEL_NAME = 'os-sim-filesystem'

function hasBroadcastChannel(): boolean {
  return typeof BroadcastChannel !== 'undefined'
}

let channel: BroadcastChannel | null = null
function getChannel(): BroadcastChannel | null {
  if (!hasBroadcastChannel()) return null
  channel ??= new BroadcastChannel(CHANNEL_NAME)
  return channel
}

/** Tell other tabs the persisted disk just changed — call once a save has actually landed in IndexedDB. */
export function announceFilesystemChange(): void {
  getChannel()?.postMessage('changed')
}

/**
 * Subscribe to *other* tabs announcing a change (a BroadcastChannel never
 * delivers a tab's own postMessage back to itself, so this can't fire from
 * this tab's own saves). Returns an unsubscribe function; a no-op one if
 * BroadcastChannel isn't available (older browsers, some test/SSR
 * environments) — that tab just doesn't get cross-tab updates, same
 * graceful-degradation posture as the rest of this file.
 */
export function onExternalFilesystemChange(listener: () => void): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const handler = () => listener()
  ch.addEventListener('message', handler)
  return () => ch.removeEventListener('message', handler)
}
