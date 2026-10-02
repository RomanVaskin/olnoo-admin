import type { Pool, PoolClient } from 'pg'
import { KeywordImportError, parseLegacyKey } from './keywords-import.ts'

// «Удалить импорт»: undoes one import (batch or pre-batch group) without guessing. A keyword is
// deleted only when it is PROVEN to have been created by that import and no SEO entity uses it:
//  - batch: import_batch_keywords.created = true AND keywords.created_at = import_batches.created_at;
//  - legacy group: keywords.created_at = the import transaction's timestamp (an import wrote its
//    keywords and imports rows in one transaction; Postgres now() is the transaction start).
// Keywords that existed before (only their frequency was updated) and linked keywords stay; the
// history record is kept with status 'Deleted'.

/** True when SEO entities reference keyword `k` — such keywords are never deleted automatically. */
const KEYWORD_LINKED_SQL = `(EXISTS (SELECT 1 FROM seo_cluster_keywords c WHERE c.keyword_id = k.id)
            OR EXISTS (SELECT 1 FROM keyword_pages kp WHERE kp.keyword_id = k.id)
            OR EXISTS (SELECT 1 FROM seo_clusters s WHERE s.primary_keyword_id = k.id))`

export type ImportDeletePreview = {
  projectId: number
  projectName: string
  createdAt: string
  files: number
  /** Batch: every keyword it brought. Legacy: keywords still in the project that it created. */
  keywords: number
  toDelete: number
  /** Updated (not created) by this import — kept. For legacy: those not touched again since. */
  existedBefore: number
  linked: { query: string; region: string }[]
  /** Batch keywords no longer in the project (or no longer provably the batch's). Unknown (null) for legacy groups. */
  notFound: number | null
}

type Db = Pool | PoolClient
type Plan = ImportDeletePreview & { deleteIds: number[]; batchId: number | null; ts: string }

async function plan(db: Db, key: string, lock: boolean): Promise<Plan> {
  const forUpdate = lock ? 'FOR UPDATE OF k' : ''
  if (key.startsWith('b:')) {
    const batchId = Number(key.slice(2))
    const { rows } = await db.query(
      `SELECT b.id, b.project_id, p.name AS project_name, b.created_at, b.created_at::text AS ts, b.status, b.kind, b.files_count
       FROM import_batches b JOIN projects p ON p.id = b.project_id WHERE b.id = $1 ${lock ? 'FOR UPDATE OF b' : ''}`,
      [Number.isInteger(batchId) ? batchId : -1],
    )
    const batch = rows[0]
    if (!batch || batch.kind !== 'import') throw new KeywordImportError('Импорт не найден')
    if (batch.status !== 'Imported') throw new KeywordImportError('Этот импорт уже удалён')

    const total = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM import_batch_keywords WHERE batch_id = $1', [batchId])).rows[0].n
    const { rows: found } = await db.query<{ id: number; query: string; region: string; was_created: boolean; provable: boolean; linked: boolean }>(
      `
      SELECT k.id, k.query, COALESCE(k.region, '') AS region, bk.created AS was_created,
             (bk.created AND k.created_at = $3::timestamptz) AS provable,
             ${KEYWORD_LINKED_SQL} AS linked
      FROM import_batch_keywords bk
      JOIN keywords k ON k.project_id = $2 AND k.query = bk.query AND COALESCE(k.region, '') = bk.region
      WHERE bk.batch_id = $1
      ORDER BY k.query, k.region
      ${forUpdate}
      `,
      [batchId, batch.project_id, batch.ts],
    )
    const provable = found.filter((r) => r.provable)
    const deletable = provable.filter((r) => !r.linked)
    const existedBefore = found.filter((r) => !r.was_created).length
    return {
      batchId,
      ts: batch.ts,
      projectId: batch.project_id,
      projectName: batch.project_name,
      createdAt: new Date(batch.created_at).toISOString(),
      files: batch.files_count,
      keywords: total,
      deleteIds: deletable.map((r) => r.id),
      toDelete: deletable.length,
      existedBefore,
      linked: provable.filter((r) => r.linked).map(({ query, region }) => ({ query, region })),
      // Gone from the project, or re-created later (created_at no longer the batch's) — not provable.
      notFound: total - provable.length - existedBefore,
    }
  }

  const legacy = parseLegacyKey(key)
  if (!legacy) throw new KeywordImportError('Импорт не найден')
  const { rows: imports } = await db.query<{ status: string; project_name: string; created_at: Date }>(
    `SELECT i.status, p.name AS project_name, i.created_at FROM imports i JOIN projects p ON p.id = i.project_id
     WHERE i.project_id = $1 AND i.batch_id IS NULL AND i.created_at = $2::timestamptz ${lock ? 'FOR UPDATE OF i' : ''}`,
    [legacy.projectId, legacy.ts],
  )
  if (!imports.length) throw new KeywordImportError('Импорт не найден')
  if (imports.some((i) => i.status !== 'Imported')) throw new KeywordImportError('Этот импорт уже удалён')

  const { rows: created } = await db.query<{ id: number; query: string; region: string; linked: boolean }>(
    `SELECT k.id, k.query, COALESCE(k.region, '') AS region, ${KEYWORD_LINKED_SQL} AS linked
     FROM keywords k WHERE k.project_id = $1 AND k.created_at = $2::timestamptz ORDER BY k.query, k.region ${forUpdate}`,
    [legacy.projectId, legacy.ts],
  )
  const existedBefore = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM keywords WHERE project_id = $1 AND updated_at = $2::timestamptz AND created_at < $2::timestamptz`,
      [legacy.projectId, legacy.ts],
    )
  ).rows[0].n
  const deletable = created.filter((r) => !r.linked)
  return {
    batchId: null,
    ts: legacy.ts,
    projectId: legacy.projectId,
    projectName: imports[0].project_name,
    createdAt: new Date(imports[0].created_at).toISOString(),
    files: imports.length,
    keywords: created.length,
    deleteIds: deletable.map((r) => r.id),
    toDelete: deletable.length,
    existedBefore,
    linked: created.filter((r) => r.linked).map(({ query, region }) => ({ query, region })),
    notFound: null,
  }
}

function publicPreview({ deleteIds: _ids, batchId: _batch, ts: _ts, ...preview }: Plan): ImportDeletePreview {
  return preview
}

/** Read-only: what «Удалить импорт» would do. */
export async function previewImportDelete(pool: Pool, key: string): Promise<ImportDeletePreview> {
  return publicPreview(await plan(pool, key, false))
}

/**
 * One transaction: re-plan under row locks, delete only the provable, unlinked keywords, mark the
 * import 'Deleted' (history kept). A second call is refused because the import is no longer 'Imported'.
 */
export async function deleteImport(pool: Pool, key: string): Promise<ImportDeletePreview & { deleted: number }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const p = await plan(client, key, true)
    const { rowCount } = await client.query('DELETE FROM keywords WHERE project_id = $1 AND id = ANY($2::int[])', [p.projectId, p.deleteIds])
    if (p.batchId !== null) {
      await client.query(`UPDATE import_batches SET status = 'Deleted' WHERE id = $1`, [p.batchId])
      await client.query(`UPDATE imports SET status = 'Deleted' WHERE batch_id = $1`, [p.batchId])
    } else {
      await client.query(`UPDATE imports SET status = 'Deleted' WHERE project_id = $1 AND batch_id IS NULL AND created_at = $2::timestamptz`, [
        p.projectId,
        p.ts,
      ])
    }
    await client.query('COMMIT')
    return { ...publicPreview(p), deleted: rowCount ?? 0 }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
