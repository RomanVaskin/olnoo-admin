// SEO Executor v1 (roadmap step E): ONE human-started, closed loop for SAFE Technical SEO issues:
// saved issue → buildTechnicalSeoFixTask() → isolated temp clone of projects.repository → coding agent (Claude Code CLI) edits files →
// Executor (not the model) checks, commits, pushes and opens a PR. It NEVER merges. Pure module (no `@/` imports): every side effect
// (shell, filesystem, GitHub, clock) is injected through `ExecutorDeps`, so tests run without Claude or GitHub.
import { buildTechnicalSeoFixTask } from './technical-seo-fix-task.ts'
import { REPOSITORY_RE, SLUG_RE } from './projects-registry.ts'
import type { Issue, ProjectHealth } from './seo-health.ts'
import { issueKey } from './seo-health-store.ts'

export { SAFE_EXECUTOR_CODES, isSafeExecutorCode } from './seo-executor-codes.ts'
import { isSafeExecutorCode } from './seo-executor-codes.ts'

export type RunStatus = 'queued' | 'running' | 'no_changes' | 'failed' | 'failed_checks' | 'pr_created'
export type ExecutorRun = {
  runId: string
  projectId: number
  issueCodes: string[]
  startedAt: string
  updatedAt: string
  status: RunStatus
  log: string[]
  prUrl: string | null
  error: string | null
}

export type CmdResult = { code: number | null; stdout: string; stderr: string; timedOut?: boolean }
export type CmdOptions = { cwd?: string; input?: string; timeoutMs: number; env?: Record<string, string>; secret?: boolean }

export type ExecutorProject = { id: number; name: string; slug: string | null; repository: string | null; archived_at?: unknown }

export type ExecutorDeps = {
  getProject: (id: number) => Promise<ExecutorProject | null>
  readLastResult: (projectId: number) => Promise<ProjectHealth | null>
  /** Optional: records the created PR in the before/after history (step F). A failure here never fails the run. */
  registerChange?: (info: { projectId: number; prUrl: string; issues: { code: string; url?: string }[] }) => Promise<void>
  /** Server-side only: `cmd` + args array, never a shell string. */
  run: (cmd: string, args: string[], opts: CmdOptions) => Promise<CmdResult>
  makeTempDir: (runId: string) => Promise<string>
  removeDir: (dir: string) => Promise<void>
  readFile: (path: string) => Promise<string | null>
  now: () => Date
  newRunId: () => string
}

export const EXECUTOR_BASE_DIR = '/tmp/olnoo-seo-executor'
export const EXECUTOR_GUARDRAIL = [
  '',
  'EXECUTOR MODE (OLNOO SEO Executor v1)',
  '- Работай только в текущем клонированном репозитории (текущая директория). Не выходи за его пределы.',
  '- Исправь только перечисленные выше issues. Минимальный patch, без редизайна.',
  '- Не меняй deploy, GitHub Actions, nginx, systemd, формы, CRM, Ads, analytics.',
  '- Не добавляй secrets и media. Не добавляй зависимости.',
  '- НЕ выполняй git commit, git push, не создавай PR и не делай merge: это сделает Executor.',
  '- Остановись сразу после изменения файлов и коротко опиши, что изменено.',
].join('\n')

/** Paths the Executor refuses to commit even if the agent touched them. */
const FORBIDDEN_PATH_RE = /^(\.github\/|\.git\/|deploy\/|node_modules\/|\.next\/)|(^|\/)(\.env[^/]*|nginx[^/]*|[^/]*\.service|[^/]*\.pem|[^/]*\.key)$/i

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BRANCH_RE = /^olnoo\/seo-fix-[a-z0-9_-]{1,64}-[0-9a-f]{8}$/
const SECRET_RE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Authorization:[^\n]*|Bearer\s+[A-Za-z0-9._-]{12,}|x-access-token:[^@\s]+@)/gi

/** Short single-line log text without anything token-like. */
export function sanitize(text: string, max = 300): string {
  const clean = text.replace(SECRET_RE, '[redacted]').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

// ---- in-memory run state (one per project; PR is the source of truth, history may be lost on restart) -------------------------

const runs: Map<number, ExecutorRun> = ((globalThis as { __olnooExecutorRuns?: Map<number, ExecutorRun> }).__olnooExecutorRuns ??= new Map())
export const getExecutorRun = (projectId: number): ExecutorRun | null => runs.get(projectId) ?? null
export const resetExecutorRunsForTests = (): void => runs.clear()
const isActive = (r: ExecutorRun | undefined | null) => !!r && (r.status === 'queued' || r.status === 'running')

export type StartResult =
  | { ok: true; run: ExecutorRun; done: Promise<void> }
  | { ok: false; http: 400 | 404 | 409 | 422; error: string }

export type StartInput = { projectId: unknown; issues?: unknown }

/**
 * Validates everything synchronously-ish (project, repository, codes, stale guard) and, if a run is warranted, registers it and
 * starts the background pipeline. `done` resolves when the pipeline ended (the route ignores it; tests await it).
 */
export async function startExecutorRun(deps: ExecutorDeps, input: StartInput): Promise<StartResult> {
  const projectId = input.projectId
  if (typeof projectId !== 'number' || !Number.isInteger(projectId) || projectId <= 0) return { ok: false, http: 400, error: 'projectId must be a positive integer' }

  // Per-issue start addresses issues by identity `code + url` (issueKey; url null/absent = project-level issue). Only the identity is
  // read from the browser; message / severity / facts always come from the latest saved result.
  let requested: { code: string; url: string | null }[] | null = null
  if (input.issues !== undefined) {
    const list = input.issues
    const valid = (x: unknown) => {
      if (!x || typeof x !== 'object') return false
      const { code, url } = x as { code?: unknown; url?: unknown }
      return typeof code === 'string' && (url === undefined || url === null || typeof url === 'string')
    }
    const shapeOk = Array.isArray(list) && list.length > 0 && list.every(valid)
    if (!shapeOk) return { ok: false, http: 400, error: 'issues must be a non-empty array of { code, url? }' }
    requested = (list as { code: string; url?: string | null }[]).map((x) => ({ code: x.code, url: x.url ?? null }))
    const bad = requested.filter((r) => !isSafeExecutorCode(r.code))
    if (bad.length) return { ok: false, http: 400, error: `issue code is not safe for the Executor: ${[...new Set(bad.map((r) => sanitize(r.code, 40)))].join(', ')}` }
  }

  const project = await deps.getProject(projectId)
  if (!project || project.archived_at) return { ok: false, http: 404, error: 'Project not found' }
  const repository = project.repository
  if (!repository || !REPOSITORY_RE.test(repository) || repository.endsWith('.git')) return { ok: false, http: 422, error: 'Project has no repository (owner/repo) in the registry; the Executor does not guess it' }

  if (isActive(runs.get(projectId))) return { ok: false, http: 409, error: 'A run is already active for this project' }

  const health = await deps.readLastResult(projectId)
  const requestedKeys = requested ? new Set(requested.map((r) => issueKey({ code: r.code, url: r.url ?? undefined }))) : null
  const safeIssues: Issue[] = (health?.issues ?? []).filter((i) => isSafeExecutorCode(i.code) && (requestedKeys === null || requestedKeys.has(issueKey(i))))
  const seen = new Set<string>()
  const issues = safeIssues.filter((i) => (seen.has(issueKey(i)) ? false : (seen.add(issueKey(i)), true)))

  const runId = deps.newRunId()
  const stamp = deps.now().toISOString()
  const run: ExecutorRun = { runId, projectId, issueCodes: [...new Set(issues.map((i) => i.code))], startedAt: stamp, updatedAt: stamp, status: 'queued', log: [], prUrl: null, error: null }
  const log = (line: string) => { run.log.push(sanitize(line, 200)); if (run.log.length > 40) run.log.shift(); run.updatedAt = deps.now().toISOString() }
  const set = (status: RunStatus, error: string | null = null) => { run.status = status; run.error = error ? sanitize(error, 400) : null; run.updatedAt = deps.now().toISOString() }
  runs.set(projectId, run)

  if (!health || issues.length === 0) {
    // Stale guard: the requested safe issue is no longer in the current saved result → nothing to fix, the agent is never started.
    run.issueCodes = requested ? [...new Set(requested.map((r) => r.code))] : []
    log('Нет актуальных безопасных issues в последнем результате Technical SEO (STALE) — агент не запускался')
    set('no_changes')
    return { ok: true, run, done: Promise.resolve() }
  }

  const task = buildTechnicalSeoFixTask({ ...health, repository }, issues)
  if (!task) {
    log('Нет задачи для агента (STALE)')
    set('no_changes')
    return { ok: true, run, done: Promise.resolve() }
  }

  const done = pipeline(deps, { project, repository, issues, task, run, log, set }).catch((err) => {
    log(`Unexpected error: ${err instanceof Error ? err.message : 'unknown'}`)
    set('failed', 'Unexpected Executor error')
  })
  return { ok: true, run, done }
}

type Ctx = { project: ExecutorProject; repository: string; issues: Issue[]; task: string; run: ExecutorRun; log: (l: string) => void; set: (s: RunStatus, e?: string | null) => void }

/** Env for git/gh: the optional dedicated token goes ONLY here (never into the agent's env, args or logs). */
function gitEnv(token: string | undefined): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' }
  if (token) env.GH_TOKEN = token
  return env
}
const CRED = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']

async function pipeline(deps: ExecutorDeps, c: Ctx): Promise<void> {
  const { run, log, set, repository } = c
  if (!RUN_ID_RE.test(run.runId)) return set('failed', 'Invalid run id')
  const slug = c.project.slug && SLUG_RE.test(c.project.slug) ? c.project.slug : `p${c.project.id}`
  const branch = `olnoo/seo-fix-${slug}-${run.runId.slice(0, 8)}`
  if (!BRANCH_RE.test(branch)) return set('failed', 'Invalid branch name')

  const token = process.env.OLNOO_EXECUTOR_GITHUB_TOKEN || undefined
  const genv = gitEnv(token)
  let dir: string | null = null
  const fail = (status: RunStatus, error: string, extra?: CmdResult) => {
    if (extra) log(sanitize(extra.stderr || extra.stdout, 200))
    set(status, error)
  }
  const git = (args: string[], cwd: string, timeoutMs = 120_000, withAuth = false) =>
    deps.run('git', withAuth ? [...CRED, ...args] : args, { cwd, timeoutMs, env: genv, secret: true })

  try {
    set('running')
    dir = await deps.makeTempDir(run.runId)
    const repoDir = `${dir}/repo`
    log('Рабочая копия: временная директория')

    // Default branch from GitHub (gh); repo not found / no access → FAILED with a clear reason.
    const view = await deps.run('gh', ['repo', 'view', repository, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { timeoutMs: 60_000, env: genv, secret: true })
    const base = view.stdout.trim()
    if (view.code !== 0 || !/^[A-Za-z0-9._\/-]{1,100}$/.test(base)) return fail('failed', 'Repository not found or no access (gh repo view failed)', view)
    log(`Репозиторий найден, base: ${base}`)

    const clone = await git(['clone', '--depth', '50', '--branch', base, `https://github.com/${repository}.git`, repoDir], dir, 300_000, true)
    if (clone.code !== 0) return fail('failed', 'git clone failed', clone)
    const co = await git(['checkout', '-b', branch], repoDir)
    if (co.code !== 0) return fail('failed', 'git checkout -b failed', co)
    log(`Ветка: ${branch}`)

    // Coding agent: Claude Code CLI as a plain subprocess (no own tool-calling loop). Files only: no shell, no network tools;
    // its env carries no GitHub token. The prompt goes through stdin.
    log('Агент работает…')
    const agentEnv: Record<string, string> = {}
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) if (process.env[k]) agentEnv[k] = process.env[k] as string
    const agent = await deps.run(
      'claude',
      ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch'],
      { cwd: repoDir, input: `${c.task}\n${EXECUTOR_GUARDRAIL}\n`, timeoutMs: 15 * 60_000, env: agentEnv, secret: true },
    )
    if (agent.code !== 0) return fail('failed', agent.timedOut ? 'Coding agent timed out' : 'Coding agent failed', agent)
    log('Агент завершил работу')

    // What changed (porcelain -z: robust to spaces). Empty → NO_CHANGES, nothing is committed or pushed.
    const st = await git(['status', '--porcelain', '-z', '--untracked-files=all'], repoDir)
    if (st.code !== 0) return fail('failed', 'git status failed', st)
    const paths = parsePorcelain(st.stdout)
    if (paths.length === 0) { log('Агент не изменил файлы'); return set('no_changes') }
    const forbidden = paths.filter((p) => FORBIDDEN_PATH_RE.test(p) || p.startsWith('/') || p.split('/').includes('..'))
    if (forbidden.length) return fail('failed', `Agent touched forbidden paths: ${forbidden.slice(0, 5).join(', ')}`)
    log(`Изменено файлов: ${paths.length}`)

    // Checks from the project's own package.json scripts (a missing script is not a failure).
    const checks = await runChecks(deps, repoDir, paths, log)
    if (!checks.ok) return fail('failed_checks', checks.error)

    const add = await git(['add', '--', ...paths], repoDir)
    if (add.code !== 0) return fail('failed', 'git add failed', add)
    const dc = await git(['diff', '--cached', '--check'], repoDir)
    if (dc.code !== 0) return fail('failed_checks', 'git diff --check failed', dc)
    log('check: git diff --check — OK')

    const commit = await git(['-c', 'user.name=OLNOO SEO Executor', '-c', 'user.email=executor@olnoo.local', 'commit', '-m', 'fix(seo): technical SEO fixes'], repoDir)
    if (commit.code !== 0) return fail('failed', 'git commit failed', commit)
    const push = await git(['push', '-u', 'origin', branch], repoDir, 180_000, true)
    if (push.code !== 0) return fail('failed', 'git push failed (no push access?)', push)
    log('Ветка запушена')

    const body = prBody(c.project.name, c.issues, paths, checks.passed)
    const pr = await deps.run(
      'gh',
      ['pr', 'create', '--repo', repository, '--base', base, '--head', branch, '--title', `fix(seo): technical SEO fixes for ${c.project.name}`, '--body', body],
      { cwd: repoDir, timeoutMs: 60_000, env: genv, secret: true },
    )
    const url = pr.stdout.split('\n').map((l) => l.trim()).filter((l) => /^https:\/\/github\.com\/[^\s]+\/pull\/\d+$/.test(l)).pop()
    if (pr.code !== 0 || !url) return fail('failed', 'gh pr create failed (branch is pushed, open the PR manually)', pr)
    run.prUrl = url
    log('PR создан')
    // One history record per created PR (never for failed / no_changes / failed_checks). Idempotent by (project, pr_url) in the store.
    try {
      await deps.registerChange?.({ projectId: c.project.id, prUrl: url, issues: c.issues.map((i) => ({ code: i.code, ...(i.url ? { url: i.url } : {}) })) })
    } catch {
      log('История изменений (before/after) не сохранена')
    }
    set('pr_created')
  } finally {
    if (dir) await deps.removeDir(dir).catch(() => {})
  }
}

/** `git status --porcelain -z` → paths ("XY path\0", renames carry a second NUL-separated origin path which is skipped). */
export function parsePorcelain(out: string): string[] {
  const parts = out.split('\0').filter(Boolean)
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (e.length < 4) continue
    paths.push(e.slice(3))
    if (e[0] === 'R' || e[0] === 'C') i++
  }
  return paths
}

async function runChecks(deps: ExecutorDeps, repoDir: string, _paths: string[], log: (l: string) => void): Promise<{ ok: true; passed: string[] } | { ok: false; error: string }> {
  const passed: string[] = []
  const pkgText = await deps.readFile(`${repoDir}/package.json`)
  if (pkgText === null) { log('check: package.json нет — npm-проверки пропущены'); return { ok: true, passed } }
  let scripts: Record<string, unknown> = {}
  try { scripts = (JSON.parse(pkgText) as { scripts?: Record<string, unknown> }).scripts ?? {} } catch { return { ok: false, error: 'package.json is not valid JSON' } }
  const wanted: [string, string[]][] = [['test', ['test']], ['typecheck', ['run', 'typecheck']], ['build', ['run', 'build']]]
  const todo = wanted.filter(([s]) => typeof scripts[s] === 'string')
  if (todo.length === 0) { log('check: нет test/typecheck/build скриптов'); return { ok: true, passed } }

  // Install with the existing lockfile only (no lockfile changes, no new dependencies).
  if ((await deps.readFile(`${repoDir}/package-lock.json`)) !== null) {
    const ci = await deps.run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: repoDir, timeoutMs: 10 * 60_000 })
    if (ci.code !== 0) { log(sanitize(ci.stderr || ci.stdout, 200)); return { ok: false, error: 'npm ci failed' } }
    log('install: npm ci — OK')
  } else {
    log('install: package-lock.json нет — установка пропущена')
  }
  for (const [name, args] of todo) {
    const r = await deps.run('npm', args, { cwd: repoDir, timeoutMs: 15 * 60_000 })
    if (r.code !== 0) { log(sanitize((r.stderr || r.stdout).split('\n').slice(-6).join(' '), 200)); return { ok: false, error: `check failed: npm ${args.join(' ')}` } }
    passed.push(name)
    log(`check: ${name} — OK`)
  }
  return { ok: true, passed }
}

function prBody(project: string, issues: Issue[], paths: string[], passed: string[]): string {
  return [
    `**Project:** ${project}`,
    '',
    '**Issues:**',
    ...issues.map((i) => `- \`${i.code}\`${i.url ? ` — ${i.url}` : ''}`),
    '',
    '**What the Executor did:** ran a coding agent on the standard Technical SEO Fix task in a fresh clone; the Executor made the checks, commit, push and this PR.',
    '',
    '**Changed files:**',
    ...paths.slice(0, 30).map((p) => `- \`${p}\``),
    '',
    `**Checks:** git diff --check${passed.length ? `, ${passed.map((p) => `npm ${p}`).join(', ')}` : ''} (scripts missing in the project are skipped).`,
    '',
    'Created by OLNOO SEO Executor v1. Merge is manual.',
  ].join('\n')
}
