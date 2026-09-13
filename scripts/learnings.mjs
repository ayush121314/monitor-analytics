import { execFile } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, SKILL_DIR, istStamp } from './lib.mjs'

const cfg = loadConfig()
const file = path.join(cfg.dataDir, 'PREFERENCES.md')

function parseArgs (argv) {
  const out = { staleDays: 30, from: 'now-24h' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stale-days') out.staleDays = Number(argv[++i])
    else if (argv[i] === '--from') out.from = argv[++i]
  }
  return out
}

function grafanaCount (grep, from) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(SKILL_DIR, 'scripts', 'grafana.mjs'),
      '--repo', cfg.repos[0].name, '--grep', grep, '--from', from, '--count'],
    { timeout: 90000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve(null)
      try { const r = JSON.parse(stdout); resolve(r.error ? null : r.count) } catch { resolve(null) }
    })
  })
}

const args = parseArgs(process.argv.slice(2))

if (!existsSync(file)) {
  console.log(JSON.stringify({ error: `no learnings file yet at ${file}` }, null, 2))
  process.exit(0)
}

const text = readFileSync(file, 'utf8')
const lines = text.split('\n')
const learnings = []
let heading = ''
for (const raw of lines) {
  const line = raw.trim()
  if (/^##\s/.test(line)) { heading = line.replace(/^##\s*/, ''); continue }
  if (!/^[-*]\s/.test(line)) continue
  const body = line.replace(/^[-*]\s*/, '')
  const saved = body.match(/\[saved\s+(\d{4}-\d{2}-\d{2})\]/i)
  const threshold = body.match(/\b([\d,]{3,})\s*(?:in|per|\/)\s*24\s*h/i) || body.match(/crosses?\s+\*{0,2}([\d,]{3,})\*{0,2}/i)
  const quoted = body.match(/"([^"]{6,60})"/) || body.match(/`([^`]{6,60})`/)
  learnings.push({
    heading,
    text: body.replace(/\*\*/g, '').slice(0, 220),
    savedOn: saved ? saved[1] : null,
    thresholdValue: threshold ? Number(threshold[1].replace(/,/g, '')) : null,
    pattern: quoted ? quoted[1] : null
  })
}

const today = new Date()
const results = []
for (const l of learnings) {
  const ageDays = l.savedOn ? Math.round((today - new Date(l.savedOn)) / 86400000) : null
  let current = null
  if (l.pattern && l.thresholdValue) current = await grafanaCount(l.pattern, args.from)

  let verdict
  if (current != null && l.thresholdValue != null) {
    verdict = current >= l.thresholdValue
      ? `RE-OPEN — it is at ${current.toLocaleString()} against the ${l.thresholdValue.toLocaleString()} threshold this learning set`
      : `still current — ${current.toLocaleString()} against a ${l.thresholdValue.toLocaleString()} threshold`
  } else if (ageDays != null && ageDays > args.staleDays) {
    verdict = `${ageDays} days old and nothing here re-checks it — confirm it is still true or delete it`
  } else if (!l.thresholdValue) {
    verdict = 'no threshold written into it, so nothing can tell you when to look again — add one'
  } else {
    verdict = 'fine'
  }

  results.push({
    heading: l.heading,
    learning: l.text,
    savedOn: l.savedOn,
    ageDays,
    threshold: l.thresholdValue,
    measuredNow: current,
    pattern: l.pattern,
    verdict
  })
}

const reopen = results.filter(r => r.verdict.startsWith('RE-OPEN'))
const weak = results.filter(r => r.verdict.includes('add one') || r.verdict.includes('confirm it is still true'))

console.log(JSON.stringify({
  generatedAt: istStamp(),
  file,
  learnings: results.length,
  reopen: reopen.length,
  needsAttention: weak.length,
  verdict: reopen.length
    ? `${reopen.length} learning(s) have crossed their own threshold — stop suppressing them`
    : (results.length ? 'every learning is still within the bounds it set for itself' : 'no learnings recorded yet'),
  results
}, null, 2))
