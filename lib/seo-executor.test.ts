import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SAFE_EXECUTOR_CODES, startExecutorRun, getExecutorRun, resetExecutorRunsForTests, sanitize, parsePorcelain, EXECUTOR_GUARDRAIL, type ExecutorDeps, type CmdResult } from './seo-executor.ts'
import { buildTechnicalSeoFixTask } from './technical-seo-fix-task.ts'
import { runCommand } from './seo-executor-runner.ts'
import type { Issue, ProjectHealth } from './seo-health.ts'

const issue = (code: string, url?: string): Issue => ({ severity: 'WARNING', code, message: `${code} msg`, ...(url ? { url } : {}) })
const health = (issues: Issue[]): ProjectHealth => ({
  projectId: 1, projectName: 'DriveSet', domain: 'https://driveset.ru', sitemapUrl: 'https://driveset.ru/sitemap.xml',
  site: { status: 'OK', httpStatus: 200 }, robots: { status: 'Missing', httpStatus: 404, disallowAll: false }, sitemap: { status: 'OK', httpStatus: 200, urlCount: 1 },
  pages: [], pagesTruncated: false, issues, errors: 0, warnings: issues.length, overall: 'Warning', checkedAt: '2026-01-01T00:00:00Z',
})

type Call = { cmd: string; args: string[]; opts: { cwd?: string; input?: string; env?: Record<string, string> } }
function setup(opts: { issues?: Issue[]; repository?: string | null; status?: string; checkFails?: string; agentCode?: number; pkg?: object | null; registerFails?: boolean } = {}) {
  const registered: { projectId: number; prUrl: string; issues: { code: string; url?: string }[] }[] = []
  const calls: Call[] = []
  const pkg = opts.pkg === undefined ? { scripts: { test: 'x', typecheck: 'x', build: 'x' } } : opts.pkg
  const deps: ExecutorDeps = {
    getProject: async () => ({ id: 1, name: 'DriveSet', slug: 'driveset', repository: opts.repository === undefined ? 'RomanVaskin/driveset' : opts.repository }),
    readLastResult: async () => health(opts.issues ?? [issue('robots_missing')]),
    run: async (cmd, args, o): Promise<CmdResult> => {
      calls.push({ cmd, args, opts: o })
      const ok = (stdout = ''): CmdResult => ({ code: 0, stdout, stderr: '' })
      if (cmd === 'gh' && args[0] === 'repo') return ok('main\n')
      if (cmd === 'gh' && args[0] === 'pr') return ok('https://github.com/RomanVaskin/driveset/pull/77\n')
      if (cmd === 'claude') return { code: opts.agentCode ?? 0, stdout: '', stderr: '' }
      if (cmd === 'git' && args[0] === 'status') return ok(opts.status ?? ' M app/x.ts\0?? app/robots.ts\0')
      if (cmd === 'npm' && opts.checkFails && args.join(' ') === opts.checkFails) return { code: 1, stdout: '', stderr: 'boom Bearer abcdefghijklmnop' }
      return ok()
    },
    makeTempDir: async (id) => `/tmp/olnoo-seo-executor/${id}-x`,
    removeDir: async () => { removed++ },
    readFile: async (p) => (p.endsWith('package.json') ? (pkg ? JSON.stringify(pkg) : null) : p.endsWith('package-lock.json') ? '{}' : null),
    registerChange: async (info) => { if (opts.registerFails) throw new Error('db down'); registered.push(info) },
    now: () => new Date('2026-02-02T00:00:00Z'),
    newRunId: () => '12345678-1234-1234-1234-123456789abc',
  }
  let removed = 0
  return { deps, calls, registered, removed: () => removed }
}
const has = (calls: Call[], cmd: string, first: string) => calls.some((c) => c.cmd === cmd && c.args.includes(first))
const start = async (s: ReturnType<typeof setup>, input: Record<string, unknown> = { projectId: 1 }) => {
  const r = await startExecutorRun(s.deps, input as never)
  if (r.ok) await r.done
  return r
}
beforeEach(() => resetExecutorRunsForTests())

test('A: allowlist is exactly the five safe codes; robots_missing is accepted', async () => {
  assert.deepEqual([...SAFE_EXECUTOR_CODES], ['robots_missing', 'canonical_missing', 'canonical_mismatch', 'title_missing', 'h1_missing'])
  const s = setup()
  const r = await start(s, { projectId: 1, issues: [{ code: 'robots_missing' }] })
  assert.ok(r.ok)
})

test('B/C: unsafe and unknown codes are rejected before anything runs', async () => {
  for (const code of ['page_unreachable', 'site_unavailable', 'sitemap_missing', 'noindex_in_sitemap', 'robots_disallow_all', 'check_failed', 'page_redirect', 'page_http_error', 'sitemap_unreadable', 'whatever']) {
    const s = setup({ issues: [issue(code)] })
    const r = await startExecutorRun(s.deps, { projectId: 1, issues: [{ code }] })
    assert.ok(!r.ok && r.http === 400, code)
    assert.equal(s.calls.length, 0)
  }
})

test('D: project without repository (or a malformed one) is rejected', async () => {
  for (const repository of [null, '', 'not a repo', 'a/b.git']) {
    const s = setup({ repository })
    const r = await startExecutorRun(s.deps, { projectId: 1 })
    assert.ok(!r.ok && r.http === 422)
    assert.equal(s.calls.length, 0)
  }
})

test('E/S: stale issue (no longer in the saved result) → no_changes and the agent is NOT called', async () => {
  const s = setup({ issues: [issue('page_unreachable')] })
  const r = await start(s, { projectId: 1, issues: [{ code: 'robots_missing' }] })
  assert.ok(r.ok)
  assert.equal(getExecutorRun(1)?.status, 'no_changes')
  assert.equal(s.calls.length, 0)
})

test('F: one active run per project → 409', async () => {
  const s = setup()
  const first = await startExecutorRun(s.deps, { projectId: 1 })
  assert.ok(first.ok)
  const second = await startExecutorRun(s.deps, { projectId: 1 })
  assert.ok(!second.ok && second.http === 409)
  if (first.ok) await first.done
  assert.ok((await startExecutorRun(s.deps, { projectId: 1 })).ok) // finished → a new run is allowed
})

test('G: agent made no diff → no_changes, no commit / push / PR', async () => {
  const s = setup({ status: '' })
  await start(s)
  assert.equal(getExecutorRun(1)?.status, 'no_changes')
  assert.ok(!has(s.calls, 'git', 'commit') && !has(s.calls, 'git', 'push') && !has(s.calls, 'gh', 'pr'))
  assert.equal(s.removed(), 1)
})

test('H/J: diff + checks pass → add, commit, push, PR; prUrl returned; temp dir removed', async () => {
  const s = setup()
  await start(s)
  const run = getExecutorRun(1)!
  assert.equal(run.status, 'pr_created')
  assert.equal(run.prUrl, 'https://github.com/RomanVaskin/driveset/pull/77')
  const order = s.calls.map((c) => `${c.cmd}:${c.args.find((a) => ['clone', 'checkout', 'status', 'add', 'commit', 'push', 'pr', 'ci', 'test', 'run'].includes(a)) ?? ''}`)
  assert.ok(order.indexOf('git:commit') < order.indexOf('git:push') && order.indexOf('git:push') < order.indexOf('gh:pr'))
  const commit = s.calls.find((c) => c.args.includes('commit'))!
  assert.ok(commit.args.includes('fix(seo): technical SEO fixes'))
  const pr = s.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr')!
  assert.ok(pr.args.includes('fix(seo): technical SEO fixes for DriveSet'))
  assert.ok(pr.args.some((a) => /Created by OLNOO SEO Executor v1\. Merge is manual\./.test(a)))
  assert.ok(pr.args.includes('olnoo/seo-fix-driveset-12345678'))
  assert.equal(s.removed(), 1)
  // checks: npm ci (lockfile), test, typecheck, build, and git diff --cached --check
  assert.ok(s.calls.some((c) => c.cmd === 'npm' && c.args[0] === 'ci'))
  for (const a of ['test', 'run typecheck', 'run build']) assert.ok(s.calls.some((c) => c.cmd === 'npm' && c.args.join(' ') === a), a)
  assert.ok(s.calls.some((c) => c.cmd === 'git' && c.args.join(' ') === 'diff --cached --check'))
})

test('I: a failing check → failed_checks, NO commit / push / PR, error shown, secrets redacted', async () => {
  const s = setup({ checkFails: 'run build' })
  await start(s)
  const run = getExecutorRun(1)!
  assert.equal(run.status, 'failed_checks')
  assert.match(run.error ?? '', /npm run build/)
  assert.ok(!has(s.calls, 'git', 'commit') && !has(s.calls, 'git', 'push') && !has(s.calls, 'gh', 'pr'))
  assert.doesNotMatch(JSON.stringify(run), /abcdefghijklmnop/)
  assert.equal(s.removed(), 1)
})

test('missing package.json scripts are not a failure; agent failure → failed; forbidden path → failed', async () => {
  const a = setup({ pkg: { scripts: {} } })
  await start(a)
  assert.equal(getExecutorRun(1)?.status, 'pr_created')
  assert.ok(!a.calls.some((c) => c.cmd === 'npm'))
  resetExecutorRunsForTests()
  const b = setup({ agentCode: 1 })
  await start(b)
  assert.equal(getExecutorRun(1)?.status, 'failed')
  assert.ok(!has(b.calls, 'git', 'commit'))
  resetExecutorRunsForTests()
  const c = setup({ status: ' M .github/workflows/deploy.yml\0' })
  await start(c)
  assert.equal(getExecutorRun(1)?.status, 'failed')
  assert.ok(!has(c.calls, 'git', 'push'))
})

test('K: the Executor never merges', () => {
  const src = readFileSync(new URL('./seo-executor.ts', import.meta.url), 'utf8') + readFileSync(new URL('../app/api/seo-executor/route.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src.replace(/Merge is manual|НЕ[^\n]*merge/g, ''), /\bmerge\b|auto-merge|--auto|pulls\/\d+\/merge/i)
  assert.match(EXECUTOR_GUARDRAIL, /НЕ выполняй git commit, git push, не создавай PR и не делай merge/)
})

test('L: no shell, no raw interpolation: args arrays, repository only in URL/--repo args, task via stdin only', async () => {
  const s = setup()
  await start(s)
  for (const c of s.calls) {
    assert.ok(['git', 'gh', 'claude', 'npm'].includes(c.cmd))
    assert.ok(!c.args.some((a) => /^(-c|sh|bash)$/.test(a) && c.cmd === 'sh'))
  }
  const agent = s.calls.find((c) => c.cmd === 'claude')!
  assert.ok(agent.opts.input?.includes('TECHNICAL SEO FIX TASK') && agent.opts.input.includes('EXECUTOR MODE'))
  assert.ok(!agent.args.some((a) => a.includes('TECHNICAL SEO')))
  assert.ok(agent.args.includes('--disallowedTools') && agent.args.includes('Bash'))
  const src = readFileSync(new URL('./seo-executor.ts', import.meta.url), 'utf8') + readFileSync(new URL('./seo-executor-runner.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /\beval\(|shell: true|exec\(|execSync|sh -c/)
  assert.match(src, /shell: false/)
})

test('M: tokens never appear in run state / log; sanitize redacts token-like text; the agent env carries no GitHub token', async () => {
  const prev = process.env.OLNOO_EXECUTOR_GITHUB_TOKEN
  process.env.OLNOO_EXECUTOR_GITHUB_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  try {
    const s = setup({ checkFails: 'test' })
    await start(s)
    assert.doesNotMatch(JSON.stringify(getExecutorRun(1)), /ghp_|Bearer/)
    const agent = s.calls.find((c) => c.cmd === 'claude')!
    assert.ok(!Object.values(agent.opts.env ?? {}).some((v) => /ghp_/.test(v)))
    assert.ok(s.calls.some((c) => c.cmd === 'git' && c.opts.env?.GH_TOKEN?.startsWith('ghp_')))
    assert.ok(!s.calls.some((c) => c.args.some((a) => a.includes('ghp_'))))
  } finally {
    if (prev === undefined) delete process.env.OLNOO_EXECUTOR_GITHUB_TOKEN
    else process.env.OLNOO_EXECUTOR_GITHUB_TOKEN = prev
  }
  assert.equal(sanitize('x ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ Authorization: Bearer abc.def.ghi-jkl-mno y'), 'x [redacted] [redacted]')
})

test('N: the task is the existing buildTechnicalSeoFixTask output (+ guardrail), repository from the registry', async () => {
  const s = setup({ issues: [issue('robots_missing'), issue('page_unreachable', 'https://driveset.ru/x')] })
  await start(s)
  const input = s.calls.find((c) => c.cmd === 'claude')!.opts.input!
  const expected = buildTechnicalSeoFixTask({ ...health([issue('robots_missing')]), repository: 'RomanVaskin/driveset' }, [issue('robots_missing')])!
  assert.ok(input.startsWith(expected))
  assert.doesNotMatch(input, /page_unreachable/) // an unsafe issue never reaches the agent
  assert.match(input, /Repository\/path: RomanVaskin\/driveset/)
  assert.ok(!/RULES\s*=/.test(readFileSync(new URL('./seo-executor.ts', import.meta.url), 'utf8')))
})

test('parsePorcelain handles spaces and renames; real runCommand uses no shell', async () => {
  assert.deepEqual(parsePorcelain(' M a b.ts\0R  new.ts\0old.ts\0?? c.ts\0'), ['a b.ts', 'new.ts', 'c.ts'])
  const r = await runCommand('node', ['-e', 'process.stdout.write(process.argv[1] + process.env.CI)', '$(echo pwned);`x`'], { timeoutMs: 10_000 })
  assert.equal(r.stdout, '$(echo pwned);`x`1')
  const missing = await runCommand('definitely-not-a-binary', [], { timeoutMs: 5_000 })
  assert.equal(missing.code, null)
})

test('wiring: API route, UI buttons only for safe codes, no auto-start', () => {
  const route = readFileSync(new URL('../app/api/seo-executor/route.ts', import.meta.url), 'utf8')
  assert.match(route, /export async function POST/)
  assert.match(route, /export async function GET/)
  assert.match(route, /409|startExecutorRun/)
  const ui = readFileSync(new URL('../components/sections/seo-health.tsx', import.meta.url), 'utf8')
  assert.match(ui, /isSafeExecutorCode\(i\.code\)/)
  assert.match(ui, /r\.issues\.some\(\(i\) => isSafeExecutorCode\(i\.code\)\)/)
  assert.doesNotMatch(readFileSync(new URL('./seo-decision-rules.ts', import.meta.url), 'utf8'), /executor/i)
})

test('per-issue start addresses exactly one issue by code + url; the other page with the same code is not sent to the agent', async () => {
  const a = 'https://driveset.ru/a', b = 'https://driveset.ru/b'
  const s = setup({ issues: [issue('canonical_missing', a), issue('canonical_missing', b)] })
  await start(s, { projectId: 1, issues: [{ code: 'canonical_missing', url: a, message: 'forged', severity: 'ERROR' }] })
  const input = s.calls.find((c) => c.cmd === 'claude')!.opts.input!
  assert.match(input, /ISSUES \(1\)/)
  assert.ok(input.includes(a) && !input.includes(b))
  assert.doesNotMatch(input, /forged/)
  assert.equal(getExecutorRun(1)?.status, 'pr_created')
})

test('project-level start (no issues) takes ALL current safe issues; url=null project-level issue works per-issue', async () => {
  const a = 'https://driveset.ru/a', b = 'https://driveset.ru/b'
  const s = setup({ issues: [issue('canonical_missing', a), issue('canonical_missing', b), issue('robots_missing'), issue('page_unreachable', b)] })
  await start(s)
  const input = s.calls.find((c) => c.cmd === 'claude')!.opts.input!
  assert.match(input, /ISSUES \(3\)/)
  assert.doesNotMatch(input, /page_unreachable/)
  resetExecutorRunsForTests()
  const r = setup({ issues: [issue('robots_missing'), issue('canonical_missing', a)] })
  await start(r, { projectId: 1, issues: [{ code: 'robots_missing', url: null }] })
  const rin = r.calls.find((c) => c.cmd === 'claude')!.opts.input!
  assert.match(rin, /ISSUES \(1\)/)
  assert.doesNotMatch(rin, /canonical_missing/)
})

test('stale identity: browser asks canonical_missing /a, latest result only has /b → no_changes, Claude not called', async () => {
  const s = setup({ issues: [issue('canonical_missing', 'https://driveset.ru/b')] })
  await start(s, { projectId: 1, issues: [{ code: 'canonical_missing', url: 'https://driveset.ru/a' }] })
  assert.equal(getExecutorRun(1)?.status, 'no_changes')
  assert.equal(s.calls.length, 0)
})

test('malformed issues payloads are rejected', async () => {
  for (const issues of [[], 'x', [{ url: 'u' }], [{ code: 'robots_missing', url: 5 }], [null]]) {
    const r = await startExecutorRun(setup().deps, { projectId: 1, issues })
    assert.ok(!r.ok && r.http === 400)
  }
})

// ---- step F: before/after history registration ----------------------------------------------------------------------------

test('F1: pr_created registers exactly ONE change per PR (all issues of the run, with their urls)', async () => {
  const s = setup({ issues: [issue('robots_missing'), issue('title_missing', 'https://driveset.ru/a'), issue('h1_missing', 'https://driveset.ru/a')] })
  const r = await start(s)
  assert.ok(r.ok && r.run.status === 'pr_created')
  assert.equal(s.registered.length, 1)
  assert.deepEqual(s.registered[0].projectId, 1)
  assert.equal(s.registered[0].prUrl, 'https://github.com/RomanVaskin/driveset/pull/77')
  assert.deepEqual(s.registered[0].issues.map((i) => i.code).sort(), ['h1_missing', 'robots_missing', 'title_missing'])
})

test('F2: no_changes / failed / failed_checks / stale register nothing', async () => {
  const noDiff = setup({ status: '' }); await start(noDiff); assert.equal(noDiff.registered.length, 0)
  resetExecutorRunsForTests()
  const failedChecks = setup({ checkFails: 'run build' }); await start(failedChecks); assert.equal(failedChecks.registered.length, 0)
  resetExecutorRunsForTests()
  const agentFail = setup({ agentCode: 1 }); await start(agentFail); assert.equal(agentFail.registered.length, 0)
  resetExecutorRunsForTests()
  const stale = setup({ issues: [] }); await start(stale); assert.equal(stale.registered.length, 0)
})

test('F3: a failing history write never fails the run (the PR exists); the project id is the registry one', async () => {
  const s = setup({ registerFails: true })
  const r = await start(s)
  assert.ok(r.ok && r.run.status === 'pr_created' && r.run.prUrl)
  assert.ok(r.ok && r.run.log.some((l) => l.includes('не сохранена')))
})
