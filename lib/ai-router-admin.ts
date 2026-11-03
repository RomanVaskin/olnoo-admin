import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const providerName = z.enum(['openai', 'anthropic', 'gemini', 'deepseek', 'qwen'])
const status = z.object({
  name: providerName,
  connected: z.boolean(),
  available: z.boolean().nullable(),
  lastError: z.string().max(64).nullable(),
  checkedAt: z.string().datetime().nullable(),
})
const catalog = z.object({
  providers: z.array(status.extend({ models: z.array(z.object({ id: z.string(), label: z.string() })) })),
  presets: z.array(z.object({
    key: z.string(), service: z.string(), task: z.string(), provider: z.string(), model: z.string(),
    quality: z.string().optional(), reasoningMode: z.string().optional(), allowFallback: z.boolean().optional(),
  })),
})

const editablePreset = z.object({
  key: z.enum(['content-factory.text', 'content-factory.review']),
  provider: providerName,
  model: z.string().min(1).max(128),
}).strict()

export type AiRouterPresetSelection = z.infer<typeof editablePreset>
export type AiRouterProvider = z.infer<typeof providerName>
export type AiRouterProviderStatus = z.infer<typeof status>
export type AiRouterCatalog = z.infer<typeof catalog>

/** This API has no browser caller: the separate Super Admin token stays on trusted servers. */
export function isAiRouterSuperAdmin(req: Request): boolean {
  const expected = process.env.AI_ROUTER_SUPER_ADMIN_TOKEN
  if (!expected || expected.length < 32) return false
  const authorization = req.headers.get('authorization')
  const given = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  const left = Buffer.from(given)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function isAiRouterProvider(value: unknown): value is AiRouterProvider {
  return providerName.safeParse(value).success
}

async function routerRequest(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
  const token = process.env.OLNOO_ROUTER_TOKEN
  if (!token) throw new Error('AI Router token is not configured.')
  const base = (process.env.AI_ROUTER_URL || 'http://127.0.0.1:3010').replace(/\/$/, '')
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    signal: AbortSignal.timeout(25_000),
  })
  if (!response.ok) throw new Error(`AI Router request failed (${response.status}).`)
  return response.json()
}

export async function readAiRouterCatalog() {
  // Zod strips all fields outside this explicit public DTO, including any future Router fields.
  return catalog.parse(await routerRequest('/v1/admin/catalog', 'GET'))
}

export async function checkAiRouterProvider(name: AiRouterProvider) {
  return status.parse(await routerRequest(`/v1/admin/providers/${name}/check`, 'POST'))
}

/** Router remains the single source of truth for model assignments. */
export async function updateAiRouterPreset(selection: AiRouterPresetSelection): Promise<AiRouterPresetSelection> {
  const valid = editablePreset.parse(selection)
  return editablePreset.parse(await routerRequest('/v1/admin/presets', 'POST', valid))
}
