// The logic behind POST /api/test-links, free of Next.js and of the database driver: the route passes the pool-backed
// `loadDomain`. READ-ONLY: it never writes anything, the token and the session id are not stored, nothing is logged.
// No `@/` imports so it runs under `node --test`.

import { buildTestUrl, normalizeProjectDomain, parseTtlMinutes, resolveTestProject, secretsFor } from './test-session-config.ts'
import { issueTestSessionToken } from './test-session-token.ts'

export type TestLinkResponse = { status: number; body: Record<string, unknown> }

const err = (status: number, kind: string, message: string): TestLinkResponse => ({ status, body: { error: { kind, message } } })
const ALLOWED_KEYS = ['project', 'ttlMinutes']

export async function createTestLink(input: {
  /** The parsed JSON body (anything: it is validated here). */
  body: unknown
  env?: Record<string, string | undefined>
  /** Reads `projects.domain` for a slug (a single SELECT); null = no such project. */
  loadDomain: (slug: string) => Promise<string | null>
  now?: number
  randomBytes?: (size: number) => Buffer
}): Promise<TestLinkResponse> {
  const body = input.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err(400, 'request', 'a JSON object body is required')
  const fields = body as Record<string, unknown>
  if (!Object.keys(fields).every((k) => ALLOWED_KEYS.includes(k))) return err(400, 'request', 'only project and ttlMinutes are accepted')
  if (typeof fields.project !== 'string' || fields.project === '') return err(400, 'request', 'project is required')

  const config = resolveTestProject(fields.project)
  if (!config) return err(404, 'unknown_project', 'project does not support test links')
  const ttl = parseTtlMinutes(fields.ttlMinutes, config)
  if (!ttl.ok) return err(400, 'request', `ttlMinutes must be an integer from 1 to ${config.maxTtlMinutes}`)

  const secrets = secretsFor(config, input.env)
  const secret = secrets[config.issueKeyVersion]
  if (!secret) return err(503, 'not_configured', 'test links are not configured for this project')

  const stored = await input.loadDomain(config.slug)
  if (stored === null) return err(404, 'unknown_project', 'project not found')
  const host = normalizeProjectDomain(stored)
  if (!host) return err(500, 'domain_invalid', 'the project domain cannot be used for a test link')

  const issued = issueTestSessionToken({ project: config.slug, secret, ttlSeconds: ttl.minutes * 60, keyVersion: config.issueKeyVersion, now: input.now, randomBytes: input.randomBytes })
  if (!issued.ok) return err(503, 'not_configured', 'test links are not configured for this project')

  // The token appears only inside the URL (the link is the deliverable); it is not repeated as a separate field.
  return { status: 200, body: { project: config.slug, url: buildTestUrl(host, config.urlPath, issued.token), expiresAt: issued.expiresAt.toISOString(), sessionId: issued.sessionId } }
}
