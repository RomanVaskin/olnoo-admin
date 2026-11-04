import type { Pool } from 'pg'
import { ISTRAART_STYLE_DEFAULT, validateIstraArtStyle } from './istraart-style.ts'
export async function getIstraArtStyle(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query("SELECT istraart_style_prompt FROM projects WHERE slug='istraart' AND archived_at IS NULL")
  return rows[0] ? rows[0].istraart_style_prompt ?? ISTRAART_STYLE_DEFAULT : null
}
export async function saveIstraArtStyle(pool: Pool, value: unknown): Promise<string | null> {
  const prompt = validateIstraArtStyle(value)
  const { rows } = await pool.query("UPDATE projects SET istraart_style_prompt=$1 WHERE slug='istraart' AND archived_at IS NULL RETURNING istraart_style_prompt", [prompt])
  return rows[0]?.istraart_style_prompt ?? null
}
