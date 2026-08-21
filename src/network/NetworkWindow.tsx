import { useEffect, useRef } from 'react'
import { WindowFrame } from '../app/WindowFrame'
import { NetworkIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { network } from '../app/engines'
import type { Packet } from './engine'

const CLIENT_X = 40
const SERVER_X = 340
const WIRE_Y = 50

const PACKET_COLOR: Record<Packet['kind'], string> = {
  ping: 'var(--accent-network)',
  pong: 'var(--accent-terminal)',
  'http-req': 'var(--accent-scheduler)',
  'http-res': 'var(--accent-syscall)',
}
const PACKET_LABEL: Record<Packet['kind'], string> = {
  ping: 'ICMP',
  pong: 'ICMP',
  'http-req': 'HTTP',
  'http-res': 'HTTP',
}

function packetX(p: Packet): number {
  const span = SERVER_X - CLIENT_X
  return p.direction === 'client-to-server' ? CLIENT_X + p.progress * span : SERVER_X - p.progress * span
}

export function NetworkWindow() {
  useSimStore((s) => s.version) // subscribed purely so this window re-renders on every tick/command
  const runCommand = useSimStore((s) => s.runCommand)
  const logRef = useRef<HTMLDivElement>(null)

  const packets = network.getPackets()
  const log = network.getLog()
  const stats = network.getStats()
  const hostLabel = network.getHostLabel()

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  return (
    <WindowFrame id="network" title="Network" subtitle="packet flow" accent="var(--accent-network)" icon={<NetworkIcon />}>
      <div className="win-body">
        <div className="mem-sidebar">
          <div className="field">
            <span className="label">Mechanism</span>
            <div className="algo-readout">
              <span className="algo-dot" />
              <span className="algo-name" style={{ fontSize: 12 }}>
                Two simulated hosts
              </span>
            </div>
            <span className="algo-desc">
              Pure packet-flow visualisation — no real TCP/IP stack or sockets (plan.md §3). `ping`/`curl` in the
              terminal launch packets that animate across a fixed link.
            </span>
          </div>

          <div className="stat-pair">
            <div className="stat">
              <span className="label">Pings sent/recv</span>
              <span className="stat-value" style={{ fontSize: 14 }}>
                {stats.pingsSent}/{stats.pingsReceived}
              </span>
            </div>
            <div className="stat">
              <span className="label">HTTP req/res</span>
              <span className="stat-value" style={{ fontSize: 14 }}>
                {stats.requestsSent}/{stats.responsesReceived}
              </span>
            </div>
          </div>

          <div className="field" style={{ gap: 8 }}>
            <button type="button" className="btn-outline" onClick={() => runCommand(`ping ${hostLabel}`)}>
              ping {hostLabel}
            </button>
            <button type="button" className="btn-outline" onClick={() => runCommand(`curl ${hostLabel}`)}>
              curl {hostLabel}
            </button>
          </div>
        </div>

        <div className="mem-main">
          <span className="label">Link</span>
          <svg viewBox="0 0 380 100" style={{ width: '100%', height: 90 }} role="img" aria-label="Packets in flight between client and server">
            <line x1={CLIENT_X} y1={WIRE_Y} x2={SERVER_X} y2={WIRE_Y} stroke="var(--border-strong)" strokeWidth="2" />

            <rect x={CLIENT_X - 22} y={WIRE_Y - 18} width="44" height="36" rx="6" fill="var(--bg-inset)" stroke="var(--border-strong)" />
            <text x={CLIENT_X} y={WIRE_Y + 5} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text-primary)">client</text>

            <rect x={SERVER_X - 22} y={WIRE_Y - 18} width="44" height="36" rx="6" fill="var(--bg-inset)" stroke="var(--border-strong)" />
            <text x={SERVER_X} y={WIRE_Y + 5} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text-primary)">{hostLabel.length > 8 ? 'server' : hostLabel}</text>

            {packets.map((p) => (
              <g key={p.id}>
                <circle cx={packetX(p)} cy={WIRE_Y} r="6" fill={PACKET_COLOR[p.kind]} />
                <text x={packetX(p)} y={WIRE_Y - 12} textAnchor="middle" fontSize="8" fill="var(--text-muted)">
                  {PACKET_LABEL[p.kind]}
                </text>
              </g>
            ))}
          </svg>

          <div className="field" style={{ flexGrow: 1, minHeight: 0 }}>
            <span className="label">Log</span>
            <div className="sync-log" ref={logRef}>
              {log.length === 0 && <span className="term-muted">no traffic yet — try `ping` or `curl` in the terminal</span>}
              {log.map((entry) => (
                <div className="sync-log-row" key={entry.id}>
                  {entry.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </WindowFrame>
  )
}
