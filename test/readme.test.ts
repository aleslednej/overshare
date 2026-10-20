import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { USAGE } from '../src/cli'

// The README is oss/README.md in the source repo and README.md at the root of the export.
const ROOT = join(import.meta.dir, '..')
const README = ['oss/README.md', 'README.md'].map((p) => join(ROOT, p)).find((p) => existsSync(p))

/** Commands and options in a usage text, e.g. `plan`, `release`, `--notes`. */
function tokens(lines: string[]): Set<string> {
  const found = new Set<string>()
  for (const line of lines) {
    const command = line.match(/(?:^\s*(?:Usage: )?overshare|cli\.ts) +([a-z|]+)/)
    for (const name of command?.[1].split('|') ?? []) found.add(name)
    for (const [option] of line.matchAll(/--[a-z][a-z-]*/g)) found.add(option)
  }
  return found
}

test('README Usage lists the same commands and options as USAGE in cli.ts', async () => {
  expect(README).toBeDefined()
  const usage = (await Bun.file(README!).text()).split(/^## Usage$/m)[1]?.split(/^## /m)[0] ?? ''
  const block = usage.match(/```sh\n([\s\S]*?)```/)?.[1] ?? ''
  const cli = tokens(USAGE.split('\n'))
  const readme = tokens(block.split('\n'))
  const diff = [
    ...[...cli].filter((t) => !readme.has(t)).map((t) => `missing in README: ${t}`),
    ...[...readme].filter((t) => !cli.has(t)).map((t) => `not in USAGE: ${t}`),
  ]
  expect(cli.size).toBeGreaterThan(0)
  expect(diff).toEqual([])
})
