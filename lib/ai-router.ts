// Server-side client for the existing OLNOO AI Router. Never call this from the browser —
// it forwards a bearer token that must stay server-side.

export type AiRouterMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type AiRouterResponse = {
  id: string
  requestId: string
  provider: string
  model: string
  content: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  latencyMs?: number
  fallbackUsed?: boolean
}

export class AiRouterError extends Error {}

/** Uses the Router's existing text-to-image endpoint; source images are never sent. */
export async function callAiRouterImage(prompt: string): Promise<Buffer> {
  const baseUrl = process.env.AI_ROUTER_URL || 'http://127.0.0.1:3010'
  const token = process.env.OLNOO_ROUTER_TOKEN
  const res = await fetch(`${baseUrl}/v1/images/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ prompt, size: '1024x1024' }),
  }).catch((err) => {
    throw new AiRouterError(`Could not reach AI Router: ${err instanceof Error ? err.message : String(err)}`)
  })
  if (!res.ok) throw new AiRouterError(`AI Router image request failed (${res.status}).`)

  const data = await res.json().catch(() => null) as { imageBase64?: unknown; mimeType?: unknown } | null
  if (data?.mimeType !== 'image/png' || typeof data.imageBase64 !== 'string' ||
      data.imageBase64.length > 20 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.imageBase64)) {
    throw new AiRouterError('AI Router returned invalid image data.')
  }
  const bytes = Buffer.from(data.imageBase64, 'base64')
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new AiRouterError('AI Router returned an invalid PNG image.')
  }
  return bytes
}

/**
 * SEO bulk tasks (relevance cleanup, clustering) run on DeepSeek Flash only: explicit provider, no
 * fallback (the Router never falls back from deepseek, and a different provider in the answer is
 * rejected below), reasoning off. Spread into the options of `callAiRouter`.
 */
export const SEO_BULK_ROUTE = { provider: 'deepseek', allowFallback: false, reasoningMode: 'off' } as const

/** Calls the OLNOO AI Router's /v1/generate endpoint and returns the raw text content. */
export async function callAiRouter(
  messages: AiRouterMessage[],
  opts: {
    /** Optional fixed service preset selected by the Router; this request then omits provider/model routing. */
    service?: string
    maxTokens?: number
    temperature?: number
    /** Provider-neutral reasoning level; omitted = the Router's/provider's default (unchanged behaviour). */
    reasoningMode?: 'off' | 'low' | 'medium' | 'high'
    /** Label for the Router's cost log, e.g. "seo-relevance-cleanup". */
    task?: string
    /** Explicit Router provider; omitted = `openai` with the Router's usual fallback chain (unchanged). */
    provider?: string
    /** Omitted = true (unchanged). `false` pins the request to `provider` — see SEO_BULK_ROUTE. */
    allowFallback?: boolean
  } = {},
): Promise<string> {
  const baseUrl = process.env.AI_ROUTER_URL || 'http://127.0.0.1:3010'
  const token = process.env.OLNOO_ROUTER_TOKEN

  const res = await fetch(`${baseUrl}/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      taskType: 'reasoning',
      messages,
      ...(opts.service ? { service: opts.service } : { provider: opts.provider ?? 'openai', model: null }),
      temperature: opts.temperature ?? 0.1,
      maxTokens: opts.maxTokens ?? 12000,
      ...(!opts.service ? { allowFallback: opts.allowFallback ?? true } : {}),
      webSearch: false,
      ...(!opts.service && opts.reasoningMode ? { reasoningMode: opts.reasoningMode } : {}),
      metadata: { application: 'olnoo-admin', ...(opts.task ? { task: opts.task } : {}) },
    }),
  }).catch((err) => {
    throw new AiRouterError(
      `Could not reach AI Router at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    )
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new AiRouterError(`AI Router request failed (${res.status}): ${body.slice(0, 500)}`)
  }

  const data = (await res.json().catch(() => null)) as AiRouterResponse | null
  if (!data || typeof data.content !== 'string') {
    throw new AiRouterError('AI Router response is missing "content".')
  }

  // A pinned request must be answered by that provider; anything else would hide a substitution.
  if (opts.allowFallback === false && opts.provider && data.provider !== opts.provider) {
    throw new AiRouterError(`AI Router answered with provider "${String(data.provider)}", expected "${opts.provider}" (fallback is not allowed).`)
  }

  return data.content
}
