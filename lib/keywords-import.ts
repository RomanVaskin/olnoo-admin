import type { Pool } from 'pg'
import type { ImportRow } from './import-parse.ts'

export type ImportFileRows = { fileName: string; rows: ImportRow[] }

/** Only these two formats are parsed; anything else (e.g. a dropped PDF) is rejected before parsing. */
export function isSupportedImportFile(fileName: string): boolean {
  return /\.(csv|xlsx)$/i.test(fileName)
}

/**
 * Merges rows from one or more Wordstat exports into one list unique by the DB key
 * (project_id, query, region) — the same keyword in two exports is one keyword. When the
 * exports disagree on frequency the highest wins, so the result does not depend on file order.
 */
export function mergeImportRows(rows: ImportRow[]): ImportRow[] {
  const merged = new Map<string, ImportRow>()
  for (const row of rows) {
    const key = `${row.keyword}\u0000${row.region}`
    const existing = merged.get(key)
    if (!existing) merged.set(key, { ...row })
    else if (row.frequency > existing.frequency) existing.frequency = row.frequency
  }
  return [...merged.values()]
}

/**
 * Upserts the merged keywords of all files in one transaction and logs one `imports` record per
 * file. An existing (project, query, region) keyword is updated (frequency, updated_at), never
 * duplicated, so re-importing the same files is a no-op update.
 */
export async function importKeywordFiles(
  pool: Pool,
  projectId: number | string,
  files: ImportFileRows[],
): Promise<{ imported: number; files: number }> {
  const rows = mergeImportRows(files.flatMap((file) => file.rows))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const row of rows) {
      await client.query(
        `
        INSERT INTO keywords (project_id, query, frequency, region, status)
        VALUES ($1, $2, $3, $4, 'active')
        ON CONFLICT (project_id, query, region)
        DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = now()
        `,
        [projectId, row.keyword, row.frequency, row.region],
      )
    }
    for (const file of files) {
      await client.query(
        `INSERT INTO imports (project_id, file_name, rows_count, status) VALUES ($1, $2, $3, 'Imported')`,
        [projectId, file.fileName, file.rows.length],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return { imported: rows.length, files: files.length }
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
