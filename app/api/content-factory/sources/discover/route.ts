import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { listSources } from '@/lib/content-factory-sources'
import { discoverRss, verifyDiscoveredFeed, connectRssSource, RssDiscoveryError } from '@/lib/content-factory-rss-discovery'

export const maxDuration = 300
export async function POST(req: Request) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'Выберите проект.' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!body || !['country', 'topics', 'language'].every((key) => typeof body[key] === 'string' && body[key].trim() && body[key].length <= 160)) return NextResponse.json({ error: 'Укажите страну, темы и язык.' }, { status: 400 })
  try {
    if (body.action !== 'connect') {
      const sources = await listSources(pool, projectId)
      return NextResponse.json({ results: await discoverRss(body, sources.filter((s) => s.type === 'rss').map((s) => s.handle)) })
    }
    if (typeof body.url !== 'string' || body.url.length > 2048) return NextResponse.json({ error: 'Некорректный URL ленты.' }, { status: 400 })
    const feed = await verifyDiscoveredFeed(body.url, body.topics)
    return NextResponse.json(await connectRssSource(pool, projectId, feed), { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof RssDiscoveryError ? error.message : 'Не удалось проверить или подключить RSS. Попробуйте позже.' }, { status: error instanceof RssDiscoveryError && error.message.includes('уже подключена') ? 409 : 502 })
  }
}
