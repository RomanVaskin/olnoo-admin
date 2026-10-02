import type { Pool, PoolClient } from 'pg'
import type { ImportRow } from './import-parse.ts'
import { mergeImportRows, type KeywordRow } from './wordstat-import-rules.ts'

export { isSupportedImportFile, mergeImportRows } from './wordstat-import-rules.ts'

export type ImportFileRows = { fileName: string; rows: ImportRow[] }

/** A user-facing rejection (unknown project, …): the route answers 400 with its message. */
export class KeywordImportError extends Error {}

type Db = Pool | PoolClient

export async function assertProjectExists(db: Db, projectId: number | string): Promise<number> {
  const id = Number(projectId)
  if (!Number.isInteger(id) || id <= 0) throw new KeywordImportError('Неизвестный проект')
  const { rows } = await db.query('SELECT 1 FROM projects WHERE id = $1', [id])
  if (!rows[0]) throw new KeywordImportError('Неизвестный проект')
  return id
}

/**
 * Upserts unique rows into a project's keywords in one statement. An existing (project, query,
 * region) keyword gets frequency/updated_at updated — never a duplicate. Reports per row whether
 * it was inserted (xmax = 0 is Postgres' "this statement inserted the row") or updated.
 */
export async function upsertKeywords(
  db: Db,
  projectId: number,
  rows: KeywordRow[],
): Promise<{ query: string; region: string; inserted: boolean }[]> {
  if (!rows.length) return []
  const { rows: result } = await db.query<{ query: string; region: string; inserted: boolean }>(
    `
    INSERT INTO keywords (project_id, query, frequency, region, status)
    SELECT $1, t.q, t.f, t.r, 'active' FROM unnest($2::text[], $3::int[], $4::text[]) AS t(q, f, r)
    ON CONFLICT (project_id, query, region)
    DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = now()
    RETURNING query, region, (xmax = 0) AS inserted
    `,
    [projectId, rows.map((r) => r.keyword), rows.map((r) => r.frequency), rows.map((r) => r.region)],
  )
  return result
}

/** Records which keywords a batch brought and whether it created each one. */
export async function recordBatchKeywords(
  db: Db,
  batchId: number,
  rows: KeywordRow[],
  upserted: { query: string; region: string; inserted: boolean }[],
): Promise<void> {
  if (!rows.length) return
  const inserted = new Map(upserted.map((u) => [`${u.query}\u0000${u.region}`, u.inserted]))
  await db.query(
    `
    INSERT INTO import_batch_keywords (batch_id, query, region, frequency, created)
    SELECT $1, t.q, t.r, t.f, t.c FROM unnest($2::text[], $3::text[], $4::int[], $5::boolean[]) AS t(q, r, f, c)
    `,
    [
      batchId,
      rows.map((r) => r.keyword),
      rows.map((r) => r.region),
      rows.map((r) => r.frequency),
      rows.map((r) => inserted.get(`${r.keyword}\u0000${r.region}`) === true),
    ],
  )
}

export type ImportBatchResult = { batchId: number; imported: number; created: number; updated: number; files: number }

/**
 * Imports N files as ONE batch in one transaction: merged keywords are upserted, the batch and
 * its keyword list are recorded, and one `imports` row per file points at the batch. Any error
 * rolls everything back — no partial batch.
 */
export async function importKeywordFiles(
  pool: Pool,
  projectId: number | string,
  files: ImportFileRows[],
): Promise<ImportBatchResult> {
  const rows = mergeImportRows(files.flatMap((file) => file.rows))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const project = await assertProjectExists(client, projectId)
    const { rows: batchRows } = await client.query<{ id: number }>(
      `INSERT INTO import_batches (project_id, kind, status, files_count, keywords_count)
       VALUES ($1, 'import', 'Imported', $2, $3) RETURNING id`,
      [project, files.length, rows.length],
    )
    const batchId = batchRows[0].id
    const upserted = await upsertKeywords(client, project, rows)
    await recordBatchKeywords(client, batchId, rows, upserted)
    for (const file of files) {
      await client.query(
        `INSERT INTO imports (project_id, file_name, rows_count, status, batch_id) VALUES ($1, $2, $3, 'Imported', $4)`,
        [project, file.fileName, file.rows.length, batchId],
      )
    }
    await client.query('COMMIT')
    const created = upserted.filter((u) => u.inserted).length
    return { batchId, imported: rows.length, created, updated: rows.length - created, files: files.length }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Single-file import; re-running with the same rows is a no-op update, not a duplicate insert. */
export async function importKeywordRows(
  pool: Pool,
  projectId: number | string,
  fileName: string,
  rows: ImportRow[],
): Promise<{ imported: number }> {
  const { imported } = await importKeywordFiles(pool, projectId, [{ fileName, rows }])
  return { imported }
}

export type ImportHistoryFile = { fileName: string; rowsCount: number; status: string }
export type ImportHistoryGroup = {
  /** `b:<batch id>` or, for imports made before batches existed, `l:<transaction timestamp>`. */
  key: string
  batchId: number | null
  legacy: boolean
  kind: string
  projectId: number
  projectName: string
  status: string
  createdAt: string
  filesCount: number
  rowsCount: number
  /** Unique keywords of the batch; for a legacy group: keywords still in the project that it created. */
  keywordsCount: number
  files: ImportHistoryFile[]
}

/**
 * Import history grouped by operation, newest first. Legacy imports (batch_id NULL) are grouped by
 * their transaction timestamp: a pre-batch import wrote its keywords and its `imports` rows in one
 * transaction, so they share created_at exactly (Postgres now() is the transaction start time).
 */
export async function listImportHistory(
  pool: Pool,
  { limit, offset, projectId }: { limit: number; offset: number; projectId?: number | null },
): Promise<{ groups: ImportHistoryGroup[]; hasMore: boolean }> {
  const take = offset + limit + 1
  const project = projectId ?? null
  const [batches, legacy] = await Promise.all([
    pool.query(
      `
      SELECT b.id, b.kind, b.status, b.project_id, p.name AS project_name,
             b.created_at, b.files_count, b.keywords_count,
             COALESCE((SELECT sum(rows_count) FROM imports i WHERE i.batch_id = b.id), 0)::int AS rows_count
      FROM import_batches b
      JOIN projects p ON p.id = b.project_id
      WHERE ($1::int IS NULL OR b.project_id = $1::int)
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $2
      `,
      [project, take],
    ),
    pool.query(
      `
      SELECT i.project_id, p.name AS project_name, i.created_at::text AS ts, max(i.created_at) AS created_at,
             count(*)::int AS files_count, sum(i.rows_count)::int AS rows_count,
             CASE WHEN count(DISTINCT i.status) = 1 THEN min(i.status) ELSE 'Imported' END AS status,
             (SELECT count(*)::int FROM keywords k WHERE k.project_id = i.project_id AND k.created_at = i.created_at) AS keywords_count
      FROM imports i
      JOIN projects p ON p.id = i.project_id
      WHERE i.batch_id IS NULL AND ($1::int IS NULL OR i.project_id = $1::int)
      GROUP BY i.project_id, p.name, i.created_at
      ORDER BY i.created_at DESC
      LIMIT $2
      `,
      [project, take],
    ),
  ])

  const groups: (ImportHistoryGroup & { sortAt: number })[] = [
    ...batches.rows.map((b) => ({
      key: `b:${b.id}`,
      batchId: b.id as number,
      legacy: false,
      kind: b.kind as string,
      projectId: b.project_id as number,
      projectName: b.project_name as string,
      status: b.status as string,
      createdAt: new Date(b.created_at).toISOString(),
      sortAt: new Date(b.created_at).getTime(),
      filesCount: b.files_count as number,
      rowsCount: b.rows_count as number,
      keywordsCount: b.keywords_count as number,
      files: [],
    })),
    ...legacy.rows.map((l) => ({
      key: `l:${l.project_id}|${l.ts}`,
      batchId: null,
      legacy: true,
      kind: 'import',
      projectId: l.project_id as number,
      projectName: l.project_name as string,
      status: l.status as string,
      createdAt: new Date(l.created_at).toISOString(),
      sortAt: new Date(l.created_at).getTime(),
      filesCount: l.files_count as number,
      rowsCount: l.rows_count as number,
      keywordsCount: l.keywords_count as number,
      files: [],
    })),
  ].sort((a, b) => b.sortAt - a.sortAt)

  const page = groups.slice(offset, offset + limit)
  await attachFiles(pool, page)
  return { groups: page.map(({ sortAt: _sortAt, ...group }) => group), hasMore: groups.length > offset + limit }
}

async function attachFiles(pool: Pool, groups: ImportHistoryGroup[]) {
  const batchIds = groups.filter((g) => g.batchId !== null).map((g) => g.batchId as number)
  const legacy = groups.filter((g) => g.legacy).map((g) => parseLegacyKey(g.key)!)
  const { rows } = await pool.query(
    `
    SELECT i.batch_id, i.project_id, i.created_at::text AS ts, i.file_name, i.rows_count, i.status
    FROM imports i
    WHERE i.batch_id = ANY($1::int[])
       OR (i.batch_id IS NULL AND (i.project_id, i.created_at) IN (
             SELECT * FROM unnest($2::int[], $3::timestamptz[])))
    ORDER BY i.id
    `,
    [batchIds, legacy.map((l) => l.projectId), legacy.map((l) => l.ts)],
  )
  for (const row of rows) {
    const key = row.batch_id !== null ? `b:${row.batch_id}` : `l:${row.project_id}|${row.ts}`
    groups.find((g) => g.key === key)?.files.push({ fileName: row.file_name, rowsCount: row.rows_count, status: row.status })
  }
}

/** `l:<project id>|<timestamptz text>` → its parts (the timestamp text round-trips exactly through ::timestamptz). */
export function parseLegacyKey(key: string): { projectId: number; ts: string } | null {
  const match = /^l:(\d+)\|(.+)$/.exec(key)
  return match ? { projectId: Number(match[1]), ts: match[2] } : null
}
