import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, loadState, saveState, SKILL_DIR, istStamp, toIst } from './lib.mjs'

let cfg = loadConfig()
const runsDir = path.join(cfg.dataDir, 'runs')
mkdirSync(runsDir, { recursive: true })

const jobs = new Map()
let jobSeq = 0

const chatDir = path.join(cfg.dataDir, 'discussions')
mkdirSync(chatDir, { recursive: true })
const prefsPath = () => path.join(cfg.dataDir, 'PREFERENCES.md')
const threadPath = key => path.join(chatDir, `${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)

function readThread (key) {
  const p = threadPath(key)
  if (!existsSync(p)) return { key, sessionId: null, messages: [] }
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return { key, sessionId: null, messages: [] } }
}
function writeThread (thread) {
  writeFileSync(threadPath(thread.key), JSON.stringify(thread, null, 2))
}
function readPrefs () {
  const p = prefsPath()
  if (!existsSync(p)) {
    writeFileSync(p, [
      '# Learnings',
      '',
      'What the audit has been told, and what it must do about it. Every run reads this file first and applies it.',
      'Each bullet: **what** — why it is true — how to apply it (and when to stop applying it).',
      '',
      '## Known and not worth reporting again',
      '',
      '## Always check',
      '',
      '## How to report',
      ''
    ].join('\n') + '\n')
  }
  return readFileSync(p, 'utf8')
}

function askClaude (prompt, sessionId) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    const model = process.env.FEATURE_AUDIT_CHAT_MODEL || 'claude-sonnet-5'
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--model', model]
    for (const r of cfg.repos) args.push('--add-dir', r.path)
    args.push('--add-dir', SKILL_DIR)
    if (sessionId) args.push('--resume', sessionId)
    const child = spawn('claude', args, { cwd: cfg.dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d.toString() })
    child.stderr.on('data', d => { err += d.toString() })
    child.on('error', e => reject(e))
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out)
        const u = parsed.usage || {}
        resolve({
          text: parsed.result || '',
          sessionId: parsed.session_id || sessionId || null,
          tokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          costUsd: parsed.total_cost_usd ?? null
        })
      } catch (e) {
        try { writeFileSync(path.join(runsDir, 'chat-last.raw'), `# parse error: ${e.message}\n# stderr:\n${err}\n# stdout:\n${out}`) } catch {}
        const m = out.match(/\{[\s\S]*\}/)
        if (m) {
          try {
            const parsed = JSON.parse(m[0])
            const u = parsed.usage || {}
            return resolve({
              text: parsed.result || '',
              sessionId: parsed.session_id || sessionId || null,
              tokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
              costUsd: parsed.total_cost_usd ?? null
            })
          } catch {}
        }
        reject(new Error((err || out || 'claude returned nothing').slice(0, 500)))
      }
    })
  })
}

const jobLogPath = id => path.join(runsDir, `${id}.log`)
const jobMetaPath = id => path.join(runsDir, `${id}.meta.json`)
const configPath = () => path.join(SKILL_DIR, 'config.json')

function readBody (req) {
  return new Promise(resolve => {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) } })
  })
}

function collect (opts = {}) {
  const args = [path.join(SKILL_DIR, 'scripts', 'collect.mjs')]
  for (const r of (opts.repos || [])) args.push('--repo', r)
  if (opts.since) args.push('--since', opts.since)
  if (opts.noFetch) args.push('--no-fetch')
  const out = execFileSync(process.execPath, args, { cwd: SKILL_DIR, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  return JSON.parse(out)
}

function describeTool (block) {
  const name = block.name || 'tool'
  const input = block.input || {}
  const clean = t => String(t || '').replace(/\s+/g, ' ').trim()
  if (name === 'Bash') {
    const desc = clean(input.description)
    if (desc) return desc
    const cmd = clean(input.command).replace(/^cd [^&]+&& /, '')
    return cmd.slice(0, 120)
  }
  if (name.startsWith('mcp__Amplitude')) return 'Amplitude — ' + clean(input.rationale || input.projectId).slice(0, 110)
  if (name === 'Read') return 'reading ' + clean(input.file_path).split('/').slice(-2).join('/')
  if (name === 'Grep') return `searching "${clean(input.pattern).slice(0, 50)}"`
  if (name === 'Glob') return 'listing ' + clean(input.pattern)
  if (name === 'Write' || name === 'Edit') return 'writing ' + clean(input.file_path).split('/').slice(-1)[0]
  return name + ' ' + clean(JSON.stringify(input)).slice(0, 90)
}

function describeChange (c) {
  const probes = []
  if (c.signals.modules.length) probes.push(`loki modules: ${c.signals.modules.join(', ')}`)
  if (c.signals.logEvents?.length) probes.push(`log events: ${c.signals.logEvents.slice(0, 6).join(', ')}`)
  if (c.signals.amplitudeEvents.length) probes.push(`amplitude: ${c.signals.amplitudeEvents.join(', ')}`)
  if (c.signals.envFlags.length) probes.push(`flags: ${c.signals.envFlags.join(', ')}`)
  if (c.signals.routes.length) probes.push(`routes: ${c.signals.routes.join(', ')}`)
  if (c.signals.migrations.length) probes.push(`migrations: ${c.signals.migrations.length}`)
  if (c.revertedInWindow) probes.push('REVERTED inside window')
  return probes
}

function saveMeta (job, extra = {}) {
  const meta = {
    id: job.id,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    startedAtIst: toIst(job.startedAt),
    endedAt: job.endedAt || null,
    durationMs: job.endedAt ? new Date(job.endedAt) - new Date(job.startedAt) : null,
    pending: job.pending ?? null,
    phase: job.phase || null,
    percent: job.percent ?? null,
    live: job.live ?? null,
    repos: job.repos || [],
    runNumber: job.runNumber ?? null,
    outcome: job.outcome || null,
    usage: job.usage || job.usageAcc || null,
    costUsd: job.costUsd ?? null,
    tokensIn: (job.usage || job.usageAcc || {}).input_tokens || 0,
    tokensOut: (job.usage || job.usageAcc || {}).output_tokens || 0,
    tokensCacheRead: (job.usage || job.usageAcc || {}).cache_read_input_tokens || 0,
    tokensCacheWrite: (job.usage || job.usageAcc || {}).cache_creation_input_tokens || 0,
    ...extra
  }
  writeFileSync(jobMetaPath(job.id), JSON.stringify(meta, null, 2))
  return meta
}

function startJob (opts = {}) {
  const running = [...jobs.values()].find(j => j.status === 'running')
  if (running) return { error: 'a run is already in progress', id: running.id }

  jobSeq++
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-audit-${jobSeq}`
  const job = {
    id, kind: 'audit', status: 'running', startedAt: new Date().toISOString(), phase: 'starting', percent: 2, toolCalls: 0, phaseBase: 2, phaseCap: 10, phaseCalls: 0,
    lines: [], subscribers: new Set(), exitCode: null, child: null,
    repos: opts.repos || [], usage: null, costUsd: null, pending: null, live: null, outcome: null, runNumber: null
  }
  jobs.set(id, job)
  writeFileSync(jobLogPath(id), `# audit ${id}\n# started ${istStamp()}\n# options ${JSON.stringify(opts)}\n\n`)

  const setPhase = (phase, base, cap) => {
    if (job.phase !== phase) {
      job.phase = phase
      job.phaseBase = Math.max(base, job.percent || 0)
      job.phaseCap = cap
      job.phaseCalls = 0
    }
    const pct = Math.min(job.phaseCap, job.phaseBase + (job.phaseCalls || 0) * 1.5)
    if (pct > (job.percent || 0)) job.percent = Math.round(pct)
  }

  const trackProgress = line => {
    if (/^ +· /.test(line)) {
      job.toolCalls = (job.toolCalls || 0) + 1
      job.phaseCalls = (job.phaseCalls || 0) + 1
    }
    const recording = /record\.mjs[^\n]*--body/.test(line)
    if (recording && /--append/.test(line)) return setPhase('publishing the health section', 92, 98)
    if (recording && /--health/.test(line)) return setPhase('publishing the health report', 92, 98)
    if (recording) return setPhase(job.healthOnly ? 'publishing the health report' : 'publishing the features section', job.healthOnly ? 92 : 60, job.healthOnly ? 98 : 66)
    if (/crashscan\.mjs/.test(line)) return setPhase('crash scan across all apps', 66, 74)
    if (/--level error/.test(line)) return setPhase('prod error sweep', 74, 90)
    if (/mcp__Amplitude/.test(line)) return setPhase('checking Amplitude events', 20, 58)
    if (/grafana\.mjs/.test(line)) return setPhase(job.percent >= 66 ? 'reading prod logs (health)' : 'reading prod logs', job.percent >= 66 ? 74 : 20, job.percent >= 66 ? 90 : 58)
    if (/prodq|mysql|information_schema/.test(line)) return setPhase('checking prod database', 20, 58)
    if (/git (show|diff|log)/.test(line)) return setPhase('reading the code changes', 20, 58)
    if (/new since checkpoint/.test(line)) return setPhase('found the new changes', 10, 14)
    if (/handing over to the AI/.test(line)) return setPhase('analysing each change', 15, 58)
    if (/No new commits/.test(line)) return setPhase('no new commits — health check only', 40, 60)
    if (/checking what has landed/.test(line)) return setPhase('collecting changes', 3, 10)
    if (/^ +· /.test(line)) return setPhase(job.phase || 'analysing', job.phaseBase || 20, job.phaseCap || 58)
  }

  const push = text => {
    job.lastOutputAt = Date.now()
    for (const chunk of String(text).split('\n')) {
      if (!chunk.length) continue
      job.lines.push(chunk)
      trackProgress(chunk)
      appendFileSync(jobLogPath(id), chunk + '\n')
      for (const res of job.subscribers) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
  }
  const finish = code => {
    if (job.watchdog) clearTimeout(job.watchdog)
    if (job.stallTimer) clearInterval(job.stallTimer)
    job.phase = 'finished'
    job.percent = 100
    job.status = 'done'
    job.exitCode = code
    job.endedAt = new Date().toISOString()
    const state = loadState(cfg)
    const appended = (state.runs || 0) > (job.runsBefore || 0)
    if (appended) job.runNumber = state.runs
    if (job.outcome === 'analysed') {
      job.outcome = job.healthOnly ? 'health-only' : 'analysed'
      if (appended && !job.healthOnly && job.evidence) {
        const moved = []
        for (const repo of job.evidence.repos) {
          if (!repo.ok || !repo.totalPending) continue
          const before = (job.reposBefore || {})[repo.name]?.last_sha || null
          const now = state.repos[repo.name]?.last_sha || null
          if (now !== before) continue
          const last = repo.changes[repo.changes.length - 1]
          state.repos[repo.name] = {
            last_sha: repo.head.sha,
            last_pr: last?.pr || null,
            last_run_at: new Date().toISOString(),
            last_run_at_ist: istStamp()
          }
          moved.push(`${repo.name}=${repo.head.short}`)
        }
        if (moved.length) {
          saveState(cfg, state)
          push(`checkpoint auto-advanced: ${moved.join(', ')}`)
        }
      } else if (!appended) {
        push('no report was appended — checkpoints left untouched')
      }
    }
    saveMeta(job)
    for (const res of job.subscribers) { res.write('event: end\ndata: {}\n\n'); res.end() }
    job.subscribers.clear()
  }

  setTimeout(() => {
    let evidence
    const stateBefore = loadState(cfg)
    job.runsBefore = stateBefore.runs || 0
    job.reposBefore = JSON.parse(JSON.stringify(stateBefore.repos || {}))
    push('checking what has landed since the last checkpoint…')
    try {
      evidence = collect({ repos: opts.repos, since: opts.since })
      job.evidence = evidence
      writeFileSync(path.join(runsDir, `${id}.json`), JSON.stringify(evidence, null, 2))
    } catch (e) {
      push(`could not read the repos: ${String(e.message).slice(0, 300)}`)
      job.outcome = 'error'
      return finish(1)
    }

    const scanState = loadState(cfg)
    for (const repo of evidence.repos) {
      if (!repo.ok) continue
      const entry = scanState.repos[repo.name] || {}
      entry.last_checked_at = new Date().toISOString()
      entry.last_checked_at_ist = istStamp()
      entry.prod_head = repo.prodHead ? repo.prodHead.short : null
      entry.prod_head_at_ist = repo.prodHead ? repo.prodHead.atIst : null
      scanState.repos[repo.name] = entry
    }
    saveState(cfg, scanState)

    let pending = 0
    let live = 0
    for (const repo of evidence.repos) {
      if (!repo.ok) { push(`${repo.name}: ERROR ${repo.error}`); continue }
      pending += repo.totalPending
      live += repo.changes.filter(c => c.live).length
      push(`${repo.name}: ${repo.totalPending} new since checkpoint · prod head ${repo.prodHead ? repo.prodHead.short + ' @ ' + repo.prodHead.atIst : 'unknown'}`)
      for (const c of repo.changes) {
        push(`  PR #${c.pr ?? '-'} [${c.kind}] ${c.live ? 'live ' + c.liveSinceIst : 'NOT DEPLOYED'} — ${c.subject.slice(0, 72)}`)
        for (const p of describeChange(c)) push(`      ${p}`)
      }
    }
    job.pending = pending
    job.live = live

    const healthOnly = pending === 0
    job.healthOnly = healthOnly
    if (healthOnly) {
      push('')
      push('No new commits since the last check — skipping the per-feature analysis.')
      push('Running the overall backend health check only.')
    }

    const flags = (opts.claudeFlags || process.env.FEATURE_AUDIT_CLAUDE_FLAGS || '--permission-mode bypassPermissions').split(' ').filter(Boolean)
    let prompt = '/feature-audit'
    const extras = []
    if (healthOnly) extras.push('no new commits since the checkpoint — skip the per-feature analysis entirely and produce ONLY the overall backend health section, then record it with record.mjs --health (no checkpoint advance)')
    if ((opts.repos || []).length) extras.push(`only these repos: ${opts.repos.join(', ')}`)
    if (opts.since) extras.push(`start from ${opts.since} instead of the saved checkpoint`)
    if (opts.dry) extras.push('do not advance the checkpoint (dry run)')
    if (opts.note) extras.push(opts.note)
    extras.push('absolutely do not touch git state — no commit, checkout, branch, stash or push; read-only git only. If you find a fix, describe it in the report instead of applying it')
    extras.push('keep it tight: publish section 1 within ~10 minutes of starting and finish the whole run in ~20 — if a probe has not settled after two follow-ups, write the honest 🟡 and move on rather than chasing an exact minute')
    if (extras.length) prompt += ' ' + extras.join('; ')

    push('')
    push(healthOnly ? 'handing over to the AI for the health check' : `${pending} change(s) to analyse — handing over to the AI audit`)
    push(`claude -p "${prompt}" ${flags.join(' ')}`)
    push('')

    const childEnv = { ...process.env }
    delete childEnv.ANTHROPIC_API_KEY
    delete childEnv.ANTHROPIC_AUTH_TOKEN
    const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...flags], {
      cwd: cfg.repos[0].path, env: childEnv, stdio: ['ignore', 'pipe', 'pipe']
    })
    job.healthOnly = healthOnly
    job.child = child
    let buffer = ''
    child.stdout.on('data', d => {
      buffer += d.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        let ev
        try { ev = JSON.parse(line) } catch { push(line); continue }
        if (ev.type === 'assistant' && ev.message?.usage) {
          const u = ev.message.usage
          job.usageAcc = job.usageAcc || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
          job.usageAcc.input_tokens += u.input_tokens || 0
          job.usageAcc.output_tokens += u.output_tokens || 0
          job.usageAcc.cache_read_input_tokens += u.cache_read_input_tokens || 0
          job.usageAcc.cache_creation_input_tokens += u.cache_creation_input_tokens || 0
          job.usage = job.usageAcc
        }
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text.trim()) push(block.text.trim())
            if (block.type === 'tool_use') push('  · ' + describeTool(block))
          }
        } else if (ev.type === 'result') {
          job.usage = ev.usage || job.usageAcc || null
          job.costUsd = ev.total_cost_usd ?? null
          job.outcome = ev.is_error ? 'error' : 'analysed'
          if (ev.result) push(String(ev.result).trim())
          const u = ev.usage || {}
          const total = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
          push('')
          push(`tokens: ${total.toLocaleString()} (in ${u.input_tokens || 0}, out ${u.output_tokens || 0}, cache read ${u.cache_read_input_tokens || 0}, cache write ${u.cache_creation_input_tokens || 0}) · cost $${(ev.total_cost_usd ?? 0).toFixed(4)} · ${Math.round((ev.duration_ms || 0) / 1000)}s · ${ev.num_turns || 0} turns`)
        }
      }
    })
    child.stderr.on('data', d => push(d.toString()))
    child.on('close', code => { push(`run finished (exit ${code})`); finish(code) })
    child.on('error', err => { push(`failed to start claude: ${err.message}`); job.outcome = 'error'; finish(-1) })
  }, 10)

  return { id }
}

function parseFindings () {
  const p = path.join(cfg.dataDir, 'FINDINGS.md')
  if (!existsSync(p)) return []
  const text = readFileSync(p, 'utf8')
  return text.split(/^## Run /m).slice(1).map(part => {
    const firstLine = part.split('\n')[0]
    const m = firstLine.match(/^(\d+)\s+—\s+(.+)$/)
    const body = part.split('\n').slice(1).join('\n').replace(/\n---\s*$/, '').trim()
    const checkpoints = []
    for (const line of body.split('\n')) {
      const c = line.match(/^- \*\*(.+?)\*\* checkpoint `(.+?) → (.+?)`(.*)$/)
      if (c) checkpoints.push({ repo: c[1], from: c[2], to: c[3] })
      else if (checkpoints.length) break
    }
    return { run: m ? Number(m[1]) : 0, stamp: m ? m[2] : firstLine, checkpoints, body }
  }).sort((a, b) => b.run - a.run)
}

function history (days = 7) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000
  const files = existsSync(runsDir) ? readdirSync(runsDir).filter(f => f.endsWith('.meta.json')) : []
  const rows = []
  for (const f of files) {
    let meta
    try { meta = JSON.parse(readFileSync(path.join(runsDir, f), 'utf8')) } catch { continue }
    if (new Date(meta.startedAt).getTime() < cutoff) continue
    const live = jobs.get(meta.id)
    if (live) meta.status = live.status
    const u = meta.usage || {}
    meta.totalTokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    if (meta.tokensIn == null) meta.tokensIn = u.input_tokens || 0
    if (meta.tokensOut == null) meta.tokensOut = u.output_tokens || 0
    if (meta.tokensCacheRead == null) meta.tokensCacheRead = u.cache_read_input_tokens || 0
    if (meta.tokensCacheWrite == null) meta.tokensCacheWrite = u.cache_creation_input_tokens || 0
    rows.push(meta)
  }
  for (const job of jobs.values()) {
    if (job.status === 'running' && !rows.find(r => r.id === job.id)) {
      const u = job.usage || job.usageAcc || {}
      rows.push({
        id: job.id, kind: job.kind, status: 'running', startedAt: job.startedAt, startedAtIst: toIst(job.startedAt),
        totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        tokensIn: u.input_tokens || 0, tokensOut: u.output_tokens || 0,
        tokensCacheRead: u.cache_read_input_tokens || 0, tokensCacheWrite: u.cache_creation_input_tokens || 0,
        outcome: null, pending: job.pending, phase: job.phase, percent: job.percent
      })
    }
  }
  return rows.sort((a, b) => a.startedAt < b.startedAt ? 1 : -1)
}

function send (res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = url.pathname

  if (route === '/' || route === '/index.html') {
    return send(res, 200, readFileSync(path.join(SKILL_DIR, 'ui', 'index.html'), 'utf8'), 'text/html; charset=utf-8')
  }

  if (route === '/api/summary') {
    const state = loadState(cfg)
    const rows = history(7)
    return send(res, 200, {
      dataDir: cfg.dataDir,
      now: istStamp(),
      runs: state.runs || 0,
      bootstrapDays: cfg.bootstrapDays,
      last7: {
        count: rows.length,
        tokens: rows.reduce((a, r) => a + (r.totalTokens || 0), 0),
        cost: rows.reduce((a, r) => a + (r.costUsd || 0), 0)
      },
      running: (() => {
        const j = [...jobs.values()].find(x => x.status === 'running')
        return j ? { id: j.id, phase: j.phase, percent: j.percent, startedAt: j.startedAt, startedAtIst: toIst(j.startedAt), pending: j.pending } : null
      })(),
      repos: cfg.repos.map(r => ({
        name: r.name, path: r.path, branch: r.branch, lokiApp: r.lokiApp, workflow: r.workflow, prodJob: r.prodJob,
        last_checked_at_ist: (state.repos[r.name] || {}).last_checked_at_ist || null,
        prod_head: (state.repos[r.name] || {}).prod_head || null,
        prod_head_at_ist: (state.repos[r.name] || {}).prod_head_at_ist || null,
        ...(state.repos[r.name] || { last_sha: null, last_pr: null, last_run_at_ist: null })
      }))
    })
  }

  if (route === '/api/health') {
    const p = path.join(cfg.dataDir, 'health.json')
    if (!existsSync(p)) return send(res, 200, { ok: null, atIst: null, checks: [] })
    try { return send(res, 200, JSON.parse(readFileSync(p, 'utf8'))) } catch { return send(res, 200, { ok: null, checks: [] }) }
  }

  if (route === '/api/runs') return send(res, 200, parseFindings())
  if (route === '/api/history') return send(res, 200, history(Number(url.searchParams.get('days') || 7)))
  if (route === '/api/findings') {
    const p = path.join(cfg.dataDir, 'FINDINGS.md')
    return send(res, 200, existsSync(p) ? readFileSync(p, 'utf8') : '', 'text/plain; charset=utf-8')
  }
  if (route === '/api/evidence') {
    const id = url.searchParams.get('id')
    const p = id ? path.join(runsDir, `${id}.json`) : null
    if (p && existsSync(p)) return send(res, 200, JSON.parse(readFileSync(p, 'utf8')))
    const files = existsSync(runsDir) ? readdirSync(runsDir).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json')).sort() : []
    if (!files.length) return send(res, 200, { repos: [] })
    return send(res, 200, JSON.parse(readFileSync(path.join(runsDir, files[files.length - 1]), 'utf8')))
  }

  if (route === '/api/job' && url.searchParams.get('id')) {
    const id = url.searchParams.get('id')
    const live = jobs.get(id)
    if (live) return send(res, 200, { id, status: live.status, phase: live.phase, percent: live.percent, lines: live.lines })
    const p = jobLogPath(id)
    if (!existsSync(p)) return send(res, 404, { error: 'not found' })
    return send(res, 200, { id, status: 'done', lines: readFileSync(p, 'utf8').split('\n') })
  }

  if (route === '/api/prefs' && req.method === 'GET') return send(res, 200, readPrefs(), 'text/plain; charset=utf-8')
  if (route === '/api/prefs' && req.method === 'POST') {
    const body = await readBody(req)
    if (typeof body.text !== 'string') return send(res, 400, { error: 'text required' })
    writeFileSync(prefsPath(), body.text.endsWith('\n') ? body.text : body.text + '\n')
    return send(res, 200, { ok: true })
  }

  if (route === '/api/chat' && req.method === 'GET') {
    return send(res, 200, readThread(url.searchParams.get('key') || 'general'))
  }
  if (route === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req)
    const key = body.key || 'general'
    const message = String(body.message || '').trim()
    if (!message) return send(res, 400, { error: 'message required' })
    const thread = readThread(key)
    thread.key = key
    const first = !thread.sessionId
    let prompt = message
    if (first) {
      const report = body.report ? String(body.report).slice(0, 20000) : ''
      prompt = [
        'You are the feature-audit assistant for the DealShop backend. The user is discussing an audit report with you.',
        '',
        'Rules:',
        `- Standing instructions live in ${prefsPath()}. Read that file before answering.`,
        '- If the user gives a standing instruction — "ignore this error from now on", "always check X", "this one is known" — save it to that file as a LEARNING, not a raw note: one bullet under the right heading ("Known and not worth reporting again" / "Always check" / "How to report"), written as **what** — why it is true — how to apply it, plus the date and, where it makes sense, when to stop applying it. Turn a one-off remark into a rule a future run can act on without asking. Then confirm in one line what you saved. Every future audit run reads that file.',
        '- Answer in the user\'s language and keep it short. You may run read-only probes (git, the skill scripts under ~/.claude/skills/feature-audit, Loki via scripts/grafana.mjs) to check facts before answering.',
        '- Never write to prod, never touch git state.',
        '',
        report ? 'The report under discussion:\n\n' + report : '',
        '',
        'User message: ' + message
      ].join('\n')
    }
    try {
      const answer = await askClaude(prompt, thread.sessionId)
      thread.sessionId = answer.sessionId
      thread.messages.push({ role: 'user', text: message, at: new Date().toISOString(), atIst: istStamp() })
      thread.messages.push({ role: 'assistant', text: answer.text, at: new Date().toISOString(), atIst: istStamp(), tokens: answer.tokens, costUsd: answer.costUsd })
      writeThread(thread)
      return send(res, 200, { ok: true, reply: answer.text, tokens: answer.tokens, costUsd: answer.costUsd })
    } catch (e) {
      return send(res, 200, { error: String(e.stderr || e.message).slice(0, 600) })
    }
  }

  if (route === '/api/start' && req.method === 'POST') return send(res, 200, startJob(await readBody(req)))

  if (route === '/api/stop' && req.method === 'POST') {
    const body = await readBody(req)
    const job = jobs.get(body.id) || [...jobs.values()].find(j => j.status === 'running')
    if (!job || !job.child) return send(res, 404, { error: 'no running job' })
    job.child.kill('SIGTERM')
    return send(res, 200, { stopped: job.id })
  }

  if (route === '/api/checkpoint' && req.method === 'POST') {
    const body = await readBody(req)
    const state = loadState(cfg)
    if (!cfg.repos.find(r => r.name === body.repo)) return send(res, 400, { error: 'unknown repo' })
    if (body.clear) delete state.repos[body.repo]
    else {
      if (!body.sha) return send(res, 400, { error: 'sha required' })
      state.repos[body.repo] = { last_sha: body.sha, last_pr: body.pr ? Number(body.pr) : null, last_run_at: new Date().toISOString(), last_run_at_ist: istStamp() }
    }
    saveState(cfg, state)
    return send(res, 200, { ok: true })
  }

  if (route === '/api/config' && req.method === 'GET') return send(res, 200, JSON.parse(readFileSync(configPath(), 'utf8')))
  if (route === '/api/config' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body || !Array.isArray(body.repos) || !body.repos.length) return send(res, 400, { error: 'repos[] required' })
    writeFileSync(configPath(), JSON.stringify(body, null, 2) + '\n')
    cfg = loadConfig()
    return send(res, 200, { ok: true })
  }

  if (route === '/api/probe' && req.method === 'POST') {
    const body = await readBody(req)
    const args = [path.join(SKILL_DIR, 'scripts', 'grafana.mjs'), '--repo', body.repo || cfg.repos[0].name]
    if (body.module) args.push('--module', body.module)
    if (body.level) args.push('--level', body.level)
    if (body.grep) args.push('--grep', body.grep)
    args.push('--from', body.from || 'now-24h', '--limit', String(body.limit || 100))
    if (body.count) args.push('--count')
    try {
      return send(res, 200, JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })))
    } catch (e) {
      return send(res, 200, { error: String(e.stdout || e.message).slice(0, 2000) })
    }
  }

  if (route === '/api/commits') {
    const repo = cfg.repos.find(r => r.name === url.searchParams.get('repo')) || cfg.repos[0]
    try {
      const out = execFileSync('git', ['-C', repo.path, 'log', '--first-parent', '-40', '--format=%H%x1f%cI%x1f%s', `origin/${repo.branch}`], { encoding: 'utf8' })
      return send(res, 200, out.trim().split('\n').filter(Boolean).map(l => {
        const [sha, date, subject] = l.split('\x1f')
        return { sha, short: sha.slice(0, 8), date, subject }
      }))
    } catch (e) {
      return send(res, 200, { error: String(e.message).slice(0, 300) })
    }
  }

  if (route === '/api/stream' && url.searchParams.get('id')) {
    const job = jobs.get(url.searchParams.get('id'))
    if (!job) return send(res, 404, { error: 'no live job' })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    for (const line of job.lines) res.write(`data: ${JSON.stringify(line)}\n\n`)
    if (job.status === 'done') { res.write('event: end\ndata: {}\n\n'); return res.end() }
    job.subscribers.add(res)
    req.on('close', () => job.subscribers.delete(res))
    return
  }

  return send(res, 404, { error: 'not found' })
})

function listen (port, maxPort) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && port < maxPort) return listen(port + 1, maxPort)
    console.error(`server failed: ${err.message}`)
    process.exit(1)
  })
  server.listen(port, () => console.log(`feature-audit UI on http://localhost:${port}`))
}

const startPort = Number(process.env.FEATURE_AUDIT_PORT || 8999)
listen(startPort, startPort + 60)
