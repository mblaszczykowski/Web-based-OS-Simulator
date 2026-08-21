// Validated dark-mode categorical palette (adjacent-pair CVD-safe, see the
// dataviz method this project's design pass used) — reused everywhere a
// process needs a consistent identity color: the Gantt chart, the process
// list, ready-queue chips and the RAM grid all call this same function so
// "P3" is always the same aqua everywhere on screen.
//
// All 8 validated slots are used (not just the first 5) because up to
// AUTO_SPAWN_CAP (7) processes can be alive at once, and a `run` command
// can push it higher still — cycling through only 5 would start handing
// two live processes the same color well within normal use.
const PALETTE = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
]

export function colorForPid(pid: number): string {
  return PALETTE[(pid - 1) % PALETTE.length]!
}

// roadmap.md §2.5 — formally verifying the palette's contrast turned up
// one real gap: a fixed dark label color (as every cell/segment/chip that
// renders a "P3"-style label directly on a colorForPid() swatch used to
// do) clears WCAG AA (4.5:1) against 7 of the 8 palette colors but not
// the darker green (#008300, ~4.1:1) — and a fixed light label would fail
// the other 7. Rather than retune the validated categorical palette
// itself (risking its CVD-safety), labels adapt per-swatch: whichever of
// dark/light actually has higher contrast against that specific color.
const DARK_LABEL = '#05070a'
const LIGHT_LABEL = '#f5f7fa'

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}

function contrastRatio(hexA: string, hexB: string): number {
  const [lLight, lDark] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a)
  return (lLight! + 0.05) / (lDark! + 0.05)
}

/** WCAG-contrast-safe label color for text rendered directly on a colorForPid() swatch. */
export function labelColorForPid(pid: number): string {
  const bg = colorForPid(pid)
  return contrastRatio(bg, DARK_LABEL) >= contrastRatio(bg, LIGHT_LABEL) ? DARK_LABEL : LIGHT_LABEL
}
