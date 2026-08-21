# OS.SIM — Web-based OS Simulator

An interactive, in-browser simulation of an operating system's core subsystems — a **process scheduler, memory manager and filesystem** whose algorithms are real, tested implementations from *Operating System Concepts* (Silberschatz), not decorative animations.

**[Live demo →](#)** _(link goes live once this repo is pushed and Pages is enabled — see [Deployment](#deployment--ci))_

![screenshot placeholder](docs/screenshot.png)
_(add a screenshot or a ~30s GIF of the desktop here for the README — see plan.md §7)_

## What this is

OS.SIM is not a playground for comparing scheduling algorithms against each other. It's a demonstration of **one well-justified system**, running continuously, that you observe and poke at the way you would a real machine — through a terminal, not a settings panel.

- **Scheduler**: Multi-Level Feedback Queue (MLFQ) — the algorithm real general-purpose kernels approximate, chosen specifically because it adapts to interactive vs. batch workloads without manual tuning.
- **Memory**: Clock (Second-Chance) page replacement — the cheap, hardware-realistic approximation of LRU that production kernels actually run — plus a First-Fit contiguous allocator shown alongside it purely as a historical reference point.
- **Filesystem**: a small inode-based filesystem with a write-ahead log, so a simulated crash mid-write can be replayed back to a consistent state on the next `fsck`.
- **Process sync**: a classic bounded-buffer producer/consumer, guarded by a counting semaphore pair and a mutex — the one correct, synchronized mechanism by default. A "show race condition" mode exists purely to demonstrate the bug the mutex prevents, the same before/after narrative as crash → `fsck`.

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
  sync/         bounded-buffer producer/consumer engine + window
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
kill <pid>            terminate a process
free                  memory usage summary
ls [path]             list a directory (default /), supports * wildcards
cat <file>            print a file
write <file> <text>   append text to a file (creates it if missing)
touch <file>          create an empty file (no-op if it already exists)
mkdir <dir>           create a directory
mv <src> <dest>       move/rename a file
cp <src> <dest>       copy a file
rm <file>             delete a file, supports * wildcards
crash                 simulate a power loss mid-write
fsck                  replay the journal and recover the filesystem
sync                  bounded-buffer producer/consumer status
race on|off           toggle the unsynchronized (racy) demo mode
clear                 clear the screen
help                  show this message
```

Every command also appends a line to the **syscall trace** window — a fictional but realistic `open()`/`read()`/`execve()`-style log, purely for flavour (no new domain logic — it's just a relabeling of what the command already did).

Tab-completes commands and filesystem paths, and persists command history to `localStorage` across reloads — the one piece of state that's *not* wiped on refresh (see [Model trwałości](plan.md#25-model-trwałości-i-restart)).

## Tech stack

React + TypeScript, Zustand, Vite, Vitest — no D3/Recharts, no backend. All visualisations (Gantt chart, RAM/disk grids, allocation strip) are hand-built CSS/flex/grid. The filesystem's "disk" persists across reloads via IndexedDB — scheduler and memory still reset on refresh, deliberately (see `plan.md` §2.5).

## Getting started

```bash
npm install
npm run dev        # start the dev server
npm test           # run the engine unit tests
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run build        # production build to dist/
```

## Deployment & CI

`.github/workflows/ci.yml` runs lint, typecheck, tests and a production build on every push/PR, and deploys `dist/` to GitHub Pages on every push to `main`. To enable it on your fork: push this repo to GitHub, then turn on **Settings → Pages → Source: GitHub Actions**.

## License

MIT — see [LICENSE](LICENSE).
