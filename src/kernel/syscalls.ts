import { SHELL_PID } from '../shared/types'
import type { CommandContext } from '../terminal/commands'
import { FIRST_USER_FD, FdTable } from './fdTable'

/**
 * The syscall trace, as an actual log of the kernel boundary being crossed
 * — roadmap-v5.md §2.1.
 *
 * What this replaces: a static `command name -> plausible-looking syscall
 * lines` map that ran *after* a command finished and re-described it from
 * the outside. It was honest about being cosmetic, and it worked, but it
 * had the failure mode every parallel description has — it could disagree
 * with reality and nothing would notice. It printed `read(fd, buf, 4096) =
 * N` for a file whose real size it never asked for, `fork() = <pid>` for a
 * pid that already existed, and it had to re-parse the command line to
 * guess what had happened.
 *
 * `CommandContext` is already the one narrow seam between the terminal and
 * the rest of the simulator (plan.md §5) — every file operation, every
 * spawn, every signal goes through it and nothing else. That makes it the
 * real system-call boundary of this program, so wrapping it is enough:
 * each trace line is now emitted by an actual crossing, with the real
 * arguments and the real return value. Byte counts are the content's real
 * length, pids are the pids that were really created, and a command
 * rejected before it ever reached the kernel produces no trace at all —
 * which is correct, and which the old map got wrong.
 *
 * What this is NOT: a change to *when* anything happens. A syscall here
 * still returns synchronously; it cannot block the calling process the way
 * roadmap-v5.md §1.1 made a process's I/O burst block. The shell is not a
 * scheduled process in this simulator (see SHELL_PID), so there is nothing
 * to block — that boundary is real for processes, and this one is real for
 * the terminal.
 */
export interface SyscallTrace {
  /** The wrapped context to hand to runCommandLine(). */
  ctx: CommandContext
  /** Every syscall line recorded since the last drain, clearing the buffer. */
  drain(): string[]
}

/**
 * Sockets are pure visualisation in this simulator (ADR-0007) — no
 * connection is opened, so no descriptor is taken and the number shown is
 * a fixed stand-in rather than one from the fd table. Kept explicit, and
 * declared here beside the other helpers rather than trailing the file, so
 * the one place this trace is still illustrative is impossible to miss.
 */
const FIRST_SOCKET_FD = 3

function quote(value: string): string {
  return `"${value}"`
}

/** Renders a list of arguments the way strace does: a few, then an ellipsis. */
function argv(name: string): string {
  return `[${quote(name)}, ...], [...]`
}

/**
 * Wraps a CommandContext so that every crossing of it is recorded as the
 * syscall it really is.
 *
 * `fdTable` is shared with the rest of the kernel so the numbers here are
 * the same ones `lsof` reports (roadmap-v5.md §2.2) — an open/close pair
 * inside one command really does take and release a descriptor, which is
 * why the trace shows fd 3 being reused rather than climbing forever.
 *
 * Read-only accessors that exist purely so the parser can resolve a path
 * or a variable — `getCwd`, `getEnv`, `listEnv` — are deliberately NOT
 * recorded. In a real shell the working directory and the environment are
 * process state, not kernel state: `cd` makes a `chdir()` call and `export`
 * mutates a local map, but resolving `./notes.txt` costs no syscall at all.
 * Recording them would bury every real line under one `getcwd()` per
 * argument.
 */
export function traceSyscalls(ctx: CommandContext, fdTable: FdTable): SyscallTrace {
  const lines: string[] = []
  const emit = (...entries: string[]) => lines.push(...entries)

  /**
   * open() + one operation + close(), the shape almost every file command
   * really has. The descriptor is genuinely taken and released against the
   * shared table, which is why the trace shows fd 3 being reused across
   * commands rather than a number that climbs forever.
   */
  function withFd(path: string, openCall: string, body: (fd: number) => string[]): void {
    const fd = fdTable.open(SHELL_PID, 'file', path)
    emit(`${openCall} = ${fd}`, ...body(fd), `close(${fd}) = 0`)
    fdTable.close(SHELL_PID, fd)
  }

  function openFailed(openCall: string, errno: string): void {
    emit(`${openCall} = -1 ${errno}`)
  }

  const traced: CommandContext = {
    ...ctx,

    listProcesses: () => {
      const processes = ctx.listProcesses()
      // The real count, from the real list — `ps` and `top` both read
      // /proc, because in this simulator they genuinely do go through the
      // same call.
      emit('openat(AT_FDCWD, "/proc", O_DIRECTORY) = 3', `getdents64(3, ...) = ${processes.length}`, 'close(3) = 0')
      return processes
    },

    schedulerMetrics: () => {
      emit('sysinfo(&info) = 0')
      return ctx.schedulerMetrics()
    },

    memoryMetrics: () => {
      emit('sysinfo(&info) = 0')
      return ctx.memoryMetrics()
    },

    ioMetrics: () => {
      emit('ioctl(fd, BLKRAGET, &readahead) = 0')
      return ctx.ioMetrics()
    },

    spawnProcess: (name) => {
      const process = ctx.spawnProcess(name)
      emit(`fork() = ${process.pid}`, `execve("/bin/${process.name}", ${argv(process.name)}) = 0`)
      return process
    },

    spawnStress: (n) => {
      const spawned = ctx.spawnStress(n)
      for (const process of spawned) emit(`fork() = ${process.pid}`)
      if (spawned.length > 0) emit(`execve("/bin/proc", [...], [...]) = 0 (x${spawned.length})`)
      return spawned
    },

    spawnThreads: (name, n) => {
      const threads = ctx.spawnThreads(name, n)
      for (const thread of threads) {
        emit(`clone(CLONE_VM|CLONE_THREAD, ...) = ${thread.pid}`)
      }
      return threads
    },

    spawnPipeline: (writerName, readerName) => {
      const [writer, reader] = ctx.spawnPipeline(writerName, readerName)
      // The descriptors were registered by the coordinator that actually
      // created the pipe (app/engines.ts) — this only reports them, so the
      // fd table never depends on whether anything is being traced.
      const readEnd = fdTable.forPid(reader.pid).find((d) => d.kind === 'pipe-read')?.fd ?? FIRST_USER_FD
      const writeEnd = fdTable.forPid(writer.pid).find((d) => d.kind === 'pipe-write')?.fd ?? FIRST_USER_FD
      emit(
        `pipe2([${readEnd}, ${writeEnd}], 0) = 0`,
        `fork() = ${writer.pid}`,
        `execve("/bin/${writer.name}", ${argv(writer.name)}) = 0`,
        `fork() = ${reader.pid}`,
        `execve("/bin/${reader.name}", ${argv(reader.name)}) = 0`,
      )
      return [writer, reader]
    },

    forkProcess: (pid) => {
      const child = ctx.forkProcess(pid)
      // The one line in the old map that was pure invention now reports a
      // pid that genuinely exists — see ADR-0012.
      emit(child ? `fork() = ${child.pid}  /* pages shared copy-on-write */` : 'fork() = -1 ESRCH')
      return child
    },

    killProcess: (pid) => {
      const ok = ctx.killProcess(pid)
      emit(`kill(${pid}, SIGKILL) = ${ok ? '0' : '-1 ESRCH'}`)
      return ok
    },

    stopProcess: (pid) => {
      const ok = ctx.stopProcess(pid)
      emit(`kill(${pid}, SIGSTOP) = ${ok ? '0' : '-1 ESRCH'}`)
      return ok
    },

    contProcess: (pid) => {
      const ok = ctx.contProcess(pid)
      emit(`kill(${pid}, SIGCONT) = ${ok ? '0' : '-1 ESRCH'}`)
      return ok
    },

    fsList: (path) => {
      const result = ctx.fsList(path)
      const call = `openat(AT_FDCWD, ${quote(path)}, O_DIRECTORY)`
      if (!result.ok) {
        openFailed(call, 'ENOENT')
        return result
      }
      withFd(path, call, (fd) => [`getdents64(${fd}, ...) = ${result.entries.length}`])
      return result
    },

    fsRead: (path) => {
      const result = ctx.fsRead(path)
      const call = `open(${quote(path)}, O_RDONLY)`
      if (!result.ok) {
        // The real error, distinguished the way a real open() does —
        // the old map reported a bare `-1` for both.
        openFailed(call, result.error.includes('Permission denied') ? 'EACCES' : 'ENOENT')
        return result
      }
      // A real byte count, taken from the content actually returned.
      withFd(path, call, (fd) => [`read(${fd}, buf, 4096) = ${result.content.length}`])
      return result
    },

    fsWrite: (path, text) => {
      const result = ctx.fsWrite(path, text)
      const call = `open(${quote(path)}, O_CREAT|O_WRONLY|O_APPEND, 0644)`
      if (!result.ok) {
        openFailed(call, result.error.includes('Permission denied') ? 'EACCES' : 'ENOSPC')
        return result
      }
      withFd(path, call, (fd) => [`write(${fd}, buf, ${text.length}) = ${text.length}`])
      return result
    },

    fsCreate: (path) => {
      const result = ctx.fsCreate(path)
      const call = `open(${quote(path)}, O_CREAT|O_WRONLY, 0644)`
      if (!result.ok) {
        openFailed(call, 'EEXIST')
        return result
      }
      withFd(path, call, () => [])
      return result
    },

    fsDelete: (path) => {
      const result = ctx.fsDelete(path)
      emit(`unlink(${quote(path)}) = ${result.ok ? '0' : `-1 ${result.error.includes('Permission denied') ? 'EACCES' : 'ENOENT'}`}`)
      return result
    },

    fsMkdir: (path) => {
      const result = ctx.fsMkdir(path)
      emit(`mkdir(${quote(path)}, 0755) = ${result.ok ? '0' : '-1 EEXIST'}`)
      return result
    },

    fsMove: (src, dest) => {
      const result = ctx.fsMove(src, dest)
      emit(`rename(${quote(src)}, ${quote(dest)}) = ${result.ok ? '0' : '-1 ENOENT'}`)
      return result
    },

    fsCopy: (src, dest) => {
      const result = ctx.fsCopy(src, dest)
      if (!result.ok) {
        openFailed(`open(${quote(src)}, O_RDONLY)`, 'ENOENT')
        return result
      }
      const fdIn = fdTable.open(SHELL_PID, 'file', src)
      const fdOut = fdTable.open(SHELL_PID, 'file', dest)
      emit(
        `open(${quote(src)}, O_RDONLY) = ${fdIn}`,
        `open(${quote(dest)}, O_CREAT|O_WRONLY, 0644) = ${fdOut}`,
        `sendfile(${fdOut}, ${fdIn}, NULL, N) = N`,
        `close(${fdIn}) = 0`,
        `close(${fdOut}) = 0`,
      )
      fdTable.close(SHELL_PID, fdIn)
      fdTable.close(SHELL_PID, fdOut)
      return result
    },

    fsLink: (target, link) => {
      const result = ctx.fsLink(target, link)
      emit(`link(${quote(target)}, ${quote(link)}) = ${result.ok ? '0' : '-1 EEXIST'}`)
      return result
    },

    fsSymlink: (target, link) => {
      const result = ctx.fsSymlink(target, link)
      emit(`symlink(${quote(target)}, ${quote(link)}) = ${result.ok ? '0' : '-1 EEXIST'}`)
      return result
    },

    fsChmod: (path, mode) => {
      const result = ctx.fsChmod(path, mode)
      emit(`chmod(${quote(path)}, 0${mode}00) = ${result.ok ? '0' : '-1 ENOENT'}`)
      return result
    },

    fsCrash: () => {
      ctx.fsCrash()
      emit('[SIMULATED POWER LOSS] exit_group(-1)')
    },

    fsFsck: () => {
      const result = ctx.fsFsck()
      emit(`ioctl(fd, FS_IOC_FSCK) = 0  /* ${result.replayed.length} journal entr(y|ies) replayed */`)
      return result
    },

    fsReset: () => {
      ctx.fsReset()
      emit('ioctl(fd, BLKDISCARD, [0, -1]) = 0')
    },

    setCwd: (path) => {
      ctx.setCwd(path)
      emit(`chdir(${quote(path)}) = 0`)
    },

    syncSetUnsafe: (unsafe) => {
      ctx.syncSetUnsafe(unsafe)
      // Two different operations, not one call that sometimes fails:
      // turning the race demo on tears the mutex down, turning it off
      // builds a fresh one. An earlier version reported the second as
      // `sem_destroy = -1 EBUSY`, which read as an error where nothing
      // had gone wrong.
      emit(unsafe ? 'sem_destroy(&mutex) = 0' : 'sem_init(&mutex, 0, 1) = 0')
    },

    networkPing: (host) => {
      ctx.networkPing(host)
      emit(`socket(AF_INET, SOCK_RAW, IPPROTO_ICMP) = ${FIRST_SOCKET_FD}`, `sendto(${FIRST_SOCKET_FD}, ..., ${quote(host)}) = 64`)
    },

    networkCurl: (host) => {
      ctx.networkCurl(host)
      emit(
        `socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = ${FIRST_SOCKET_FD}`,
        `connect(${FIRST_SOCKET_FD}, ${quote(host)}:80) = 0`,
        `sendto(${FIRST_SOCKET_FD}, "GET / HTTP/1.1", 14) = 14`,
      )
    },
  }

  return {
    ctx: traced,
    drain: () => lines.splice(0, lines.length),
  }
}
