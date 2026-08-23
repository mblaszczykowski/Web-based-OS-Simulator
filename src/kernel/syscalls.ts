import { SHELL_PID } from '../shared/types'
import type { CommandContext } from '../terminal/commands'
import { FdTable } from './fdTable'

export interface SyscallTrace {
  ctx: CommandContext
  drain(): string[]
}

const FIRST_SOCKET_FD = 3

function quote(value: string): string {
  return `"${value}"`
}

function argv(name: string): string {
  return `[${quote(name)}, ...], [...]`
}

/**
 * Records every crossing of CommandContext as the call it really is.
 * getCwd/getEnv/listEnv are not recorded: they are shell-local state, and
 * resolving a relative path costs no syscall.
 */
export function traceSyscalls(ctx: CommandContext, fdTable: FdTable): SyscallTrace {
  const lines: string[] = []
  const emit = (...entries: string[]) => lines.push(...entries)

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
      withFd('/proc', 'openat(AT_FDCWD, "/proc", O_DIRECTORY)', (fd) => [`getdents64(${fd}, ...) = ${processes.length}`])
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
      // pipe2() returns both descriptors to the caller, so they come from the
      // shell's table; each child would otherwise number its single end 3.
      const readEnd = fdTable.open(SHELL_PID, 'pipe-read', `pipe:[${reader.pid}]`)
      const writeEnd = fdTable.open(SHELL_PID, 'pipe-write', `pipe:[${writer.pid}]`)
      emit(
        `pipe2([${readEnd}, ${writeEnd}], 0) = 0`,
        `fork() = ${writer.pid}`,
        `execve("/bin/${writer.name}", ${argv(writer.name)}) = 0`,
        `fork() = ${reader.pid}`,
        `execve("/bin/${reader.name}", ${argv(reader.name)}) = 0`,
        `close(${readEnd}) = 0`,
        `close(${writeEnd}) = 0`,
      )
      fdTable.close(SHELL_PID, readEnd)
      fdTable.close(SHELL_PID, writeEnd)
      return [writer, reader]
    },

    forkProcess: (pid) => {
      const child = ctx.forkProcess(pid)
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
        openFailed(call, result.error.includes('Permission denied') ? 'EACCES' : 'ENOENT')
        return result
      }
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
