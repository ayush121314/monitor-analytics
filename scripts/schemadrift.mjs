import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, istStamp, SKILL_DIR } from './lib.mjs'

const cfg = loadConfig()
const snapDir = path.join(cfg.dataDir, 'schema')
mkdirSync(snapDir, { recursive: true })

function envShValue (file, name) {
  if (!existsSync(file)) return null
  const m = readFileSync(file, 'utf8').match(new RegExp(`^export\\s+${name}=["']?([^"'\\n]+)`, 'm'))
  return m ? m[1].trim() : null
}

function stageConfig () {
  const p = path.join(cfg.dataDir, 'db.json')
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (j.stage?.host && j.stage?.user) return j.stage
    } catch {}
  }
  for (const repo of cfg.repos) {
    for (const name of ['env.sh', '.env.sh']) {
      const file = path.join(repo.path.replace(/-3$/, ''), name)
      const host = envShValue(file, 'MASTER_DB_HOST_RO')
      const user = envShValue(file, 'MASTER_DB_USERNAME_RO')
      const password = envShValue(file, 'MASTER_DB_PASSWORD_RO')
      const database = envShValue(file, 'MASTER_DATABASE')
      if (host && user && password) return { host, user, password, database: database || 'ecommerce_stage', from: file }
    }
  }
  return null
}

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
    else if (argv[i] === '--since') out.since = argv[++i]
    else if (argv[i] === '--from') out.from = argv[++i]
    else if (argv[i] === '--skip-errors') out.skipErrors = true
    else if (argv[i] === '--skip-stage') out.skipStage = true
  }
  return out
}

function git (repoPath, gitArgs) {
  try {
    return execFileSync('git', ['-C', repoPath, ...gitArgs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function usedInCode (identifier) {
  const hits = []
  for (const repo of cfg.repos) {
    const src = path.join(repo.path, 'src')
    if (!existsSync(src)) continue
    let out = ''
    try {
      out = execFileSync('grep', ['-rl', '--include=*.js', '--include=*.mjs', '-w', identifier, src],
        { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { out = '' }
    for (const f of out.trim().split('\n').filter(Boolean).slice(0, 3)) {
      hits.push(`${repo.name}:${path.relative(repo.path, f)}`)
    }
  }
  return hits
}

function classifyStageOnly (kind, name, identifier) {
  const files = usedInCode(identifier)
  return {
    kind,
    what: name,
    usedInCode: files.length > 0,
    where: files,
    verdict: files.length
      ? (kind === 'index'
          ? 'IMPORTANT — code queries this table, so prod is running those queries without the index'
          : 'CRITICAL — code references this and prod does not have it')
      : 'not an issue right now — nothing in the three repos references it'
  }
}

function sqlIdentifiersFromDiff (repo, since, schema) {
  const range = since ? `${since}..origin/${repo.branch}` : `origin/${repo.branch}~10..origin/${repo.branch}`
  const diff = git(repo.path, ['diff', '-U0', range])
  const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n')
  if (!added.trim()) return []

  const tables = Object.keys(schema.tables)
  const tableSet = new Set(tables)
  const findings = []
  const seen = new Set()
  const note = (table, column, how, sample) => {
    const key = `${table}.${column}`
    if (seen.has(key)) return
    seen.add(key)
    if (!tableSet.has(table)) return
    if (Object.prototype.hasOwnProperty.call(schema.tables[table], column)) return
    findings.push({ table, column, how, sample: sample.trim().slice(0, 160) })
  }

  for (const m of added.matchAll(/INSERT\s+INTO\s+`?(\w+)`?\s*\(([^)]{3,600})\)/gi)) {
    const table = m[1]
    for (const raw of m[2].split(',')) {
      const col = raw.replace(/[`\s]/g, '')
      if (/^[a-z_][a-z0-9_]*$/i.test(col)) note(table, col, 'INSERT column list', m[0])
    }
  }

  for (const m of added.matchAll(/UPDATE\s+`?(\w+)`?\s+SET\s+([^;]{3,400})/gi)) {
    const table = m[1]
    for (const part of m[2].split(',')) {
      const c = part.match(/^\s*`?([a-z_][a-z0-9_]*)`?\s*=/i)
      if (c) note(table, c[1], 'UPDATE SET', m[0])
    }
  }

  const JS_MEMBERS = new Set(['startsWith', 'endsWith', 'includes', 'length', 'map', 'filter', 'find', 'push', 'join', 'split', 'slice', 'trim', 'toString', 'replace', 'then', 'catch', 'forEach', 'reduce', 'some', 'every', 'match', 'test', 'toFixed', 'concat', 'keys', 'values', 'entries', 'indexOf', 'sort', 'flat', 'id', 'name', 'value', 'data', 'rows', 'body', 'query', 'params'])
  const SQLISH = /\b(SELECT|FROM|JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|INSERT\s+INTO|UPDATE|SET|VALUES|ON\s+DUPLICATE)\b/i

  for (const line of added.split('\n')) {
    if (!SQLISH.test(line)) continue
    const aliasMap = {}
    for (const m of line.matchAll(/\b(?:FROM|JOIN)\s+`?(\w+)`?(?:\s+(?:AS\s+)?`?([a-z][a-z0-9_]*)`?)?/gi)) {
      if (!tableSet.has(m[1])) continue
      aliasMap[m[1]] = m[1]
      if (m[2] && !/^(on|where|set|values|as|left|right|inner|outer|join|group|order|limit|using)$/i.test(m[2])) aliasMap[m[2]] = m[1]
    }
    if (!Object.keys(aliasMap).length) continue
    for (const m of line.matchAll(/\b([a-z][a-z0-9_]*)\.`?([a-z_][a-z0-9_]*)`?/gi)) {
      const table = aliasMap[m[1]]
      if (!table) continue
      if (JS_MEMBERS.has(m[2])) continue
      if (/\.\w+\s*\(/.test(m[0] + line.slice(line.indexOf(m[0]) + m[0].length, line.indexOf(m[0]) + m[0].length + 1))) continue
      note(table, m[2], 'qualified reference in SQL', line)
    }
  }

  return findings
}

function lokiDbErrors (from) {
  const patterns = [
    { key: 'Unknown column', why: 'a query references a column prod does not have' },
    { key: "doesn't exist", why: 'a query references a table prod does not have' },
    { key: 'ER_BAD_FIELD_ERROR', why: 'MySQL rejected an unknown column' },
    { key: 'ER_NO_SUCH_TABLE', why: 'MySQL rejected an unknown table' },
    { key: 'ER_PARSE_ERROR', why: 'malformed SQL reached prod' },
    { key: 'ER_WRONG_VALUE', why: 'a value did not fit the column type' },
    { key: 'Data truncated', why: 'a value did not fit the column type' },
    { key: 'Incorrect integer value', why: 'a value did not fit the column type' }
  ]
  const grafana = path.join(SKILL_DIR, 'scripts', 'grafana.mjs')
  const jobs = []
  for (const repo of cfg.repos) {
    for (const p of patterns) {
      jobs.push(new Promise(resolve => {
        execFile(process.execPath, [grafana, '--repo', repo.name, '--grep', p.key, '--from', from, '--limit', '20'],
          { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            if (err && !stdout) return resolve(null)
            try {
              const r = JSON.parse(stdout)
              if (!r || r.error || !r.lineCount) return resolve(null)
              resolve({
                app: repo.name,
                pattern: p.key,
                why: p.why,
                lines: r.lineCount,
                modules: r.modules || {},
                samples: (r.samples || []).slice(0, 2).map(x => ({ at: x.at, module: x.module, msg: x.msg, err: typeof x.err === 'string' ? x.err.slice(0, 200) : (x.err?.message || null) }))
              })
            } catch { resolve(null) }
          })
      }))
    }
  }
  return Promise.all(jobs).then(rs => rs.filter(Boolean))
}

let mysql2 = null
async function loadDriver () {
  if (mysql2 !== null) return mysql2
  for (const repo of cfg.repos) {
    for (const base of [repo.path, repo.path.replace(/-3$/, '')]) {
      const file = path.join(base, 'node_modules', 'mysql2', 'promise.js')
      if (!existsSync(file)) continue
      try {
        mysql2 = await import(pathToFileURL(file).href)
        return mysql2
      } catch {}
    }
  }
  mysql2 = false
  return mysql2
}

async function queryDriver (db, sql) {
  const driver = await loadDriver()
  if (!driver) return null
  let conn
  try {
    conn = await driver.createConnection({
      host: db.host, user: db.user, password: db.password, database: db.database || 'ecommerce',
      port: Number(db.port || 3306), connectTimeout: 20000
    })
    const [rows] = await conn.query(sql)
    return { rows: rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? '' : String(v)]))) }
  } catch (e) {
    return { error: String(e.message).slice(0, 300) }
  } finally {
    if (conn) { try { await conn.end() } catch {} }
  }
}

function queryCli (db, sql) {
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

async function query (db, sql) {
  const viaDriver = await queryDriver(db, sql)
  if (viaDriver && !viaDriver.error) return viaDriver
  const viaCli = await queryCli(db, sql)
  if (viaCli && !viaCli.error) return viaCli
  return viaDriver || viaCli
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

out.codeExpectsMissing = []
for (const repo of repos) {
  try {
    for (const f of sqlIdentifiersFromDiff(repo, args.since, now)) {
      out.codeExpectsMissing.push({ repo: repo.name, ...f })
    }
  } catch {}
}

if (!args.skipErrors) {
  out.dbErrorsInProd = await lokiDbErrors(args.from || 'now-24h')
}

out.verdictFromCode = out.codeExpectsMissing.length
  ? `${out.codeExpectsMissing.length} column(s) written or read by new code that prod does not have`
  : 'no new code references a column prod is missing'
out.verdictFromErrors = (out.dbErrorsInProd || []).length
  ? `${out.dbErrorsInProd.length} schema-shaped error pattern(s) firing in prod`
  : 'prod is not throwing any unknown-column or unknown-table errors'

if (!args.skipStage) {
  const stage = stageConfig()
  if (!stage) {
    out.stage = { error: 'no stage credentials — add a "stage" block to db.json or keep env.sh in the working checkout' }
  } else {
    const stageSchema = await readProd(stage)
    if (stageSchema.error) {
      out.stage = { error: stageSchema.error }
    } else {
      const d = diffSchemas(now, stageSchema)
      const judged = [
        ...d.newTables.map(t => classifyStageOnly('table', t, t)),
        ...d.newColumns.map(c => classifyStageOnly('column', `${c.table}.${c.column} ${c.type}`, c.column)),
        ...d.newIndexes
          .filter(i => i.index !== 'PRIMARY')
          .map(i => classifyStageOnly('index', `${i.table}.${i.index} (${i.cols})`, i.table))
      ]
      const mismatches = d.changedColumns.map(c => {
        const files = usedInCode(c.column)
        return {
          what: `${c.table}.${c.column}`,
          prod: c.was,
          stage: c.now,
          usedInCode: files.length > 0,
          where: files,
          verdict: files.length && /varchar\((\d+)\)/.test(c.was) && /varchar\((\d+)\)/.test(c.now) &&
            Number(c.was.match(/varchar\((\d+)\)/)[1]) < Number(c.now.match(/varchar\((\d+)\)/)[1])
            ? 'IMPORTANT — prod is narrower than stage, so a value that passes testing can truncate in prod'
            : files.length ? 'WATCH — type differs and code touches this column' : 'not an issue right now — nothing references it'
        }
      })
      out.stage = {
        judged,
        realIssues: judged.filter(j => j.usedInCode),
        notAnIssue: judged.filter(j => !j.usedInCode).map(j => j.what),
        typeMismatchJudged: mismatches,
        host: stage.host.split('.')[0],
        database: stage.database,
        source: stage.from ? path.basename(stage.from) : 'db.json',
        tables: Object.keys(stageSchema.tables).length,
        onStageNotInProd: {
          tables: d.newTables,
          columns: d.newColumns.map(c => `${c.table}.${c.column} ${c.type}`),
          indexes: d.newIndexes.map(i => `${i.table}.${i.index} (${i.cols})`)
        },
        onProdNotOnStage: {
          tables: d.droppedTables,
          columns: d.droppedColumns.map(c => `${c.table}.${c.column}`),
          indexes: d.droppedIndexes.map(i => `${i.table}.${i.index}`)
        },
        typeMismatch: d.changedColumns.map(c => `${c.table}.${c.column}: prod ${c.was} vs stage ${c.now}`)
      }
      const real = out.stage.realIssues.length
      const total = out.stage.judged.length
      out.stage.verdict = total
        ? (real
            ? `${real} of ${total} stage-only object(s) are actually used by the code — those are the issues; the rest are noise`
            : `${total} object(s) exist only on stage, but nothing in the code references any of them — not an issue right now`)
        : 'stage and prod agree on every table and column'
    }
  }
}

if (args.snapshot) {
  const file = path.join(snapDir, `prod-${new Date().toISOString().slice(0, 10)}.json`)
  writeFileSync(file, JSON.stringify(now, null, 2))
  out.snapshotWritten = path.basename(file)
}

console.log(JSON.stringify(out, null, 2))
