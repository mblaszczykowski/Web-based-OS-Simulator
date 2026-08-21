// Purely cosmetic mapping from terminal commands to realistic-looking
// (fictional) syscalls — roadmap.md §1.6. No new domain logic: this just
// re-describes what a command already did in libc/kernel-call vocabulary.

import { resolvePath } from './commands'

let fdCounter = 3
function nextFd(): number {
  const fd = fdCounter
  fdCounter = fdCounter >= 12 ? 3 : fdCounter + 1
  return fd
}

/**
 * Returns the fictional syscall lines a command "made" — called after the
 * command already ran, given whether it succeeded and the cwd it ran in
 * (roadmap-v3.md §1.1 made paths cwd-relative, so the trace has to resolve
 * them the same way to show the real absolute path).
 */
export function syscallTraceFor(input: string, ok: boolean, cwd: string): string[] {
  const [cmd, ...args] = input.trim().split(/\s+/).filter(Boolean)
  const path = resolvePath(cwd, args[0])

  switch (cmd) {
    case 'ps':
      return ['openat(AT_FDCWD, "/proc", O_DIRECTORY) = 3', 'getdents64(3, ...) = N', 'close(3) = 0']

    case 'top':
      return ['sysinfo(&info) = 0']

    case 'run': {
      const name = args.join(' ') || 'proc'
      return ['fork() = <pid>', `execve("/bin/${name}", [...], [...]) = 0`]
    }

    case 'stress': {
      // Real forks/execs are actually happening here too — this had no
      // case at all before (found by code review), so `stress` silently
      // produced zero trace lines despite spawning several processes,
      // unlike every other spawning command.
      const count = args[0] ?? '6'
      return [`fork() = <pid> (x${count})`, `execve("/bin/proc", [...], [...]) = 0 (x${count})`]
    }

    case 'kill': {
      if (args[0] === '-STOP' || args[0] === '-CONT') {
        const signal = args[0] === '-STOP' ? 'SIGSTOP' : 'SIGCONT'
        return [`kill(${args[1] ?? '?'}, ${signal}) = ${ok ? '0' : '-1 ESRCH'}`]
      }
      return [`kill(${args[0] ?? '?'}, SIGKILL) = ${ok ? '0' : '-1 ESRCH'}`]
    }

    case 'free':
      return ['mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, -1, 0) = 0x7f...', 'sysinfo(&info) = 0']

    case 'cd':
      return [`chdir("${path}") = ${ok ? '0' : '-1 ENOENT'}`]

    case 'pwd':
      return [`getcwd(buf, 4096) = "${cwd}"`]

    case 'ls': {
      const fd = nextFd()
      // args[0] can be `-l` — the generic `path` above (built from args[0]
      // unconditionally) would resolve that flag as if it were a
      // filename, so this recomputes it from the first non-flag argument.
      const lsPath = resolvePath(cwd, args.find((a) => a !== '-l'))
      return [
        `openat(AT_FDCWD, "${lsPath}", O_DIRECTORY) = ${ok ? fd : -1}`,
        ...(ok ? [`getdents64(${fd}, ...) = N`, `close(${fd}) = 0`] : []),
      ]
    }

    case 'cat': {
      const fd = nextFd()
      return [
        `open("${path}", O_RDONLY) = ${ok ? fd : -1}`,
        ...(ok ? [`read(${fd}, buf, 4096) = N`, `close(${fd}) = 0`] : []),
      ]
    }

    case 'write': {
      const fd = nextFd()
      return [
        `open("${path}", O_CREAT|O_WRONLY|O_APPEND, 0644) = ${ok ? fd : -1}`,
        ...(ok ? [`write(${fd}, buf, N) = N`, `close(${fd}) = 0`] : []),
      ]
    }

    case 'touch': {
      const fd = nextFd()
      return [`open("${path}", O_CREAT|O_WRONLY, 0644) = ${ok ? fd : -1}`, ...(ok ? [`close(${fd}) = 0`] : [])]
    }

    case 'mkdir':
      return [`mkdir("${path}", 0755) = ${ok ? '0' : '-1'}`]

    case 'mv':
      return [`rename("${path}", "${resolvePath(cwd, args[1])}") = ${ok ? '0' : '-1'}`]

    case 'cp': {
      const fdIn = nextFd()
      const fdOut = nextFd()
      return ok
        ? [
            `open("${path}", O_RDONLY) = ${fdIn}`,
            `open("${resolvePath(cwd, args[1])}", O_CREAT|O_WRONLY, 0644) = ${fdOut}`,
            `sendfile(${fdOut}, ${fdIn}, NULL, N) = N`,
            `close(${fdIn}) = 0`,
            `close(${fdOut}) = 0`,
          ]
        : [`open("${path}", O_RDONLY) = -1`]
    }

    case 'ln':
      return [`link("${path}", "${resolvePath(cwd, args[1])}") = ${ok ? '0' : '-1'}`]

    case 'chmod':
      // args[0] here is the MODE, not a path — the generic `path` above is meaningless for this command.
      return [`chmod("${resolvePath(cwd, args[1])}", 0${args[0] ?? '?'}) = ${ok ? '0' : '-1'}`]

    case 'rm':
      return [`unlink("${path}") = ${ok ? '0' : '-1'}`]

    case 'crash':
      return ['[SIMULATED POWER LOSS] exit_group(-1)']

    case 'fsck':
      return ['ioctl(fd, FS_IOC_FSCK) = 0']

    default:
      return []
  }
}
