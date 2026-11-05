import type { Pool } from 'pg'

/** The existing reverse proxy verifies Basic credentials; the app does not have users/roles.
 * Like AI Router actions, refuse requests without the forwarded Basic header. The Next port
 * must remain private. Require an explicit same-site Origin for these destructive writes.
 */
export function istraArtDeleteAccess(req: Request): Response | null {
  const url = new URL(req.url)
  const origin = req.headers.get('origin')
  const allowedOrigin = origin === 'https://admin.olnoo.com'
    || (process.env.NODE_ENV !== 'production' && origin === url.origin)
  if (!/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(req.headers.get('authorization') ?? '') || !allowedOrigin) {
    return Response.json({ error: 'Нет доступа. Войдите в OLNOO Admin и повторите запрос.' }, { status: 403 })
  }
  if (url.searchParams.get('project') !== 'istraart') return Response.json({ error: 'Not found' }, { status: 404 })
  return null
}

type DeleteResult = { status: number; body: { id?: string; error?: string; catalogCardCount?: number } }
const missing = (): DeleteResult => ({ status: 404, body: { error: 'Запись не найдена или уже удалена.' } })

/** Lock the source before counting: concurrent card creation cannot bypass the FK restriction.
 * Files and Social posts/publications are intentionally retained; no platform API calls.
 */
export async function deleteIstraArtMaterial(pool: Pool, projectId: number, id: string): Promise<DeleteResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`SELECT i.id, i.status, i.en_publish_claimed, i.en_social_post_id
      FROM content_factory_items i JOIN projects p ON p.id = i.project_id
      WHERE i.id = $1 AND i.project_id = $2 AND p.slug = 'istraart' AND p.archived_at IS NULL
      FOR UPDATE OF i`, [id, projectId])
    if (!rows[0]) { await client.query('ROLLBACK'); return missing() }
    const linked = await client.query(`SELECT COUNT(*)::int AS count FROM catalog_cards
      WHERE content_item_id = $1 AND project_id = $2`, [id, projectId])
    const count = linked.rows[0].count as number
    if (count > 0) {
      await client.query('ROLLBACK')
      return { status: 409, body: { error: `С материалом связаны карточки товаров: ${count}. Сначала удалите карточки.`, catalogCardCount: count } }
    }
    const current = rows[0]
    if (['processing', 'scheduled'].includes(current.status) || (current.en_publish_claimed && !current.en_social_post_id)) {
      await client.query('ROLLBACK')
      return { status: 409, body: { error: 'Материал сейчас обрабатывается или публикуется. Дождитесь завершения операции.' } }
    }
    const deleted = await client.query('DELETE FROM content_factory_items WHERE id = $1 AND project_id = $2 RETURNING id', [id, projectId])
    await client.query('COMMIT')
    return deleted.rows[0] ? { status: 200, body: { id: deleted.rows[0].id } } : missing()
  } catch (error) {
    await client.query('ROLLBACK')
    if ((error as { code?: string }).code === '23503') return { status: 409, body: { error: 'У материала есть связанные записи. Обновите список и сначала удалите карточки товаров.' } }
    throw error
  } finally { client.release() }
}

export async function deleteIstraArtCard(pool: Pool, projectId: number, id: string): Promise<DeleteResult> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) return missing()
  try {
    const deleted = await pool.query(`DELETE FROM catalog_cards c USING projects p, content_factory_items i
      WHERE c.id = $1 AND c.project_id = $2 AND p.id = c.project_id
        AND p.slug = 'istraart' AND p.archived_at IS NULL
        AND i.id = c.content_item_id AND i.project_id = c.project_id AND i.origin_kind = 'own'
      RETURNING c.id`, [id, projectId])
    return deleted.rows[0] ? { status: 200, body: { id: deleted.rows[0].id } } : missing()
  } catch (error) {
    // Existing parent FK is RESTRICT: never cascade into another product/guide.
    if ((error as { code?: string }).code === '23503') return { status: 409, body: { error: 'С товаром связан DIY-гайд. Сначала удалите его в списке карточек прежнего формата.' } }
    throw error
  }
}
