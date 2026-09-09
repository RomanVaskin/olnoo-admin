import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { isLeadStatus } from '@/lib/crm'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid request' }, { status: 400 })

  const sets: string[] = []
  const values: unknown[] = []
  let i = 1

  function set(column: string, value: unknown) {
    sets.push(`${column} = $${i}`)
    values.push(value)
    i++
  }

  if (typeof body.name === 'string') {
    if (!body.name.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    set('name', body.name.trim())
  }
  if (typeof body.email === 'string') {
    if (!/^\S+@\S+\.\S+$/.test(body.email)) {
      return NextResponse.json({ error: 'a valid email is required' }, { status: 400 })
    }
    set('email', body.email.trim())
  }
  if (typeof body.company === 'string') set('company', body.company.trim())
  if (typeof body.service === 'string') set('service', body.service.trim())
  if (typeof body.message === 'string') set('message', body.message)
  if (typeof body.notes === 'string') set('notes', body.notes)
  if (typeof body.status !== 'undefined') {
    if (!isLeadStatus(body.status)) return NextResponse.json({ error: 'invalid status' }, { status: 400 })
    set('status', body.status)
  }

  if (!sets.length) {
    const { rows } = await pool.query('SELECT * FROM leads WHERE id = $1', [id])
    if (!rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json(rows[0])
  }

  sets.push('updated_at = now()')
  values.push(id)

  const { rows } = await pool.query(
    `UPDATE leads SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values,
  )
  if (!rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(rows[0])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { rowCount } = await pool.query('DELETE FROM leads WHERE id = $1', [id])
  if (!rowCount) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
