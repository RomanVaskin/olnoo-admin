import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function catalogDeployEnvironment(env) {
  let tokens
  try { tokens = JSON.parse(env.CATALOG_SITE_TOKENS || '') } catch { throw new Error('CATALOG_SITE_TOKENS must be a valid nonempty project-token JSON object') }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens) || !Object.hasOwn(tokens, 'istraart')) throw new Error('CATALOG_SITE_TOKENS must include istraart')
  const entries = Object.entries(tokens)
  if (entries.some(([slug, token]) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) || typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) || new Set(entries.map(([,v]) => v)).size !== entries.length) throw new Error('CATALOG_SITE_TOKENS contains an invalid project or token')
  return { CATALOG_SITE_TOKENS: JSON.stringify(tokens) }
}

/** Called by next.config at build AND next start. Never use Next's public `env` property. */
export function loadCatalogDeployEnvironment(file) {
  let raw
  try { raw = readFileSync(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return; throw new Error('Cannot read catalog deploy environment') }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || Object.keys(parsed).join(',') !== 'CATALOG_SITE_TOKENS') throw new Error()
    Object.assign(process.env, catalogDeployEnvironment(parsed))
  } catch { throw new Error('Invalid catalog deploy environment') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(catalogDeployEnvironment(process.env))}\n`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
