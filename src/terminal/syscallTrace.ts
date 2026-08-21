// Purely cosmetic mapping from terminal commands to realistic-looking
// (fictional) syscalls — roadmap.md §1.6. No new domain logic: this just
// re-describes what a command already did in libc/kernel-call vocabulary.

let fdCounter = 3
function nextFd(): number {
  const fd = fdCounter
  fdCounter = fdCounter >= 12 ? 3 : fdCounter + 1
  return fd
}

function normalize(path: string | undefined): string {
  if (!path) return '/'
  return path.startsWith('/') ? path : `/${path}`
}

/** Returns the fictional syscall lines a command "made" — called after the command already ran, given whether it succeeded. */
export function syscallTraceFor(input: string, ok: boolean): string[] {
  const [cmd, ...args] = input.trim().split(/\s+/).filter(Boolean)
  const path = normalize(args[0])

  switch (cmd) {
    case 'ps':
      return ['openat(AT_FDCWD, "/proc", O_DIRECTORY) = 3', 'getdents64(3, ...) = N', 'close(3) = 0']

    case 'top':
      return ['sysinfo(&info) = 0']

    case 'run': {
      const name = args.join(' ') || 'proc'
      return ['fork() = <pid>', `execve("/bin/${name}", [...], [...]) = 0`]
    }

    case 'kill':
      return [`kill(${args[0] ?? '?'}, SIGKILL) = ${ok ? '0' : '-1 ESRCH'}`]

    case 'free':
      return ['mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, -1, 0) = 0x7f...', 'sysinfo(&info) = 0']

    case 'ls': {
      const fd = nextFd()
      return [
        `openat(AT_FDCWD, "${path}", O_DIRECTORY) = ${ok ? fd : -1}`,
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
      return [`rename("${path}", "${normalize(args[1])}") = ${ok ? '0' : '-1'}`]

    case 'cp': {
      const fdIn = nextFd()
      const fdOut = nextFd()
      return ok
        ? [
            `open("${path}", O_RDONLY) = ${fdIn}`,
            `open("${normalize(args[1])}", O_CREAT|O_WRONLY, 0644) = ${fdOut}`,
            `sendfile(${fdOut}, ${fdIn}, NULL, N) = N`,
            `close(${fdIn}) = 0`,
            `close(${fdOut}) = 0`,
          ]
        : [`open("${path}", O_RDONLY) = -1`]
    }

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
