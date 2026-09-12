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

const QUERIES = {
  orders_by_day: `SELECT DATE(created_at) d, COUNT(*) n FROM product_orders
    WHERE created_at >= CURDATE() - INTERVAL 7 DAY AND order_status <> 'ORDER_FAILED'
    GROUP BY d ORDER BY d`,
  order_failed_by_day: `SELECT DATE(created_at) d, COUNT(*) n FROM product_orders
    WHERE created_at >= CURDATE() - INTERVAL 7 DAY AND order_status = 'ORDER_FAILED'
    GROUP BY d ORDER BY d`,
  delivered_by_day: `SELECT DATE(delivered_at) d, COUNT(*) n FROM product_orders
    WHERE delivered_at >= CURDATE() - INTERVAL 7 DAY GROUP BY d ORDER BY d`,
  cancelled_by_day: `SELECT DATE(updated_at) d, COUNT(*) n FROM product_orders
    WHERE order_status = 'CANCELLED' AND updated_at >= CURDATE() - INTERVAL 7 DAY GROUP BY d ORDER BY d`,
  returns_by_day: `SELECT DATE(created_at) d, COUNT(*) n FROM return_requests
    WHERE created_at >= CURDATE() - INTERVAL 7 DAY GROUP BY d ORDER BY d`,
  refunds_by_day: `SELECT DATE(created_at) d, status, COUNT(*) n FROM refund_ledger
    WHERE created_at >= CURDATE() - INTERVAL 7 DAY GROUP BY d, status ORDER BY d`,
  refunds_stuck_24h: `SELECT status, COUNT(*) n, MIN(created_at) oldest FROM refund_ledger
    WHERE status NOT IN ('PROCESSED','COMPLETED','SUCCESS','REVERSED','FAILED')
      AND created_at < NOW() - INTERVAL 24 HOUR GROUP BY status`,
  orders_stuck_48h: `SELECT order_status, COUNT(*) n, MIN(updated_at) oldest FROM product_orders
    WHERE order_status IN ('ORDER_PLACED','REFUND_QUEUED','RETURN_REQUESTED')
      AND updated_at < NOW() - INTERVAL 48 HOUR
      AND created_at >= CURDATE() - INTERVAL 30 DAY GROUP BY order_status`,
  zero_price_items_today: `SELECT COUNT(*) n FROM product_order_items poi
    JOIN product_orders po ON po.order_id = poi.order_id
    WHERE po.created_at >= CURDATE() AND (poi.price IS NULL OR poi.price = 0)`,
  returns_pending_qc: `SELECT COUNT(*) n FROM return_requests
    WHERE status IN ('RECEIVED','PICKED_UP') AND updated_at < NOW() - INTERVAL 72 HOUR`
}

function run (db, sql) {
  return new Promise(resolve => {
    execFile('mysql', ['-h', db.host, '-u', db.user, `-p${db.password}`, db.database || 'ecommerce', '--batch', '--raw', '-e', sql],
      { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ error: String(stderr || err.message).replace(/\[Warning\][^\n]*\n/g, '').slice(0, 300) })
        const lines = stdout.trim().split('\n').filter(Boolean)
        if (!lines.length) return resolve({ rows: [] })
        const cols = lines[0].split('\t')
        const rows = lines.slice(1).map(l => {
          const vals = l.split('\t')
          return Object.fromEntries(cols.map((c, i) => [c, vals[i]]))
        })
        resolve({ rows })
      })
  })
}

const db = dbConfig()
if (!db) {
  console.log(JSON.stringify({
    error: `no database config — create ${path.join(cfg.dataDir, 'db.json')} with {host,user,password,database}, or set FA_DB_HOST / FA_DB_USER / FA_DB_PASS / FA_DB_NAME in the environment`
  }, null, 2))
  process.exit(0)
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
const names = only ? [only] : Object.keys(QUERIES)
const out = { generatedAt: new Date().toISOString(), host: db.host.split('.')[0], results: {} }
const settled = await Promise.all(names.map(n => run(db, QUERIES[n]).then(r => [n, r])))
for (const [name, res] of settled) out.results[name] = res.error ? { error: res.error } : res.rows
console.log(JSON.stringify(out, null, 2))
