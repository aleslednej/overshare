import { OvershareError } from './errors'

export type Config = {
  targetUrl: string
  identity: { name: string; email: string }
  include: string[]
  overlay?: string
  transforms: { files: string; replace: RegExp; with: string }[]
  forbidden: RegExp[]
  denylistExceptions: string[]
}

const KEYS = ['target', 'identity', 'include', 'overlay', 'transforms', 'forbidden', 'denylistExceptions']

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new OvershareError(`Config ${path} not found.`)
  let raw: unknown
  try {
    raw = Bun.YAML.parse(await file.text())
  } catch (e) {
    throw new OvershareError(`Config ${path} is not valid YAML: ${(e as Error).message}`)
  }
  return parseConfig(raw)
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) fail('must be a YAML mapping')
  const unknown = Object.keys(raw).filter((k) => !KEYS.includes(k))
  if (unknown.length) fail(`has unknown keys: ${unknown.join(', ')}`)
  const targetUrl = resolveTarget(str(raw.target, 'target'))
  const identity = parseIdentity(str(raw.identity, 'identity'))
  const include = stringList(raw.include, 'include')
  if (!include.length) fail('include must list at least one path')
  include.forEach((p) => literalPath(p, 'include'))
  const overlay = raw.overlay === undefined ? undefined : literalPath(str(raw.overlay, 'overlay'), 'overlay')

  if (!Array.isArray(raw.transforms ?? [])) fail('transforms must be a list')
  const transforms = ((raw.transforms ?? []) as unknown[]).map((t, i) => {
    if (!isRecord(t)) fail(`transforms[${i}] must be a mapping`)
    return {
      files: str(t.files, `transforms[${i}].files`),
      replace: regex(str(t.replace, `transforms[${i}].replace`), 'g', `transforms[${i}].replace`),
      with: str(t.with, `transforms[${i}].with`, true),
    }
  })

  return {
    targetUrl,
    identity,
    include,
    overlay,
    transforms,
    forbidden: stringList(raw.forbidden, 'forbidden').map((p, i) => regex(p, 'i', `forbidden[${i}]`)),
    denylistExceptions: stringList(raw.denylistExceptions, 'denylistExceptions'),
  }
}

/** `owner/repo` means a GitHub repo; anything else is a git URL or path used as is. */
export function resolveTarget(target: string): string {
  return /^[\w.-]+\/[\w.-]+$/.test(target) ? `https://github.com/${target}.git` : target
}

function parseIdentity(identity: string) {
  const m = /^([^<>]*[^<>\s])\s*<([^<>\s]+@[^<>\s]+)>$/.exec(identity)
  if (!m) fail(`identity must have the form "Name <email>", got "${identity}"`)
  return { name: m[1]!, email: m[2]! }
}

function literalPath(path: string, key: string): string {
  const bad =
    /[*?[\]{}]/.test(path) ? 'a glob' :
    path.startsWith(':') ? 'a pathspec magic' :
    path.startsWith('/') ? 'an absolute path' :
    path.split('/').includes('..') ? 'a ".." segment' :
    !path.replace(/\/+$/, '') ? 'empty' : undefined
  if (bad) fail(`${key} entry "${path}" is ${bad}; only literal relative paths are allowed`)
  return path
}

function regex(source: string, flags: string, key: string): RegExp {
  try {
    return new RegExp(source, flags)
  } catch (e) {
    fail(`${key} is not a valid regex: ${(e as Error).message}`)
  }
}

function stringList(value: unknown, key: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${key} must be a list`)
  return value.map((v, i) => str(v, `${key}[${i}]`))
}

function str(value: unknown, key: string, allowEmpty = false): string {
  if (value === undefined || value === null) fail(`${key} is required`)
  if (typeof value !== 'string' || (!allowEmpty && !value)) fail(`${key} must be a non-empty string`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
  throw new OvershareError(`Invalid overshare.yaml: ${message}.`)
}
