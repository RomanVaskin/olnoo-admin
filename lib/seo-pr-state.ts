// Reads whether ONE pull request is merged, through the `gh` CLI the SEO Executor already uses (same optional server token, args array,
// no shell, timeout). Read-only; no polling: it is called only from a manual Observer run. Any problem → null ("unknown").
import { runCommand } from './seo-executor-runner.ts'
import type { PrState, PrStateReader } from './seo-page-changes.ts'

const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,9}$/

/** Pure: `gh pr view --json state,mergedAt` output → PrState (null when unreadable). */
export function parsePrState(stdout: string): PrState | null {
  try {
    const j = JSON.parse(stdout) as { state?: unknown; mergedAt?: unknown }
    if (j.state === 'MERGED' && typeof j.mergedAt === 'string' && !Number.isNaN(new Date(j.mergedAt).getTime())) return { merged: true, mergedAt: j.mergedAt }
    if (j.state === 'OPEN' || j.state === 'CLOSED') return { merged: false, mergedAt: null }
    return null
  } catch {
    return null
  }
}

export const ghPrState: PrStateReader = async (prUrl) => {
  if (!PR_URL_RE.test(prUrl)) return null
  const token = process.env.OLNOO_EXECUTOR_GITHUB_TOKEN || undefined
  const res = await runCommand('gh', ['pr', 'view', prUrl, '--json', 'state,mergedAt'], {
    timeoutMs: 20_000,
    env: { GIT_TERMINAL_PROMPT: '0', ...(token ? { GH_TOKEN: token } : {}) },
    secret: true,
  })
  return res.code === 0 ? parsePrState(res.stdout) : null
}
