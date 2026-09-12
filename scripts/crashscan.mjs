import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { loadConfig, SKILL_DIR } from './lib.mjs'

const PATTERNS = [
  { key: 'is not a function', why: 'missing/renamed method — a caller survived a refactor' },
  { key: 'Cannot read propert', why: 'null/undefined dereference' },
  { key: 'is not defined', why: 'missing import or typo on a live path' },
  { key: 'TypeError', why: 'type error at runtime' },
  { key: 'Unknown column', why: 'query references a column prod does not have — missing migration' },
  { key: "doesn't exist", why: 'missing table/column in prod' },
  { key: 'code":"ER_', why: 'MySQL driver error' },
  { key: 'ECONNREFUSED', why: 'dependency unreachable' },
  { key: 'ETIMEDOUT', why: 'dependency timing out' },
  { key: 'timeout of', why: 'outbound HTTP call timing out' },
  { key: 'unhandledRejection', why: 'promise rejection with no handler' },
  { key: 'uncaughtException', why: 'process-level crash' },
  { key: 'out of memory', why: 'OOM' },
  { key: 'MODULE_NOT_FOUND', why: 'bad import path shipped to prod' }
]

function parseArgs (argv) {
  const out = { from: 'now-24h', repos: [], limit: 5 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') out.from = argv[++i]
    else if (a === '--repo') out.repos.push(argv[++i])
    else if (a === '--limit') out.limit = Number(argv[++i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const cfg = loadConfig()
const repos = args.repos.length ? cfg.repos.filter(r => args.repos.includes(r.name)) : cfg.repos
const grafana = path.join(SKILL_DIR, 'scripts', 'grafana.mjs')

const report = { from: args.from, generatedAt: new Date().toISOString(), repos: [] }

for (const repo of repos) {
  const hits = []
  for (const p of PATTERNS) {
    let count = 0
    try {
      const out = execFileSync(process.execPath, [grafana, '--repo', repo.name, '--grep', p.key, '--from', args.from, '--count'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      count = JSON.parse(out).count || 0
    } catch { count = -1 }
    if (count <= 0) continue
    let samples = []
    try {
      const out = execFileSync(process.execPath, [grafana, '--repo', repo.name, '--grep', p.key, '--from', args.from, '--limit', String(args.limit)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      const parsed = JSON.parse(out)
      samples = (parsed.samples || []).slice(0, 3).map(s => ({ at: s.at, module: s.module, msg: s.msg, err: typeof s.err === 'string' ? s.err.slice(0, 200) : (s.err?.message || null) }))
      hits.push({ pattern: p.key, why: p.why, count, modules: parsed.modules || {}, samples })
    } catch {
      hits.push({ pattern: p.key, why: p.why, count, modules: {}, samples: [] })
    }
  }
  report.repos.push({ repo: repo.name, lokiApp: repo.lokiApp, hits })
}

console.log(JSON.stringify(report, null, 2))
