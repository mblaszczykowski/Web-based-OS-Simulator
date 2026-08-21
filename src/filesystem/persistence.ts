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
