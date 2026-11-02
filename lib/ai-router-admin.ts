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

export type AiRouterProvider = z.infer<typeof providerName>

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

async function routerRequest(path: string, method: 'GET' | 'POST'): Promise<unknown> {
  const token = process.env.OLNOO_ROUTER_TOKEN
  if (!token) throw new Error('AI Router token is not configured.')
  const base = (process.env.AI_ROUTER_URL || 'http://127.0.0.1:3010').replace(/\/$/, '')
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
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
