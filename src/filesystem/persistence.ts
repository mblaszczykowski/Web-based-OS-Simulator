import type { FilesystemState } from './engine'

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
    // IndexedDB unavailable or blocked — the disk just won't persist.
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
    // IndexedDB unavailable or blocked — the disk just won't persist.
  }
}

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

export function announceFilesystemChange(): void {
  getChannel()?.postMessage('changed')
}

export function onExternalFilesystemChange(listener: () => void): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const handler = () => listener()
  ch.addEventListener('message', handler)
  return () => ch.removeEventListener('message', handler)
}
