// Global Vitest setup — roadmap-v3.md §2.4. Only extends `expect` with
// jest-dom's DOM matchers (toBeInTheDocument, etc.); harmless for the
// pure-logic engine tests that never render anything, so this can stay a
// single global setupFile rather than something component tests each
// have to remember to import.
import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement layout, so it has no real notion of scrolling —
// Element.scrollTo is simply absent. TerminalWindow.tsx calls it to keep
// the transcript pinned to the bottom on every new line, which is a real
// browser behavior worth keeping, not something to strip out for tests.
// A no-op stub here is the standard fix for this well-known jsdom gap.
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {}
}
