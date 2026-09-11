import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { UPLOADS_ROOT, isValidProjectSlug, isValidUploadFilename } from '@/lib/social-instagram-uploads'

// Serves a file written by POST /api/social/upload-instagram-image. Explicit route handler rather
// than Next's public/ folder — see lib/social-instagram-uploads.ts for why. project and filename
// are each checked against a strict allow-list regex before ever touching the filesystem, so this
// can only ever resolve to a path under UPLOADS_ROOT — no ".." or other traversal is possible
// regardless of what's requested.
export async function GET(_req: Request, { params }: { params: Promise<{ project: string; filename: string }> }) {
  const { project, filename } = await params
  if (!isValidProjectSlug(project) || !isValidUploadFilename(filename)) {
    return new NextResponse(null, { status: 404 })
  }

  const bytes = await readFile(path.join(UPLOADS_ROOT, project, filename)).catch(() => null)
  if (!bytes) {
    return new NextResponse(null, { status: 404 })
  }

  return new NextResponse(bytes, {
    headers: {
      'Content-Type': 'image/jpeg',
      // Safe to cache forever: filenames are fresh random UUIDs, never reused or overwritten.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
