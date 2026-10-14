'use client'

import { useEffect, useState } from 'react'
import { SectionHeader, HeaderActions, TableShell, Th, Td } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'

type ReplyStatus = 'sending' | 'sent' | 'failed'

type SocialComment = {
  id: string
  authorName: string
  authorUsername: string
  body: string
  externalPostedAt: string
  createdAt: string
  publicationExternalUrl: string
  replyStatus: ReplyStatus | null
  replyBody: string
  replyError: string
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
    replyStatus: (row.reply_status as ReplyStatus | null) ?? null,
    replyBody: (row.reply_body as string) ?? '',
    replyError: (row.reply_error as string) ?? '',
  }
}

/** Ephemeral, per-comment state for the AI-suggested-reply flow — never persisted until a human
 * clicks "Отправить"; "Сгенерировать заново" just re-runs `suggest`, replacing `draft` in place.
 * Kept separate from `SocialComment` (the server's own, reload-driven state) since a suggestion is
 * explicitly NOT saved anywhere until sent (requirement: "Никакой автоматической отправки без
 * подтверждения человека"). */
type ReplyDraftState = {
  draft: string
  suggesting: boolean
  sending: boolean
  error: string
}

function ReplyCell({
  comment,
  project,
  draft,
  onDraftChange,
  onSent,
}: {
  comment: SocialComment
  project: string
  draft: ReplyDraftState | undefined
  onDraftChange: (next: ReplyDraftState | undefined) => void
  onSent: (row: Record<string, unknown>) => void
}) {
  const { t } = useI18n()

  async function suggest() {
    onDraftChange({ draft: draft?.draft ?? '', suggesting: true, sending: false, error: '' })
    try {
      const res = await fetch(`/api/social-comments/${comment.id}/suggest-reply?project=${encodeURIComponent(project)}`, {
        method: 'POST',
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || typeof data?.reply !== 'string') {
        onDraftChange({ draft: draft?.draft ?? '', suggesting: false, sending: false, error: (data && data.error) || t.socialCommentsView.suggestError })
        return
      }
      onDraftChange({ draft: data.reply, suggesting: false, sending: false, error: '' })
    } catch {
      onDraftChange({ draft: draft?.draft ?? '', suggesting: false, sending: false, error: t.socialCommentsView.suggestError })
    }
  }

  async function send() {
    if (!draft) return
    onDraftChange({ ...draft, sending: true, error: '' })
    try {
      const res = await fetch(`/api/social-comments/${comment.id}/send-reply?project=${encodeURIComponent(project)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: draft.draft }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) {
        onDraftChange({ ...draft, sending: false, error: (data && data.error) || t.socialCommentsView.sendError })
        return
      }
      // A 'sending' row here means Telegram's own outcome was unknown (timeout/dropped
      // connection) — requirement 8: never auto-retried. The draft is cleared either way since the
      // claim already exists server-side; a second click would only be refused as a duplicate.
      onSent(data)
      onDraftChange(undefined)
    } catch {
      onDraftChange({ ...draft, sending: false, error: t.socialCommentsView.sendError })
    }
  }

  function cancel() {
    onDraftChange(undefined)
  }

  /** Opens the SAME edit-and-confirm flow "Предложить ответ" uses, pre-filled with the failed
   * attempt's own text — a manual retry is a human re-confirming (and possibly editing) the reply
   * before it goes out again, never an instant silent resend of the identical text. The server
   * enforces the actual rule (only a CONFIRMED `'failed'` row is ever reclaimable — see
   * lib/social-comment-reply.ts's atomic claim); this button is just the entry point into that. */
  function retry() {
    onDraftChange({ draft: comment.replyBody, suggesting: false, sending: false, error: '' })
  }

  // 1. Already sent — show the actual reply that went out, nothing editable, no actions. Terminal:
  // the server's own atomic claim (lib/social-comment-reply.ts) never allows retrying a 'sent' row.
  if (comment.replyStatus === 'sent') {
    return (
      <div className="flex flex-col gap-1">
        <span className="label-mono text-foreground/60">{t.socialCommentsView.replySent}</span>
        <p className="whitespace-pre-wrap text-foreground/90">{comment.replyBody}</p>
      </div>
    )
  }

  // 2. The outcome of a previous attempt was never confirmed (Telegram timeout/dropped
  // connection) — requirement 2: retry is strictly forbidden while this is unresolved, by
  // construction of the server's own atomic claim, not merely by this UI hiding a button. There is
  // no retry affordance here on purpose; a human must check Telegram directly.
  if (comment.replyStatus === 'sending') {
    return <span className="label-mono text-muted-foreground">{t.socialCommentsView.replyUnknown}</span>
  }

  // 3. A previous attempt was CONFIRMED to have failed — this is the one state a manual retry is
  // allowed from (requirement 1). Showing the edit form (below) once "Повторить" is clicked, with
  // the draft pre-filled, keeps this on the exact same human-confirmation path as a fresh
  // suggestion — never an automatic resend.
  if (comment.replyStatus === 'failed' && !draft) {
    return (
      <div className="flex flex-col gap-2">
        <span className="label-mono text-destructive">{t.socialCommentsView.replyFailed}</span>
        {comment.replyError && <p className="text-xs text-muted-foreground">{comment.replyError}</p>}
        <button
          onClick={retry}
          className="label-mono self-start border border-hairline px-3 py-1.5 text-foreground transition-colors hover:bg-muted/60"
        >
          {t.socialCommentsView.retry}
        </button>
      </div>
    )
  }

  // 4. Nothing sent yet (or a confirmed failure's manual retry was just started) — the "Suggest a
  // reply" entry point, or the editable draft once suggested/retried.
  if (!draft) {
    return (
      <button
        onClick={suggest}
        className="label-mono border border-hairline px-3 py-1.5 text-foreground transition-colors hover:bg-muted/60"
      >
        {t.socialCommentsView.suggestReply}
      </button>
    )
  }

  if (draft.suggesting) {
    return <span className="label-mono text-muted-foreground">{t.socialCommentsView.suggesting}</span>
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={draft.draft}
        onChange={(e) => onDraftChange({ ...draft, draft: e.target.value })}
        rows={3}
        className="min-w-[260px] resize-none border border-hairline bg-card p-2 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
      />
      {draft.error && <span className="text-xs text-destructive">{draft.error}</span>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={send}
          disabled={draft.sending || !draft.draft.trim()}
          className="label-mono border border-foreground bg-foreground px-3 py-1.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
        >
          {draft.sending ? t.socialCommentsView.sending : t.socialCommentsView.send}
        </button>
        <button
          onClick={suggest}
          disabled={draft.sending}
          className="label-mono border border-hairline px-3 py-1.5 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
        >
          {t.socialCommentsView.regenerate}
        </button>
        <button
          onClick={cancel}
          disabled={draft.sending}
          className="label-mono text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {t.socialCommentsView.cancel}
        </button>
      </div>
    </div>
  )
}

/**
 * Social Community — Telegram channel comments: read-only capture (auto-captured via the webhook,
 * app/api/telegram/comments-webhook/route.ts) plus the AI-suggested-reply MVP (this view's own
 * addition): "Предложить ответ" asks the OLNOO AI Router (via /api/social-comments/[id]/suggest-
 * reply) for one draft, editable here before a human explicitly sends it (/api/social-comments/
 * [id]/send-reply) as a real Telegram reply to the comment's own message, in the same discussion
 * group. No automatic send anywhere in this file.
 *
 * No "All projects" aggregate (same deliberate simplicity as /api/ads — see OLNOO_PROJECT_MAP.md's
 * "Ads" section): `ProjectSelector` is still rendered (requirement: reuse the existing component),
 * but choosing "All projects" shows a prompt instead of a cross-project list.
 */
export function SocialCommentsView({ project, onProjectChange }: { project: string; onProjectChange: (id: string) => void }) {
  const { t } = useI18n()
  const [comments, setComments] = useState<SocialComment[]>([])
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, ReplyDraftState>>({})

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
        setDrafts({})
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project])

  function setDraft(commentId: string, next: ReplyDraftState | undefined) {
    setDrafts((current) => {
      const copy = { ...current }
      if (next) copy[commentId] = next
      else delete copy[commentId]
      return copy
    })
  }

  function handleSent(commentId: string, row: Record<string, unknown>) {
    setComments((current) =>
      current.map((c) =>
        c.id === commentId
          ? {
              ...c,
              replyStatus: (row.status as ReplyStatus) ?? 'sending',
              replyBody: (row.body as string) ?? '',
              replyError: (row.error as string) ?? '',
            }
          : c,
      ),
    )
  }

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
              <Th>{t.socialCommentsView.reply}</Th>
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
                <Td className="max-w-[320px] align-top">
                  <ReplyCell
                    comment={c}
                    project={project}
                    draft={drafts[c.id]}
                    onDraftChange={(next) => setDraft(c.id, next)}
                    onSent={(row) => handleSent(c.id, row)}
                  />
                </Td>
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
                <Td> </Td>
              </tr>
            )}
          </tbody>
        </TableShell>
      )}
    </div>
  )
}
