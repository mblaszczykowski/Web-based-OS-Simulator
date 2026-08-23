export type SharedSyncTab = 'buffer' | 'ipc' | 'deadlock' | 'banker'
const VALID_SYNC_TABS: readonly SharedSyncTab[] = ['buffer', 'ipc', 'deadlock', 'banker']

export interface SharedSessionState {
  syncTab: SharedSyncTab | null
  raceOn: boolean | null
}

function isSharedSyncTab(value: string | null): value is SharedSyncTab {
  return VALID_SYNC_TABS.includes(value as SharedSyncTab)
}

export function readSharedSessionState(): SharedSessionState {
  const params = new URLSearchParams(window.location.search)
  const syncParam = params.get('sync')
  const raceParam = params.get('race')
  return {
    syncTab: isSharedSyncTab(syncParam) ? syncParam : null,
    raceOn: raceParam === 'on' ? true : raceParam === 'off' ? false : null,
  }
}

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
