// The logic behind POST /api/test-links, free of Next.js and of the database driver: the route passes the pool-backed
// `loadDomain`. READ-ONLY: it never writes anything and nothing is logged. The link is a plain URL with the test UTM
// (no token, no signature, no secret); `sessionId` is just a random label for this link (it becomes `utm_term`).
// No `@/` imports so it runs under `node --test`.

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { buildTestUrl, normalizeProjectDomain, resolveTestProject } from './test-link-config.ts'

export type TestLinkResponse = { status: number; body: Record<string, unknown> }

const err = (status: number, kind: string, message: string): TestLinkResponse => ({ status, body: { error: { kind, message } } })
const ALLOWED_KEYS = ['project', 'ttlMinutes']
const MAX_TTL_MINUTES = 720

export async function createTestLink(input: {
  /** The parsed JSON body (anything: it is validated here). */
  body: unknown
  /** Reads `projects.domain` for a slug (a single SELECT); null = no such project. */
  loadDomain: (slug: string) => Promise<string | null>
  /** Injected randomness for tests; defaults to crypto.randomBytes. */
  randomBytes?: (size: number) => Buffer
}): Promise<TestLinkResponse> {
  const body = input.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err(400, 'request', 'a JSON object body is required')
  const fields = body as Record<string, unknown>
  if (!Object.keys(fields).every((k) => ALLOWED_KEYS.includes(k))) return err(400, 'request', 'only project (and the legacy ttlMinutes) are accepted')
  if (typeof fields.project !== 'string' || fields.project === '') return err(400, 'request', 'project is required')
  // ttlMinutes was part of the signed-link contract; it is still validated for old callers but has no effect (UTM links do not expire).
  if (fields.ttlMinutes !== undefined && (typeof fields.ttlMinutes !== 'number' || !Number.isInteger(fields.ttlMinutes) || fields.ttlMinutes < 1 || fields.ttlMinutes > MAX_TTL_MINUTES)) {
    return err(400, 'request', `ttlMinutes must be an integer from 1 to ${MAX_TTL_MINUTES} (it has no effect: test links do not expire)`)
  }

  const project = resolveTestProject(fields.project)
  if (!project) return err(404, 'unknown_project', 'project does not support test links')

  const stored = await input.loadDomain(project.slug)
  if (stored === null) return err(404, 'unknown_project', 'project not found')
  const host = normalizeProjectDomain(stored)
  if (!host) return err(500, 'domain_invalid', 'the project domain cannot be used for a test link')

  const sessionId = (input.randomBytes ?? nodeRandomBytes)(9).toString('base64url')
  return { status: 200, body: { project: project.slug, url: buildTestUrl(host, project.urlPath, sessionId), expiresAt: null, sessionId } }
}
