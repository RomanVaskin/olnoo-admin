import { createManualMaterial } from '@/lib/content-factory-manual-intake'
import { CatalogMediaError } from '@/lib/catalog-manual-media'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { listItems } from '@/lib/content-factory-items'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const status = searchParams.get('status') ?? undefined
  const sourceId = searchParams.get('sourceId') ?? undefined
  return NextResponse.json(await listItems(pool, projectId, { status, sourceId }))
}

/** Admin-only manual owner intake, restricted to IstraArt; GET remains shared and unchanged. */
export async function POST(req: Request) {
  const headers = { 'Cache-Control': 'no-store' }
  const origin = req.headers.get('origin')
  if (origin && origin !== new URL(req.url).origin && origin !== 'https://admin.olnoo.com') return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers })
  if (new URL(req.url).searchParams.get('project') !== 'istraart') return NextResponse.json({ error: 'Not found' }, { status: 404, headers })
  const projectId = await resolveProjectId('istraart')
  if (!projectId) return NextResponse.json({ error: 'Not found' }, { status: 404, headers })
  const type = req.headers.get('content-type') || ''
  if (!type.startsWith('multipart/form-data')) return NextResponse.json({ error: 'Используйте форму загрузки.' }, { status: 415, headers })
  try {
    const reader = req.body?.getReader(), chunks: Buffer[] = []; let size = 0
    if (!reader) throw new CatalogMediaError('Заполните форму материала.')
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 101 * 1024 * 1024) throw new CatalogMediaError('Размер запроса превышает 101 МБ.', 413); chunks.push(Buffer.from(part.value)) } }
    finally { await reader.cancel().catch(() => {}) }
    const form = await new Request(req.url, { method: 'POST', headers: { 'Content-Type': type }, body: Buffer.concat(chunks) }).formData().catch(() => { throw new CatalogMediaError('Некорректная форма загрузки.') })
    if ([...form.keys()].some((key) => !['text','requestId','file'].includes(key)) || form.getAll('text').length !== 1 || form.getAll('requestId').length !== 1) throw new CatalogMediaError('Проверьте поля формы.')
    const text = form.get('text'), requestId = form.get('requestId'), photos = form.getAll('file')
    if (typeof text !== 'string' || typeof requestId !== 'string' || photos.length > 10 || photos.some((file) => !(file instanceof File) || file.size > 10 * 1024 * 1024)) throw new CatalogMediaError('Допустимы текст и до 10 фото, каждое не больше 10 МБ.')
    const result = await createManualMaterial(pool, projectId, requestId, text, await Promise.all((photos as File[]).map(async (file) => Buffer.from(await file.arrayBuffer()))))
    return NextResponse.json(result.item, { status: result.created ? 201 : 200, headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof CatalogMediaError ? error.message : 'Не удалось сохранить материал. Повторите запрос с теми же данными.' }, { status: error instanceof CatalogMediaError ? error.status : 500, headers })
  }
}
