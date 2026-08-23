const PALETTE = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
]

export function colorForPid(pid: number): string {
  return PALETTE[(pid - 1) % PALETTE.length]!
}

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

const LABEL_BY_PALETTE_INDEX = PALETTE.map((bg) =>
  contrastRatio(bg, DARK_LABEL) >= contrastRatio(bg, LIGHT_LABEL) ? DARK_LABEL : LIGHT_LABEL,
)

export function labelColorForPid(pid: number): string {
  return LABEL_BY_PALETTE_INDEX[(pid - 1) % PALETTE.length]!
}
