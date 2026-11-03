import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem } from '@/lib/content-factory-items'
import { approveLanguage, ContentFactoryLanguageError, translateItemToEnglish, validateEnglishTranslation } from '@/lib/content-factory-languages'

async function itemFor(req: Request, id: string) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  return projectId ? { projectId, item: await getItem(pool, projectId, id) } : null
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const found = await itemFor(req, id)
  if (!found?.item) return NextResponse.json({ error: 'Material not found in this project.' }, { status: 404 })
  const [accounts, publications] = await Promise.all([
    pool.query(`SELECT id, name, username, status, active FROM social_accounts
      WHERE project_id = $1 AND platform = 'telegram' ORDER BY created_at`, [found.projectId]),
    pool.query(`SELECT social_post_id, status, error, external_url FROM social_publications
      WHERE project_id = $1 AND social_post_id IN ($2, $3) AND platform = 'telegram'`,
      [found.projectId, found.item.socialPostId ?? '', found.item.enSocialPostId ?? '']),
  ])
  const statusFor = (postId: string | null) => publications.rows.find((row) => row.social_post_id === postId) ?? null
  return NextResponse.json({ accounts: accounts.rows, ru: statusFor(found.item.socialPostId), en: statusFor(found.item.enSocialPostId) })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const found = await itemFor(req, id)
  if (!found?.item) return NextResponse.json({ error: 'Material not found in this project.' }, { status: 404 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  const item = found.item
  try {
    if (body.action === 'translate') {
      return NextResponse.json(await translateItemToEnglish(pool, item, body.confirmPartnerTranslationRights === true))
    }
    if (body.action === 'save_en') {
      if (item.enSocialPostId || typeof body.text !== 'string' || item.enSourceText !== item.generatedText) throw new ContentFactoryLanguageError('English post is linked to Social or the Russian source has changed.')
      validateEnglishTranslation(item.generatedText, body.text)
      await pool.query(`UPDATE content_factory_items SET en_text = $1, en_approved_at = NULL, updated_at = now()
        WHERE id = $2 AND project_id = $3 AND en_social_post_id IS NULL`, [body.text, item.id, found.projectId])
      return NextResponse.json(await getItem(pool, found.projectId, id))
    }
    if (body.action === 'approve_ru' || body.action === 'approve_en') {
      if (typeof body.accountId !== 'string' || !body.accountId) throw new ContentFactoryLanguageError('Choose a Telegram channel.')
      return NextResponse.json(await approveLanguage(pool, item, body.action === 'approve_ru' ? 'ru' : 'en', body.accountId, body.confirmRights === true))
    }
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (error) {
    if (error instanceof ContentFactoryLanguageError) return NextResponse.json({ error: error.message }, { status: 409 })
    console.error('[content-factory-languages]', error)
    return NextResponse.json({ error: 'Could not prepare this language version.' }, { status: 502 })
  }
}
