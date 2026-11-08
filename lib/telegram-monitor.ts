import { spawn } from 'node:child_process'
import path from 'node:path'

export class TelegramMonitorError extends Error {
  code: string
  retryAfterSeconds: number
  constructor(code: string, retryAfterSeconds = 0) { super(`OLNOO Monitor: ${code}`); this.code=code; this.retryAfterSeconds=retryAfterSeconds }
}
/** Credentials are inherited by the child only; stdin/stdout never carry auth/session material. */
export async function runTelegramMonitor(command: 'status' | 'fetch', input: unknown = {}): Promise<any> {
  if (!process.env.TELEGRAM_MONITOR_API_ID || !process.env.TELEGRAM_MONITOR_API_HASH) throw new TelegramMonitorError('NOT_CONFIGURED')
  return new Promise((resolve,reject) => {
    const env: NodeJS.ProcessEnv = { PATH:process.env.PATH, LANG:'C.UTF-8', NODE_ENV:process.env.NODE_ENV }
    for (const key of ['TELEGRAM_MONITOR_API_ID','TELEGRAM_MONITOR_API_HASH','TELEGRAM_MONITOR_DIR']) if (process.env[key]) env[key]=process.env[key]
    const child=spawn(process.env.TELEGRAM_MONITOR_PYTHON || 'python3',[path.join(process.cwd(),'scripts/telegram-monitor/monitor.py'),command],{env,stdio:['pipe','pipe','ignore']})
    child.stdout.setEncoding('utf8')
    let output='',done=false
    const finish=(err?:Error,result?:unknown)=>{if(done)return;done=true;clearTimeout(timer);if(err)reject(err);else resolve(result)}
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new TelegramMonitorError('TIMEOUT'))},180_000)
    child.on('error',()=>finish(new TelegramMonitorError('PYTHON_UNAVAILABLE')))
    child.stdout.on('data',(chunk)=>{output+=chunk;if(output.length>2_000_000){child.kill('SIGKILL');finish(new TelegramMonitorError('RESPONSE_TOO_LARGE'))}})
    child.on('close',()=>{
      try { const data=JSON.parse(output);if(data.error)finish(new TelegramMonitorError(/^[A-Z_]+$/.test(data.error)?data.error:'CONNECTION_FAILED',Number(data.retryAfterSeconds)||0));else finish(undefined,data) }
      catch {finish(new TelegramMonitorError('INVALID_RESPONSE'))}
    })
    child.stdin.on('error',()=>{})
    child.stdin.end(JSON.stringify(input))
  })
}
