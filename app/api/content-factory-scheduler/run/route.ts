import { timingSafeEqual } from 'node:crypto'
import { publishContentFactoryItem } from '@/lib/content-factory-publish'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { runContentFactorySourceSweep } from '@/lib/content-factory-scheduler'

// Same internal scheduler route. The server-only token protects collection and paid work;
// automation remains off unless CONTENT_FACTORY_AUTOMATION_ENABLED is explicitly true.
// Existing project Automation settings are not an opt-in for per-source publishing.
export async function POST(req: Request) {
  const token = process.env.CONTENT_FACTORY_SCHEDULER_TOKEN
  if (!token || token.length < 32) {
    return NextResponse.json({ error: 'CONTENT_FACTORY_SCHEDULER_TOKEN is not configured on the server' }, { status: 503 })
  }
  const provided = req.headers.get('x-scheduler-token') ?? ''
  if (Buffer.byteLength(provided) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const results = await runContentFactorySourceSweep(pool, { enabled: process.env.CONTENT_FACTORY_AUTOMATION_ENABLED === 'true', publish: publishContentFactoryItem })
    const createdTotal = results.reduce((sum, r) => sum + r.createdCount, 0)
    console.log(`content-factory-scheduler: checked ${results.length} source(s), ${createdTotal} new item(s)`)
    return NextResponse.json({ checkedCount: results.length, createdTotal, results })
  } catch (err) {
    console.error('content-factory-scheduler/run failed')
    return NextResponse.json({ error: 'scheduler run failed' }, { status: 500 })
  }
}
