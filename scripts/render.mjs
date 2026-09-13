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

export function actionsOf (data) {
  if (Array.isArray(data.actions)) return data.actions.filter(Boolean)
  const out = []
  for (const f of [...(data.health?.newCode?.findings || []), ...(data.health?.overall?.findings || [])]) {
    if (f.fix) out.push({ what: f.fix, who: '', severity: f.severity })
  }
  for (const n of data.needsAttention || []) out.push({ what: n.title, who: '', severity: n.severity, why: n.why })
  return out
}

export function toPoints (data) {
  if (Array.isArray(data.sections) && data.sections.some(s => Array.isArray(s.points))) {
    return data.sections.map(s => ({ title: s.title || 'Section', points: (s.points || []).filter(Boolean) }))
  }
  const feats = (data.features || []).map(f => ({
    severity: f.severity,
    title: f.name + (f.pr ? ` (PR #${String(f.pr).replace(/^#/, '')})` : ''),
    explain: [f.matlab, f.loss && !/^none\b/i.test(f.loss) ? `Nuksaan: ${f.loss}` : null, f.verdict].filter(Boolean).join('\n')
  }))
  const healthFindings = [
    ...(data.health?.newCode?.findings || []),
    ...(data.health?.overall?.findings || []),
    ...(data.needsAttention || []).map(n => ({ severity: n.severity, title: n.title, body: n.why }))
  ]
  const seen = new Set()
  const health = []
  for (const f of healthFindings) {
    const key = String(f.title || '').toLowerCase().slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    health.push({ severity: f.severity, title: f.title, explain: [f.body, f.fix ? `Fix: ${f.fix}` : null].filter(Boolean).join('\n') })
  }
  return [
    { title: 'New features', points: feats },
    { title: 'Backend health', points: health }
  ]
}

export function validate (data) {
  const errors = []
  if (!data || typeof data !== 'object') return ['report must be a JSON object']
  if (!data.bottomLine) errors.push('bottomLine is required — one sentence a reader can act on')

  if (Array.isArray(data.sections) && data.sections.some(s => Array.isArray(s.points))) {
    for (const [i, sec] of data.sections.entries()) {
      if (!sec.title) errors.push(`sections[${i}].title is required`)
      for (const [j, pt] of (sec.points || []).entries()) {
        if (!pt.title) errors.push(`sections[${i}].points[${j}].title is required — one line, plain words`)
        if (!pt.explain) errors.push(`sections[${i}].points[${j}].explain is required — the easy-language explanation`)
        if (!pt.severity || !SEV[String(pt.severity).toLowerCase()]) errors.push(`sections[${i}].points[${j}].severity must be one of ${Object.keys(SEV).join(', ')}`)
      }
    }
    for (const [i, a] of (data.actions || []).entries()) {
      if (!a.what) errors.push(`actions[${i}].what is required — the thing to do, in one line`)
      if (!a.who) errors.push(`actions[${i}].who is required — who does it (backend / infra / DB owner / CMS), so the reader knows where to send it`)
    }
    return errors
  }

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
  if (Array.isArray(data.sections) && data.sections.some(s => Array.isArray(s.points))) {
    const md = []
    if (data.window) md.push(`**Window:** ${data.window}`)
    md.push(`**Bottom line:** ${data.bottomLine}`)
    md.push('')
    const secs = toPoints(data)
    for (const [i, sec] of secs.entries()) {
      md.push(`### ${i + 1}. ${sec.title}`)
      md.push('')
      if (!sec.points.length) md.push('Nothing here.')
      for (const pt of sec.points) {
        const sv = severity(pt.severity)
        md.push(`**${sv.emoji} ${pt.title}**`)
        md.push('')
        md.push(String(pt.explain || '').trim())
        md.push('')
        if (pt.proof?.length) {
          md.push(...pt.proof.map(x => `_${x}_`))
          md.push('')
        }
      }
    }

    const actions = actionsOf(data)
    md.push(`### ${secs.length + 1}. Conclusion`)
    md.push('')
    if (!actions.length) md.push('Nothing to act on.')
    for (const a of actions) {
      const sv = severity(a.severity)
      md.push(`- ${sv.emoji} **${a.what}**${a.who ? ` — ${a.who}` : ''}${a.why ? ` (${a.why})` : ''}`)
    }
    md.push('')
    return md.join('\n')
  }

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
