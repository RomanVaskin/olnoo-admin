// Real side effects for the SEO Executor (lib/seo-executor.ts): spawn WITHOUT a shell (args array), minimal env, timeouts, output caps.
// No `@/` imports. Secrets are never logged here; callers pass a token only through `opts.env` of git/gh.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { EXECUTOR_BASE_DIR, type CmdOptions, type CmdResult, type ExecutorDeps } from './seo-executor.ts'

const MAX_OUT = 256 * 1024
/** Only these variables are inherited; project scripts and the agent never see the rest of the Admin's environment. */
const INHERIT = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']

export function runCommand(cmd: string, args: string[], opts: CmdOptions): Promise<CmdResult> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { CI: '1' }
    for (const k of INHERIT) if (process.env[k]) env[k] = process.env[k] as string
    Object.assign(env, opts.env ?? {})
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: env as NodeJS.ProcessEnv, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      return resolve({ code: null, stdout: '', stderr: `cannot start ${cmd}` })
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (s: string, chunk: Buffer) => (s.length >= MAX_OUT ? s : s + chunk.toString('utf8'))
    child.stdout.on('data', (d: Buffer) => { stdout = cap(stdout, d) })
    child.stderr.on('data', (d: Buffer) => { stderr = cap(stderr, d) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, opts.timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr || `cannot start ${cmd}` }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
}

export const realExecutorDeps = (db: Pick<ExecutorDeps, 'getProject' | 'readLastResult' | 'registerChange'>): ExecutorDeps => ({
  ...db,
  run: runCommand,
  makeTempDir: async (runId) => {
    await mkdir(EXECUTOR_BASE_DIR, { recursive: true })
    return mkdtemp(`${EXECUTOR_BASE_DIR}/${runId}-`)
  },
  removeDir: async (dir) => {
    // Only ever inside the Executor's own temp root.
    if (!dir.startsWith(`${EXECUTOR_BASE_DIR}/`) || dir.includes('..')) return
    await rm(dir, { recursive: true, force: true })
  },
  readFile: async (path) => { try { return await readFile(path, 'utf8') } catch { return null } },
  now: () => new Date(),
  newRunId: () => randomUUID(),
})
