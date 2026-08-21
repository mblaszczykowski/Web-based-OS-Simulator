# OS.SIM — Web-based OS Simulator

An interactive, in-browser simulation of an operating system's core subsystems — a **process scheduler, memory manager and filesystem** whose algorithms are real, tested implementations from *Operating System Concepts* (Silberschatz), not decorative animations.

**[Live demo →](#)** _(link goes live once this repo is pushed and Pages is enabled — see [Deployment](#deployment--ci))_

![bundle size (gzip)](https://img.shields.io/badge/bundle_size_(gzip)-~85_kB-blue) ![lighthouse](https://img.shields.io/badge/lighthouse-runs_in_CI-4c1)
_Bundle size is measured straight from the latest `npm run build` (JS + CSS, gzipped) — see [Tech stack](#tech-stack). A Lighthouse audit (performance/accessibility/best-practices/SEO) runs against the production build in `.github/workflows/ci.yml` on every push and is written to the job summary — not a hardcoded badge number, since this repo isn't deployed yet and a stale score would be worse than none._

![screenshot placeholder](docs/screenshot.png)
_(add a screenshot or a ~30s GIF of the desktop here for the README — see plan.md §7)_

## What this is

OS.SIM is not a playground for comparing scheduling algorithms against each other. It's a demonstration of **one well-justified system**, running continuously, that you observe and poke at the way you would a real machine — through a terminal, not a settings panel.

- **Scheduler**: Multi-Level Feedback Queue (MLFQ) — the algorithm real general-purpose kernels approximate, chosen specifically because it adapts to interactive vs. batch workloads without manual tuning. Its window can export the current run's full Gantt history and metrics as a CSV.
- **Memory**: Clock (Second-Chance) page replacement — the cheap, hardware-realistic approximation of LRU that production kernels actually run — plus a First-Fit contiguous allocator shown alongside it purely as a historical reference point. Evicted pages are actually swapped to a `/swap` file on the simulated disk (and read back on the next fault) — the one place two subsystems are wired together directly, coordinated from `app/engines.ts` rather than either engine depending on the other.
- **Filesystem**: a small inode-based filesystem with a write-ahead log, so a simulated crash mid-write can be replayed back to a consistent state on the next `fsck`.
- **Process sync**: a classic bounded-buffer producer/consumer, guarded by a counting semaphore pair and a mutex — the one correct, synchronized mechanism by default. A "show race condition" mode exists purely to demonstrate the bug the mutex prevents, the same before/after narrative as crash → `fsck`. A second tab extends this into **deadlock detection**: a scripted circular-wait scenario (two processes, two resources) drives a real wait-for-graph DFS cycle detector, with a resource-allocation graph and a "break the deadlock" resolution step. A third tab adds **deadlock avoidance** — Banker's Algorithm over Silberschatz's own 5-process/3-resource worked example, running the safety algorithm before granting any request instead of detecting trouble after the fact.
- **Network**: two simulated hosts and a pure packet-flow visualisation — `ping`/`curl` in the terminal launch packets that animate across a fixed link over a few ticks. No real TCP/IP stack or sockets, by design (plan.md §3).

No algorithm picker, no "add process" button. Workload is generated automatically and through the terminal (`run <name>`), the same way you'd interact with a real shell.

Don't know what to type? Click **▶ Watch demo** in the menu bar — it types and runs a scripted tour (`ps` → `run compiler` → `top` → file write/read → a simulated crash + recovery → `kill`) across every subsystem, with a typewriter effect and no manual interaction required.

## Real algorithm, simulated environment

The **environment** is simulated — there is no real hardware, no ring 0/ring 3 isolation, no physical multi-core scheduling or interrupts, and the filesystem lives entirely inside IndexedDB rather than being a mountable POSIX filesystem. See [`plan.md` §3](plan.md#3-czego-projekt-świadomie-nie-symuluje) for the full, explicit list of what's out of scope by design.

The **algorithms** are not. `src/scheduler/engine.ts`, `src/memory/engine.ts` and `src/filesystem/engine.ts` are plain, dependency-free TypeScript with no React or store coupling — each is unit-tested against hand-traced reference scenarios (see `*.test.ts` next to each engine) the way you'd check a textbook example by hand: exact tick-by-tick MLFQ demotion/preemption traces, a classic Second-Chance reference string, and a crash → journal replay round-trip.

## Architecture

```
src/
  scheduler/    MLFQ engine + Gantt chart window        (pure logic + React)
  memory/       Clock paging + First-Fit engine + window
  filesystem/   inode fs + journal/WAL engine + window
  sync/         bounded-buffer producer/consumer + deadlock detection/avoidance, engine + window
  network/      packet-flow visualisation engine + window
  terminal/     command parser, terminal window, syscall trace window
  shared/       cross-module types + a small typed event bus
  app/          desktop shell: store, window manager, menu bar, dock, boot screen
```

Modules only ever talk through the narrow `CommandContext` interface (terminal → engines) and the `EventBus` (engines → anything listening) — the scheduler engine has no idea the terminal exists, and it doesn't know memory exists either. `SchedulerEngine` emits `process:terminated` from the one place a process's state actually flips to `TERMINATED` (`kill()` or a burst running out); `src/app/engines.ts` is just a subscriber that reacts by freeing that process's memory. Spawning (`run` allocates memory as well as scheduling a process) is coordinated the more direct way, one level up in `engines.ts`, since it isn't a state transition an engine owns on its own.

State management is deliberately thin: the Zustand store (`src/app/store.ts`) holds only UI-relevant state (window positions, terminal history, a `version` counter). The simulation engines are plain singleton class instances; components read from them directly on render and re-render whenever `version` changes. This sidesteps the classic "mutated nested state doesn't trigger a re-render" class of bugs that comes from trying to mirror deeply-mutated engine state into a separate reactive snapshot.

## Terminal commands

```
ps                    list processes
top                   live scheduler summary
run <name>            spawn a new process
stress [n]            spawn n (default 6) CPU-bound processes at once
kill <pid>            terminate a process
kill -STOP <pid>      pause a process (SIGSTOP) without terminating it
kill -CONT <pid>      resume a stopped process (SIGCONT)
free                  memory usage summary
cd [dir]              change working directory (no arg -> /)
pwd                   print working directory
ls [-l] [path]        list a directory (default: cwd), supports * wildcards
cat <file>            print a file
write <file> <text>   append text to a file (creates it if missing)
touch <file>          create an empty file (no-op if it already exists)
mkdir <dir>           create a directory
mv <src> <dest>       move/rename a file
cp <src> <dest>       copy a file
ln <target> <link>    create a hard link (shares content with target)
chmod <mode> <file>   set permissions (1-3 octal digits, e.g. 644 or 6)
rm <file>             delete a file, supports * wildcards
crash                 simulate a power loss mid-write
fsck                  replay the journal and recover the filesystem
reset-fs              wipe the disk (in memory and the persisted copy)
sync                  bounded-buffer producer/consumer status
race on|off           toggle the unsynchronized (racy) demo mode
ping [host]           send simulated ICMP echo packets to a host
curl [host]           simulate one HTTP request/response round trip
clear                 clear the screen
help                  show this message
```

Paths are relative to the current directory unless they start with `/`. Commands chain with `;` (always run the next), `&&` (only on success), and pipe through `|` (only `grep <pattern>` is a supported filter) — e.g. `ls | grep .log` or `mkdir /tmp && write /tmp/x.txt hi`. This is composition of existing commands, not a real shell scripting language (no variables, loops, or conditionals).

Every command also appends a line to the **syscall trace** window — a fictional but realistic `open()`/`read()`/`execve()`-style log, purely for flavour (no new domain logic — it's just a relabeling of what the command already did).

Tab-completes commands and filesystem paths (relative to the current directory), and persists command history to `localStorage` across reloads — one of a small set of pieces of state that are *not* wiped on refresh (see [Model trwałości](plan.md#25-model-trwałości-i-restart) and "State & robustness" below).

## Tech stack

React + TypeScript, Zustand, Vite, Vitest (+ React Testing Library/jsdom for component tests) — no D3/Recharts, no backend. All visualisations (Gantt chart, RAM/disk grids, allocation strip) are hand-built CSS/flex/grid. The filesystem's "disk" persists across reloads via IndexedDB — scheduler and memory still reset on refresh, deliberately (see `plan.md` §2.5).

`npm run build`'s current output is the whole app in one JS chunk + one CSS file: **261.58 kB JS / 80.28 kB gzipped**, **20.48 kB CSS / 4.35 kB gzipped** — no charting library, no UI framework, no icon font is why that number stays small as the simulator grows (roadmap-v4.md §2.5). Re-run `npm run build` yourself to see the current number for the actual code in this tree.

## State & robustness

- **Window layout** (position/size/open/z-order) persists to `localStorage`, debounced on every drag/resize/focus — the same medium as terminal history, since it's UI chrome, not simulated system state.
- **Cross-tab consistency**: opening the app in two tabs no longer means one silently overwrites the other's disk on the next save. Tabs announce a successful filesystem save over a `BroadcastChannel`; on hearing another tab's announcement, a tab cancels its own pending save and re-hydrates from the newer persisted state, logging it to the terminal so the reconciliation is visible. Best-effort, not full multi-tab consistency — memory/scheduler state stays tab-local by design.
- **Small screens**: the desktop metaphor (overlapping draggable windows) has nowhere sensible to degrade to on a phone. Below ~860px wide, a small feature-detected notice replaces the boot sequence and desktop entirely, rather than a horizontally-clipped layout.
- **Hard links, permissions**: `Inode.links` and a real rwx mode bit are actually enforced — `rm` only frees a file's blocks once every hard-linked name pointing at it is gone, and `write`/`rm`/`cat`/`cp` reject a file missing the relevant permission bit, not just cosmetically.

## Accessibility

A skip link, a screen-reader-announced terminal (`aria-live`), a per-window Tab focus trap, keyboard-movable/resizable windows (focus a titlebar, then use arrow keys), and labeled controls throughout. The color palette's contrast was formally verified against WCAG AA — that check found and fixed two real gaps: `--text-muted` was ~2.9:1 against panel backgrounds (needs 4.5:1), and one categorical PID color failed against a fixed dark label, so cell/segment labels now pick whichever of a dark/light label actually has higher contrast against that specific swatch (see `src/app/colors.ts`).

## Getting started

```bash
npm install
npm run dev        # start the dev server
npm test           # engine unit/property tests + React component tests
npm run test:e2e     # Playwright smoke test against a real Chromium, on the production build
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run build        # production build to dist/
```

`npm test`'s jsdom component tests cover interaction logic; `npm run test:e2e` (Playwright, `e2e/smoke.spec.ts`) exists specifically for what jsdom can't — a real pointer-drag on a window, real layout, a full boot → desktop → terminal round trip against the actual built `dist/`. First run needs browser binaries: `npx playwright install chromium`.

## Deployment & CI

`.github/workflows/ci.yml` runs lint, typecheck, tests, a production build, the Playwright smoke test against that build, and a Lighthouse audit (performance/accessibility/best-practices/SEO against the built `dist/`, served locally in the CI job — written to the run's job summary, and the raw JSON report uploaded as a build artifact) on every push/PR, and deploys `dist/` to GitHub Pages on every push to `main`. To enable it on your fork: push this repo to GitHub, then turn on **Settings → Pages → Source: GitHub Actions**.

## License

MIT — see [LICENSE](LICENSE).
