// Test Link config (Test Traffic v1): which projects can get a test link and how a project's domain becomes the link.
// The link is a plain URL carrying the test UTM (see lib/traffic-class.ts) — no token, no signature, no secret, no
// expiry: the site's existing first-touch attribution stores the UTM and the CRM classifies the lead as TEST.
// No `@/` imports and no DB here — the route/service passes the stored domain in.

import { TEST_UTM_CONTENT, TEST_UTM_MEDIUM, TEST_UTM_SOURCE } from './traffic-class.ts'

export type TestLinkProject = { slug: string; /** Landing path the link opens (query is appended). */ urlPath: string }

/** Explicit allow-list; the next project is one more entry. */
export const TEST_LINK_PROJECTS: Readonly<Record<string, TestLinkProject>> = {
  driveset: { slug: 'driveset', urlPath: '/' },
}

export function resolveTestProject(slug: unknown): TestLinkProject | null {
  return typeof slug === 'string' && Object.prototype.hasOwnProperty.call(TEST_LINK_PROJECTS, slug) ? TEST_LINK_PROJECTS[slug] : null
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/**
 * `projects.domain` is stored as a bare host or with a scheme (e.g. `https://olnoo.com`). Accepted: an optional
 * `http://`/`https://`, a host name, an optional trailing `/`. Anything else (userinfo, port, path, query, spaces, an IP,
 * an underscore) is rejected → null. The URL built from it is always https.
 */
export function normalizeProjectDomain(domain: unknown): string | null {
  if (typeof domain !== 'string') return null
  const m = /^(?:https?:\/\/)?([^/\s?#@:]+)\/?$/i.exec(domain.trim())
  const host = m?.[1].toLowerCase()
  return host && HOST_RE.test(host) ? host : null
}

/** `https://<host>/?utm_source=olnoo&utm_medium=test&utm_content=olnoo_test&utm_term=<sessionId>`. */
export function buildTestUrl(host: string, urlPath: string, sessionId: string): string {
  const query = new URLSearchParams({ utm_source: TEST_UTM_SOURCE, utm_medium: TEST_UTM_MEDIUM, utm_content: TEST_UTM_CONTENT, utm_term: sessionId })
  return `https://${host}${urlPath}?${query.toString()}`
}
