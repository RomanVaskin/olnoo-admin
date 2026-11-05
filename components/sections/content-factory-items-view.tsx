'use client'

import { CatalogCardEditor } from './catalog-card-editor'
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'

// Mirrors lib/content-factory-items.ts's ITEM_STATUSES and status-transition guards — kept as
// local literals/functions (not imported) for the same client-bundle-hygiene reason
// social-view.tsx's EDITOR_ACTIONS already is: this client component must never pull in a
// server-only module just for a type or a pure boolean check.
const ITEM_STATUSES = ['new', 'processing', 'ready', 'scheduled', 'published', 'needs_review', 'rejected', 'failed'] as const
type ItemStatus = (typeof ITEM_STATUSES)[number]

function canGenerate(status: ItemStatus): boolean {
  return status === 'new' || status === 'ready' || status === 'needs_review' || status === 'rejected' || status === 'failed'
}
function canApprove(status: ItemStatus): boolean {
  return status === 'needs_review'
}
function canReject(status: ItemStatus): boolean {
  return status === 'new' || status === 'ready' || status === 'needs_review' || status === 'failed'
}

type Item = {
  id: string
  sourceId: string
  externalId: string
  originalUrl: string
  originalText: string
  originKind?: 'source' | 'own'
  ownBrief?: string
  processingMode: 'ai' | 'copy'
  copyPermissionConfirmed: boolean
  copyApprovedAt: string | null
  originalImageUrls: string[]
  originalImageFiles: string[]
  originalImageError: string
  copyImagePermissionConfirmed: boolean
  originalPublishedAt: string | null
  status: ItemStatus
  generatedTitle: string
  generatedText: string
  sourceLanguage: 'ru' | 'en' | null
  ruText: string
  ruSourceText: string
  ruRightsConfirmed: boolean
  reviewReason: string
  aiReview: {
    status: 'checking' | 'passed' | 'changes_required' | 'blocked' | 'error'
    risk?: 'low' | 'medium' | 'high'
    issues?: { category: string; detail: string; example: string }[]
    recommendations?: string[]
    quality?: { passed: boolean }
    checkedAt?: string
    error?: string
  } | null
  error: string
  socialPostId: string | null
  ruAccountId: string | null
  ruApprovedAt: string | null
  enText: string
  enSourceText: string
  enApprovedAt: string | null
  enRightsConfirmed: boolean
  enAccountId: string | null
  enSocialPostId: string | null
  enPublishClaimed: boolean
  imageFilename: string
  createdAt: string
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

type ChannelData = {
  accounts: { id: string; name: string; username: string; status: string; active: boolean }[]
  ru: { status: string; error: string; external_url: string } | null
  en: { status: string; error: string; external_url: string } | null
}

function ItemDetail({
  item,
  project,
  onClose,
  onUpdated,
}: {
  item: Item
  project: string
  onClose: () => void
  onUpdated: (item: Item) => void
}) {
  const { t } = useI18n()
  const [ownBrief, setOwnBrief] = useState(item.ownBrief || '')
  const [title, setTitle] = useState(item.generatedTitle)
  const [text, setText] = useState(item.generatedText)
  const [enText, setEnText] = useState(item.enText)
  const [ruText, setRuText] = useState(item.ruText)
  const [channels, setChannels] = useState<ChannelData>({ accounts: [], ru: null, en: null })
  const [ruAccount, setRuAccount] = useState(item.ruAccountId ?? '')
  const [enAccount, setEnAccount] = useState(item.enAccountId ?? '')
  const [selectedRu, setSelectedRu] = useState(false)
  const [selectedEn, setSelectedEn] = useState(false)
  const [partnerTranslationRights, setPartnerTranslationRights] = useState(false)
  const [busy, setBusy] = useState<'generate' | 'review' | 'publish' | 'save' | 'approve' | 'translate' | 'reject' | 'image' | 'deleteImage' | 'originalImages' | null>(null)
  const [error, setError] = useState('')
  const [copyCompared, setCopyCompared] = useState(false)
  const [imageRights, setImageRights] = useState(false)
  const isCopy = item.processingMode === 'copy'
  const linked = !!(item.socialPostId || item.enSocialPostId || item.enPublishClaimed || item.status === 'scheduled')
  const dirty = title !== item.generatedTitle || text !== item.generatedText
  const reviewPassed = item.aiReview?.status === 'passed' && (item.aiReview.risk === 'low' || item.aiReview.risk === 'medium') && item.aiReview.quality?.passed === true

  useEffect(() => {
    setTitle(item.generatedTitle)
    setText(item.generatedText)
    setError('')
    setCopyCompared(false)
    setImageRights(false)
  }, [item])

  useEffect(() => {
    setRuAccount(item.ruAccountId ?? '')
    setEnAccount(item.enAccountId ?? '')
    setSelectedRu(false)
    setSelectedEn(false)
    setPartnerTranslationRights(false)
  }, [item.id])

  useEffect(() => { setEnText(item.enText) }, [item.enText])
  useEffect(() => { setRuText(item.ruText) }, [item.ruText])

  async function loadChannels() {
    try {
      const res = await fetch(`/api/content-factory/items/${item.id}/languages?project=${encodeURIComponent(project)}`)
      if (res.ok) setChannels(await res.json())
    } catch { setError(t.contentFactory.items.channelLoadError) }
  }
  useEffect(() => { void loadChannels() }, [item.id, project, item.socialPostId, item.enSocialPostId])

  async function call(path: string, init: RequestInit, busyKind: typeof busy) {
    setBusy(busyKind)
    setError('')
    try {
      const res = await fetch(`${path}?project=${encodeURIComponent(project)}`, init)
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error((data && data.error) || 'Request failed.')
      onUpdated(data as Item)
      void loadChannels()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.')
    } finally {
      setBusy(null)
    }
  }

  function generate() {
    call(`/api/content-factory/items/${item.id}/generate`, { method: 'POST' }, 'generate')
  }
  function saveEdit() {
    call(`/api/content-factory/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, text }) }, 'save')
  }
  function approve() {
    call(`/api/content-factory/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve', confirmOriginalTextComplete: isCopy && copyCompared, confirmImageRights: isCopy && imageRights }) }, 'approve')
  }
  function reject() {
    if (!window.confirm(t.contentFactory.items.confirmReject)) return
    call(`/api/content-factory/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reject' }) }, 'reject')
  }
  function publish() {
    void publishSelected()
  }
  function languageAction(action: string, language: 'ru' | 'en', accountId?: string, textValue?: string) {
    const native = language === item.sourceLanguage
    call(`/api/content-factory/items/${item.id}/languages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, language, accountId, text: textValue, confirmRights: isCopy && (native ? copyCompared && (item.originalImageUrls.length === 0 || imageRights) : partnerTranslationRights), confirmPartnerTranslationRights: isCopy && partnerTranslationRights }) }, action === 'translate' ? 'translate' : 'approve')
  }
  async function publishSelected() {
    setBusy('publish')
    setError('')
    const errors: string[] = []
    for (const language of (['ru', 'en'] as const)) {
      if (language === 'ru' ? !selectedRu : !selectedEn) continue
      if (channels[language]?.status === 'published') continue
      try {
        const res = await fetch(`/api/content-factory/items/${item.id}/publish?project=${encodeURIComponent(project)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language }) })
        const data = await res.json()
        if (!res.ok) errors.push(`${language.toUpperCase()}: ${data.error || 'Publication failed.'}`)
        else onUpdated(data as Item)
      } catch (err) { errors.push(`${language.toUpperCase()}: ${err instanceof Error ? err.message : 'Publication failed.'}`) }
    }
    setError(errors.join('\n'))
    await loadChannels()
    setBusy(null)
  }
  function review() {
    call(`/api/content-factory/items/${item.id}/review`, { method: 'POST' }, 'review')
  }
  function generateImage() {
    call(`/api/content-factory/items/${item.id}/image`, { method: 'POST' }, 'image')
  }
  function deleteImage() {
    call(`/api/content-factory/items/${item.id}/image`, { method: 'DELETE' }, 'deleteImage')
  }
  function retryOriginalImages() {
    call(`/api/content-factory/items/${item.id}/original-images`, { method: 'POST' }, 'originalImages')
  }

  const isIstraArt = project === 'istraart' && item.originKind === 'own'
  const originalSection = (
          <div className="flex flex-col gap-1.5">
            {item.originKind === 'own' && <p className="text-sm font-medium">{t.contentFactory.items.ownMaterial}</p>}
            {isCopy && <p className="text-sm font-medium">{t.contentFactory.items.partnerCopy}</p>}
            {item.originKind === 'own' && ['new', 'failed'].includes(item.status) && !linked && <label className="flex flex-col gap-2 text-sm">{t.contentFactory.items.ownBrief}<textarea rows={4} value={ownBrief} onChange={(e) => setOwnBrief(e.target.value)} maxLength={10000} className="border border-hairline bg-card p-3" /><button disabled={busy !== null} onClick={() => call(`/api/content-factory/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownBrief }) }, 'save')} className="label-mono self-start border border-hairline p-2">{t.contentFactory.items.saveEdit}</button></label>}
            <span className="label-mono text-muted-foreground">{t.contentFactory.items.original}</span>
            <p className="whitespace-pre-wrap border border-hairline bg-background p-3 text-sm text-muted-foreground">{item.originalText || '—'}</p>
            {item.originalUrl && (
              <a href={item.originalUrl} target="_blank" rel="noreferrer" className="label-mono text-blue underline underline-offset-4">
                {t.contentFactory.items.sourceLink}
              </a>
            )}
          </div>
  )
  const socialSection = (
          <section className="flex flex-col gap-6 border-t border-hairline pt-4" aria-label={t.contentFactory.items.socialSection}>
            <h3 className="label-mono">{t.contentFactory.items.socialSection}</h3>
            {item.originKind === 'own' && <p className="text-sm text-muted-foreground">{t.contentFactory.items.socialSectionHint}</p>}

          {item.reviewReason && (
            <p className="border border-hairline bg-background p-3 text-sm text-foreground">
              <span className="label-mono text-muted-foreground">{t.contentFactory.items.reviewReasonLabel} </span>
              {item.reviewReason}
            </p>
          )}
          {item.error && (
            <p className="text-sm text-destructive">
              <span className="label-mono">{t.contentFactory.items.errorLabel} </span>
              {item.error}
            </p>
          )}

          {!isCopy && <div className="flex flex-col gap-2 border border-hairline bg-background p-3 text-sm">
            <span className="label-mono text-muted-foreground">{t.contentFactory.items.aiReviewLabel}</span>
            <p>{item.aiReview ? t.contentFactory.items.aiReviewStatuses[item.aiReview.status] : t.contentFactory.items.aiReviewNotRun}</p>
            {item.aiReview?.risk && <p>{t.contentFactory.items.aiReviewRisk}: {t.contentFactory.items.aiReviewRisks[item.aiReview.risk]}</p>}
            {item.aiReview?.quality && <p>{t.contentFactory.items.aiReviewQuality}: {item.aiReview.quality.passed ? t.contentFactory.items.aiReviewQualityPassed : t.contentFactory.items.aiReviewQualityFailed}</p>}
            {item.aiReview?.checkedAt && <p className="text-muted-foreground">{formatDate(item.aiReview.checkedAt)}</p>}
            {item.aiReview?.error && <p className="text-destructive">{item.aiReview.error}</p>}
            {!!item.aiReview?.issues?.length && <div><p className="font-medium">{t.contentFactory.items.aiReviewIssues}</p><ul className="list-disc pl-5">{item.aiReview.issues.map((issue, index) => <li key={index}>{issue.detail} — {issue.example}</li>)}</ul></div>}
            {!!item.aiReview?.recommendations?.length && <div><p className="font-medium">{t.contentFactory.items.aiReviewRecommendations}</p><ul className="list-disc pl-5">{item.aiReview.recommendations.map((recommendation, index) => <li key={index}>{recommendation}</li>)}</ul></div>}
            {item.generatedText && ['ready', 'needs_review', 'failed'].includes(item.status) && !linked && (
              <button onClick={review} disabled={busy !== null || dirty || reviewPassed} className="label-mono self-start border border-hairline px-3 py-2 disabled:opacity-50">
                {busy === 'review' ? t.contentFactory.items.aiReviewChecking : t.contentFactory.items.aiReviewAction}
              </button>
            )}
          </div>}

          <div className="flex flex-col gap-3 border border-hairline bg-card p-4">
            <span className="label-mono text-muted-foreground">{t.contentFactory.items.prepared}</span>
            {isCopy ? <p className="whitespace-pre-wrap text-sm">{item.originalText || '—'}</p> : item.generatedText || canGenerate(item.status) ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="label-mono text-muted-foreground">{t.contentFactory.items.editTitleLabel}</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={linked}
                    className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="label-mono text-muted-foreground">{t.contentFactory.items.editTextLabel}</span>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    disabled={linked}
                    rows={10}
                    className="resize-none border border-hairline bg-card p-3 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                  />
                </label>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t.contentFactory.items.noText}</p>
            )}

            {item.imageFilename && (
              <img
                src={`/api/content-factory/items/${item.id}/image?project=${encodeURIComponent(project)}&v=${encodeURIComponent(item.imageFilename)}`}
                alt={t.contentFactory.items.imageAlt}
                className="aspect-square w-full border border-hairline object-cover"
              />
            )}
            {!isCopy && item.generatedText && (item.status === 'ready' || item.status === 'needs_review') && !linked && (
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={generateImage}
                  disabled={busy !== null}
                  className="label-mono border border-hairline px-3 py-2 text-foreground disabled:opacity-50"
                >
                  {busy === 'image' ? t.contentFactory.items.generatingImage : item.imageFilename ? t.contentFactory.items.regenerateImage : t.contentFactory.items.generateImage}
                </button>
                {item.imageFilename && (
                  <button onClick={deleteImage} disabled={busy !== null} className="label-mono border border-hairline px-3 py-2 text-destructive disabled:opacity-50">
                    {t.contentFactory.items.deleteImage}
                  </button>
                )}
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex flex-wrap gap-2">
              {!isCopy && canGenerate(item.status) && !linked && (
                <button
                  onClick={generate}
                  disabled={busy !== null}
                  className="label-mono border border-hairline px-3 py-2 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                >
                  {busy === 'generate' ? t.contentFactory.items.generating : item.generatedText ? t.contentFactory.items.actionRegenerate : t.contentFactory.items.actionGenerate}
                </button>
              )}
              {!isCopy && item.generatedText && !linked && (
                <button
                  onClick={saveEdit}
                  disabled={busy !== null}
                  className="label-mono border border-hairline px-3 py-2 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                >
                  {t.contentFactory.items.saveEdit}
                </button>
              )}
              {!isCopy && canApprove(item.status) && (
                <button
                  onClick={approve}
                  disabled={busy !== null}
                  className="label-mono border border-foreground bg-foreground px-3 py-2 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
                >
                  {t.contentFactory.items.actionApprove}
                </button>
              )}
              {canReject(item.status) && (
                <button
                  onClick={reject}
                  disabled={busy !== null}
                  className="label-mono text-foreground/80 underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                >
                  {t.contentFactory.items.actionReject}
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-4 border border-hairline bg-card p-4 text-sm">
            <span className="label-mono text-muted-foreground">{t.contentFactory.items.languagesTitle}</span>
            {isCopy && <label className="flex items-start gap-2"><input type="checkbox" checked={copyCompared} onChange={(e) => setCopyCompared(e.target.checked)} />{t.contentFactory.items.confirmCopyText}</label>}
            {isCopy && item.originalImageUrls.length > 0 && <label className="flex items-start gap-2"><input type="checkbox" checked={imageRights} onChange={(e) => setImageRights(e.target.checked)} />{t.contentFactory.items.confirmImageRights}</label>}
            <p>{t.contentFactory.items.sourceLanguage}: {item.sourceLanguage?.toUpperCase() ?? t.contentFactory.items.unknownLanguage}</p>
            {isCopy && <label className="flex items-start gap-2"><input type="checkbox" checked={partnerTranslationRights} onChange={(e) => setPartnerTranslationRights(e.target.checked)} />{t.contentFactory.items.confirmTranslationRights}</label>}
            {(['ru', 'en'] as const).map((language) => {
              const account = language === 'ru' ? ruAccount : enAccount
              const approved = language === 'ru' ? item.ruApprovedAt : item.enApprovedAt
              const publication = channels[language]
              const native = language === item.sourceLanguage
              const translation = language === 'ru' ? ruText : enText
              const savedTranslation = language === 'ru' ? item.ruText : item.enText
              const nativeApproved = item.sourceLanguage === 'ru' ? item.ruApprovedAt : item.enApprovedAt
              return <div key={language} className="flex flex-col gap-2 border-t border-hairline pt-3">
                <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={language === 'ru' ? selectedRu : selectedEn} onChange={(e) => language === 'ru' ? setSelectedRu(e.target.checked) : setSelectedEn(e.target.checked)} />{language.toUpperCase()}</label>
                <select value={account} onChange={(e) => language === 'ru' ? setRuAccount(e.target.value) : setEnAccount(e.target.value)} className="border border-hairline bg-card px-3 py-2" disabled={publication?.status === 'published' || publication?.status === 'publishing'}>
                  <option value="">{t.contentFactory.items.chooseChannel}</option>
                  {channels.accounts.filter((a) => a.status === 'connected' && a.active).map((a) => <option key={a.id} value={a.id}>{a.name || a.username} ({a.username})</option>)}
                </select>
                <p className="text-muted-foreground">{t.contentFactory.items.approvalStatus}: {approved ? t.contentFactory.items.approved : t.contentFactory.items.notApproved} · {t.contentFactory.items.publicationStatus}: {publication?.status || '—'}</p>
                {publication?.error && <p className="text-destructive">{publication.error}</p>}
                {publication?.external_url && <a href={publication.external_url} target="_blank" rel="noreferrer" className="text-blue underline">{t.contentFactory.items.publishedLinkLabel}</a>}
                {!native && item.sourceLanguage && <>
                  <button onClick={() => languageAction('translate', language)} disabled={busy !== null || !nativeApproved || !item.generatedText || !!(language === 'ru' ? item.socialPostId : item.enSocialPostId) || (isCopy && !partnerTranslationRights)} className="label-mono self-start border border-hairline px-3 py-2 disabled:opacity-50">{language === 'ru' ? t.contentFactory.items.translateRussian : t.contentFactory.items.translateEnglish}</button>
                  <textarea rows={10} value={translation} onChange={(e) => language === 'ru' ? setRuText(e.target.value) : setEnText(e.target.value)} className="w-full border border-hairline bg-card p-3" disabled={!!(language === 'ru' ? item.socialPostId : item.enSocialPostId)} />
                  <button onClick={() => languageAction('save_translation', language, undefined, translation)} disabled={busy !== null || !savedTranslation || translation === savedTranslation || !!(language === 'ru' ? item.socialPostId : item.enSocialPostId)} className="label-mono self-start border border-hairline px-3 py-2 disabled:opacity-50">{language === 'ru' ? t.contentFactory.items.saveRussian : t.contentFactory.items.saveEnglish}</button>
                </>}
                <button onClick={() => languageAction(language === 'ru' ? 'approve_ru' : 'approve_en', language, account)} disabled={busy !== null || !account || !item.sourceLanguage || (!!approved && account === (language === 'ru' ? item.ruAccountId : item.enAccountId)) || publication?.status === 'published' || publication?.status === 'publishing' || (native ? (!isCopy && (!reviewPassed || dirty || !['ready', 'failed', 'scheduled'].includes(item.status))) || (isCopy && (!copyCompared || (item.originalImageUrls.length > 0 && !imageRights))) : (!savedTranslation || translation !== savedTranslation || !nativeApproved || (isCopy && !partnerTranslationRights)))} className="label-mono self-start border border-hairline px-3 py-2 disabled:opacity-50">{t.contentFactory.items.actionApprove} {language.toUpperCase()}</button>
              </div>
            })}
            <button onClick={publish} disabled={busy !== null || (!selectedRu && !selectedEn) || (selectedRu && channels.ru?.status !== 'published' && (!item.ruApprovedAt || ruAccount !== item.ruAccountId)) || (selectedEn && channels.en?.status !== 'published' && (!item.enApprovedAt || enAccount !== item.enAccountId)) || ((!selectedRu || channels.ru?.status === 'published') && (!selectedEn || channels.en?.status === 'published'))} className="label-mono border border-foreground bg-foreground px-3 py-2 text-background disabled:opacity-50">{busy === 'publish' ? t.contentFactory.items.publishing : t.contentFactory.items.publishSelected}</button>
          </div>
          </section>
  )

  return (
    <>
      <div className="fixed inset-0 z-30 bg-foreground/10" onClick={onClose} aria-hidden />
      <aside className={`fixed right-0 top-0 z-40 flex h-full w-full flex-col overflow-y-auto border-l border-hairline bg-card ${isIstraArt ? 'max-w-3xl' : 'max-w-lg'}`}>
        <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
          <StatusPill status={item.status} />
          <button onClick={onClose} className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground">
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-6 px-6 py-6">
          {isIstraArt ? <details><summary className="cursor-pointer text-sm">Исходный материал и задание для соцсетей</summary><div className="mt-3">{originalSection}</div></details> : originalSection}

          {isCopy && <p className="border border-hairline bg-background p-3 text-sm">{t.contentFactory.items.previewWarning}</p>}
          {!isIstraArt && (isCopy || item.originKind === 'own') && item.originalImageUrls.length > 0 && <div className="flex flex-col gap-2 border border-hairline bg-background p-3 text-sm">
            <span className="label-mono text-muted-foreground">{t.contentFactory.items.originalImages} ({item.originalImageFiles.length}/{item.originalImageUrls.length})</span>
            <div className="grid grid-cols-2 gap-2">{item.originalImageFiles.map((filename, index) => <img key={filename} src={`/api/content-factory/items/${item.id}/original-images/${index}?project=${encodeURIComponent(project)}`} alt={`${t.contentFactory.items.originalImages} ${index + 1}`} className="aspect-square w-full border border-hairline object-cover" />)}</div>
            {item.originalImageError && <p className="text-destructive">{item.originalImageError}</p>}
            {item.originalImageFiles.length !== item.originalImageUrls.length && !item.originalImageError && <p className="text-destructive">{t.contentFactory.items.imagesIncomplete}</p>}
            {isCopy && !item.socialPostId && item.originalImageFiles.length !== item.originalImageUrls.length && <button onClick={retryOriginalImages} disabled={busy !== null} className="label-mono self-start border border-hairline px-3 py-2 disabled:opacity-50">{t.contentFactory.items.retryImages}</button>}
          </div>}

          {item.originKind === 'own' && <CatalogCardEditor project={project} item={item} social={isIstraArt ? socialSection : undefined} />}

          {!isIstraArt && socialSection}
        </div>
      </aside>
    </>
  )
}

export function ContentFactoryItemsView({
  project,
  onProjectChange,
}: {
  project: string
  onProjectChange: (id: string) => void
}) {
  const { t } = useI18n()
  const [items, setItems] = useState<Item[]>([])
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [selected, setSelected] = useState<Item | null>(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    if (project === 'all') {
      setItems([])
      return
    }
    setLoading(true)
    try {
      const qs = new URLSearchParams({ project })
      if (statusFilter) qs.set('status', statusFilter)
      const res = await fetch(`/api/content-factory/items?${qs.toString()}`)
      if (res.ok) setItems(await res.json())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    setSelected(null)
  }, [project, statusFilter])

  function handleUpdated(updated: Item) {
    setItems((current) => current.map((it) => (it.id === updated.id ? updated : it)))
    setSelected(updated)
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="03"
        title={t.contentFactory.items.title}
        description={t.contentFactory.items.description}
        action={<ProjectSelector value={project} onChange={onProjectChange} />}
      />

      {project === 'all' ? (
        <p className="text-sm text-muted-foreground">{t.contentFactory.selectProjectHint}</p>
      ) : (
        <>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-fit border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
          >
            <option value="">{t.contentFactory.items.filterAllStatuses}</option>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t.status[s]}
              </option>
            ))}
          </select>

          <TableShell>
            <thead>
              <tr>
                <Th>{t.field.status}</Th>
                <Th>{t.table.created}</Th>
                <Th>{t.contentFactory.items.original}</Th>
                <Th>{t.contentFactory.items.prepared}</Th>
                <Th>{t.table.actions}</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setSelected(item)}>
                  <Td>
                    <StatusPill status={item.status} />
                    {item.originKind === 'own' && <span className="label-mono block text-muted-foreground">{t.contentFactory.items.ownMaterial}</span>}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(item.createdAt)}</Td>
                  <Td className="max-w-[260px] truncate text-muted-foreground" title={item.originalText}>
                    {item.originalText || '—'}
                  </Td>
                  <Td className="max-w-[260px] truncate text-foreground" title={item.generatedTitle}>
                    {item.generatedTitle || '—'}
                  </Td>
                  <Td>
                    <button className="label-mono text-blue underline underline-offset-4">{t.common.open}</button>
                  </Td>
                </tr>
              ))}
              {!loading && items.length === 0 && (
                <tr>
                  <Td className="text-muted-foreground">
                    <span className="label-mono">{t.contentFactory.items.noResults}</span>
                  </Td>
                  <Td> </Td>
                  <Td> </Td>
                  <Td> </Td>
                  <Td> </Td>
                </tr>
              )}
            </tbody>
          </TableShell>
        </>
      )}

      {selected && <ItemDetail item={selected} project={project} onClose={() => setSelected(null)} onUpdated={handleUpdated} />}
    </div>
  )
}
