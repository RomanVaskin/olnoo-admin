import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem } from '@/lib/content-factory-items'
import { readMonitorMedia } from '@/lib/social-telegram-original'
import type { TelegramOriginal } from '@/lib/telegram-original'
export async function GET(req:Request,{params}:{params:Promise<{id:string;message:string}>}){
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}
  if(!/^Basic \S+$/i.test(req.headers.get('authorization')??''))return new Response(null,{status:403,headers})
  const projectId=await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if(!projectId)return new Response(null,{status:404,headers})
  const {id,message}=await params
  const item=await getItem(pool,projectId,id)
  const media=(item?.originalTelegram as TelegramOriginal|undefined)?.messages?.find((m)=>m.id===message)?.media
  if(!item||!media)return new Response(null,{status:404,headers})
  try{
    const bytes=await readMonitorMedia(projectId,item.id,media)
    const common={...headers,'Content-Type':media.mimeType,'Accept-Ranges':'bytes','Content-Disposition':`${media.kind==='document'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(media.name)}`}
    const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range')??'')
    if(range){const start=Number(range[1]),end=range[2]?Number(range[2]):bytes.length-1;if(start>end||end>=bytes.length)return new Response(null,{status:416,headers:{...common,'Content-Range':`bytes */${bytes.length}`}});return new Response(new Uint8Array(bytes.subarray(start,end+1)),{status:206,headers:{...common,'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':String(end-start+1)}})}
    return new Response(new Uint8Array(bytes),{headers:{...common,'Content-Length':String(bytes.length)}})
  }catch{return new Response(null,{status:404,headers})}
}
