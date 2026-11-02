'use server'

import { headers } from 'next/headers'
import { GET, POST } from '@/app/api/ai-router/route'
import type { AiRouterCatalog, AiRouterProvider, AiRouterProviderStatus } from '@/lib/ai-router-admin'

// The production nginx `location /` verifies Basic Auth before forwarding this page's
// Server Action POST. Do not accept a request that did not pass through that layer.
async function internalRequest(method: 'GET' | 'POST', provider?: AiRouterProvider) {
  const authorization = (await headers()).get('authorization')
  if (!authorization?.startsWith('Basic ')) throw new Error('Admin authentication is required.')

  const token = process.env.AI_ROUTER_SUPER_ADMIN_TOKEN
  if (!token || token.length < 32) throw new Error('AI Router access is not configured.')
  const request = new Request('http://localhost/api/ai-router', {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(provider ? { body: JSON.stringify({ provider }) } : {}),
  })
  const response = method === 'GET' ? await GET(request) : await POST(request)
  if (!response.ok) throw new Error('AI Router is unavailable.')
  return response.json()
}

export async function loadAiRouterCatalog(): Promise<AiRouterCatalog> {
  return internalRequest('GET')
}

export async function checkAiRouterProvider(provider: AiRouterProvider): Promise<AiRouterProviderStatus> {
  return internalRequest('POST', provider)
}
