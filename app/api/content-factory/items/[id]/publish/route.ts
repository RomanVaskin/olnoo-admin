import { NextResponse } from 'next/server'
import { publishContentFactoryItem } from '@/lib/content-factory-publish'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = new URL(req.url).searchParams.get('project')
  if (!project) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  try {
    const result = await publishContentFactoryItem(project, id)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.item)
  } catch (err) {
    console.error('content-factory/items publish failed', err)
    return NextResponse.json({ error: 'Could not publish this item. Please try again.' }, { status: 500 })
  }
}
