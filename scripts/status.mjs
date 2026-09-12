import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, loadState, istStamp } from './lib.mjs'

const cfg = loadConfig()
const findingsPath = path.join(cfg.dataDir, 'FINDINGS.md')
const statusPath = path.join(cfg.dataDir, 'STATUS.md')

function reports (n = 3) {
  if (!existsSync(findingsPath)) return []
  const parts = readFileSync(findingsPath, 'utf8').split(/^## Run /m).slice(1)
  return parts.slice(-n).reverse().map(part => ({
    header: part.split('\n')[0],
    body: part.split('\n').slice(1).join('\n')
  }))
}

function latestReport () {
  return reports(1)[0] || null
}

function features (body) {
  const out = []
  const lines = body.split('\n')
  let cur = null
  for (const raw of lines) {
    const line = raw.trimEnd()
    const m = line.match(/^\*\*(.+?)\*\*\s*(?:\((.+?)\))?\s*[—-]+\s*(.+)$/)
    if (m && /🔴|🟡|✅|⏳|🔁|⚪/.test(m[3])) {
      cur = { name: m[1], meta: m[2] || '', verdict: m[3], matlab: '', loss: '' }
      out.push(cur)
      continue
    }
    if (!cur) continue
    const kv = line.match(/^- \*\*(.+?):\*\*\s*(.*)$/)
    if (!kv) continue
    if (/^matlab|^meaning/i.test(kv[1])) cur.matlab = kv[2]
    if (/^loss/i.test(kv[1])) cur.loss = kv[2]
  }

  for (const raw of lines) {
    const m = raw.trimEnd().match(/^\*\*(🔴|🟠|🟡|⚠️)\s*(.+?)\.?\*\*\s*(.*)$/)
    if (!m) continue
    const name = m[2].replace(/^New this run\s*[—-]\s*/i, '').trim()
    if (/^(closed|resolved|fixed)\b/i.test(name)) continue
    if (out.some(f => sameThing(f.name, name))) continue
    out.push({ name, meta: '', verdict: m[1], matlab: (m[3] || '').slice(0, 220), loss: '' })
  }
  return out
}

function emoji (v) {
  const m = v.match(/🔴|🟠|🟡|✅|⏳|🔁|⚪|⚠️/)
  return m ? m[0] : '•'
}

const STOP = new Set(['still', 'unchanged', 'chronic', 'again', 'this', 'that', 'with', 'from', 'into', 'have', 'been', 'they', 'their', 'them', 'about', 'every', 'each', 'these', 'those', 'when', 'what', 'which', 'nothing', 'answers', 'returns', 'a day', 'run'])

function words (name) {
  return new Set(name.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)))
}

function sameThing (a, b) {
  const wa = words(a)
  const wb = words(b)
  if (!wa.size || !wb.size) return false
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / Math.min(wa.size, wb.size) >= 0.5
}

function lastRunMeta () {
  const dir = path.join(cfg.dataDir, 'runs')
  if (!existsSync(dir)) return null
  const metas = readdirSync(dir).filter(f => f.endsWith('.meta.json')).sort()
  for (let i = metas.length - 1; i >= 0; i--) {
    try {
      const m = JSON.parse(readFileSync(path.join(dir, metas[i]), 'utf8'))
      if (['analysed', 'health-only'].includes(m.outcome)) return m
    } catch {}
  }
  return null
}

const state = loadState(cfg)
const report = latestReport()
const recent = reports(2)
const seenNames = new Set()
const open = []
for (const r of recent) {
  for (const f of features(r.body)) {
    if (!/🔴|🟠|🟡|⏳/.test(f.verdict)) continue
    if (/^(closed|resolved|fixed)\b/i.test(f.name)) continue
    if (open.some(o => sameThing(o.name, f.name))) continue
    open.push(f)
  }
}
const meta = lastRunMeta()
let health = null
try { health = JSON.parse(readFileSync(path.join(cfg.dataDir, 'health.json'), 'utf8')) } catch {}

const summaryLines = report
  ? report.body.split('\n').filter(l => /^\*\*(Window|Tally|Prod heads|Bottom line|Applied learnings)/.test(l))
  : []

const md = []
md.push('# Right now')
md.push('')
md.push(`_Rewritten by every audit run. Last updated ${istStamp()}._`)
md.push('')

const bottom = summaryLines.find(l => l.startsWith('**Bottom line'))
if (bottom) {
  md.push('## Bottom line')
  md.push('')
  md.push(bottom.replace(/^\*\*Bottom line:\*\*\s*/, ''))
  md.push('')
}

md.push('## What is still open')
md.push('')
if (!open.length) {
  md.push('Nothing carried forward — the last report closed everything it looked at.')
} else {
  open.forEach((f, i) => {
    const line = (f.matlab || f.loss || f.verdict).replace(/\*\*/g, '').trim()
    md.push(`${i + 1}. ${emoji(f.verdict)} **${f.name}**${f.meta ? ` _(${f.meta})_` : ''} — ${line}`)
  })
}
md.push('')

md.push('## Where the audit has reached')
md.push('')
md.push('| repo | analysed through | prod head | last checked |')
md.push('|---|---|---|---|')
for (const r of cfg.repos) {
  const s = state.repos[r.name] || {}
  md.push(`| ${r.name} | ${s.last_sha ? '`' + s.last_sha.slice(0, 8) + '`' : '—'}${s.last_pr ? ` · PR #${s.last_pr}` : ''} | ${s.prod_head ? '`' + s.prod_head + '`' + (s.prod_head_at_ist ? ` · ${s.prod_head_at_ist}` : '') : '—'} | ${s.last_checked_at_ist || '—'} |`)
}
md.push('')

md.push('## Last run')
md.push('')
if (meta) {
  const tok = meta.tokensOut ? `${meta.tokensOut.toLocaleString()} tokens written` : 'tokens not recorded'
  md.push(`${meta.startedAtIst} · ${meta.outcome === 'health-only' ? 'health check only' : 'full audit'} · ${meta.pending ?? 0} change(s) · ${tok} · $${(meta.costUsd ?? 0).toFixed(2)} · ${Math.round((meta.durationMs || 0) / 60000)} min`)
} else {
  md.push('No completed run recorded yet.')
}
md.push('')
if (summaryLines.length) {
  md.push('## That run in one screen')
  md.push('')
  for (const l of summaryLines) md.push(`- ${l.replace(/^\*\*/, '**')}`)
  md.push('')
}

md.push('## Is the tool itself healthy')
md.push('')
if (health) {
  md.push(`${health.ok ? 'Yes' : 'No'} — checked ${health.atIst}`)
  md.push('')
  for (const c of health.checks || []) md.push(`- ${c.ok ? '✅' : '❌'} ${c.name} — ${c.detail}${c.fixed ? ` _(${c.fixed})_` : ''}`)
} else {
  md.push('The monitor has not written a health file yet.')
}
md.push('')
md.push('---')
md.push('')
md.push(`Full history: [FINDINGS.md](FINDINGS.md) · standing learnings: [PREFERENCES.md](PREFERENCES.md) · how it all works: [HOW-IT-WORKS.md](HOW-IT-WORKS.md)`)
md.push('')

writeFileSync(statusPath, md.join('\n'))
console.log(JSON.stringify({ written: statusPath, open: open.length, repos: cfg.repos.length }, null, 2))
