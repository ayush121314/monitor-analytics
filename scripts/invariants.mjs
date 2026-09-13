import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, SKILL_DIR, istStamp } from './lib.mjs'

const cfg = loadConfig()
const file = path.join(cfg.dataDir, 'invariants.json')

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') out.only = argv[++i]
    else if (argv[i] === '--dry') out.dry = true
  }
  return out
}

function dbConfig () {
  const p = path.join(cfg.dataDir, 'db.json')
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))
  const { FA_DB_HOST, FA_DB_USER, FA_DB_PASS, FA_DB_NAME } = process.env
  if (FA_DB_HOST && FA_DB_USER) return { host: FA_DB_HOST, user: FA_DB_USER, password: FA_DB_PASS, database: FA_DB_NAME || 'ecommerce' }
  return null
}

let driver = null
async function loadDriver () {
  if (driver !== null) return driver
  for (const repo of cfg.repos) {
    for (const base of [repo.path, repo.path.replace(/-3$/, '')]) {
      const f = path.join(base, 'node_modules', 'mysql2', 'promise.js')
      if (!existsSync(f)) continue
      try { driver = await import(pathToFileURL(f).href); return driver } catch {}
    }
  }
  driver = false
  return driver
}

async function runSql (db, sql) {
  const d = await loadDriver()
  if (!d) return { error: 'mysql2 not available' }
  let conn
  try {
    conn = await d.createConnection({ host: db.host, user: db.user, password: db.password, database: db.database, connectTimeout: 20000 })
    const [rows] = await conn.query(sql)
    return { row: rows[0] || {} }
  } catch (e) {
    return { error: String(e.message).slice(0, 250) }
  } finally {
    if (conn) { try { await conn.end() } catch {} }
  }
}

function runLoki (inv) {
  return new Promise(resolve => {
    const args = [path.join(SKILL_DIR, 'scripts', 'grafana.mjs'), '--repo', inv.repo || cfg.repos[0].name,
      '--from', inv.from || 'now-24h', '--count']
    if (inv.expr) args.push('--expr', inv.expr)
    else if (inv.grep) args.push('--grep', inv.grep)
    else if (inv.module) args.push('--module', inv.module)
    execFile(process.execPath, args, { timeout: 90000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ error: 'loki query failed' })
      try {
        const r = JSON.parse(stdout)
        resolve(r.error ? { error: r.error } : { row: { n: r.count } })
      } catch { resolve({ error: 'loki returned nothing parseable' }) }
    })
  })
}

function judge (value, expect) {
  const v = Number(value)
  const target = Number(expect.value)
  switch (expect.op) {
    case '==': return v === target
    case '!=': return v !== target
    case '<': return v < target
    case '<=': return v <= target
    case '>': return v > target
    case '>=': return v >= target
    default: return null
  }
}

const args = parseArgs(process.argv.slice(2))

if (!existsSync(file)) {
  console.log(JSON.stringify({
    error: `no invariants file yet — create ${file}`,
    example: [{
      id: 'refund-queue-clears',
      feature: 'Refund pipeline',
      says: 'Nothing sits in REFUND_QUEUED for more than 24 hours',
      severity: 'critical',
      kind: 'sql',
      query: "SELECT COUNT(*) AS n FROM product_orders WHERE order_status='REFUND_QUEUED' AND updated_at < NOW() - INTERVAL 24 HOUR",
      expect: { field: 'n', op: '==', value: 0 }
    }]
  }, null, 2))
  process.exit(0)
}

let list = []
try { list = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
  console.log(JSON.stringify({ error: `invariants.json does not parse: ${e.message}` }, null, 2))
  process.exit(0)
}
if (!Array.isArray(list)) list = list.invariants || []
if (args.only) list = list.filter(i => i.id === args.only)

const db = dbConfig()
const results = await Promise.all(list.map(async inv => {
  if (inv.paused) return { ...inv, skipped: 'paused' }
  const res = inv.kind === 'loki' ? await runLoki(inv) : (db ? await runSql(db, inv.query) : { error: 'no database config' })
  if (res.error) return { id: inv.id, feature: inv.feature, says: inv.says, severity: inv.severity, error: res.error }
  const field = inv.expect?.field || Object.keys(res.row)[0]
  const value = res.row[field]
  const ok = judge(value, inv.expect || { op: '==', value: 0 })
  return {
    id: inv.id,
    feature: inv.feature,
    says: inv.says,
    severity: inv.severity || 'important',
    kind: inv.kind || 'sql',
    value: value === null || value === undefined ? null : Number(value),
    expected: `${inv.expect?.field || 'n'} ${inv.expect?.op || '=='} ${inv.expect?.value ?? 0}`,
    holds: ok,
    verdict: ok === null ? 'could not evaluate' : ok ? 'holds' : `BROKEN — ${inv.says}`
  }
}))

if (!args.dry) {
  const stamped = list.map(inv => {
    const r = results.find(x => x.id === inv.id)
    return r && r.holds !== undefined ? { ...inv, lastChecked: istStamp(), lastValue: r.value, lastHeld: r.holds } : inv
  })
  writeFileSync(file, JSON.stringify(stamped, null, 2) + '\n')
}

const broken = results.filter(r => r.holds === false)
const errored = results.filter(r => r.error)

console.log(JSON.stringify({
  generatedAt: istStamp(),
  checked: results.length,
  broken: broken.length,
  errored: errored.length,
  verdict: broken.length
    ? `${broken.length} invariant(s) do not hold — the code is running but doing the wrong thing`
    : (results.length ? 'every invariant holds' : 'no invariants defined yet'),
  results
}, null, 2))
