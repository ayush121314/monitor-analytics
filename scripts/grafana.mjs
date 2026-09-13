import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { loadConfig } from './lib.mjs'

function parseArgs (argv) {
  const out = { env: 'prod', modules: [], from: 'now-24h', to: 'now', limit: 200, count: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repo') out.repo = argv[++i]
    else if (a === '--app') out.app = argv[++i]
    else if (a === '--module') out.modules.push(argv[++i])
    else if (a === '--level') out.level = argv[++i]
    else if (a === '--grep') out.grep = argv[++i]
    else if (a === '--from') out.from = argv[++i]
    else if (a === '--to') out.to = argv[++i]
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--expr') out.expr = argv[++i]
    else if (a === '--env') out.env = argv[++i]
    else if (a === '--count') out.count = true
    else if (a === '--fields') out.fields = argv[++i].split(',').map(x => x.trim()).filter(Boolean)
  }
  return out
}

function tokenFor (envName) {
  if (process.env[envName]) return process.env[envName]
  const rc = path.join(homedir(), '.zshrc')
  if (!existsSync(rc)) return null
  const m = readFileSync(rc, 'utf8').match(new RegExp(`^export\\s+${envName}=["']?([^"'\\n]+)`, 'm'))
  return m ? m[1] : null
}

function buildExpr (args, app) {
  if (args.expr) return args.expr
  let expr = `{app="${app}"}`
  if (args.grep) expr += ` |= \`${args.grep}\``
  const needsJson = args.modules.length || args.level
  if (needsJson) expr += ' | json'
  if (args.modules.length === 1) expr += ` | module="${args.modules[0]}"`
  else if (args.modules.length > 1) expr += ` | module=~"${args.modules.join('|')}"`
  if (args.level) expr += ` | level="${args.level}"`
  return expr
}

async function query (cfg, args, expr, instant) {
  const g = cfg.grafana[args.env]
  if (!g) throw new Error(`unknown env ${args.env}`)
  const token = tokenFor(g.tokenEnv)
  if (!token) throw new Error(`${g.tokenEnv} not set in env or ~/.zshrc`)
  const body = {
    queries: [{
      refId: 'A',
      datasource: { type: 'loki', uid: g.lokiUid },
      expr,
      queryType: instant ? 'instant' : 'range',
      maxLines: args.limit,
      direction: 'backward'
    }],
    from: args.from,
    to: args.to
  }
  const res = await fetch(`${g.addr}/api/ds/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`grafana ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

function extractLines (json) {
  const frames = json?.results?.A?.frames || []
  const rows = []
  for (const f of frames) {
    const fields = (f.schema?.fields || []).map(x => x.name)
    const ti = fields.indexOf('Time')
    const li = fields.indexOf('Line')
    if (li < 0) continue
    const times = f.data.values[ti] || []
    const lines = f.data.values[li] || []
    for (let i = 0; i < lines.length; i++) rows.push({ t: times[i] || null, line: lines[i] })
  }
  return rows
}

function summarise (rows) {
  const levels = {}
  const modules = {}
  const events = {}
  const samples = []
  for (const r of rows) {
    let obj = null
    try { obj = JSON.parse(r.line) } catch {}
    const lvl = obj?.level || 'raw'
    levels[lvl] = (levels[lvl] || 0) + 1
    if (obj?.module) modules[obj.module] = (modules[obj.module] || 0) + 1
    if (obj?.event) events[obj.event] = (events[obj.event] || 0) + 1
    if (samples.length < 12 && (lvl === 'error' || lvl === 'warn' || samples.length < 4)) {
      samples.push({
        at: r.t ? new Date(r.t).toISOString() : null,
        level: lvl,
        module: obj?.module || null,
        event: obj?.event || null,
        msg: obj?.msg || obj?.message || r.line.slice(0, 300),
        err: obj?.err?.message || obj?.error || null
      })
    }
  }
  return { levels, modules, events, samples }
}

const args = parseArgs(process.argv.slice(2))
const cfg = loadConfig()
let app = args.app
if (!app && args.repo) app = (cfg.repos.find(r => r.name === args.repo) || {}).lokiApp
if (!app) {
  console.error('usage: grafana.mjs --repo <name>|--app <lokiApp> [--module m] [--level error] [--grep text] [--from now-24h] [--to now] [--limit 200] [--count]')
  process.exit(1)
}

const expr = buildExpr(args, app)
try {
  if (args.count) {
    const window = args.from.startsWith('now-') ? args.from.slice(4) : '24h'
    const metric = `sum(count_over_time(${expr}[${window}]))`
    const json = await query(cfg, args, metric, true)
    const frames = json?.results?.A?.frames || []
    let value = 0
    for (const f of frames) {
      const vals = f.data?.values || []
      const last = vals[vals.length - 1]
      if (Array.isArray(last) && last.length) value += Number(last[last.length - 1]) || 0
    }
    console.log(JSON.stringify({ env: args.env, app, expr: metric, from: args.from, to: args.to, count: value }, null, 2))
  } else if (args.fields) {
    const json = await query(cfg, args, expr, false)
    const rows = extractLines(json)
    const picked = []
    for (const r of rows) {
      let o = null
      try { o = JSON.parse(r.line) } catch { continue }
      const item = {}
      for (const f of args.fields) if (o[f] !== undefined) item[f] = o[f]
      if (Object.keys(item).length) picked.push(item)
    }
    console.log(JSON.stringify({ env: args.env, app, expr, from: args.from, to: args.to, lineCount: rows.length, rows: picked }, null, 2))
  } else {
    const json = await query(cfg, args, expr, false)
    const rows = extractLines(json)
    console.log(JSON.stringify({
      env: args.env,
      app,
      expr,
      from: args.from,
      to: args.to,
      lineCount: rows.length,
      cappedAt: args.limit,
      ...summarise(rows)
    }, null, 2))
  }
} catch (e) {
  console.log(JSON.stringify({ error: String(e.message), env: args.env, app, expr }, null, 2))
  process.exit(2)
}
