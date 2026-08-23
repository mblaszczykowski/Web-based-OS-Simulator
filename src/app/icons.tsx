type IconProps = { size?: number }

export function SchedulerIcon({ size = 14 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <line x1="3" y1="5" x2="14" y2="5" />
      <line x1="3" y1="10" x2="17" y2="10" />
      <line x1="3" y1="15" x2="10" y2="15" />
    </svg>
  )
}

export function MemoryIcon({ size = 14 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="5" y="5" width="10" height="10" rx="1.5" />
      <line x1="8" y1="2" x2="8" y2="5" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="8" y1="15" x2="8" y2="18" />
      <line x1="12" y1="15" x2="12" y2="18" />
      <line x1="2" y1="8" x2="5" y2="8" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="15" y1="8" x2="18" y2="8" />
      <line x1="15" y1="12" x2="18" y2="12" />
    </svg>
  )
}

export function FilesystemIcon({ size = 14 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M3 6a1 1 0 011-1h4l1.5 2H16a1 1 0 011 1v7a1 1 0 01-1 1H4a1 1 0 01-1-1V6z" />
    </svg>
  )
}

export function TerminalIcon({ size = 14 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5l5 5-5 5" />
      <line x1="11" y1="15" x2="16" y2="15" />
    </svg>
  )
}

export function FolderIcon({ size = 13 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M3 6a1 1 0 011-1h4l1.4 1.8H16a1 1 0 011 1v7a1 1 0 01-1 1H4a1 1 0 01-1-1V6z" />
    </svg>
  )
}

export function FileIcon({ size = 12 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M6 2.5h6l3 3v12a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5v-14a.5.5 0 01.5-.5z" />
      <path d="M12 2.5V6h3" />
    </svg>
  )
}

export function MaximizeIcon({ size = 10 }: IconProps) {
  return (
    <svg viewBox="0 0 10 10" width={size} height={size}>
      <rect x="1.5" y="1.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  )
}

export function CloseIcon({ size = 10 }: IconProps) {
  return (
    <svg viewBox="0 0 10 10" width={size} height={size}>
      <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export function PlayIcon({ size = 13 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="currentColor">
      <path d="M6 4.5v11l9-5.5z" />
    </svg>
  )
}

export function PauseIcon({ size = 13 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="currentColor">
      <rect x="5" y="4" width="3.4" height="12" rx="0.8" />
      <rect x="11.6" y="4" width="3.4" height="12" rx="0.8" />
    </svg>
  )
}

export function DownloadIcon({ size = 13 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <line x1="10" y1="2.5" x2="10" y2="12" />
      <path d="M6 8.5l4 4 4-4" />
      <line x1="4" y1="16.5" x2="16" y2="16.5" />
    </svg>
  )
}

export function LogoIcon({ size = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="11" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="11" width="6" height="6" rx="1" />
      <rect x="11" y="11" width="6" height="6" rx="1" />
    </svg>
  )
}

export function TraceIcon({ size = 14 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5l3 3-3 3" />
      <line x1="8" y1="5" x2="17" y2="5" />
      <line x1="8" y1="11" x2="17" y2="11" />
      <line x1="3" y1="15" x2="17" y2="15" />
    </svg>
  )
}

export function SyncIcon({ size = 14 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="9" width="8" height="7" rx="1.5" />
      <path d="M8 9V6a2 2 0 014 0v3" />
    </svg>
  )
}

export function NetworkIcon({ size = 14 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="4" cy="10" r="2.3" />
      <circle cx="16" cy="10" r="2.3" />
      <line x1="6.3" y1="10" x2="13.7" y2="10" />
    </svg>
  )
}

export function CpuIcon({ size = 13 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="6" y="6" width="8" height="8" rx="1" />
      <path d="M9 2v3M11 2v3M9 15v3M11 15v3M2 9h3M2 11h3M15 9h3M15 11h3" />
    </svg>
  )
}

export function MemChipIcon({ size = 13 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="14" height="10" rx="1.5" />
      <path d="M6.5 8v4M10 8v4M13.5 8v4" />
    </svg>
  )
}

export function WarningIcon({ size = 13 }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M10 3l8 14H2z" />
      <line x1="10" y1="8" x2="10" y2="12" />
      <circle cx="10" cy="14.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
