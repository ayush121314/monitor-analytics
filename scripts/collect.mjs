import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, loadState, saveState, git, gitOk, gh, toIst, expand } from './lib.mjs'

function parseArgs (argv) {
  const out = { repos: [], limit: 40, fetch: true, status: false, since: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repo') out.repos.push(argv[++i])
    else if (a === '--since') out.since = argv[++i]
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--no-fetch') out.fetch = false
    else if (a === '--status') out.status = true
  }
  return out
}

function prNumber (subject) {
  const merge = subject.match(/Merge pull request #(\d+)/)
  if (merge) return Number(merge[1])
  const squash = subject.match(/\(#(\d+)\)\s*$/)
  if (squash) return Number(squash[1])
  return null
}

function branchOf (subject) {
  const m = subject.match(/from [^/]+\/(.+)$/)
  return m ? m[1] : null
}

function revertsPr (subject, branch) {
  const b = (branch || '').match(/^revert-(\d+)-/)
  if (b) return Number(b[1])
  const s = subject.match(/Revert .*\(#(\d+)\)/)
  return s ? Number(s[1]) : null
}

function kindOf (subject, branch) {
  const s = subject.toLowerCase()
  const b = (branch || '').toLowerCase()
  if (s.startsWith('revert')) return 'revert'
  if (b.startsWith('revert-')) return 'revert'
  if (b.startsWith('fix/') || s.startsWith('fix')) return 'fix'
  if (b.startsWith('feat') || s.startsWith('feat')) return 'feature'
  if (b.startsWith('chore') || b.startsWith('ci/') || s.startsWith('chore')) return 'chore'
  return 'feature'
}

function baseOf (repoPath, sha) {
  const parents = git(repoPath, ['rev-list', '--parents', '-n', '1', sha]).split(' ')
  return parents.length > 1 ? parents[1] : `${sha}^`
}

function addedLines (repoPath, base, sha) {
  const diff = git(repoPath, ['diff', '-U0', base, sha], { soft: true })
  const lines = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) lines.push(line.slice(1))
  }
  return lines.join('\n')
}

function uniq (arr) {
  return [...new Set(arr.filter(Boolean))]
}

function matchAll (text, re) {
  return uniq([...text.matchAll(re)].map(m => m[1]))
}

function modulesOf (repoPath, sha, files) {
  const mods = []
  for (const f of files.slice(0, 60)) {
    if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue
    const content = git(repoPath, ['show', `${sha}:${f}`], { soft: true })
    if (!content) continue
    for (const m of content.matchAll(/createModuleLogger\(\s*['"]([^'"]+)['"]/g)) mods.push(m[1])
  }
  return uniq(mods)
}

function signalsOf (repoPath, sha, base, files) {
  const added = addedLines(repoPath, base, sha)
  return {
    modules: modulesOf(repoPath, sha, files),
    routes: matchAll(added, /router\.(?:get|post|put|patch|delete)\(\s*['"`]([^'"`]+)/g),
    envFlags: matchAll(added, /process\.env\.([A-Z0-9_]+)/g),
    amplitudeEvents: uniq([
      ...matchAll(added, /event_type:\s*['"]([^'"]+)['"]/g),
      ...matchAll(added, /eventType:\s*['"]([^'"]+)['"]/g),
      ...matchAll(added, /trackEvent\(\s*['"]([^'"]+)['"]/g),
      ...matchAll(added, /sendAmplitudeEvent\([^,]*,\s*['"]([^'"]+)['"]/g),
      ...matchAll(added, /fireAmplitudeEvent\([^,]*,\s*['"]([^'"]+)['"]/g),
      ...matchAll(added, /amplitudeName:\s*['"]([^'"]+)['"]/g),
      ...matchAll(added, /event_name:\s*['"]([^'"]+)['"]/g)
    ]),
    logEvents: uniq([
      ...matchAll(added, /LogEvents\.([A-Z0-9_]+)/g),
      ...matchAll(added, /event:\s*['"]([A-Z][A-Z0-9_]{3,})['"]/g)
    ]),
    fileHints: uniq(files.filter(f => /\.(js|mjs)$/.test(f)).map(f => f.split('/').pop().replace(/\.(js|mjs)$/, ''))).slice(0, 12),
    crons: uniq(files.filter(f => /cron|schedul/i.test(f))),
    migrations: uniq(files.filter(f => /migration|\.sql$/i.test(f))),
    tests: files.filter(f => /^test\/|\.test\.|\.spec\./.test(f)).length,
    redisKeys: matchAll(added, /redisKey\(\s*['"`]([^'"`]+)/g),
    sqlTouched: uniq(files.filter(f => f.startsWith('src/data/'))).slice(0, 10)
  }
}

function deployTimeline (cfg, repo, state, windowStartIso) {
  const cache = state.deploys[repo.name] || (state.deploys[repo.name] = {})
  const runs = gh(`repos/${cfg.org}/${repo.name}/actions/workflows/${repo.workflow}/runs?per_page=40&branch=${repo.branch}`)
  if (!runs || !runs.workflow_runs) return { available: false, deploys: [] }
  const deploys = []
  let found = 0
  for (const run of runs.workflow_runs) {
    const key = String(run.id)
    let value = cache[key]
    if (value === undefined) {
      const jobs = gh(`repos/${cfg.org}/${repo.name}/actions/runs/${run.id}/jobs`)
      if (!jobs || !jobs.jobs) { value = null } else {
        const prod = jobs.jobs.find(j => j.name.endsWith(repo.prodJob) && j.conclusion === 'success')
        value = prod ? prod.completed_at : (run.status === 'completed' ? false : null)
      }
      if (value !== null) cache[key] = value
    }
    if (value) {
      deploys.push({ sha: run.head_sha, at: value, runId: run.id })
      found++
    }
    if (!windowStartIso && found >= 1) break
    const olderThanWindow = windowStartIso && new Date(run.created_at) < new Date(windowStartIso)
    if (found >= 2 && olderThanWindow) break
  }
  deploys.sort((a, b) => new Date(a.at) - new Date(b.at))
  return { available: true, deploys }
}

function liveInfo (repoPath, sha, deploys) {
  for (const d of deploys) {
    if (!gitOk(repoPath, ['cat-file', '-e', `${d.sha}^{commit}`])) continue
    if (gitOk(repoPath, ['merge-base', '--is-ancestor', sha, d.sha])) {
      return { live: true, liveSince: d.at, liveSinceIst: toIst(d.at), viaSha: d.sha.slice(0, 8) }
    }
  }
  return { live: false, liveSince: null, liveSinceIst: null, viaSha: null }
}

function collectRepo (cfg, state, repo, args) {
  const result = { name: repo.name, path: repo.path, lokiApp: repo.lokiApp, ok: true }
  if (!gitOk(repo.path, ['rev-parse', '--git-dir'])) {
    return { ...result, ok: false, error: 'repo path is not a git checkout' }
  }
  if (args.fetch) {
    git(repo.path, ['fetch', '--quiet', 'origin', repo.branch], { soft: true })
    if (repo.managed) {
      const dirty = git(repo.path, ['status', '--porcelain', '--untracked-files=no'], { soft: true })
      const branch = git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'], { soft: true })
      if (dirty) {
        result.managedNote = `left alone: ${repo.path} has uncommitted changes`
      } else {
        if (branch !== repo.branch) git(repo.path, ['checkout', '--quiet', repo.branch], { soft: true })
        git(repo.path, ['pull', '--quiet', '--ff-only', 'origin', repo.branch], { soft: true })
        result.managedNote = `checked out ${repo.branch} and pulled`
      }
    }
  }

  const ref = `origin/${repo.branch}`
  const head = git(repo.path, ['rev-parse', ref])
  const saved = state.repos[repo.name] || {}
  let since = args.since || saved.last_sha
  if (since && !gitOk(repo.path, ['cat-file', '-e', `${since}^{commit}`])) since = null
  if (!since) {
    const boot = git(repo.path, ['log', '--first-parent', `--since=${cfg.bootstrapDays} days ago`, '--reverse', '--format=%H', ref], { soft: true }).split('\n').filter(Boolean)[0]
    since = boot ? `${boot}^` : `${head}~1`
    if (!gitOk(repo.path, ['cat-file', '-e', `${since}^{commit}`])) since = head
    result.bootstrapped = true
  }

  const raw = git(repo.path, ['log', '--first-parent', '--reverse', `${since}..${ref}`, '--format=%H%x1f%cI%x1f%an%x1f%s'], { soft: true })
  const rows = raw ? raw.split('\n').filter(Boolean) : []
  const windowStart = rows.length ? rows[0].split('\x1f')[1] : null
  const timeline = deployTimeline(cfg, repo, state, windowStart)

  const changes = rows.slice(-args.limit).map(row => {
    const [sha, date, author, subject] = row.split('\x1f')
    const base = baseOf(repo.path, sha)
    const files = git(repo.path, ['diff', '--name-only', base, sha], { soft: true }).split('\n').filter(Boolean)
    const numstat = git(repo.path, ['diff', '--shortstat', base, sha], { soft: true })
    const branch = branchOf(subject)
    return {
      sha,
      short: sha.slice(0, 8),
      date,
      dateIst: toIst(date),
      author,
      subject,
      pr: prNumber(subject),
      branch,
      kind: kindOf(subject, branch),
      revertsPr: revertsPr(subject, branch),
      files,
      fileCount: files.length,
      stat: numstat,
      signals: signalsOf(repo.path, sha, base, files),
      ...liveInfo(repo.path, sha, timeline.deploys)
    }
  })

  const revertedPrs = new Set(changes.map(c => c.revertsPr).filter(Boolean))
  for (const c of changes) c.revertedInWindow = c.pr ? revertedPrs.has(c.pr) : false

  const prodHead = timeline.deploys.length ? timeline.deploys[timeline.deploys.length - 1] : null
  return {
    ...result,
    checkpoint: { sha: since === head ? head : git(repo.path, ['rev-parse', since]), pr: saved.last_pr || null, lastRunAt: saved.last_run_at || null },
    head: { sha: head, short: head.slice(0, 8) },
    prodHead: prodHead ? { sha: prodHead.sha, short: prodHead.sha.slice(0, 8), at: prodHead.at, atIst: toIst(prodHead.at) } : null,
    deployAvailable: timeline.available,
    totalPending: rows.length,
    analysed: changes.length,
    changes
  }
}

function refreshGraph (repo) {
  if (!existsSync(path.join(repo.path, 'graphify-out', 'graph.json'))) return null
  try {
    execFileSync('graphify', ['update', repo.path], { timeout: 10 * 60 * 1000, stdio: 'ignore' })
    return 'graph rebuilt'
  } catch {
    return 'graph rebuild failed'
  }
}

function remergeGraph (cfg) {
  const merged = expand(cfg.graph?.merged)
  if (!merged) return null
  const parts = cfg.repos
    .map(r => path.join(r.path, 'graphify-out', 'graph.json'))
    .filter(p => existsSync(p))
  if (parts.length < 2) return null
  try {
    execFileSync('graphify', ['merge-graphs', ...parts, '--out', merged], { timeout: 5 * 60 * 1000, stdio: 'ignore' })
    return merged
  } catch {
    return null
  }
}

const args = parseArgs(process.argv.slice(2))
const cfg = loadConfig()
const state = loadState(cfg)

if (args.status) {
  const rows = cfg.repos.map(r => ({ repo: r.name, ...(state.repos[r.name] || { last_sha: null, last_pr: null, last_run_at: null }) }))
  console.log(JSON.stringify({ dataDir: cfg.dataDir, checkpoints: rows }, null, 2))
  process.exit(0)
}

const wanted = args.repos.length ? cfg.repos.filter(r => args.repos.includes(r.name)) : cfg.repos
const out = { generatedAt: new Date().toISOString(), generatedAtIst: toIst(new Date().toISOString()), repos: [] }
let graphStale = false
for (const repo of wanted) {
  try {
    const res = collectRepo(cfg, state, repo, args)
    if (res.ok && res.totalPending > 0 && cfg.graph?.refreshOnNewCommits) {
      res.graphNote = refreshGraph(repo)
      if (res.graphNote === 'graph rebuilt') graphStale = true
    }
    out.repos.push(res)
  } catch (e) {
    out.repos.push({ name: repo.name, ok: false, error: String(e.message).slice(0, 400) })
  }
}
if (graphStale) out.mergedGraph = remergeGraph(cfg)
else out.mergedGraph = expand(cfg.graph?.merged) || null
saveState(cfg, state)
console.log(JSON.stringify(out, null, 2))
