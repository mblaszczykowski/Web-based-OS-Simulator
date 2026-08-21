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
