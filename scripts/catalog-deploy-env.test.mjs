import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, readdirSync, rmSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { catalogDeployEnvironment } from './catalog-deploy-env.mjs'
const source = new URL('./catalog-deploy-env.mjs', import.meta.url)
const root = new URL('../', import.meta.url)
const token = 'catalog-test-'.repeat(4) + '$"`\\'
const env = { CATALOG_SITE_TOKENS: JSON.stringify({ istraart: token, other: 'other-project-token-'.repeat(3) }, null, 2) }
const workflow = readFileSync(new URL('.github/workflows/deploy.yml', root), 'utf8')
const installer = workflow.match(/remote_script=\$\(cat <<'REMOTE_CATALOG'\n([\s\S]*?)\n\s*REMOTE_CATALOG/)?.[1].replace(/^ {10}/gm, '')

test('pretty JSON and token punctuation round-trip without dotenv/shell interpolation', () => {
  const payload = JSON.parse(JSON.stringify(catalogDeployEnvironment(env)))
  assert.deepEqual(JSON.parse(payload.CATALOG_SITE_TOKENS), JSON.parse(env.CATALOG_SITE_TOKENS))
  assert.deepEqual(Object.keys(payload), ['CATALOG_SITE_TOKENS'])
})
test('missing, malformed, empty, duplicate or incomplete maps fail without leaking a value', () => {
  for (const value of [undefined, '', 'invalid secret input', '[]', '{}', '{"other":"' + token + '"}', JSON.stringify({ istraart: 'short' }), JSON.stringify({ istraart: token, other: token })]) {
    const child = spawnSync(process.execPath, [source.pathname], { env: { ...process.env, CATALOG_SITE_TOKENS: value || '' }, encoding: 'utf8' })
    assert.notEqual(child.status, 0)
    assert.equal(child.stdout, '')
    assert.equal(child.stderr.includes(token), false)
    assert.equal(child.stderr.includes('invalid secret input'), false)
  }
})
test('actual remote installer atomically replaces only its private file and rejects truncated input', () => {
  assert.ok(installer)
  const dir = mkdtempSync(join(tmpdir(), 'catalog-admin-install-'))
  try {
    writeFileSync(join(dir, '.env.local'), 'YANDEX_DIRECT_TOKEN=unchanged\nDATABASE_URL=unchanged\n', { mode: 0o600 })
    writeFileSync(join(dir, '.env.production.local'), 'YANDEX_METRIKA_TOKEN=unchanged\n', { mode: 0o600 })
    const payload = JSON.stringify(catalogDeployEnvironment(env))
    writeFileSync(join(dir, 'payload'), payload)
    let fd = openSync(join(dir, 'payload'), 'r')
    const installed = spawnSync('bash', ['-c', installer], { cwd: dir, stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000 })
    closeSync(fd)
    assert.equal(installed.status, 0, installed.stderr)
    assert.equal(installed.stdout.includes(token), false)
    assert.equal(readFileSync(join(dir, '.env.catalog.json'), 'utf8'), payload)
    writeFileSync(join(dir, 'payload'), payload.slice(0, -2))
    fd = openSync(join(dir, 'payload'), 'r')
    const failed = spawnSync('bash', ['-c', installer], { cwd: dir, stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000 })
    closeSync(fd)
    assert.notEqual(failed.status, 0)
    assert.equal(failed.stderr.includes('CATALOG_SITE_TOKENS'), false)
    assert.equal(readFileSync(join(dir, '.env.catalog.json'), 'utf8'), payload)
    assert.equal(readFileSync(join(dir, '.env.local'), 'utf8'), 'YANDEX_DIRECT_TOKEN=unchanged\nDATABASE_URL=unchanged\n')
    assert.equal(readFileSync(join(dir, '.env.production.local'), 'utf8'), 'YANDEX_METRIKA_TOKEN=unchanged\n')
    assert.equal(readdirSync(dir).some((name) => name.startsWith('.env.catalog.json.')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('fresh runtime loads the delivered file through next.config with no runner env or public env setting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-admin-runtime-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    copyFileSync(source, join(dir, 'scripts/catalog-deploy-env.mjs'))
    copyFileSync(new URL('next.config.mjs', root), join(dir, 'next.config.mjs'))
    writeFileSync(join(dir, '.env.catalog.json'), JSON.stringify(catalogDeployEnvironment(env)))
    const childEnv = { ...process.env }; delete childEnv.CATALOG_SITE_TOKENS
    writeFileSync(join(dir, 'runtime.mjs'), `const {default: config}=await import('./next.config.mjs'); if(!process.env.CATALOG_SITE_TOKENS || config.env) process.exit(1); const x=JSON.parse(process.env.CATALOG_SITE_TOKENS); if(x.istraart.length < 32) process.exit(1); (await import('node:fs')).writeFileSync('runtime-ok', 'runtime environment loaded');`)
    const child = spawnSync(process.execPath, [join(dir, 'runtime.mjs')], { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(readFileSync(join(dir, 'runtime-ok'), 'utf8'), 'runtime environment loaded')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('workflow CLI writes only validated JSON to a private payload file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-cli-'))
  try {
    const file = join(dir, 'payload')
    const fd = openSync(file, 'w', 0o600)
    const child = spawnSync(process.execPath, [source.pathname], { env: { ...process.env, ...env }, stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: 10000 })
    closeSync(fd)
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), catalogDeployEnvironment(env))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
