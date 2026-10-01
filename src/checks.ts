import { lstat, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { under } from './build'
import type { Config } from './config'
import { OvershareError } from './errors'

/** Published text outside the tree: release notes and release identity. */
export type Text = { label: string; text: string }
export type CheckInput = {
  config: Config
  gitleaks: string // the binary preflight found
  dir: string // the export, an absolute path
  files: string[]
  binary: string[]
  notes?: string
  scratch: string // a directory of its own for gitleaks' config, inputs and reports
}
type Leak = { RuleID: string; File: string; StartLine: number }

const DENYLIST = ['**/AGENTS.md', '**/CLAUDE.md', '**/.env*', '**/.claude/**'].map((p) => new Bun.Glob(p))

/** Runs every check over what the export publishes; aborts listing all findings of all checks. */
export async function check(input: CheckInput): Promise<void> {
  const { identity } = input.config
  const texts: Text[] = [{ label: 'release identity', text: `${identity.name} <${identity.email}>` }]
  if (input.notes !== undefined) texts.push({ label: 'release notes', text: input.notes })
  const [content, leaks] = await Promise.all([tree(input, texts), gitleaks(input, texts)])
  const findings = [...denied(input), ...content, ...leaks]
  if (findings.length) throw new OvershareError(`Checks failed:\n${findings.map((f) => `  ${f}`).join('\n')}`)
}

/** A file is denylisted when its path or the path of any directory it sits in matches; exceptions match the file. */
function denied({ config, files }: CheckInput): string[] {
  const exceptions = config.denylistExceptions.map((p) => new Bun.Glob(p))
  const listed = (path: string) =>
    path.split('/').some((_, i, parts) => DENYLIST.some((g) => g.match(parts.slice(0, i + 1).join('/'))))
  return files
    .filter((path) => listed(path) && !exceptions.some((g) => g.match(path)))
    .map((path) => `denylisted: ${path}`)
}

/** Symlinks, and forbidden patterns in paths, text file contents and the texts. */
async function tree({ config, dir, files, binary }: CheckInput, texts: Text[]): Promise<string[]> {
  const found = []
  const skip = new Set(binary)
  const match = (text: string, where: string) => {
    for (const pattern of config.forbidden) if (pattern.test(text)) found.push(`forbidden pattern ${pattern} in ${where}`)
  }
  for (const path of files) {
    match(path, `path: ${path}`)
    const stat = await lstat(under(dir, path))
    if (stat.isSymbolicLink()) found.push(`symlink: ${path}`)
    else if (stat.isFile() && !skip.has(path) && config.forbidden.length) match(await readFile(under(dir, path), 'utf8'), path)
  }
  for (const { label, text } of texts) match(text, label)
  return found
}

/**
 * Gitleaks over the tree and the texts, in one run over copies named by number, each led by an empty line.
 * Nothing in the export can switch it off or steer it past a file: the names leave no `.gitleaksignore`,
 * `.gitleaks.toml` or path from gitleaks' default allowlist (lockfiles, `node_modules/`, `*.svg`…), the empty line
 * hides content that starts like a PDF or ELF from its sniffing, an explicit `--config` wins over `GITLEAKS_CONFIG*`
 * (stripped from the environment as well) and `--ignore-gitleaks-allow` over `gitleaks:allow` comments.
 */
async function gitleaks({ gitleaks, dir, files, binary, scratch }: CheckInput, texts: Text[]): Promise<string[]> {
  const config = join(scratch, 'gitleaks.toml')
  const target = join(scratch, 'scan')
  const report = join(scratch, 'report.json')
  await Bun.write(config, '[extend]\nuseDefault = true\n')
  const skip = new Set(binary)
  const sources: { where: string; content: string | Buffer }[] = texts.map(({ label, text }) => ({ where: label, content: text }))
  for (const path of files) {
    if (skip.has(path) || !(await lstat(under(dir, path))).isFile()) continue
    sources.push({ where: path, content: await readFile(under(dir, path)) })
  }
  for (const [i, { content }] of sources.entries()) await Bun.write(join(target, `${i}`), [Buffer.from('\n'), content])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GITLEAKS_CONFIG')))
  const result = await Bun.$`${gitleaks} dir . --config ${config} --ignore-gitleaks-allow --gitleaks-ignore-path ${scratch} --no-banner --redact --exit-code 2 --report-format json --report-path ${report}`
    .cwd(target).env(env).quiet().nothrow()
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    throw new OvershareError(`gitleaks failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`)
  }
  const leaks = (await Bun.file(report).json()) as Leak[]
  return leaks.map((l) => `secret (${l.RuleID}) in ${sources[Number(basename(l.File))]!.where}:${l.StartLine - 1}`)
}
