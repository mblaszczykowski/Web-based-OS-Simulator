// Renders docs/diagrams/*.mmd to light and dark SVGs, so the README stays
// readable whichever theme GitHub is showing.
// Run with: npm run diagrams

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'docs/diagrams'
const THEMES = [
  { suffix: '', args: ['-t', 'default', '-b', 'white'] },
  { suffix: '-dark', args: ['-t', 'dark', '-b', 'transparent'] },
]

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.mmd'))) {
  const name = file.replace(/\.mmd$/, '')
  for (const theme of THEMES) {
    const out = join(DIR, `${name}${theme.suffix}.svg`)
    execFileSync('npx', ['mmdc', '-i', join(DIR, file), '-o', out, ...theme.args], { stdio: 'inherit' })
  }
}
