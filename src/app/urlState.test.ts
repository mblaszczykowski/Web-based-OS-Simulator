// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { readSharedSessionState, writeSharedSessionState } from './urlState'

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('readSharedSessionState', () => {
  it('reads a recognized sync tab and race value from the query string', () => {
    window.history.replaceState(null, '', '/?sync=deadlock&race=on')
    expect(readSharedSessionState()).toEqual({ syncTab: 'deadlock', raceOn: true })
  })

  it('reads race=off as false, not just "unspecified"', () => {
    window.history.replaceState(null, '', '/?race=off')
    expect(readSharedSessionState()).toEqual({ syncTab: null, raceOn: false })
  })

  it('treats an unrecognized or missing value as unspecified (null), never throwing', () => {
    window.history.replaceState(null, '', '/?sync=nonsense&race=maybe')
    expect(readSharedSessionState()).toEqual({ syncTab: null, raceOn: null })

    window.history.replaceState(null, '', '/')
    expect(readSharedSessionState()).toEqual({ syncTab: null, raceOn: null })
  })
})

describe('writeSharedSessionState', () => {
  it('sets query params without touching fields left undefined', () => {
    writeSharedSessionState({ syncTab: 'banker' })
    expect(window.location.search).toBe('?sync=banker')

    writeSharedSessionState({ raceOn: true })
    expect(new URLSearchParams(window.location.search).get('sync')).toBe('banker')
    expect(new URLSearchParams(window.location.search).get('race')).toBe('on')
  })

  it('removes a field from the URL when passed null explicitly', () => {
    writeSharedSessionState({ syncTab: 'deadlock', raceOn: false })
    writeSharedSessionState({ syncTab: null })
    const params = new URLSearchParams(window.location.search)
    expect(params.has('sync')).toBe(false)
    expect(params.get('race')).toBe('off')
  })

  it('uses replaceState, not pushState — round-tripping never grows browser history', () => {
    const before = window.history.length
    writeSharedSessionState({ syncTab: 'buffer' })
    writeSharedSessionState({ syncTab: 'deadlock' })
    writeSharedSessionState({ raceOn: true })
    expect(window.history.length).toBe(before)
  })
})

describe('round-trip', () => {
  it('write then read recovers exactly what was written', () => {
    writeSharedSessionState({ syncTab: 'deadlock', raceOn: true })
    expect(readSharedSessionState()).toEqual({ syncTab: 'deadlock', raceOn: true })
  })
})
