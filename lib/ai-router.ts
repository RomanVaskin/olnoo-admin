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

/** Calls the OLNOO AI Router's /v1/generate endpoint and returns the raw text content. */
export async function callAiRouter(
  messages: AiRouterMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
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
      provider: 'auto',
      model: null,
      temperature: opts.temperature ?? 0.1,
      maxTokens: opts.maxTokens ?? 12000,
      allowFallback: true,
      webSearch: false,
      metadata: { application: 'olnoo-admin' },
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

  return data.content
}
