import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem } from '@/lib/content-factory-items'
import { syncOriginalImages } from '@/lib/content-factory-original-images'
import { getSource } from '@/lib/content-factory-sources'
import { fetchPublicTelegramChannel, normalizeTelegramHandle } from '@/lib/content-factory-telegram-source'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  const { id } = await params
  const item = await getItem(pool, projectId, id)
  if (!item || item.processingMode !== 'copy') return NextResponse.json({ error: 'Partner copy not found.' }, { status: 404 })
  if (item.socialPostId || item.enSocialPostId || item.enPublishClaimed || item.status === 'published' || item.status === 'scheduled') return NextResponse.json({ error: 'Published material cannot be changed.' }, { status: 409 })
  const source = await getSource(pool, projectId, item.sourceId)
  const handle = source?.type === 'telegram' ? normalizeTelegramHandle(source.handle) : null
  let freshUrls: string[] | undefined
  if (handle && normalizeTelegramHandle(item.originalUrl) === handle) {
    try {
      freshUrls = (await fetchPublicTelegramChannel(handle)).find((message) => message.externalId === item.externalId)?.imageUrls
    } catch {
      // The stored URLs can still work when the public preview is temporarily unavailable.
    }
  }
  await syncOriginalImages(pool, item, fetch, freshUrls)
  const updated = await getItem(pool, projectId, id)
  if (!updated) return NextResponse.json({ error: 'Material disappeared during image download.' }, { status: 404 })
  return NextResponse.json(updated)
}
