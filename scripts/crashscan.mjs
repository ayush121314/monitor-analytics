import { execFile } from 'node:child_process'
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

function run (args) {
  return new Promise(resolve => {
    execFile(process.execPath, args, { maxBuffer: 16 * 1024 * 1024, timeout: 90 * 1000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null)
      try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
    })
  })
}

const args = parseArgs(process.argv.slice(2))
const cfg = loadConfig()
const repos = args.repos.length ? cfg.repos.filter(r => args.repos.includes(r.name)) : cfg.repos
const grafana = path.join(SKILL_DIR, 'scripts', 'grafana.mjs')

const tasks = []
for (const repo of repos) {
  for (const p of PATTERNS) {
    tasks.push(
      run([grafana, '--repo', repo.name, '--grep', p.key, '--from', args.from, '--limit', String(args.limit)])
        .then(res => ({ repo: repo.name, pattern: p.key, why: p.why, res }))
    )
  }
}

const settled = await Promise.all(tasks)
const report = { from: args.from, generatedAt: new Date().toISOString(), repos: [] }

for (const repo of repos) {
  const hits = []
  for (const row of settled.filter(x => x.repo === repo.name)) {
    const res = row.res
    if (!res || res.error || !res.lineCount) continue
    hits.push({
      pattern: row.pattern,
      why: row.why,
      lines: res.lineCount,
      capped: res.lineCount >= (res.cappedAt || args.limit),
      modules: res.modules || {},
      samples: (res.samples || []).slice(0, 3).map(s => ({
        at: s.at,
        module: s.module,
        msg: s.msg,
        err: typeof s.err === 'string' ? s.err.slice(0, 200) : (s.err?.message || null)
      }))
    })
  }
  report.repos.push({ repo: repo.name, lokiApp: repo.lokiApp, hits })
}

console.log(JSON.stringify(report, null, 2))
