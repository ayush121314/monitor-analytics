import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, istStamp } from './lib.mjs'

const cfg = loadConfig()
const snapDir = path.join(cfg.dataDir, 'schema')
mkdirSync(snapDir, { recursive: true })

function dbConfig () {
  const p = path.join(cfg.dataDir, 'db.json')
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))
  const { FA_DB_HOST, FA_DB_USER, FA_DB_PASS, FA_DB_NAME } = process.env
  if (FA_DB_HOST && FA_DB_USER) return { host: FA_DB_HOST, user: FA_DB_USER, password: FA_DB_PASS, database: FA_DB_NAME || 'ecommerce' }
  return null
}

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--snapshot') out.snapshot = true
    else if (argv[i] === '--repo') out.repo = argv[++i]
    else if (argv[i] === '--against') out.against = argv[++i]
  }
  return out
}

function query (db, sql) {
  return new Promise(resolve => {
    execFile('mysql', ['-h', db.host, '-u', db.user, `-p${db.password}`, db.database || 'ecommerce', '--batch', '--raw', '-e', sql],
      { timeout: 180000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ error: String(stderr || err.message).replace(/\[Warning\][^\n]*\n/g, '').slice(0, 300) })
        const lines = stdout.trim().split('\n').filter(Boolean)
        if (!lines.length) return resolve({ rows: [] })
        const cols = lines[0].split('\t')
        resolve({ rows: lines.slice(1).map(l => { const v = l.split('\t'); return Object.fromEntries(cols.map((c, i) => [c, v[i]])) }) })
      })
  })
}

async function readProd (db) {
  const cols = await query(db, `SELECT table_name tbl, column_name col, column_type typ, is_nullable nul, COALESCE(column_default,'') dflt
    FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY tbl, col`)
  if (cols.error) return { error: cols.error }
  const idx = await query(db, `SELECT table_name tbl, index_name idx, GROUP_CONCAT(column_name ORDER BY seq_in_index) cols, MAX(non_unique) non_unique
    FROM information_schema.statistics WHERE table_schema = DATABASE() GROUP BY tbl, idx ORDER BY tbl, idx`)
  const schema = { at: new Date().toISOString(), atIst: istStamp(), tables: {}, indexes: {} }
  for (const r of cols.rows) {
    schema.tables[r.tbl] = schema.tables[r.tbl] || {}
    schema.tables[r.tbl][r.col] = `${r.typ}${r.nul === 'NO' ? ' NOT NULL' : ''}${r.dflt ? ` DEFAULT ${r.dflt}` : ''}`
  }
  for (const r of (idx.rows || [])) {
    schema.indexes[r.tbl] = schema.indexes[r.tbl] || {}
    schema.indexes[r.tbl][r.idx] = { cols: r.cols, unique: r.non_unique === '0' }
  }
  return schema
}

function stripSql (sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
}

const ident = s => String(s || '').replace(/[`"']/g, '').trim()

function parseMigration (sql) {
  const expects = []
  const text = stripSql(sql)
  for (const stmt of text.split(';')) {
    const s = stmt.trim()
    if (!s) continue

    const create = s.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.]+)/i)
    if (create) { expects.push({ kind: 'table', table: ident(create[1]), want: 'present' }); continue }

    const dropT = s.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`"\w.]+)/i)
    if (dropT) { expects.push({ kind: 'table', table: ident(dropT[1]), want: 'absent' }); continue }

    const createIdx = s.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+([`"\w]+)\s+ON\s+([`"\w.]+)/i)
    if (createIdx) { expects.push({ kind: 'index', table: ident(createIdx[3]), index: ident(createIdx[2]), want: 'present' }); continue }

    const alter = s.match(/ALTER\s+TABLE\s+([`"\w.]+)([\s\S]*)/i)
    if (!alter) continue
    const table = ident(alter[1])
    const body = alter[2]
    for (const m of body.matchAll(/ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!INDEX\b|KEY\b|UNIQUE\b|CONSTRAINT\b|PRIMARY\b|FOREIGN\b|FULLTEXT\b|SPATIAL\b)`?([A-Za-z_][\w]*)`?\s+([A-Za-z]+)/gi)) {
      expects.push({ kind: 'column', table, column: ident(m[1]), want: 'present' })
    }
    for (const m of body.matchAll(/DROP\s+(?:COLUMN\s+)?`?([A-Za-z_][\w]*)`?/gi)) {
      const name = ident(m[1])
      if (/^(index|key|primary|foreign|constraint)$/i.test(name)) continue
      expects.push({ kind: 'column', table, column: name, want: 'absent' })
    }
    for (const m of body.matchAll(/(?:MODIFY|CHANGE)\s+(?:COLUMN\s+)?`?([A-Za-z_][\w]*)`?/gi)) {
      expects.push({ kind: 'column', table, column: ident(m[1]), want: 'present' })
    }
    for (const m of body.matchAll(/ADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\s+`?([A-Za-z_][\w]*)`?\s*\(/gi)) {
      expects.push({ kind: 'index', table, index: ident(m[1]), want: 'present' })
    }
  }
  return expects
}

function checkExpectation (schema, e) {
  if (e.kind === 'table') {
    const present = !!schema.tables[e.table]
    const ok = e.want === 'present' ? present : !present
    return { ...e, present, ok, stale: !ok && e.want === 'present' }
  }
  if (e.kind === 'column') {
    const t = schema.tables[e.table]
    if (!t) return { ...e, present: false, ok: true, stale: true, note: 'the table itself is gone from prod — old migration' }
    const present = Object.prototype.hasOwnProperty.call(t, e.column)
    return { ...e, present, ok: e.want === 'present' ? present : !present }
  }
  if (!schema.tables[e.table]) return { ...e, present: false, ok: true, stale: true, note: 'the table itself is gone from prod — old migration' }
  const t = schema.indexes[e.table] || {}
  const present = Object.prototype.hasOwnProperty.call(t, e.index)
  return { ...e, present, ok: e.want === 'present' ? present : !present }
}

function diffSchemas (before, after) {
  const out = { newTables: [], droppedTables: [], newColumns: [], droppedColumns: [], changedColumns: [], newIndexes: [], droppedIndexes: [] }
  const bt = before.tables || {}
  const at = after.tables || {}
  for (const t of Object.keys(at)) if (!bt[t]) out.newTables.push(t)
  for (const t of Object.keys(bt)) if (!at[t]) out.droppedTables.push(t)
  for (const t of Object.keys(at)) {
    if (!bt[t]) continue
    for (const c of Object.keys(at[t])) {
      if (!(c in bt[t])) out.newColumns.push({ table: t, column: c, type: at[t][c] })
      else if (bt[t][c] !== at[t][c]) out.changedColumns.push({ table: t, column: c, was: bt[t][c], now: at[t][c] })
    }
    for (const c of Object.keys(bt[t])) if (!(c in at[t])) out.droppedColumns.push({ table: t, column: c, was: bt[t][c] })
  }
  const bi = before.indexes || {}
  const ai = after.indexes || {}
  for (const t of Object.keys(ai)) for (const i of Object.keys(ai[t])) if (!bi[t]?.[i]) out.newIndexes.push({ table: t, index: i, cols: ai[t][i].cols })
  for (const t of Object.keys(bi)) for (const i of Object.keys(bi[t])) if (!ai[t]?.[i]) out.droppedIndexes.push({ table: t, index: i, cols: bi[t][i].cols })
  return out
}

const args = parseArgs(process.argv.slice(2))
const db = dbConfig()
if (!db) {
  console.log(JSON.stringify({ error: `no database config — create ${path.join(cfg.dataDir, 'db.json')} or set FA_DB_*` }, null, 2))
  process.exit(0)
}

const now = await readProd(db)
if (now.error) {
  console.log(JSON.stringify({ error: now.error }, null, 2))
  process.exit(0)
}

const snaps = readdirSync(snapDir).filter(f => /^prod-.*\.json$/.test(f)).sort()
const previousFile = args.against || (snaps.length ? path.join(snapDir, snaps[snaps.length - 1]) : null)
let previous = null
if (previousFile && existsSync(previousFile)) {
  try { previous = JSON.parse(readFileSync(previousFile, 'utf8')) } catch {}
}

const out = {
  generatedAt: istStamp(),
  tables: Object.keys(now.tables).length,
  columns: Object.values(now.tables).reduce((a, t) => a + Object.keys(t).length, 0)
}

if (previous) {
  out.comparedAgainst = { file: path.basename(previousFile), takenAt: previous.atIst || previous.at }
  out.drift = diffSchemas(previous, now)
  const d = out.drift
  out.driftSummary = [
    d.newTables.length && `${d.newTables.length} new table(s)`,
    d.droppedTables.length && `${d.droppedTables.length} dropped table(s)`,
    d.newColumns.length && `${d.newColumns.length} new column(s)`,
    d.droppedColumns.length && `${d.droppedColumns.length} dropped column(s)`,
    d.changedColumns.length && `${d.changedColumns.length} changed column(s)`,
    d.newIndexes.length && `${d.newIndexes.length} new index(es)`,
    d.droppedIndexes.length && `${d.droppedIndexes.length} dropped index(es)`
  ].filter(Boolean).join(' · ') || 'no change since that snapshot'
} else {
  out.comparedAgainst = null
  out.driftSummary = 'no earlier snapshot — this run establishes the baseline'
}

const repos = args.repo ? cfg.repos.filter(r => r.name === args.repo) : cfg.repos
out.migrations = []
for (const repo of repos) {
  const dir = path.join(repo.path, 'migrations')
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql') && !/rollback/i.test(f)).sort()) {
    let expects = []
    try { expects = parseMigration(readFileSync(path.join(dir, file), 'utf8')) } catch { continue }
    if (!expects.length) continue
    const checked = expects.map(e => checkExpectation(now, e))
    const missing = checked.filter(c => !c.ok && !c.stale)
    const stale = checked.filter(c => c.stale)
    out.migrations.push({
      repo: repo.name,
      file,
      expectations: checked.length,
      applied: checked.length - missing.length - stale.length,
      stale: stale.length,
      missing: missing.map(m => ({
        what: m.kind === 'column' ? `${m.table}.${m.column}` : m.kind === 'index' ? `${m.table} index ${m.index}` : m.table,
        expected: m.want,
        note: m.note || (m.want === 'present' ? 'not in prod — code touching it will fail' : 'still in prod — the drop never ran')
      }))
    })
  }
}

const notApplied = out.migrations.filter(m => m.missing.length)
out.notApplied = notApplied.map(m => `${m.file}: ${m.missing.map(x => `${x.what} (${x.note})`).join(', ')}`)
out.staleMigrations = out.migrations.filter(m => m.stale && !m.missing.length).length
out.verdict = notApplied.length
  ? `${notApplied.length} migration file(s) expect something prod does not have — code touching those columns will fail`
  : 'every live migration is reflected in prod'
out.migrations = out.migrations.filter(m => m.missing.length)

if (args.snapshot) {
  const file = path.join(snapDir, `prod-${new Date().toISOString().slice(0, 10)}.json`)
  writeFileSync(file, JSON.stringify(now, null, 2))
  out.snapshotWritten = path.basename(file)
}

console.log(JSON.stringify(out, null, 2))
