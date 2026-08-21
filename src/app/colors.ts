// Validated dark-mode categorical palette (adjacent-pair CVD-safe, see the
// dataviz method this project's design pass used) — reused everywhere a
// process needs a consistent identity color: the Gantt chart, the process
// list, ready-queue chips and the RAM grid all call this same function so
// "P3" is always the same aqua everywhere on screen.
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']

export function colorForPid(pid: number): string {
  return PALETTE[(pid - 1) % PALETTE.length]!
}
