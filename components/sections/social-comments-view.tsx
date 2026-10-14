'use client'

import { useEffect, useState } from 'react'
import { SectionHeader, HeaderActions, TableShell, Th, Td } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'

type SocialComment = {
  id: string
  authorName: string
  authorUsername: string
  body: string
  externalPostedAt: string
  createdAt: string
  publicationExternalUrl: string
}

function fromApiComment(row: Record<string, unknown>): SocialComment {
  return {
    id: row.id as string,
    authorName: (row.author_name as string) ?? '',
    authorUsername: (row.author_username as string) ?? '',
    body: (row.body as string) ?? '',
    externalPostedAt: (row.external_posted_at as string) ?? '',
    createdAt: row.created_at as string,
    publicationExternalUrl: (row.publication_external_url as string) ?? '',
  }
}

/**
 * Minimal, read-only MVP (Social Community): new Telegram channel comments, auto-captured via the
 * webhook (app/api/telegram/comments-webhook/route.ts) and shown here for the selected project —
 * no reply, no generation, no CRM lead, same deliberate scope limit as the task that built this.
 *
 * No "All projects" aggregate (same deliberate simplicity as /api/ads — see OLNOO_PROJECT_MAP.md's
 * "Ads" section): `ProjectSelector` is still rendered (requirement: reuse the existing component),
 * but choosing "All projects" shows a prompt instead of a cross-project list — avoiding Ads' own
 * dead-end (it renders nothing at all for "all", with no selector on screen to switch back).
 */
export function SocialCommentsView({ project, onProjectChange }: { project: string; onProjectChange: (id: string) => void }) {
  const { t } = useI18n()
  const [comments, setComments] = useState<SocialComment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (project === 'all') {
      setComments([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/social-comments?project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((rows) => {
        if (cancelled) return
        setComments((rows as Record<string, unknown>[]).map(fromApiComment))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project])

  function formatTime(value: string): string {
    if (!value) return '—'
    return new Date(value).toLocaleString()
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="04"
        title={t.socialCommentsView.title}
        description={t.socialCommentsView.description}
        action={
          <HeaderActions>
            <ProjectSelector value={project} onChange={onProjectChange} />
          </HeaderActions>
        }
      />

      {project === 'all' ? (
        <p className="label-mono text-muted-foreground">{t.socialCommentsView.selectProjectHint}</p>
      ) : (
        <TableShell>
          <thead>
            <tr>
              <Th>{t.socialCommentsView.author}</Th>
              <Th>{t.socialCommentsView.comment}</Th>
              <Th>{t.socialCommentsView.post}</Th>
              <Th>{t.socialCommentsView.time}</Th>
            </tr>
          </thead>
          <tbody>
            {comments.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium text-foreground">
                  {c.authorUsername ? `@${c.authorUsername}` : c.authorName || '—'}
                </Td>
                <Td className="max-w-[420px] whitespace-pre-wrap text-foreground/90">{c.body || '—'}</Td>
                <Td>
                  {c.publicationExternalUrl ? (
                    <a
                      href={c.publicationExternalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="label-mono text-foreground underline-offset-2 hover:underline"
                    >
                      {t.socialCommentsView.openPost}
                    </a>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td className="text-muted-foreground">{formatTime(c.externalPostedAt || c.createdAt)}</Td>
              </tr>
            ))}
            {!loading && comments.length === 0 && (
              <tr>
                <Td className="text-muted-foreground">
                  <span className="label-mono">{t.socialCommentsView.noResults}</span>
                </Td>
                <Td> </Td>
                <Td> </Td>
                <Td> </Td>
              </tr>
            )}
          </tbody>
        </TableShell>
      )}
    </div>
  )
}
