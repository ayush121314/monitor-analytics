import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, SKILL_DIR, istStamp } from './lib.mjs'

const cfg = loadConfig()
const baselineFile = path.join(cfg.dataDir, 'latency-baseline.json')

function parseArgs (argv) {
  const out = { from: 'now-24h', limit: 1000, minSamples: 8, slowMs: 1000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') out.from = argv[++i]
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--baseline') out.writeBaseline = true
    else if (a === '--slow') out.slowMs = Number(argv[++i])
  }
  return out
}

function grafana (args) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(SKILL_DIR, 'scripts', 'grafana.mjs'), ...args],
      { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve(null)
        try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
      })
  })
}

function pct (sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}

const args = parseArgs(process.argv.slice(2))
const repos = args.repo ? cfg.repos.filter(r => r.name === args.repo) : cfg.repos

let baseline = {}
if (existsSync(baselineFile)) {
  try { baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) } catch {}
}

const report = { window: args.from, generatedAt: istStamp(), apps: [], regressions: [], slowest: [] }
const fresh = {}

for (const repo of repos) {
  const res = await grafana(['--repo', repo.name, '--grep', 'durationMs', '--from', args.from,
    '--limit', String(args.limit), '--fields', 'module,handler,durationMs,event,op'])
  const rows = res?.rows || []
  const buckets = {}
  for (const r of rows) {
    const ms = Number(r.durationMs)
    if (!Number.isFinite(ms)) continue
    const key = `${r.module || '-'}${r.handler ? ' · ' + r.handler : (r.op ? ' · ' + r.op : '')}`
    buckets[key] = buckets[key] || []
    buckets[key].push(ms)
  }

  const stats = Object.entries(buckets)
    .map(([key, vals]) => {
      const sorted = [...vals].sort((a, b) => a - b)
      return {
        key,
        samples: sorted.length,
        p50: pct(sorted, 50),
        p95: pct(sorted, 95),
        max: sorted[sorted.length - 1]
      }
    })
    .filter(s => s.samples >= args.minSamples)
    .sort((a, b) => b.p95 - a.p95)

  fresh[repo.name] = Object.fromEntries(stats.map(s => [s.key, { p50: s.p50, p95: s.p95, samples: s.samples }]))

  const prev = baseline[repo.name] || {}
  for (const s of stats) {
    const was = prev[s.key]
    if (!was || !was.p95 || was.samples < args.minSamples) continue
    const factor = s.p95 / was.p95
    if (factor >= 2 && s.p95 - was.p95 >= 150) {
      report.regressions.push({
        app: repo.name,
        what: s.key,
        wasP95: was.p95,
        nowP95: s.p95,
        factor: Number(factor.toFixed(1)),
        samples: s.samples,
        verdict: `IMPORTANT — p95 went from ${was.p95}ms to ${s.p95}ms (${factor.toFixed(1)}x) since the baseline`
      })
    }
  }

  report.apps.push({
    app: repo.name,
    tracked: stats.length,
    linesRead: rows.length,
    slowest: stats.slice(0, 8).map(s => `${s.key} — p95 ${s.p95}ms, p50 ${s.p50}ms (${s.samples} samples)`)
  })
  for (const s of stats.filter(x => x.p95 >= args.slowMs).slice(0, 6)) {
    report.slowest.push({ app: repo.name, what: s.key, p95: s.p95, p50: s.p50, samples: s.samples })
  }
}

if (args.writeBaseline) {
  writeFileSync(baselineFile, JSON.stringify(fresh, null, 2) + '\n')
  report.baselineWritten = path.basename(baselineFile)
}

report.verdict = report.regressions.length
  ? `${report.regressions.length} path(s) got materially slower since the baseline`
  : (Object.keys(baseline).length ? 'no path doubled its p95 since the baseline' : 'no baseline yet — this run establishes it')

console.log(JSON.stringify(report, null, 2))
