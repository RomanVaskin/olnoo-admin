// olnoo-admin side of Test Mode: which projects can have a signed test link, where each project's secret comes from, and
// how a project's domain becomes the test URL. Explicit config (no platform): the next project is one more entry.
// No `@/` imports and no DB here — the route/service passes the stored domain in.

import type { SecretsByVersion } from './test-session-token.ts'
import { MAX_TTL_SECONDS } from './test-session-token.ts'

export type TestKey = { version: number; env: string }

export type TestProjectConfig = {
  slug: string
  /** Secrets by key version (rotation: add a second entry, accept both, then retire the old one). Never one global secret. */
  keys: readonly TestKey[]
  /** The key version new tokens are signed with. */
  issueKeyVersion: number
  defaultTtlMinutes: number
  maxTtlMinutes: number
  /** Path on the client site that will accept the link (the route itself ships with the client repo). */
  urlPath: string
}

export const TEST_SESSION_PROJECTS: Readonly<Record<string, TestProjectConfig>> = {
  driveset: {
    slug: 'driveset',
    keys: [{ version: 1, env: 'OLNOO_TEST_SECRET_DRIVESET' }],
    issueKeyVersion: 1,
    defaultTtlMinutes: 120,
    maxTtlMinutes: MAX_TTL_SECONDS / 60,
    urlPath: '/olnoo-test',
  },
}

export function resolveTestProject(slug: unknown): TestProjectConfig | null {
  return typeof slug === 'string' && Object.prototype.hasOwnProperty.call(TEST_SESSION_PROJECTS, slug) ? TEST_SESSION_PROJECTS[slug] : null
}

/** Secrets of a project by key version, read from the given env (only the project's own variables). */
export function secretsFor(config: TestProjectConfig, env: Record<string, string | undefined> = process.env): SecretsByVersion {
  return Object.fromEntries(config.keys.map((k) => [k.version, env[k.env]?.trim() || undefined]))
}

export type Ttl = { ok: true; minutes: number } | { ok: false }

/** Absent → the project default; otherwise an integer number of minutes from 1 to the project maximum. */
export function parseTtlMinutes(input: unknown, config: TestProjectConfig): Ttl {
  if (input === undefined) return { ok: true, minutes: config.defaultTtlMinutes }
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1 || input > config.maxTtlMinutes) return { ok: false }
  return { ok: true, minutes: input }
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

/** The token is base64url + dots only, so it needs no escaping; nothing from the client is part of the URL. */
export function buildTestUrl(host: string, urlPath: string, token: string): string {
  return `https://${host}${urlPath}?t=${token}`
}
