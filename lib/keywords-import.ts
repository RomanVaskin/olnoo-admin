import type { Pool } from 'pg'
import type { ImportRow } from './import-parse.ts'

/** Upserts parsed Wordstat rows and records the import; re-running with the same rows is a no-op update, not a duplicate insert. */
export async function importKeywordRows(
  pool: Pool,
  projectId: number | string,
  fileName: string,
  rows: ImportRow[],
): Promise<{ imported: number }> {
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
    await client.query(
      `INSERT INTO imports (project_id, file_name, rows_count, status) VALUES ($1, $2, $3, 'Imported')`,
      [projectId, fileName, rows.length],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return { imported: rows.length }
}
