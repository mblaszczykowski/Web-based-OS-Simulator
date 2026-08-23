export type FdKind = 'file' | 'pipe-read' | 'pipe-write'

export interface FileDescriptor {
  pid: number
  fd: number
  kind: FdKind
  target: string
}

export const FIRST_USER_FD = 3

export const STANDARD_STREAMS: readonly { fd: number; name: string }[] = [
  { fd: 0, name: 'stdin' },
  { fd: 1, name: 'stdout' },
  { fd: 2, name: 'stderr' },
]

/**
 * Per-process open file descriptors. Standard streams (0/1/2) are
 * synthesised on read rather than stored, since nothing here can close or
 * redirect them.
 */
export class FdTable {
  private descriptors: FileDescriptor[] = []

  /** Lowest free descriptor at or above 3, like a real open() — not a counter that climbs forever. */
  open(pid: number, kind: FdKind, target: string): number {
    const taken = new Set(this.descriptors.filter((d) => d.pid === pid).map((d) => d.fd))
    let fd = FIRST_USER_FD
    while (taken.has(fd)) fd++
    this.descriptors.push({ pid, fd, kind, target })
    return fd
  }

  close(pid: number, fd: number): boolean {
    const index = this.descriptors.findIndex((d) => d.pid === pid && d.fd === fd)
    if (index === -1) return false
    this.descriptors.splice(index, 1)
    return true
  }

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
