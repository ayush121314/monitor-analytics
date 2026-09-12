import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { SKILL_DIR, loadConfig, loadState, saveState, istStamp } from './lib.mjs'
import { toMarkdown, validate } from './render.mjs'

function parseArgs (argv) {
  const out = { advance: [], dry: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--body') out.body = argv[++i]
    else if (a === '--advance') out.advance.push(argv[++i])
    else if (a === '--data') out.data = argv[++i]
    else if (a === '--health') out.health = true
    else if (a === '--append') out.append = true
    else if (a === '--dry') out.dry = true
  }
  return out
}

function refreshStatus () {
  try { execFileSync(process.execPath, [path.join(SKILL_DIR, 'scripts', 'status.mjs')], { timeout: 60000, stdio: 'ignore' }) } catch {}
}

const args = parseArgs(process.argv.slice(2))
const cfg = loadConfig()
const state = loadState(cfg)

if (args.data) {
  if (!existsSync(args.data)) {
    console.error(`no such file: ${args.data}`)
    process.exit(1)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(args.data, 'utf8'))
  } catch (e) {
    console.error(`report JSON does not parse: ${e.message}`)
    process.exit(1)
  }
  const errors = validate(parsed)
  if (errors.length) {
    console.error('report JSON is not valid:\n' + errors.map(e => ' - ' + e).join('\n'))
    process.exit(1)
  }
  const bodyPath = path.join(cfg.dataDir, '.report-body.md')
  mkdirSync(cfg.dataDir, { recursive: true })
  writeFileSync(bodyPath, toMarkdown(parsed))
  args.body = bodyPath
  args.reportData = parsed
}

if (!args.body || !existsSync(args.body)) {
  console.error('usage: record.mjs --body <findings.md> --advance <repo>=<sha>[:<pr>] [--advance ...] [--dry]')
  process.exit(1)
}
if (args.append) {
  const findingsPath = path.join(cfg.dataDir, 'FINDINGS.md')
  if (!existsSync(findingsPath)) {
    console.error('nothing to append to — no FINDINGS.md yet')
    process.exit(1)
  }
  const text = readFileSync(findingsPath, 'utf8')
  const body = readFileSync(args.body, 'utf8').trim()
  const marker = text.lastIndexOf('\n---\n')
  const next = marker >= 0 ? text.slice(0, marker) + '\n\n' + body + text.slice(marker) : text + '\n' + body + '\n\n---\n\n'
  if (args.dry) {
    console.log(body)
    console.log(`[dry] would append ${body.length} chars into the latest report in ${findingsPath}`)
    process.exit(0)
  }
  writeFileSync(findingsPath, next)
  refreshStatus()
  console.log(JSON.stringify({ appended: true, chars: body.length, findings: findingsPath }, null, 2))
  process.exit(0)
}

if (!args.advance.length && !args.health) {
  console.error('refusing to record without at least one --advance <repo>=<sha> (use --health for a health-only report)')
  process.exit(1)
}

const known = new Set(cfg.repos.map(r => r.name))
const moves = []
for (const spec of args.advance) {
  const [name, rest] = spec.split('=')
  if (!known.has(name)) { console.error(`unknown repo: ${name}`); process.exit(1) }
  if (!rest) { console.error(`missing sha for ${name}`); process.exit(1) }
  const [sha, pr] = rest.split(':')
  const prev = state.repos[name] || {}
  moves.push({ name, sha, pr: pr ? Number(pr) : null, prevSha: prev.last_sha || null, prevPr: prev.last_pr || null })
}

const runNo = (state.runs || 0) + 1
const stamp = istStamp()
const header = [
  `## Run ${runNo} — ${stamp}${args.health ? ' · health check only' : ''}`,
  '',
  ...(args.health && !moves.length ? ['- no new commits since the last checkpoint — backend health only, checkpoints unchanged', ''] : []),
  ...moves.map(m => {
    const from = m.prevSha ? m.prevSha.slice(0, 8) : 'bootstrap'
    const prTxt = m.pr ? ` (through PR #${m.pr}${m.prevPr ? `, from #${m.prevPr}` : ''})` : ''
    return `- **${m.name}** checkpoint \`${from} → ${m.sha.slice(0, 8)}\`${prTxt}`
  }),
  ''
].join('\n')

const body = readFileSync(args.body, 'utf8').trim()
const block = `${header}\n${body}\n\n---\n\n`

const findingsPath = path.join(cfg.dataDir, 'FINDINGS.md')
if (args.dry) {
  console.log(block)
  console.log(`[dry] would append to ${findingsPath} and advance ${moves.length} checkpoint(s)`)
  process.exit(0)
}

mkdirSync(cfg.dataDir, { recursive: true })
if (!existsSync(findingsPath)) {
  writeFileSync(findingsPath, '# Feature audit findings\n\nAppend-only log. Newest run at the bottom. Written by the `feature-audit` skill.\n\n---\n\n')
}
appendFileSync(findingsPath, block)

const nowIso = new Date().toISOString()
for (const m of moves) {
  state.repos[m.name] = { last_sha: m.sha, last_pr: m.pr, last_run_at: nowIso, last_run_at_ist: stamp }
}
state.runs = runNo
saveState(cfg, state)
if (args.reportData) {
  const dir = path.join(cfg.dataDir, 'reports')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `run-${runNo}.json`), JSON.stringify({ run: runNo, stamp, ...args.reportData }, null, 2))
}
refreshStatus()

console.log(JSON.stringify({ recorded: true, run: runNo, findings: findingsPath, advanced: moves.map(m => `${m.name}=${m.sha.slice(0, 8)}`) }, null, 2))
