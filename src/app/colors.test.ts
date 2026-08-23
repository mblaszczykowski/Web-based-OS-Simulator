import { describe, expect, it } from 'vitest'
import { colorForPid, labelColorForPid } from './colors'

function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function contrastRatio(hexA: string, hexB: string): number {
  const [lLight, lDark] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a)
  return (lLight! + 0.05) / (lDark! + 0.05)
}

describe('labelColorForPid', () => {
  it('picks a label that clears WCAG AA (4.5:1) against every palette color', () => {
    for (let pid = 1; pid <= 16; pid++) {
      const bg = colorForPid(pid)
      const label = labelColorForPid(pid)
      expect(contrastRatio(bg, label)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('is a pure function of the pid — same pid always yields the same label', () => {
    expect(labelColorForPid(3)).toBe(labelColorForPid(3))
    expect(labelColorForPid(3)).toBe(labelColorForPid(3 + 8))
  })
})
