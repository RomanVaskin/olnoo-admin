import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem } from '@/lib/content-factory-items'
import { approveLanguage, ContentFactoryLanguageError, translateItem, validateTranslation } from '@/lib/content-factory-languages'

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
      if (body.language !== 'ru' && body.language !== 'en') throw new ContentFactoryLanguageError('Choose RU or EN as the translation language.')
      return NextResponse.json(await translateItem(pool, item, body.language, body.confirmPartnerTranslationRights === true))
    }
    if (body.action === 'save_translation') {
      const language = body.language
      if ((language !== 'ru' && language !== 'en') || language === item.sourceLanguage || typeof body.text !== 'string') throw new ContentFactoryLanguageError('Choose the other language for this translation.')
      const linkedPost = language === 'ru' ? item.socialPostId : item.enSocialPostId
      if ((language === 'en' && item.enPublishClaimed) || (language === 'ru' && item.status === 'scheduled')) throw new ContentFactoryLanguageError('This channel is being prepared for publication.')
      const source = language === 'ru' ? item.ruSourceText : item.enSourceText
      const postIdColumn = language === 'ru' ? 'social_post_id' : 'en_social_post_id'
      if (linkedPost || source !== item.generatedText) throw new ContentFactoryLanguageError('The translation is linked to Social or the source has changed.')
      validateTranslation(item.generatedText, body.text, language)
      const result = await pool.query(`UPDATE content_factory_items SET ${language}_text = $1, ${language}_approved_at = NULL, updated_at = now()
        WHERE id = $2 AND project_id = $3 AND ${postIdColumn} IS NULL AND ${language === 'en' ? 'en_publish_claimed = false' : "status <> 'scheduled'"} AND source_language <> $4
          AND ${language}_source_text = generated_text AND generated_text = $5 RETURNING id`,
      [body.text, item.id, found.projectId, language, item.generatedText])
      if (!result.rowCount) throw new ContentFactoryLanguageError('The source changed during editing. Reload it.')
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
