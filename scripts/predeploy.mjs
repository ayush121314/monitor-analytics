import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { loadConfig } from './lib.mjs'

const cfg = loadConfig()

function parseArgs (argv) {
  const out = { shas: [], repo: cfg.repos[0].name }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sha') out.shas.push(argv[++i])
    else if (argv[i] === '--repo') out.repo = argv[++i]
    else if (argv[i] === '--since') out.since = argv[++i]
  }
  return out
}

function git (repoPath, args) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function baseOf (repoPath, sha) {
  const parents = git(repoPath, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ')
  return parents.length > 1 ? parents[1] : `${sha}^`
}

function addedLines (repoPath, base, sha, file) {
  const diff = git(repoPath, ['diff', '-U0', base, sha, '--', file])
  return diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1))
}

function resolveImport (repoPath, sha, fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const dir = path.dirname(fromFile)
  let target = path.normalize(path.join(dir, spec))
  if (!/\.(js|mjs)$/.test(target)) target += '.js'
  const content = git(repoPath, ['show', `${sha}:${target}`])
  return content ? { file: target, content } : null
}

function definesMember (content, member) {
  const patterns = [
    new RegExp(`\\b(static\\s+)?(async\\s+)?${member}\\s*\\(`),
    new RegExp(`${member}\\s*[:=]\\s*(async\\s*)?\\(`),
    new RegExp(`${member}\\s*[:=]\\s*(async\\s+)?function`),
    new RegExp(`export\\s+(async\\s+)?function\\s+${member}\\b`),
    new RegExp(`export\\s+const\\s+${member}\\b`),
    new RegExp(`\\b${member}\\s*,`),
    new RegExp(`\\b${member}\\s*\\}`)
  ]
  return patterns.some(re => re.test(content))
}

function checkCommit (repo, sha) {
  const findings = []
  const base = baseOf(repo.path, sha)
  const files = git(repo.path, ['diff', '--name-only', base, sha]).split('\n')
    .filter(f => /\.(js|mjs)$/.test(f) && !/^test\//.test(f))

  for (const file of files.slice(0, 60)) {
    const content = git(repo.path, ['show', `${sha}:${file}`])
    if (!content) continue
    const added = addedLines(repo.path, base, sha, file)
    if (!added.length) continue

    const imports = {}
    for (const m of content.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g)) imports[m[1]] = m[2]

    const seen = new Set()
    for (const line of added) {
      for (const call of line.matchAll(/\b([A-Z][\w$]*)\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
        const [, obj, member] = call
        if (!imports[obj]) continue
        const key = `${obj}.${member}`
        if (seen.has(key)) continue
        seen.add(key)
        const target = resolveImport(repo.path, sha, file, imports[obj])
        if (!target) continue
        if (!definesMember(target.content, member)) {
          findings.push({
            kind: 'missing-method',
            severity: 'high',
            file,
            call: `${obj}.${member}()`,
            target: target.file,
            detail: `${file} calls ${obj}.${member}(), but ${target.file} does not define ${member}. At runtime this throws TypeError: ${obj}.${member} is not a function.`
          })
        }
      }
    }

    for (const line of added) {
      for (const env of line.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        const varName = env[1]
        const hasDefault = /\|\||\?\?/.test(line)
        if (!hasDefault) {
          findings.push({
            kind: 'env-without-default',
            severity: 'medium',
            file,
            variable: varName,
            detail: `${file} reads process.env.${varName} with no fallback on that line — if it is unset in prod the value is undefined.`
          })
        }
      }
    }
  }

  const migrations = git(repo.path, ['diff', '--name-only', base, sha]).split('\n')
    .filter(f => /migrations?\/.*\.sql$/.test(f) && !/rollback/i.test(f))
  for (const m of migrations) {
    findings.push({
      kind: 'migration',
      severity: 'high',
      file: m,
      detail: `${m} ships with this change — confirm it is applied on prod before the code goes live, or every query touching those columns fails.`
    })
  }

  return findings
}

const args = parseArgs(process.argv.slice(2))
const repo = cfg.repos.find(r => r.name === args.repo) || cfg.repos[0]

let shas = args.shas
if (!shas.length) {
  const range = args.since ? `${args.since}..origin/${repo.branch}` : `origin/${repo.branch}~5..origin/${repo.branch}`
  shas = git(repo.path, ['log', '--first-parent', '--format=%H', range]).split('\n').filter(Boolean)
}

const out = { repo: repo.name, checked: [], findings: [] }
for (const sha of shas.slice(0, 20)) {
  const subject = git(repo.path, ['log', '-1', '--format=%s', sha]).trim()
  const findings = checkCommit(repo, sha)
  out.checked.push({ sha: sha.slice(0, 8), subject, findings: findings.length })
  for (const f of findings) out.findings.push({ sha: sha.slice(0, 8), subject, ...f })
}

const seen = new Set()
out.findings = out.findings.filter(f => {
  const key = `${f.kind}|${f.file}|${f.call || f.variable || ''}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
})

console.log(JSON.stringify(out, null, 2))
