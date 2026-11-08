import type { Pool } from 'pg'
import { runTelegramMonitor,TelegramMonitorError } from './telegram-monitor.ts'
import { trustedTelegramOriginal, type TelegramOriginal } from './telegram-original.ts'
import { detectPostLanguage, getItem, type ContentFactoryItem } from './content-factory-items.ts'
import type { ContentFactorySource } from './content-factory-sources.ts'

/** A source row lock serializes scheduled/manual polls; cursor commits with the imported items.
 * File downloads are immutable, so a transaction/network failure can safely reuse the bytes.
 */
export async function collectTelegramMonitor(pool:Pool,source:ContentFactorySource,run=runTelegramMonitor,baseline=false):Promise<{created:ContentFactoryItem[];error:string;observedMaxId:string}> {
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    const locked=await client.query('SELECT automation_runtime FROM content_factory_sources WHERE id=$1 AND project_id=$2 FOR UPDATE',[source.id,source.projectId])
    if(!locked.rows[0])throw new Error('Source not found')
    const state=locked.rows[0].automation_runtime??{}
    if (state.monitorRetryAt && new Date(state.monitorRetryAt).getTime()>Date.now()) throw new TelegramMonitorError('FLOOD_WAIT',Math.ceil((new Date(state.monitorRetryAt).getTime()-Date.now())/1000))
    const known=await client.query(`SELECT id,external_id FROM content_factory_items WHERE source_id=$1 AND project_id=$2 AND external_id ~ '^[0-9]+$' ORDER BY external_id::numeric DESC LIMIT 220`,[source.id,source.projectId])
    const response=await run('fetch',{handle:source.handle.replace(/^@/,''),projectId:source.projectId,sourceId:source.id,
      maxPosts:source.automation?.mode==='manual'?20:source.automation?.dailyLimit??3,afterId:baseline?null:state.monitorCursor??null,peerId:state.monitorPeer??null,knownItems:Object.fromEntries(known.rows.map((r)=>[r.external_id,r.id]))})
    if(!/^\d+$/.test(response.cursor)||!/^\d+$/.test(response.peerId)||!Array.isArray(response.posts))throw new Error('Invalid monitor response')
    const ids:string[]=[];let error=''
    for(const post of response.posts){
      if(!/^[0-9a-f-]{36}$/.test(post.itemId)||!/^\d+$/.test(post.externalId)||post.url!==`https://t.me/${source.handle.replace(/^@/,'')}/${post.externalId}`||typeof post.text!=='string')throw new Error('Invalid monitor post')
      const original=post.original as TelegramOriginal
      const complete=trustedTelegramOriginal(original,post.text)
      if(!complete&&!post.error)throw new Error('Incomplete monitor response')
      const photos=(original.messages??[]).filter((m)=>m.media?.kind==='photo').map((m)=>m.media!.filename)
      const photoUrls=(original.messages??[]).filter((m)=>m.media?.kind==='photo').map((m)=>`telegram-client:${m.id}`)
      const copy=source.processingMode==='copy'
      const inserted=await client.query(`INSERT INTO content_factory_items
        (id,project_id,source_id,external_id,original_url,original_text,original_published_at,original_image_urls,original_image_files,
         original_image_error,processing_mode,copy_permission_confirmed,generated_text,source_language,status,original_telegram)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb)
        ON CONFLICT (source_id,external_id) DO UPDATE SET original_telegram=EXCLUDED.original_telegram,
          original_image_urls=EXCLUDED.original_image_urls,original_image_files=EXCLUDED.original_image_files,
          original_image_error=EXCLUDED.original_image_error,status=CASE WHEN EXCLUDED.original_image_error='' THEN CASE WHEN content_factory_items.processing_mode='copy' THEN 'needs_review' ELSE 'new' END ELSE 'failed' END
        WHERE content_factory_items.original_telegram->>'complete' IS DISTINCT FROM 'true'
          AND content_factory_items.original_text=EXCLUDED.original_text AND content_factory_items.social_post_id IS NULL
          AND content_factory_items.en_social_post_id IS NULL AND content_factory_items.status IN ('new','needs_review','failed') RETURNING id`,
        [post.itemId,source.projectId,source.id,post.externalId,post.url,post.text,post.publishedAt,photoUrls.join(','),JSON.stringify(photos),complete?'':`OLNOO Monitor: ${post.error}`,source.processingMode,source.copyPermissionConfirmed,copy?post.text:'',detectPostLanguage(post.text)??'ru',complete?(copy?'needs_review':'new'):'failed',JSON.stringify(original)])
      if(inserted.rows[0])ids.push(inserted.rows[0].id)
      if(post.error){error=`OLNOO Monitor: ${post.error}`;break}
    }
    delete state.monitorRetryAt
    state.monitorCursor=response.cursor;state.monitorPeer=response.peerId
    await client.query('UPDATE content_factory_sources SET automation_runtime=$1::jsonb WHERE id=$2 AND project_id=$3',[JSON.stringify(state),source.id,source.projectId])
    await client.query('COMMIT')
    source.automationRuntime=state
    const created=[]
    for(const id of ids){const item=await getItem(pool,source.projectId,id);if(item)created.push(item)}
    return {created,error,observedMaxId:response.cursor}
  } catch(e){await client.query('ROLLBACK');throw e} finally{client.release()}
}
