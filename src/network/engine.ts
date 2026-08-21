// Simple network module — roadmap.md §3.2. Explicitly "pure visualisation
// of packet flow" per plan.md §3: two simulated hosts, no real TCP/IP
// stack, no sockets. `ping`/`curl` just launch packets that animate across
// a fixed link over a few ticks and log what a real one would print.

export type PacketKind = 'ping' | 'pong' | 'http-req' | 'http-res'
export type Direction = 'client-to-server' | 'server-to-client'

export interface Packet {
  id: number
  kind: PacketKind
  direction: Direction
  /** Position along the link, 0 (client) .. 1 (server) or vice versa depending on direction. Can start negative to stagger a burst. */
  progress: number
  seq: number
  /** The host this packet's request/reply pair is talking to — captured at launch, not read from shared engine state (see the note on `hostLabel` below). */
  host: string
}

export interface NetworkLogEntry {
  id: number
  text: string
}

export interface NetworkStats {
  pingsSent: number
  pingsReceived: number
  requestsSent: number
  responsesReceived: number
}

const LATENCY_TICKS = 5
const STEP = 1 / LATENCY_TICKS
const LOG_LIMIT = 60

export class NetworkEngine {
  private packets: Packet[] = []
  private nextPacketId = 1
  private nextSeq = 1
  private log: NetworkLogEntry[] = []
  private nextLogId = 1
  // Only for UI labeling ("ping {hostLabel}" quick-action, the server
  // node's name) — "most recently referenced host" is a reasonable
  // convenience there. NOT used for per-packet log lines: a packet
  // in flight must remember the host *it* was launched against, since a
  // second ping/curl to a different host can overwrite this before the
  // first one's replies arrive — see Packet.host.
  private hostLabel = 'server'

  private pingsSent = 0
  private pingsReceived = 0
  private requestsSent = 0
  private responsesReceived = 0

  private pushLog(text: string): void {
    this.log.push({ id: this.nextLogId++, text })
    if (this.log.length > LOG_LIMIT) this.log.shift()
  }

  /** Sends `count` ICMP-style echo requests, staggered slightly so they animate as a visible burst rather than one blob. */
  ping(host = 'server', count = 4): void {
    this.hostLabel = host
    this.pushLog(`PING ${host}: ${count} packets`)
    for (let i = 0; i < count; i++) {
      const seq = this.nextSeq++
      this.packets.push({
        id: this.nextPacketId++,
        kind: 'ping',
        direction: 'client-to-server',
        progress: -i * 0.4,
        seq,
        host,
      })
    }
    this.pingsSent += count
  }

  /** Sends a single simulated HTTP request/response round trip. */
  curl(host = 'server'): void {
    this.hostLabel = host
    const seq = this.nextSeq++
    this.pushLog(`GET / HTTP/1.1 -> ${host} (seq=${seq})`)
    this.packets.push({
      id: this.nextPacketId++,
      kind: 'http-req',
      direction: 'client-to-server',
      progress: 0,
      seq,
      host,
    })
    this.requestsSent++
  }

  tick(): void {
    const survivors: Packet[] = []
    for (const p of this.packets) {
      const progress = p.progress + STEP
      if (progress < 1) {
        survivors.push({ ...p, progress })
        continue
      }
      this.onArrive(p, survivors)
    }
    this.packets = survivors
  }

  private onArrive(p: Packet, survivors: Packet[]): void {
    switch (p.kind) {
      case 'ping':
        this.pushLog(`${p.host}: echo reply (seq=${p.seq})`)
        survivors.push({
          id: this.nextPacketId++,
          kind: 'pong',
          direction: 'server-to-client',
          progress: 0,
          seq: p.seq,
          host: p.host,
        })
        break
      case 'pong':
        this.pingsReceived++
        this.pushLog(`client: reply from ${p.host}: seq=${p.seq} time=${LATENCY_TICKS * 2}t`)
        break
      case 'http-req':
        this.pushLog(`${p.host}: 200 OK (seq=${p.seq})`)
        survivors.push({
          id: this.nextPacketId++,
          kind: 'http-res',
          direction: 'server-to-client',
          progress: 0,
          seq: p.seq,
          host: p.host,
        })
        break
      case 'http-res':
        this.responsesReceived++
        this.pushLog(`client: received 200 OK (seq=${p.seq}, ${LATENCY_TICKS * 2}t round trip)`)
        break
    }
  }

  /** In-flight packets that have actually launched (staggered bursts hold some back at negative progress). */
  getPackets(): Packet[] {
    return this.packets.filter((p) => p.progress >= 0)
  }

  getLog(): NetworkLogEntry[] {
    return this.log
  }

  getHostLabel(): string {
    return this.hostLabel
  }

  getStats(): NetworkStats {
    return {
      pingsSent: this.pingsSent,
      pingsReceived: this.pingsReceived,
      requestsSent: this.requestsSent,
      responsesReceived: this.responsesReceived,
    }
  }
}
