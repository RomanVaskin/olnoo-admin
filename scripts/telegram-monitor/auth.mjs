// Run locally on KZ with a TTY and the Admin service identity; never from a browser/Actions.
import { spawnSync } from 'node:child_process'
if (!process.stdin.isTTY) throw new Error('Monitor authorization requires an interactive terminal.')
const env = {}
for (const key of ['PATH','TELEGRAM_MONITOR_API_ID','TELEGRAM_MONITOR_API_HASH','TELEGRAM_MONITOR_DIR']) if (process.env[key]) env[key]=process.env[key]
const result=spawnSync(process.env.TELEGRAM_MONITOR_PYTHON || 'python3',['scripts/telegram-monitor/monitor.py','auth'],{env,stdio:'inherit'})
if (result.error) console.error('Could not start the Monitor authorization command.')
process.exitCode=result.status ?? 1
