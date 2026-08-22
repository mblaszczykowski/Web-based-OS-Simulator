/**
 * Per-process open file descriptors — roadmap-v5.md §2.2.
 *
 * Every live process implicitly owns fds 0/1/2 (stdin/stdout/stderr);
 * those are synthesised on read rather than stored, since nothing in this
 * simulator can close or redirect them. Only descriptors a process really
 * acquired are tracked here: the two ends of a pipe (roadmap-v5.md §1.2),
 * and the short-lived ones the shell opens and closes inside a single
 * command (see kernel/syscalls.ts).
 *
 * Deliberately kernel-side rather than a field on Process: a descriptor
 * table is exactly the kind of state a kernel keeps *about* a process, and
 * putting it here keeps SchedulerEngine — which is the thing being taught
 * — free of bookkeeping that has nothing to do with scheduling.
 */

export type FdKind = 'file' | 'pipe-read' | 'pipe-write'

export interface FileDescriptor {
  pid: number
  fd: number
  kind: FdKind
  /** What the descriptor refers to: an absolute path, or `pipe:[id]`. */
  target: string
}

/** fds 0, 1 and 2 are always taken; a real open() returns the lowest free number at or above this. */
export const FIRST_USER_FD = 3

/** The three streams every live process has, synthesised rather than stored — see the module doc. */
export const STANDARD_STREAMS: readonly { fd: number; name: string }[] = [
  { fd: 0, name: 'stdin' },
  { fd: 1, name: 'stdout' },
  { fd: 2, name: 'stderr' },
]

export class FdTable {
  private descriptors: FileDescriptor[] = []

  /**
   * Assigns the lowest free descriptor number at or above FIRST_USER_FD,
   * which is what a real `open()` guarantees — not a monotonically
   * increasing counter. The difference is observable: a shell that opens
   * and closes a file per command would otherwise show an ever-climbing fd
   * number in the syscall trace, when a real one reuses 3 every time.
   */
  open(pid: number, kind: FdKind, target: string): number {
    const taken = new Set(this.descriptors.filter((d) => d.pid === pid).map((d) => d.fd))
    let fd = FIRST_USER_FD
    while (taken.has(fd)) fd++
    this.descriptors.push({ pid, fd, kind, target })
    return fd
  }

  /** Returns false for a descriptor this process doesn't hold — a real close() would return EBADF. */
  close(pid: number, fd: number): boolean {
    const index = this.descriptors.findIndex((d) => d.pid === pid && d.fd === fd)
    if (index === -1) return false
    this.descriptors.splice(index, 1)
    return true
  }

  /** Everything a process still holds is released when it exits, exactly like a real one. */
  closeAll(pid: number): void {
    this.descriptors = this.descriptors.filter((d) => d.pid !== pid)
  }

  forPid(pid: number): FileDescriptor[] {
    return this.descriptors.filter((d) => d.pid === pid).sort((a, b) => a.fd - b.fd)
  }

  all(): FileDescriptor[] {
    return [...this.descriptors].sort((a, b) => a.pid - b.pid || a.fd - b.fd)
  }

  reset(): void {
    this.descriptors = []
  }
}
