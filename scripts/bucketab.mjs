import { execFile } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from './lib.mjs'

const cfg = loadConfig()

function dbConfig () {
  const p = path.join(cfg.dataDir, 'db.json')
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))
  const { FA_DB_HOST, FA_DB_USER, FA_DB_PASS, FA_DB_NAME } = process.env
  if (FA_DB_HOST && FA_DB_USER) return { host: FA_DB_HOST, user: FA_DB_USER, password: FA_DB_PASS, database: FA_DB_NAME || 'ecommerce' }
  return null
}

function parseArgs (argv) {
  const out = { days: 7 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--band') out.band = argv[++i]
    else if (a === '--buckets') out.buckets = argv[++i]
    else if (a === '--days') out.days = Number(argv[++i])
    else if (a === '--since') out.since = argv[++i]
    else if (a === '--daily') out.daily = true
  }
  return out
}

function exposedSql (args, col = 'u.bucket') {
  if (args.buckets) {
    const list = args.buckets.split(',').map(n => Number(n.trim())).filter(Number.isInteger)
    if (!list.length) return null
    return `${col} IN (${list.join(',')})`
  }
  if (args.band) {
    const [lo, hi] = args.band.split('-').map(n => Number(n.trim()))
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null
    return `${col} BETWEEN ${lo} AND ${hi}`
  }
  return null
}

function run (db, sql) {
  return new Promise(resolve => {
    execFile('mysql', ['-h', db.host, '-u', db.user, `-p${db.password}`, db.database || 'ecommerce', '--batch', '--raw', '-e', sql],
      { timeout: 180000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ error: String(stderr || err.message).replace(/\[Warning\][^\n]*\n/g, '').slice(0, 300) })
        const lines = stdout.trim().split('\n').filter(Boolean)
        if (!lines.length) return resolve({ rows: [] })
        const cols = lines[0].split('\t')
        resolve({ rows: lines.slice(1).map(l => { const v = l.split('\t'); return Object.fromEntries(cols.map((c, i) => [c, v[i]])) }) })
      })
  })
}

const args = parseArgs(process.argv.slice(2))
const db = dbConfig()
const cond = exposedSql(args)

if (!db) {
  console.log(JSON.stringify({ error: `no database config — create ${path.join(cfg.dataDir, 'db.json')} or set FA_DB_*` }, null, 2))
  process.exit(0)
}
if (!cond) {
  console.log(JSON.stringify({ error: 'pass the exposed buckets: --band 60-69 (inclusive range) or --buckets 4,14,24 (exact set)' }, null, 2))
  process.exit(0)
}

const window = args.since ? `po.created_at >= '${args.since}'` : `po.created_at >= CURDATE() - INTERVAL ${args.days} DAY`
const group = `CASE WHEN ${cond.replace(/u\.bucket/g, 'u.bucket')} THEN 'exposed' ELSE 'control' END`

const queries = {
  users: `SELECT CASE WHEN ${cond} THEN 'exposed' ELSE 'control' END grp, COUNT(*) users
    FROM user u WHERE u.bucket BETWEEN 0 AND 99 GROUP BY grp`,
  orders: `SELECT ${group} grp,
      COUNT(*) orders,
      COUNT(DISTINCT po.user_id) buyers,
      ROUND(SUM(po.total_amount)) revenue,
      ROUND(AVG(po.total_amount)) aov,
      SUM(po.order_status = 'CANCELLED') cancelled,
      SUM(po.order_status = 'ORDER_FAILED') failed
    FROM product_orders po JOIN user u ON u.user_id = po.user_id
    WHERE ${window} AND u.bucket BETWEEN 0 AND 99
    GROUP BY grp`,
  delivered: `SELECT ${group} grp, COUNT(*) delivered
    FROM product_orders po JOIN user u ON u.user_id = po.user_id
    WHERE po.delivered_at >= CURDATE() - INTERVAL ${args.days} DAY AND u.bucket BETWEEN 0 AND 99
    GROUP BY grp`,
  returns: `SELECT ${group} grp, COUNT(*) returns_raised
    FROM return_requests rr JOIN product_orders po ON po.order_id = rr.order_id
    JOIN user u ON u.user_id = po.user_id
    WHERE rr.created_at >= CURDATE() - INTERVAL ${args.days} DAY AND u.bucket BETWEEN 0 AND 99
    GROUP BY grp`
}

if (args.daily) {
  queries.daily = `SELECT DATE(po.created_at) d, ${group} grp, COUNT(*) orders
    FROM product_orders po JOIN user u ON u.user_id = po.user_id
    WHERE ${window} AND po.order_status <> 'ORDER_FAILED' AND u.bucket BETWEEN 0 AND 99
    GROUP BY d, grp ORDER BY d`
}

const names = Object.keys(queries)
const settled = await Promise.all(names.map(n => run(db, queries[n]).then(r => [n, r])))
const raw = Object.fromEntries(settled.map(([n, r]) => [n, r.error ? { error: r.error } : r.rows]))

function pick (rows, grp) {
  return (Array.isArray(rows) ? rows : []).find(r => r.grp === grp) || {}
}

const out = { exposed: {}, control: {}, comparison: {}, window: args.since ? `since ${args.since}` : `last ${args.days} days`, exposedBuckets: args.buckets || args.band }

for (const grp of ['exposed', 'control']) {
  const u = Number(pick(raw.users, grp).users || 0)
  const o = pick(raw.orders, grp)
  const orders = Number(o.orders || 0)
  const failed = Number(o.failed || 0)
  const real = orders - failed
  const g = {
    users: u,
    orders: real,
    orderFailed: failed,
    buyers: Number(o.buyers || 0),
    revenue: Number(o.revenue || 0),
    aov: Number(o.aov || 0),
    cancelled: Number(o.cancelled || 0),
    delivered: Number(pick(raw.delivered, grp).delivered || 0),
    returnsRaised: Number(pick(raw.returns, grp).returns_raised || 0)
  }
  g.ordersPer1000Users = u ? Number((real / u * 1000).toFixed(2)) : null
  g.buyersPer1000Users = u ? Number((g.buyers / u * 1000).toFixed(2)) : null
  g.revenuePerUser = u ? Number((g.revenue / u).toFixed(2)) : null
  g.cancelRate = real ? Number((g.cancelled / real * 100).toFixed(2)) : null
  g.returnRate = g.delivered ? Number((g.returnsRaised / g.delivered * 100).toFixed(2)) : null
  g.failedShare = orders ? Number((failed / orders * 100).toFixed(2)) : null
  out[grp] = g
}

const lift = (a, b) => (b ? Number(((a - b) / b * 100).toFixed(1)) : null)
out.comparison = {
  ordersPer1000Users: lift(out.exposed.ordersPer1000Users, out.control.ordersPer1000Users),
  buyersPer1000Users: lift(out.exposed.buyersPer1000Users, out.control.buyersPer1000Users),
  revenuePerUser: lift(out.exposed.revenuePerUser, out.control.revenuePerUser),
  aov: lift(out.exposed.aov, out.control.aov),
  cancelRate: lift(out.exposed.cancelRate, out.control.cancelRate),
  returnRate: lift(out.exposed.returnRate, out.control.returnRate),
  note: 'percent difference of exposed against control, on per-user rates so unequal group sizes do not mislead'
}

function zTest (x1, n1, x2, n2) {
  if (!n1 || !n2 || (x1 + x2) === 0) return null
  const p1 = x1 / n1
  const p2 = x2 / n2
  const p = (x1 + x2) / (n1 + n2)
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
  if (!se) return null
  return Number(((p1 - p2) / se).toFixed(2))
}

const z = zTest(out.exposed.buyers, out.exposed.users, out.control.buyers, out.control.users)
out.significance = {
  metric: 'buyers per user (conversion)',
  z,
  verdict: z === null ? 'not computable'
    : Math.abs(z) >= 2.58 ? 'real — would happen by chance under 1% of the time'
      : Math.abs(z) >= 1.96 ? 'probably real — under 5% chance of being noise'
        : 'within noise — do not report this as a lift',
  note: 'two-proportion z on unique buyers; the other metrics are directional only'
}

if (out.exposed.orders < 100 || out.control.orders < 100) {
  out.caution = `small sample — exposed ${out.exposed.orders} orders, control ${out.control.orders}. Widen --days before reading anything into the difference.`
}

if (args.daily) out.daily = raw.daily

console.log(JSON.stringify(out, null, 2))
