const SEV = {
  critical: { emoji: '🔴', label: 'CRITICAL' },
  important: { emoji: '🟠', label: 'IMPORTANT' },
  watch: { emoji: '🟡', label: 'WATCH' },
  pending: { emoji: '⏳', label: 'NOT DEPLOYED' },
  reverted: { emoji: '🔁', label: 'REVERTED' },
  working: { emoji: '✅', label: 'WORKING' },
  none: { emoji: '⚪', label: 'NO SURFACE' },
  resolved: { emoji: '✅', label: 'RESOLVED' }
}

export const SEVERITIES = SEV

export function severity (s) {
  return SEV[String(s || '').toLowerCase()] || SEV.watch
}

export const RANK = { critical: 0, important: 1, pending: 2, watch: 3, reverted: 4, working: 5, none: 6, resolved: 7 }

export function validate (data) {
  const errors = []
  if (!data || typeof data !== 'object') return ['report must be a JSON object']
  if (!data.bottomLine) errors.push('bottomLine is required — one sentence a reader can act on')
  if (!Array.isArray(data.features)) errors.push('features must be an array (use [] for a health-only run)')
  for (const [i, f] of (data.features || []).entries()) {
    if (!f.name) errors.push(`features[${i}].name is required`)
    if (!f.severity || !SEV[String(f.severity).toLowerCase()]) errors.push(`features[${i}].severity must be one of ${Object.keys(SEV).join(', ')}`)
    if (!f.matlab) errors.push(`features[${i}].matlab is required — the plain line for the summary`)
    if (f.loss === undefined) errors.push(`features[${i}].loss is required — write "none — <what would have shown it>" when nothing was lost`)
    if (!Array.isArray(f.checked) || !f.checked.length) errors.push(`features[${i}].checked must list the probes you ran`)
  }
  for (const key of ['newCode', 'overall']) {
    const sec = data.health?.[key]
    if (!sec) continue
    for (const [i, f] of (sec.findings || []).entries()) {
      if (!f.title) errors.push(`health.${key}.findings[${i}].title is required`)
      if (!f.severity || !SEV[String(f.severity).toLowerCase()]) errors.push(`health.${key}.findings[${i}].severity is invalid`)
    }
  }
  return errors
}

export function blocksMd (blocks) {
  const out = []
  for (const b of blocks || []) {
    if (!b) continue
    const type = b.type || (b.rows ? 'table' : b.items ? 'list' : 'text')
    if (b.title) { out.push(`**${b.title}**`); out.push('') }
    if (type === 'table') out.push(...table(b.rows))
    else if (type === 'list') { out.push(...(b.items || []).map(i => `- ${i}`)); out.push('') }
    else if (type === 'numbered') { out.push(...(b.items || []).map((i, n) => `${n + 1}. ${i}`)); out.push('') }
    else if (type === 'code') { out.push('```' + (b.lang || '')); out.push(b.text || ''); out.push('```'); out.push('') }
    else if (type === 'kv') { out.push(...(b.rows || []).map(r => `- **${r.k}:** ${r.v}`)); out.push('') }
    else if (type === 'quote') { out.push(...String(b.text || '').split('\n').map(l => `> ${l}`)); out.push('') }
    else { out.push(b.text || ''); out.push('') }
  }
  return out
}

function table (rows) {
  if (!rows?.length) return []
  const cols = Object.keys(rows[0])
  const out = ['| ' + cols.join(' | ') + ' |', '|' + cols.map(() => '---').join('|') + '|']
  for (const r of rows) out.push('| ' + cols.map(c => String(r[c] ?? '')).join(' | ') + ' |')
  out.push('')
  return out
}

function findingMd (f) {
  const s = severity(f.severity)
  const out = [`**${s.emoji} ${f.title}**`, '']
  if (f.body) { out.push(f.body); out.push('') }
  if (f.evidence?.length) { out.push(...f.evidence.map(e => `- ${e}`)); out.push('') }
  out.push(...blocksMd(f.blocks))
  if (f.fix) { out.push(`_Fix:_ ${f.fix}`); out.push('') }
  return out
}

export function toMarkdown (data) {
  const md = []
  const sorted = [...(data.features || [])].sort((a, b) => (RANK[String(a.severity).toLowerCase()] ?? 9) - (RANK[String(b.severity).toLowerCase()] ?? 9))

  if (data.window) md.push(`**Window:** ${data.window}`)
  if (data.tally) {
    const t = Object.entries(data.tally).filter(([, n]) => n)
      .map(([k, n]) => `${severity(k).emoji} ${n} ${k}`).join(' · ')
    if (t) md.push(`**Tally:** ${t}`)
  }
  if (data.prodHeads?.length) {
    md.push(`**Prod heads:** ${data.prodHeads.map(h => `${h.repo} \`${h.sha}\`${h.at ? ' ' + h.at : ''}`).join(' · ')}`)
  }
  if (data.appliedLearnings?.length) md.push(`**Applied learnings:** ${data.appliedLearnings.join(' · ')}`)
  md.push(`**Bottom line:** ${data.bottomLine}`)
  md.push('')

  md.push('### 1. Features shipped')
  md.push('')
  if (!sorted.length) {
    md.push('No new commits since the last checkpoint — nothing shipped to analyse.')
    md.push('')
  }
  for (const f of sorted) {
    const s = severity(f.severity)
    const meta = [f.pr ? `PR #${String(f.pr).replace(/^#/, '')}` : null, f.liveAt ? `live ${f.liveAt}` : (f.severity === 'pending' ? 'not deployed' : null)]
      .filter(Boolean).join(', ')
    md.push(`**${f.name}**${meta ? ` (${meta})` : ''} — ${s.emoji} ${f.verdictLabel || s.label}`)
    md.push(`- **Matlab:** ${f.matlab}`)
    if (f.kyaHai) md.push(`- **Kya hai:** ${f.kyaHai}`)
    md.push(`- **Loss:** ${f.loss}`)
    md.push(`- **Checked:** ${(f.checked || []).map((c, i) => `(${i + 1}) ${c}`).join('; ')}`)
    if (f.verdict) md.push(`- **Verdict:** ${f.verdict}`)
    md.push('')
    md.push(...blocksMd(f.blocks))
  }

  md.push('### 2. Health')
  md.push('')
  md.push('#### 2.1 Naya code kuch tod to nahi raha')
  md.push('')
  const nc = data.health?.newCode || {}
  if (nc.summary) { md.push(nc.summary); md.push('') }
  md.push(...table(nc.table))
  md.push(...blocksMd(nc.blocks))
  for (const f of nc.findings || []) md.push(...findingMd(f))

  md.push('#### 2.2 Overall backend health')
  md.push('')
  const ov = data.health?.overall || {}
  if (ov.summary) { md.push(ov.summary); md.push('') }
  md.push(...table(ov.table))
  md.push(...blocksMd(ov.blocks))
  for (const f of ov.findings || []) md.push(...findingMd(f))

  if (data.needsAttention?.length) {
    md.push('### Needs attention')
    md.push('')
    data.needsAttention.forEach((n, i) => {
      const s = severity(n.severity)
      md.push(`${i + 1}. ${s.emoji} **${n.title}** — ${n.why}`)
    })
    md.push('')
  }

  for (const sec of data.sections || []) {
    md.push(`### ${sec.title || 'More'}`)
    md.push('')
    if (sec.summary) { md.push(sec.summary); md.push('') }
    md.push(...blocksMd(sec.blocks))
    for (const f of sec.findings || []) md.push(...findingMd(f))
  }

  if (data.method?.length) {
    md.push('### Method / caveats')
    md.push('')
    md.push(...data.method.map(m => `- ${m}`))
    md.push('')
  }

  return md.join('\n')
}
