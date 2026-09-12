import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, SKILL_DIR, istStamp, toIst, gh } from './lib.mjs'

const cfg = loadConfig()
const statePath = path.join(cfg.dataDir, 'watch-state.json')
const alertsPath = path.join(cfg.dataDir, 'alerts.json')
const alertLog = path.join(cfg.dataDir, 'alerts.log')

const WINDOW = process.env.FA_WATCH_WINDOW || 'now-15m'
const KEEP_WINDOWS = 96
const SPIKE_FACTOR = 3
const SPIKE_FLOOR = 10
const REALERT_HOURS = 6

function loadState () {
  if (!existsSync(statePath)) return { signatures: {}, windows: {}, deploys: {}, alerts: [] }
  try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return { signatures: {}, windows: {}, deploys: {}, alerts: [] } }
}

function saveState (s) {
  writeFileSync(statePath, JSON.stringify(s, null, 2))
}

function normalise (text) {
  return String(text || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\b\d+\b/g, 'N')
    .replace(/'[^']{0,40}'/g, "'…'")
    .replace(/"[^"]{0,40}"/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function probe (repoName) {
  return new Promise(resolve => {
    execFile(process.execPath, [
      path.join(SKILL_DIR, 'scripts', 'grafana.mjs'),
      '--repo', repoName, '--level', 'error', '--from', WINDOW, '--limit', '300'
    ], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve(null)
      try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
    })
  })
}

function median (nums) {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function attribute (module) {
  for (const repo of cfg.repos) {
    let files = ''
    try {
      files = execFileSync('grep', ['-rl', `createModuleLogger('${module}')`, path.join(repo.path, 'src')],
        { encoding: 'utf8', timeout: 15000 }).trim()
    } catch { files = '' }
    if (!files) continue
    const list = files.split('\n').slice(0, 3).map(f => path.relative(repo.path, f))
    const prs = []
    for (const f of list) {
      try {
        const log = execFileSync('git', ['-C', repo.path, 'log', '--first-parent', '--since=10 days ago', '--format=%s', `origin/${repo.branch}`, '--', f],
          { encoding: 'utf8', timeout: 15000 })
        for (const line of log.split('\n')) {
          const m = line.match(/#(\d+)/)
          if (m && !prs.includes(m[1])) prs.push(m[1])
        }
      } catch {}
    }
    return { repo: repo.name, files: list, prs: prs.slice(0, 4) }
  }
  return null
}

function notify (title, message) {
  try {
    execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message.slice(0, 220))} with title ${JSON.stringify(title)} sound name "Submarine"`], { timeout: 8000 })
  } catch {}
}

async function checkDeploys (state) {
  const triggered = []
  for (const repo of cfg.repos) {
    const runs = gh(`repos/${cfg.org}/${repo.name}/actions/workflows/${repo.workflow}/runs?per_page=5&branch=${repo.branch}`)
    if (!runs || !runs.workflow_runs?.length) continue
    for (const run of runs.workflow_runs) {
      const seen = state.deploys[repo.name]
      if (seen === String(run.id)) break
      const jobs = gh(`repos/${cfg.org}/${repo.name}/actions/runs/${run.id}/jobs`)
      const prod = jobs?.jobs?.find(j => j.name.endsWith(repo.prodJob) && j.conclusion === 'success')
      if (!prod) continue
      if (!state.deploys[repo.name]) { state.deploys[repo.name] = String(run.id); break }
      state.deploys[repo.name] = String(run.id)
      triggered.push({ repo: repo.name, sha: run.head_sha.slice(0, 8), at: prod.completed_at, atIst: toIst(prod.completed_at), title: run.display_title })
      break
    }
  }
  return triggered
}

const state = loadState()
const now = new Date().toISOString()
const alerts = []

for (const repo of cfg.repos) {
  const res = await probe(repo.name)
  if (!res || res.error) continue

  for (const [module, count] of Object.entries(res.modules || {})) {
    const key = `${repo.name}|${module}`
    const hist = state.windows[key] || []
    const past = hist.map(h => h.n)
    const base = median(past)
    hist.push({ t: now, n: count })
    state.windows[key] = hist.slice(-KEEP_WINDOWS)
    if (past.length >= 8 && count >= SPIKE_FLOOR && base > 0 && count >= base * SPIKE_FACTOR) {
      alerts.push({
        kind: 'spike', app: repo.name, module, count, baseline: base,
        detail: `${module} logged ${count} errors in the last window against a usual ${base}`,
        blame: attribute(module)
      })
    }
  }

  for (const s of res.samples || []) {
    if (s.level !== 'error') continue
    const sig = normalise(s.err || s.msg)
    if (!sig) continue
    const key = `${repo.name}|${s.module || '-'}|${sig}`
    const known = state.signatures[key]
    if (!known) {
      state.signatures[key] = { first_seen: now, last_seen: now, seen: 1, sample: (s.err || s.msg || '').slice(0, 220) }
      if (Object.keys(state.signatures).length > 40) {
        alerts.push({
          kind: 'new-signature', app: repo.name, module: s.module, signature: sig,
          detail: `a prod error that has never been seen before: ${(s.err || s.msg || '').slice(0, 180)}`,
          blame: attribute(s.module)
        })
      }
    } else {
      known.last_seen = now
      known.seen = (known.seen || 0) + 1
    }
  }
}

function predeployRisks () {
  const risks = []
  let saved = {}
  try { saved = JSON.parse(readFileSync(path.join(cfg.dataDir, 'state.json'), 'utf8')).repos || {} } catch {}
  for (const repo of cfg.repos) {
    const since = saved[repo.name]?.last_sha
    const args = [path.join(SKILL_DIR, 'scripts', 'predeploy.mjs'), '--repo', repo.name]
    if (since) args.push('--since', since)
    let out = ''
    try { out = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 }) } catch { continue }
    let parsed = null
    try { parsed = JSON.parse(out) } catch { continue }
    for (const f of parsed.findings || []) {
      if (f.severity !== 'high') continue
      risks.push({
        kind: 'pre-deploy-risk', app: repo.name, module: f.file,
        signature: `${f.kind}:${f.call || f.file}`,
        detail: `${f.subject || f.sha}: ${f.detail}`,
        blame: { repo: repo.name, files: [f.file], prs: (f.subject || '').match(/#(\d+)/) ? [(f.subject.match(/#(\d+)/))[1]] : [] }
      })
    }
  }
  return risks
}

alerts.push(...predeployRisks())

const deploys = await checkDeploys(state)

const fresh = []
for (const a of alerts) {
  const key = `${a.kind}|${a.app}|${a.module}|${a.signature || ''}`
  const prev = (state.alerts || []).find(x => x.key === key)
  if (prev && (Date.now() - new Date(prev.at).getTime()) < REALERT_HOURS * 3600 * 1000) continue
  a.key = key
  a.at = now
  a.atIst = istStamp()
  fresh.push(a)
}
state.alerts = [...fresh, ...(state.alerts || [])].slice(0, 200)
saveState(state)

writeFileSync(alertsPath, JSON.stringify({ at: now, atIst: istStamp(), open: state.alerts.slice(0, 25), deploys }, null, 2))

for (const a of fresh) {
  const who = a.blame?.prs?.length ? ` · last touched by PR #${a.blame.prs.join(', #')}` : ''
  const line = `${a.kind.toUpperCase()} ${a.app} ${a.module || ''} — ${a.detail}${who}`
  appendFileSync(alertLog, `${istStamp()}  ${line}\n`)
  notify(a.kind === 'new-signature' ? 'New prod error' : 'Prod error spike', `${a.app} · ${a.module || ''}\n${a.detail}${who}`)
}

for (const d of deploys) {
  appendFileSync(alertLog, `${istStamp()}  DEPLOY ${d.repo} ${d.sha} went live at ${d.atIst} — ${d.title}\n`)
}

console.log(JSON.stringify({
  at: istStamp(),
  newAlerts: fresh.length,
  alerts: fresh.map(a => ({ kind: a.kind, app: a.app, module: a.module, detail: a.detail, blame: a.blame })),
  deploysDetected: deploys,
  signaturesKnown: Object.keys(state.signatures).length,
  modulesTracked: Object.keys(state.windows).length
}, null, 2))
