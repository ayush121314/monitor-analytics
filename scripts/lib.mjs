import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const SKILL_DIR = path.resolve(new URL('..', import.meta.url).pathname)

export function expand (p) {
  if (!p) return p
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p
}

export function loadConfig () {
  const cfg = JSON.parse(readFileSync(path.join(SKILL_DIR, 'config.json'), 'utf8'))
  cfg.dataDir = expand(cfg.dataDir)
  cfg.repos = cfg.repos.map(r => ({ ...r, path: expand(r.path) }))
  return cfg
}

export function statePath (cfg) {
  return path.join(cfg.dataDir, 'state.json')
}

export function loadState (cfg) {
  const p = statePath(cfg)
  if (!existsSync(p)) return { version: 1, repos: {}, deploys: {} }
  const s = JSON.parse(readFileSync(p, 'utf8'))
  s.repos = s.repos || {}
  s.deploys = s.deploys || {}
  return s
}

export function saveState (cfg, state) {
  mkdirSync(cfg.dataDir, { recursive: true })
  writeFileSync(statePath(cfg), JSON.stringify(state, null, 2) + '\n')
}

export function git (repoPath, args, opts = {}) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', opts.quiet === false ? 'inherit' : 'pipe']
    }).trim()
  } catch (e) {
    if (opts.soft) return ''
    throw new Error(`git ${args.join(' ')} failed in ${repoPath}: ${String(e.stderr || e.message).slice(0, 300)}`)
  }
}

export function gitOk (repoPath, args) {
  try {
    execFileSync('git', ['-C', repoPath, ...args], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let cachedToken = null
export function ghToken () {
  if (cachedToken !== null) return cachedToken
  if (process.env.GH_DIGEST_TOKEN) { cachedToken = process.env.GH_DIGEST_TOKEN; return cachedToken }
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8'
    })
    const m = out.match(/^password=(.+)$/m)
    cachedToken = m ? m[1].trim() : ''
  } catch {
    cachedToken = ''
  }
  return cachedToken
}

export function gh (endpoint) {
  const token = ghToken()
  if (!token) return null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = execFileSync('gh', ['api', endpoint], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token }
      })
      return JSON.parse(out)
    } catch {}
  }
  return null
}

export function istStamp (d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d).replace(',', '') + ' IST'
}

export function toIst (iso) {
  if (!iso) return null
  return istStamp(new Date(iso))
}
