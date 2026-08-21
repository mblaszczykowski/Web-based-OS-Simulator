// Thin, untested DOM trigger for a client-side file download — no backend
// to upload to or generate it server-side (ADR-0003), so this is the
// entire mechanism: a Blob URL and a synthetic, immediately-clicked <a
// download> element, the standard way to do this without a server.
export function downloadTextFile(filename: string, content: string, mimeType = 'text/csv'): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // Revoking on the next tick, not synchronously — a browser's actual
  // save-to-disk step after an <a download> click isn't guaranteed to
  // have read the blob's data yet by the time click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
