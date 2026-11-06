import { runTelegramMonitor,TelegramMonitorError } from '@/lib/telegram-monitor'
import { resolveProjectId } from '@/lib/crm'
import { sourceAutomationAccess } from '@/lib/content-factory-source-policy'
async function status(req:Request){
  if(!/^Basic \S+$/i.test(req.headers.get('authorization')??''))return Response.json({error:'Forbidden'},{status:403})
  if(!await resolveProjectId(new URL(req.url).searchParams.get('project')))return Response.json({error:'Unknown project'},{status:400})
  const checkedAt=new Date().toISOString()
  try{const result=await runTelegramMonitor('status');return Response.json({status:result.status==='connected'?'connected':'error',checkedAt},{headers:{'Cache-Control':'no-store'}})}
  catch(e){return Response.json({status:'unavailable',error:e instanceof TelegramMonitorError?e.code:'CONNECTION_FAILED',checkedAt},{headers:{'Cache-Control':'no-store'}})}
}
export const GET=status
export async function POST(req:Request){if(!sourceAutomationAccess(req))return Response.json({error:'Forbidden'},{status:403});return status(req)}
