import type { Pool, PoolClient } from 'pg'
import {
  assertProjectExists,
  KeywordImportError,
  parseLegacyKey,
  recordBatchKeywords,
  upsertKeywords,
  type ImportFileRows,
} from './keywords-import.ts'
import { mergeImportRows, type KeywordRow } from './wordstat-import-rules.ts'

// Moves keywords that an import put into the wrong project. Safety rule: a keyword is removed
// from the source project only when it is proven to have been CREATED by one of the selected
// imports and nothing else references it; everything else is reported as a conflict and kept.
//
// Proof: an import writes its keywords and its log rows in one transaction, and Postgres now()
// is the transaction start time, so a keyword created by that import has keywords.created_at
// exactly equal to the import's imports.created_at / import_batches.created_at. A keyword that
// existed before (only its frequency was updated by the import) has an earlier created_at.

export type TransferScope = {
  /** Batches (import_batches.id) of the source project. */
  batchIds?: number[]
  /** Legacy (pre-batch) import groups of the source project: `l:<project id>|<timestamp>` keys. */
  legacyKeys?: string[]
}

export type TransferRequest = {
  sourceProjectId: number | string
  targetProjectId: number | string
  scope: TransferScope
  /** The re-uploaded original files. Required for legacy groups; optional for batches (their keyword list is recorded). */
  files?: ImportFileRows[]
}

export type TransferConflict = { query: string; region: string; reason: 'existed_before' | 'linked' }

export type TransferPreview = {
  keywords: number
  target: { new: number; existing: number }
  source: { found: number; toDelete: number; missing: number }
  conflicts: TransferConflict[]
}

type Db = Pool | PoolClient
type Resolved = {
  source: number
  target: number
  rows: KeywordRow[]
  scopeTimestamps: string[]
  batchIds: number[]
  legacy: { projectId: number; ts: string }[]
}

async function resolveRequest(db: Db, req: TransferRequest): Promise<Resolved> {
  const source = await assertProjectExists(db, req.sourceProjectId)
  const target = await assertProjectExists(db, req.targetProjectId)
  if (source === target) throw new KeywordImportError('Исходный и целевой проект совпадают')

  const batchIds = [...new Set(req.scope.batchIds ?? [])]
  const legacy = (req.scope.legacyKeys ?? []).map((key) => {
    const parsed = parseLegacyKey(key)
    if (!parsed || parsed.projectId !== source) throw new KeywordImportError('Импорт не относится к исходному проекту')
    return parsed
  })
  if (!batchIds.length && !legacy.length) throw new KeywordImportError('Не выбран импорт для переноса')

  const scopeTimestamps: string[] = []
  if (batchIds.length) {
    const { rows } = await db.query<{ id: number; ts: string }>(
      `SELECT id, created_at::text AS ts FROM import_batches WHERE id = ANY($1::int[]) AND project_id = $2 AND status = 'Imported'`,
      [batchIds, source],
    )
    if (rows.length !== batchIds.length) throw new KeywordImportError('Batch не найден в исходном проекте или уже перенесён')
    scopeTimestamps.push(...rows.map((r) => r.ts))
  }
  for (const group of legacy) {
    const { rows } = await db.query(
      `SELECT 1 FROM imports WHERE project_id = $1 AND batch_id IS NULL AND created_at = $2::timestamptz AND status <> 'Moved' LIMIT 1`,
      [source, group.ts],
    )
    if (!rows[0]) throw new KeywordImportError('Импорт не найден в исходном проекте или уже перенесён')
    scopeTimestamps.push(group.ts)
  }

  let rows: KeywordRow[]
  if (req.files?.length) {
    rows = mergeImportRows(req.files.flatMap((f) => f.rows))
  } else if (!legacy.length) {
    const { rows: recorded } = await db.query<{ query: string; region: string; frequency: number | null }>(
      `SELECT query, region, frequency FROM import_batch_keywords WHERE batch_id = ANY($1::int[])`,
      [batchIds],
    )
    rows = mergeImportRows(recorded.map((r) => ({ keyword: r.query, region: r.region, frequency: r.frequency ?? 0 })))
  } else {
    throw new KeywordImportError('Для импорта до batch-учёта приложите исходные файлы Wordstat')
  }
  if (!rows.length) throw new KeywordImportError('В файлах нет ключевых слов')
  return { source, target, rows, scopeTimestamps, batchIds, legacy }
}

type Classified = { preview: TransferPreview; deleteIds: number[] }

async function classify(db: Db, r: Resolved, lock: boolean): Promise<Classified> {
  const queries = r.rows.map((row) => row.keyword)
  const regions = r.rows.map((row) => row.region)
  const { rows: found } = await db.query<{ id: number; query: string; region: string; from_scope: boolean; linked: boolean }>(
    `
    SELECT k.id, k.query, COALESCE(k.region, '') AS region,
           k.created_at = ANY($4::timestamptz[]) AS from_scope,
           (EXISTS (SELECT 1 FROM seo_cluster_keywords c WHERE c.keyword_id = k.id)
            OR EXISTS (SELECT 1 FROM keyword_pages kp WHERE kp.keyword_id = k.id)
            OR EXISTS (SELECT 1 FROM seo_clusters s WHERE s.primary_keyword_id = k.id)) AS linked
    FROM keywords k
    JOIN unnest($2::text[], $3::text[]) AS t(q, r) ON k.query = t.q AND COALESCE(k.region, '') = t.r
    WHERE k.project_id = $1
    ORDER BY k.query, k.region
    ${lock ? 'FOR UPDATE OF k' : ''}
    `,
    [r.source, queries, regions, r.scopeTimestamps],
  )
  const { rows: inTarget } = await db.query<{ n: number }>(
    `
    SELECT count(*)::int AS n FROM keywords k
    JOIN unnest($2::text[], $3::text[]) AS t(q, r) ON k.query = t.q AND COALESCE(k.region, '') = t.r
    WHERE k.project_id = $1
    `,
    [r.target, queries, regions],
  )

  const conflicts: TransferConflict[] = []
  const deleteIds: number[] = []
  for (const row of found) {
    if (!row.from_scope) conflicts.push({ query: row.query, region: row.region, reason: 'existed_before' })
    else if (row.linked) conflicts.push({ query: row.query, region: row.region, reason: 'linked' })
    else deleteIds.push(row.id)
  }
  const existing = inTarget[0].n
  return {
    deleteIds,
    preview: {
      keywords: r.rows.length,
      target: { new: r.rows.length - existing, existing },
      source: { found: found.length, toDelete: deleteIds.length, missing: r.rows.length - found.length },
      conflicts,
    },
  }
}

/** Read-only: what a transfer would do. Nothing is written. */
export async function previewKeywordTransfer(pool: Pool, req: TransferRequest): Promise<TransferPreview> {
  const resolved = await resolveRequest(pool, req)
  return (await classify(pool, resolved, false)).preview
}

/**
 * One transaction: upsert every keyword of the files/batch into the target project as a new
 * 'transfer' batch, delete from the source only the keywords proven to come from the selected
 * imports (conflicts stay), and mark the source imports as Moved. The plan is recomputed under
 * row locks, so it reflects the data at commit time, not at preview time.
 */
export async function transferKeywords(
  pool: Pool,
  req: TransferRequest,
): Promise<TransferPreview & { batchId: number; deleted: number }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const resolved = await resolveRequest(client, req)
    const { preview, deleteIds } = await classify(client, resolved, true)

    const { rows: batchRows } = await client.query<{ id: number }>(
      `INSERT INTO import_batches (project_id, kind, source_project_id, status, files_count, keywords_count)
       VALUES ($1, 'transfer', $2, 'Imported', $3, $4) RETURNING id`,
      [resolved.target, resolved.source, req.files?.length ?? 0, resolved.rows.length],
    )
    const batchId = batchRows[0].id
    const upserted = await upsertKeywords(client, resolved.target, resolved.rows)
    await recordBatchKeywords(client, batchId, resolved.rows, upserted)
    for (const file of req.files ?? []) {
      await client.query(
        `INSERT INTO imports (project_id, file_name, rows_count, status, batch_id) VALUES ($1, $2, $3, 'Imported', $4)`,
        [resolved.target, file.fileName, file.rows.length, batchId],
      )
    }

    const { rowCount } = await client.query('DELETE FROM keywords WHERE project_id = $1 AND id = ANY($2::int[])', [
      resolved.source,
      deleteIds,
    ])
    if (resolved.batchIds.length) {
      await client.query(`UPDATE import_batches SET status = 'Moved' WHERE id = ANY($1::int[])`, [resolved.batchIds])
      await client.query(`UPDATE imports SET status = 'Moved' WHERE batch_id = ANY($1::int[])`, [resolved.batchIds])
    }
    for (const group of resolved.legacy) {
      await client.query(
        `UPDATE imports SET status = 'Moved' WHERE project_id = $1 AND batch_id IS NULL AND created_at = $2::timestamptz`,
        [group.projectId, group.ts],
      )
    }
    await client.query('COMMIT')
    return { ...preview, batchId, deleted: rowCount ?? 0 }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

