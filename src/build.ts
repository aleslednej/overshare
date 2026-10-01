import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { Config } from './config'
import { OvershareError } from './errors'

export type BuildResult = { files: string[]; shadowed: string[]; stale: string[]; binary: string[]; warnings: string[] }
export type BuildInput = {
  sourceRepo: string
  config: Config
  tag: string
  lastExport?: string
  files: { path: string; local: string }[]
}

/** Writes the export of `tag` into `dir`: allowlist, transforms, committed overlay, operator's files. */
export async function build(input: BuildInput, dir: string): Promise<BuildResult> {
  const { sourceRepo, config, tag, lastExport } = input
  const ref = `refs/tags/${tag}`
  await mkdir(dir, { recursive: true })
  const allowlisted = await extract(sourceRepo, ref, config.include, dir)
  const warnings = await transform(config, allowlisted, dir)

  const overlaid = new Set<string>()
  const overlay = config.overlay === undefined ? undefined : canonical(config.overlay, 'overlay')
  if (overlay === '') throw new OvershareError(`overlay "${config.overlay}" names the repo root, not a directory.`)
  if (overlay) {
    const strip = overlay.split('/').length
    for (const path of await extract(sourceRepo, ref, [overlay], dir, strip)) overlaid.add(path)
  }
  for (const { path: given, local } of input.files) {
    const path = canonical(given, '--file path')
    if (!path) throw new OvershareError(`--file path "${given}" names no file.`)
    const bytes = encodePath(path)
    for (let end = bytes.indexOf('/'); end >= 0; end = bytes.indexOf('/', end + 1)) {
      const parent = await lstat(under(dir, bytes.subarray(0, end))).catch(() => undefined)
      if (!parent) break
      if (parent.isSymbolicLink()) throw new OvershareError(`--file path "${given}" goes through a symlink from the archive.`)
    }
    await rm(under(dir, bytes), { force: true }) // never write through a symlink from the archive
    if (bytes.includes('/')) await mkdir(under(dir, bytes.subarray(0, bytes.lastIndexOf('/'))), { recursive: true })
    await writeFile(under(dir, bytes), await readFile(local))
    overlaid.add(path)
  }

  const shadowed = allowlisted.filter((path) => overlaid.has(path))
  // no pathspec: git diff has no way to take one as bytes, and a name need not be UTF-8
  const changed = lastExport && shadowed.length
    ? nulSeparated(await run(sourceRepo, ['git', 'diff', '--no-renames', '--name-only', '-z', `refs/tags/${lastExport}`, ref]))
    : []
  const stale = shadowed.filter((path) => changed.includes(path))
  for (const path of stale) warnings.push(`Stale overlay: ${path} changed in the source repo since ${lastExport}.`)

  const files = await listFiles(dir)
  const binary = []
  for (const path of files) if (await isBinary(under(dir, path))) binary.push(path)
  return { files, shadowed, stale, binary, warnings }
}

/** Extracts `git archive` of literal paths into `dir`; returns the archived files, paths as in the export. */
async function extract(repo: string, ref: string, paths: string[], dir: string, strip = 0): Promise<string[]> {
  const archive = await run(repo, ['git', '--literal-pathspecs', 'archive', '--format=tar', ref, '--', ...paths])
  const archived = tarFiles(archive)
  const attrs = (await run(repo, ['git', 'check-attr', `--source=${ref}`, '-z', '--stdin', 'export-subst'],
    Buffer.concat(archived.flatMap((name) => [name, Buffer.from('\0')])))).toString().split('\0')
  const subst = archived.filter((_, i) => attrs[i * 3 + 2] === 'set').map(decodePath)
  if (subst.length) {
    throw new OvershareError(`export-subst would expand source repo metadata in: ${subst.join(', ')}.`)
  }
  await run(dir, ['tar', '-xf', '-', `--strip-components=${strip}`], archive)
  const stripped = archived.map((name) => Buffer.from(name.toString('latin1').split('/').slice(strip).join('/'), 'latin1'))
  return stripped.filter((name) => name.length).map(decodePath)
}

/** Applies transforms to allowlisted text files; returns a warning for each transform that matched nothing. */
async function transform(config: Config, allowlisted: string[], dir: string): Promise<string[]> {
  const warnings = []
  for (const t of config.transforms) {
    const glob = new Bun.Glob(t.files)
    let found = false
    for (const path of allowlisted.filter((p) => glob.match(p))) {
      const file = under(dir, path)
      if (!(await lstat(file)).isFile() || (await isBinary(file))) continue
      const text = await readFile(file, 'utf8')
      if (!text.match(t.replace)) continue
      found = true
      await writeFile(file, text.replace(t.replace, t.with))
    }
    if (!found) warnings.push(`Transform ${t.replace} on ${t.files} matched nothing.`)
  }
  return warnings
}

async function listFiles(dir: string, sub?: Buffer): Promise<string[]> {
  const files = []
  for (const name of await readdir(sub ? under(dir, sub) : dir, { encoding: 'buffer' })) {
    const path = sub ? Buffer.concat([sub, Buffer.from('/'), name]) : name
    if ((await lstat(under(dir, path))).isDirectory()) files.push(...(await listFiles(dir, path)))
    else files.push(decodePath(path))
  }
  return sub ? files : files.sort()
}

/** Binary = a NUL in the first 8000 bytes, as git decides. */
async function isBinary(file: Buffer): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const handle = await open(file)
  try {
    const head = Buffer.alloc(8000)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return head.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

export async function run(cwd: string, cmd: string[], stdin?: Buffer, env?: Record<string, string | undefined>): Promise<Buffer> {
  const result = await (stdin ? Bun.$`${cmd} < ${stdin}` : Bun.$`${cmd}`).cwd(cwd).env(env ?? process.env).quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new OvershareError(`${cmd.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`)
  }
  return result.stdout
}

/** A relative path without empty or "." segments, the form git archive writes it in; ".." could leave the export. */
function canonical(path: string, what: string): string {
  const segments = path.split('/').filter((s) => s && s !== '.')
  if (segments.includes('..')) throw new OvershareError(`${what} "${path}" must not have ".." segments.`)
  return segments.join('/')
}

/**
 * A git path as a string, without loss: UTF-8 when its bytes are valid UTF-8, otherwise every byte from 0x80 up
 * as the lone surrogate U+DC00 + byte, which no valid UTF-8 decodes to. `encodePath` gives the bytes back.
 */
export function decodePath(bytes: Buffer): string {
  const text = bytes.toString()
  return Buffer.from(text).equals(bytes) ? text : String.fromCharCode(...Array.from(bytes, (b) => (b < 0x80 ? b : 0xdc00 + b)))
}

export function encodePath(path: string): Buffer {
  return /[\udc80-\udcff]/u.test(path) ? Buffer.from(Array.from(path, (c) => c.charCodeAt(0) & 0xff)) : Buffer.from(path)
}

/** `path` in `dir` as the bytes the file system knows it by. */
export const under = (dir: string, path: string | Buffer) =>
  Buffer.concat([Buffer.from(`${dir}/`), typeof path === 'string' ? encodePath(path) : path])

export const nulSeparated = (bytes: Buffer) =>
  bytes.toString('latin1').split('\0').filter(Boolean).map((name) => decodePath(Buffer.from(name, 'latin1')))

/** Files and symlinks of a tar stream, names read from the headers as bytes so a newline or non-UTF-8 survives. */
function tarFiles(tar: Buffer): Buffer[] {
  const files = []
  let pax: Record<string, Buffer> = {}
  for (let off = 0; off + 512 <= tar.length && tar[off] !== 0;) {
    const field = (start: number, length: number) => {
      const bytes = tar.subarray(off + start, off + start + length)
      const end = bytes.indexOf(0)
      return bytes.subarray(0, end < 0 ? length : end)
    }
    const type = String.fromCharCode(tar[off + 156]!)
    const size = pax.size && type !== 'x' && type !== 'g' ? Number(pax.size.toString()) : Number.parseInt(field(124, 12).toString(), 8)
    const body = tar.subarray(off + 512, off + 512 + size)
    if (type === 'x') {
      pax = paxRecords(body)
    } else {
      const prefix = field(345, 155)
      const name = pax.path ?? (prefix.length ? Buffer.concat([prefix, Buffer.from('/'), field(0, 100)]) : field(0, 100))
      if (type === '0' || type === '\0' || type === '2') files.push(name)
      if (type !== 'g') pax = {}
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

/** Records of a pax extended header: "<length> <key>=<value>\n", the length counting the whole record. */
function paxRecords(body: Buffer): Record<string, Buffer> {
  const records: Record<string, Buffer> = {}
  for (let pos = 0; pos < body.length;) {
    const space = body.indexOf(0x20, pos)
    const length = Number.parseInt(body.subarray(pos, space).toString(), 10)
    if (space < 0 || !(length > 0)) break
    const record = body.subarray(space + 1, pos + length - 1)
    const eq = record.indexOf('=')
    records[record.subarray(0, eq).toString()] = record.subarray(eq + 1)
    pos += length
  }
  return records
}
