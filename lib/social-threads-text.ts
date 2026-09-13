// Pure, dependency-free piece of the Threads publisher pulled out purely so it's testable with the
// project's plain-.ts node:test runner (node's native module resolution doesn't understand the
// "@/..." path alias that lib/social-threads.ts itself needs for lib/crm and lib/social).

// Meta's documented limit for a Threads text post.
export const THREADS_TEXT_MAX_LENGTH = 500

export function resolveThreadsText(threadsText: string | null | undefined, body: string | null | undefined): string {
  return threadsText?.trim() || body?.trim() || ''
}
