import path from 'node:path'

// Where uploaded Instagram images actually live on disk — a plain top-level directory outside
// public/, gitignored, never committed. Not served by Next's implicit public/ static handler:
// in this Next.js version, a root-level static request collides with the app/[locale] dynamic
// segment and 404s before the file is ever checked (confirmed by direct testing — public/ files,
// even ones present at build time, return 404 the same way an unmatched locale does). So this is
// served instead by an explicit route handler (app/api/social/instagram-image/[project]/[filename])
// that reads the file itself — still zero new services, same disk, same app process.
export const UPLOADS_ROOT = path.join(process.cwd(), 'uploads', 'instagram')

// Matches the exact slug pattern resolveProjectId's callers already rely on (lowercase
// alphanumeric + hyphen) — used again here as a filesystem-path safety net, on top of
// resolveProjectId's own DB-backed validation.
export function isValidProjectSlug(value: string | null): value is string {
  return !!value && /^[a-z0-9-]+$/.test(value)
}

// Filenames are always a fresh crypto.randomUUID() + ".jpg" written by the upload route — this
// regex is the read side's independent check that a requested filename can only ever be exactly
// that shape, so a path-traversal attempt (or any other input) never reaches the filesystem call.
const UPLOAD_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/

export function isValidUploadFilename(value: string | null): value is string {
  return !!value && UPLOAD_FILENAME_RE.test(value)
}
