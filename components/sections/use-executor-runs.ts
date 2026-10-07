'use client'

import { useEffect, useState } from 'react'

export type AgentRun = { runId: string; status: 'queued' | 'running' | 'no_changes' | 'failed' | 'failed_checks' | 'pr_created'; log: string[]; prUrl: string | null; error: string | null }

/**
 * SEO Executor client state: a human click starts ONE run for the project (the server re-reads the issues itself);
 * while a run is active its in-memory state is polled every 3 s. Nothing here starts a run on its own.
 */
export function useExecutorRuns() {
  const [runs, setRuns] = useState<Record<number, AgentRun>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})

  const start = (projectId: number, issues?: { code: string; url?: string }[]) => {
    setErrors((cur) => ({ ...cur, [projectId]: '' }))
    fetch('/api/seo-executor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, ...(issues ? { issues } : {}) }) })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'error')
        setRuns((cur) => ({ ...cur, [projectId]: data.run }))
      })
      .catch((e: Error) => setErrors((cur) => ({ ...cur, [projectId]: e.message })))
  }

  const activeIds = Object.entries(runs).filter(([, r]) => r.status === 'queued' || r.status === 'running').map(([id]) => Number(id)).join(',')
  useEffect(() => {
    if (!activeIds) return
    const timer = setInterval(() => {
      for (const id of activeIds.split(',')) {
        fetch(`/api/seo-executor?projectId=${id}`)
          .then((res) => (res.ok ? res.json() : null))
          .then((d) => { if (d?.run) setRuns((cur) => ({ ...cur, [Number(id)]: d.run })) })
          .catch(() => {})
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [activeIds])

  return { runs, errors, start }
}
