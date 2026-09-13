import { execFile } from 'node:child_process'
import path from 'node:path'
import { loadConfig, SKILL_DIR, istStamp } from './lib.mjs'

const cfg = loadConfig()

const FAILURE_WORDS = [
  'failed', 'failure', 'exception', 'timeout', 'timed out', 'refused', 'denied',
  'invalid', 'unable', 'could not', 'cannot', 'rejected', 'retry', 'retrying',
  'missing', 'not found', 'unexpected', 'fallback', 'skipped', 'dropped',
  'undefined', 'null', 'mismatch', 'conflict', 'stuck', 'stale', 'suppressed'
]

function parseArgs (argv) {
  const out = { from: 'now-24h', limit: 300, top: 12 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') out.from = argv[++i]
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--top') out.top = Number(argv[++i])
  }
  return out
}

function grafana (args) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(SKILL_DIR, 'scripts', 'grafana.mjs'), ...args],
      { timeout: 90000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve(null)
        try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
      })
  })
}

function shapeOf (msg) {
  return String(msg || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b\d+\b/g, 'N')
    .replace(/'[^']{0,40}'/g, "'…'")
    .replace(/"[^"]{0,40}"/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110)
}

const args = parseArgs(process.argv.slice(2))
const repos = args.repo ? cfg.repos.filter(r => r.name === args.repo) : cfg.repos
const report = { window: args.from, generatedAt: istStamp(), apps: [] }

for (const repo of repos) {
  const app = repo.lokiApp
  const levelWord = args.from.startsWith('now-') ? args.from.slice(4) : '24h'

  const words = FAILURE_WORDS.join('|')
  const lvl = (names, nums) => `{app="${app}"} | json | level=~"${names}|${nums}"`
  const [errS, errN, warnS, warnN, infoS, infoN, allSample, nonErrorFailures, weekSample, todaySample] = await Promise.all([
    grafana(['--app', app, '--level', 'error', '--from', args.from, '--count']),
    grafana(['--app', app, '--expr', `{app="${app}"} | json | level="50"`, '--from', args.from, '--count']),
    grafana(['--app', app, '--level', 'warn', '--from', args.from, '--count']),
    grafana(['--app', app, '--expr', `{app="${app}"} | json | level="40"`, '--from', args.from, '--count']),
    grafana(['--app', app, '--level', 'info', '--from', args.from, '--count']),
    grafana(['--app', app, '--expr', `{app="${app}"} | json | level="30"`, '--from', args.from, '--count']),
    grafana(['--app', app, '--from', args.from, '--limit', String(args.limit)]),
    grafana(['--app', app, '--expr', `{app="${app}"} | json | level!="error" | level!="50" | msg=~"(?i).*(${words}).*"`, '--from', args.from, '--limit', String(args.limit)]),
    grafana(['--app', app, '--from', 'now-7d', '--limit', '400']),
    grafana(['--app', app, '--from', 'now-6h', '--limit', '400'])
  ])
  const pick = (a, b) => Math.max(a?.count || 0, b?.count || 0) || (a?.count ?? b?.count ?? null)
  const errCount = { count: pick(errS, errN) }
  const warnCount = { count: pick(warnS, warnN) }
  const infoCount = { count: pick(infoS, infoN) }

  const hidden = {}
  for (const s of (nonErrorFailures?.samples || [])) {
    const key = `${s.level || '?'}|${s.module || '-'}|${shapeOf(s.msg || s.err)}`
    hidden[key] = hidden[key] || { level: s.level, module: s.module, shape: shapeOf(s.msg || s.err), seen: 0, sample: (s.msg || '').slice(0, 160) }
    hidden[key].seen++
  }

  const weekModules = new Set(Object.keys(weekSample?.modules || {}))
  const todayModules = new Set(Object.keys(todaySample?.modules || {}))
  const wentQuiet = [...weekModules].filter(m => !todayModules.has(m))

  report.apps.push({
    app,
    repo: repo.name,
    levels: {
      error: errCount?.count ?? null,
      warn: warnCount?.count ?? null,
      info: infoCount?.count ?? null
    },
    nonErrorFailureLines: nonErrorFailures?.lineCount ?? 0,
    nonErrorFailureModules: nonErrorFailures?.modules || {},
    hiddenFailures: Object.values(hidden).sort((a, b) => b.seen - a.seen).slice(0, args.top),
    busiestModules: Object.entries(allSample?.modules || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, n]) => `${m}: ${n}`),
    eventsSeen: Object.entries(allSample?.events || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e}: ${n}`),
    wentQuiet: wentQuiet.slice(0, 10),
    note: `levels counted over ${levelWord}; shapes sampled from the most recent ${args.limit} lines`
  })
}

const totals = report.apps.reduce((a, x) => ({
  error: a.error + (x.levels.error || 0),
  warn: a.warn + (x.levels.warn || 0),
  info: a.info + (x.levels.info || 0),
  hidden: a.hidden + x.nonErrorFailureLines
}), { error: 0, warn: 0, info: 0, hidden: 0 })

report.summary = `errors ${totals.error.toLocaleString()} · warns ${totals.warn.toLocaleString()} · info ${totals.info.toLocaleString()} · failure-shaped lines below error level ${totals.hidden.toLocaleString()}`
report.why = 'an error-level sweep only sees what the code chose to call an error; these are the failures logged as warn or info, and the modules that stopped logging entirely'

console.log(JSON.stringify(report, null, 2))
