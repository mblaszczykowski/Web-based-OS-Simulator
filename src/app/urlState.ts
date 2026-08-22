// Shareable session link (roadmap-v4.md §3.1) — front-end only, no backend
// (ADR-0003): the query string is the whole mechanism, read once at boot
// and kept in sync via history.replaceState() (never pushState — clicking
// a sync tab or toggling race mode is not a "new page", it shouldn't grow
// the browser back-button history).
//
// Deliberately a small, modest slice of "the session", not a general
// state-serialization framework: which SyncWindow tab is showing, and
// whether the unsafe/"race condition" demo mode is on. Both are plain
// enums/booleans a future engine rewrite is very unlikely to invalidate —
// unlike, say, a literal snapshot of the scheduler's current process list
// and tick count, which would need to be re-versioned every time
// scheduler/engine.ts's Process shape changes. Window layout is
// deliberately NOT part of this — it already persists via localStorage
// (see store.ts) as UI chrome, not "the session" someone would want to
// send a link to.

export type SharedSyncTab = 'buffer' | 'deadlock' | 'banker'
const VALID_SYNC_TABS: readonly SharedSyncTab[] = ['buffer', 'deadlock', 'banker']

export interface SharedSessionState {
  /** Which SyncWindow tab to open with, or null if the URL doesn't specify one (or specifies something unrecognized). */
  syncTab: SharedSyncTab | null
  /** Whether to boot straight into the unsafe/race-condition sync demo, or null if unspecified. */
  raceOn: boolean | null
}

function isSharedSyncTab(value: string | null): value is SharedSyncTab {
  return VALID_SYNC_TABS.includes(value as SharedSyncTab)
}

/** Reads whatever slice of shared session state the current URL's query string encodes. Never throws — a malformed/foreign query string just reads back as "unspecified" for that field. */
export function readSharedSessionState(): SharedSessionState {
  const params = new URLSearchParams(window.location.search)
  const syncParam = params.get('sync')
  const raceParam = params.get('race')
  return {
    syncTab: isSharedSyncTab(syncParam) ? syncParam : null,
    raceOn: raceParam === 'on' ? true : raceParam === 'off' ? false : null,
  }
}

/**
 * Updates the URL's query string to reflect a change to shared session
 * state, via replaceState — never triggers a navigation or a reload.
 * `undefined` fields are left untouched; pass `null` explicitly to remove
 * a field from the URL instead.
 */
export function writeSharedSessionState(state: { syncTab?: SharedSyncTab | null; raceOn?: boolean | null }): void {
  const url = new URL(window.location.href)
  if (state.syncTab !== undefined) {
    if (state.syncTab === null) url.searchParams.delete('sync')
    else url.searchParams.set('sync', state.syncTab)
  }
  if (state.raceOn !== undefined) {
    if (state.raceOn === null) url.searchParams.delete('race')
    else url.searchParams.set('race', state.raceOn ? 'on' : 'off')
  }
  window.history.replaceState(null, '', url)
}
