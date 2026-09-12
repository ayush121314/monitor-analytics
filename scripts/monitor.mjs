import { execFile, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, openSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, SKILL_DIR, istStamp } from './lib.mjs'

const cfg = loadConfig()
mkdirSync(cfg.dataDir, { recursive: true })
const healthPath = path.join(cfg.dataDir, 'health.json')
const logPath = path.join(cfg.dataDir, 'monitor.log')
const START_PORT = Number(process.env.FEATURE_AUDIT_PORT || 8999)
const STALL_MINUTES = 8

const log = line => appendFileSync(logPath, `${istStamp()}  ${line}\n`)

function sh (cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: opts.timeout || 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout || '', err: String(stderr || (err && err.message) || '') })
    })
  })
}

async function get (url, ms = 4000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function findServer () {
  for (let p = START_PORT; p < START_PORT + 60; p++) {
    const s = await get(`http://localhost:${p}/api/summary`, 1500)
    if (s && s.repos) return { port: p, summary: s }
  }
  return null
}

function startServer () {
  const out = openSync(path.join(cfg.dataDir, 'server.log'), 'a')
  const child = spawn(process.execPath, [path.join(SKILL_DIR, 'scripts', 'server.mjs')], {
    detached: true, stdio: ['ignore', out, out], cwd: SKILL_DIR
  })
  child.unref()
}

const checks = []
const record = (name, ok, detail, fixed = null) => checks.push({ name, ok, detail, fixed })

let server = await findServer()
if (!server) {
  record('dashboard', false, 'not responding on any port from ' + START_PORT, 'restarted it')
  log('dashboard was down — restarting')
  startServer()
  await new Promise(r => setTimeout(r, 4000))
  server = await findServer()
  if (server) log(`dashboard back up on ${server.port}`)
  else log('dashboard did NOT come back — needs a look')
} else {
  record('dashboard', true, `up on port ${server.port}`)
}

if (server) {
  const hist = await get(`http://localhost:${server.port}/api/history?days=1`) || []
  const running = hist.find(h => h.status === 'running')
  if (running) {
    const job = await get(`http://localhost:${server.port}/api/job?id=${encodeURIComponent(running.id)}`)
    const logFile = path.join(cfg.dataDir, 'runs', `${running.id}.log`)
    let idleMin = 0
    if (existsSync(logFile)) {
      const mtime = statSync(logFile).mtimeMs
      idleMin = (Date.now() - mtime) / 60000
    }
    if (idleMin > STALL_MINUTES) {
      record('run', false, `${running.id} idle for ${Math.round(idleMin)} min at ${running.percent || 0}%`, 'stopped it')
      log(`run ${running.id} stalled (${Math.round(idleMin)} min idle) — stopping`)
      await fetch(`http://localhost:${server.port}/api/stop`, { method: 'POST', body: '{}' }).catch(() => {})
    } else {
      record('run', true, `${running.phase || 'working'} · ${running.percent || 0}% · ${Math.round(idleMin)}m idle`)
    }
  } else {
    record('run', true, 'idle')
  }
}

try {
  const state = JSON.parse(readFileSync(path.join(cfg.dataDir, 'state.json'), 'utf8'))
  const missing = cfg.repos.filter(r => !state.repos?.[r.name]?.last_sha).map(r => r.name)
  record('checkpoints', missing.length === 0, missing.length ? `no checkpoint for ${missing.join(', ')}` : `${Object.keys(state.repos || {}).length} repos tracked`)
} catch (e) {
  record('checkpoints', false, 'state.json unreadable: ' + String(e.message).slice(0, 120))
}

for (const repo of cfg.repos) {
  const r = await sh('git', ['-C', repo.path, 'rev-parse', '--git-dir'], { timeout: 8000 })
  if (!r.ok) { record(`repo:${repo.name}`, false, 'not a git checkout at ' + repo.path); continue }
  const head = await sh('git', ['-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8000 })
  const branch = head.out.trim()
  record(`repo:${repo.name}`, branch === repo.branch, branch === repo.branch ? `on ${branch}` : `on ${branch}, expected ${repo.branch} — an audit must never leave it switched`)
}

const grafana = await sh(process.execPath, [path.join(SKILL_DIR, 'scripts', 'grafana.mjs'), '--repo', cfg.repos[0].name, '--from', 'now-10m', '--limit', '1'], { timeout: 30000 })
let grafanaOk = false
try { grafanaOk = !JSON.parse(grafana.out).error } catch {}
record('grafana', grafanaOk, grafanaOk ? 'prod Loki answering' : 'prod Loki query failed — check GRAFANA_TOKEN_PROD')

const health = {
  at: new Date().toISOString(),
  atIst: istStamp(),
  ok: checks.every(c => c.ok || c.fixed),
  fixed: checks.filter(c => c.fixed).map(c => `${c.name}: ${c.fixed}`),
  checks
}
writeFileSync(healthPath, JSON.stringify(health, null, 2))

const failed = checks.filter(c => !c.ok && !c.fixed)
if (failed.length) log('FAILING: ' + failed.map(c => `${c.name} (${c.detail})`).join(' | '))
else if (health.fixed.length) log('FIXED: ' + health.fixed.join(' | '))
else log('ok — ' + checks.map(c => c.name).join(', ') + (checks.find(c => c.name === 'run') ? ' · ' + checks.find(c => c.name === 'run').detail : ''))

console.log(JSON.stringify(health, null, 2))
