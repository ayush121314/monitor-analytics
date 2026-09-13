# monitor-analytics

A post-deploy audit that answers one question: **everything that shipped since I last looked — is it actually working in production?**

It is a Claude Code skill plus a local dashboard. The scripts collect evidence deterministically; Claude reads that evidence, runs the probes, and writes the verdicts. Scripts never decide anything on their own.

## What it checks

For every change merged since the last checkpoint:

| Source | What it answers |
|---|---|
| **GitHub Actions** | Did this commit actually reach production? The `… / Deploy to prod` job is the source of truth — prod deploy is a manual-approval gate, so merged ≠ live. Its completion time becomes the lower bound for every other probe. |
| **Grafana / Loki** | Is the changed code path running in prod, and is it erroring? Changed files → their `createModuleLogger('…')` module names → per-module queries against prod logs. |
| **Amplitude** | Are the new events/properties actually arriving, with what coverage? |
| **Prod MySQL (read-only)** | Did the migration land? Is the new column/table being written? And, for the health pass, the seven-day shape of orders, deliveries, returns and refunds plus the stuck-work counts — the things a log can never answer (`scripts/prodhealth.mjs`). |
| **The code itself** | Does it do what the PR title claims, and is the new path even reachable (flag, bucket, app-version gate)? |

A report is two sections - what shipped, and how the backend is doing - and each is a list of one-line points. Click a point and the explanation opens in plain language; the queries and counts sit underneath it in small grey type, so the same report works for someone scanning it and someone re-running it.

Every report closes with two health sections: *is the new code breaking anything*, and *overall backend health* — and that second one runs three lenses, because logs alone are not a health check: **logs** (error volume per module, real failures separated from business validation), **data** (today versus the seven-day shape, plus stuck refunds and orders), and **events** (the load-bearing Amplitude events against their own baseline — a flatlined event means the emitter broke while every service still looks healthy).

An error a previous report already explained is never re-investigated. The audit writes the explanation into `PREFERENCES.md` as a learning with a re-investigation threshold, counts it on later runs, and only re-opens it if the shape changes.

## Verdicts

`✅ LIVE-PROVEN` · `🟡 LIVE-NO-SIGNAL` · `⏳ NOT-DEPLOYED` · `🔁 REVERTED` · `⚪ NO-RUNTIME-SURFACE` · `🔴 SUSPECT`

A verdict without a quoted number or log line is not allowed — no evidence means `🟡 could not prove`, never `✅`.

## The dashboard

```bash
./start.sh                       # starts it in the background and opens the browser
# or: node scripts/server.mjs    # first free port from 8999
```

- one button: **Run audit**
- no new commits → it says so and runs only the backend health check; no per-feature analysis, no checkpoint move
- every run is stored with its outcome, token usage, cost and duration; the **Last 7 days** tab lists them
- reports render as collapsible sections — summary, features, health
- each report has a **discussion**: ask the AI about it, and anything you say "from now on…" is saved to `PREFERENCES.md`, which every future run reads
- **Controls**: pick repos, override the start point, move or clear a checkpoint, fire ad-hoc Loki probes

## Who starts a run

**Nothing starts an audit except you.** Hit **Run audit** (or type `/feature-audit`) and everything after that click is automatic: collect, deploy status, probes across logs, events, database and code, section 1 published with the checkpoint moved, then the health section appended. No schedule, no deploy trigger — model time is spent only when you ask for it.

The layers below run by themselves because they cost nothing: git reads and prod queries, no model calls. They are what tells you a report is worth asking for.

## State

| File | Purpose |
|---|---|
| `<dataDir>/state.json` | per-repo checkpoint (last analysed commit) + deploy cache |
| `<dataDir>/STATUS.md` | **what is broken right now** — rewritten by every run: open items, how far each repo is checked, what the last run cost, whether the tool is healthy |
| `<dataDir>/FINDINGS.md` | append-only report log, newest run at the bottom |
| `<dataDir>/PREFERENCES.md` | standing instructions honoured by every run |
| `<dataDir>/amplitude-charts.json` | the project's real event names, the chart definitions the audit reuses, and what each property's coverage was last time |
| `<dataDir>/runs/` | per-run log, collected evidence, and metadata (tokens, cost) |
| `<dataDir>/discussions/` | per-report chat threads |

## The design

[HOW-IT-WORKS.md](HOW-IT-WORKS.md) is the reasoning behind all of this — the five evidence sources and why each is load-bearing, the mechanisms that took real digging to find, what went wrong while building it, and the order to rebuild it in for a different system.

## Install

```bash
./install.sh                     # copies into ~/.claude/skills/feature-audit
```

Then edit `config.json`: repo paths, the Loki app label per repo, the deploy workflow file and its prod job name, and `dataDir`.

Give the audit its **own checkouts**. A repo marked `"managed": true` is put on its branch and pulled before every run, so the audit always reads the real `main` — never whatever branch you happen to be working on. Here that means `ecommerce-backend-3`, `ecom-cron-worker-3`, `ecommerce-async-worker-3`, cloned once and never opened by hand. A managed checkout with uncommitted changes is left alone rather than forced.

Requires: Node 20+, `git`, `gh`, `jq`, the `mysql` client, a Grafana token in the environment, and Claude Code logged in (the dashboard shells out to `claude -p`).

For the database lens, put a read-only account in `<dataDir>/db.json` (`{host, user, password, database}`) or set `FA_DB_HOST` / `FA_DB_USER` / `FA_DB_PASS` / `FA_DB_NAME`. That file lives outside the repo and is gitignored — never commit credentials.

## Scripts

| Script | Does |
|---|---|
| `collect.mjs` | merged commits since the checkpoint → files, diffs, module names, event names, env flags, migrations, revert links, and live/deploy time per commit |
| `grafana.mjs` | prod Loki queries by module / level / text, lines or counts |
| `crashscan.mjs` | greps prod for crash-shaped errors across every app, all patterns in parallel |
| `prodhealth.mjs` | read-only prod SQL: seven-day series for orders, deliveries, returns, refunds, plus stuck-work counts |
| `logsweep.mjs` | every log level, not just error: failures logged as warn or info, and modules that stopped logging |
| `schemadrift.mjs` | prod DDL snapshot + diff against the last one, and every repo migration checked against what prod actually has |
| `bucketab.mjs` | bucket-gated features compared against every other bucket, per-user rates with a z test |
| `monitor.mjs` | the five-minute self-heal pass |
| `status.mjs` | rewrites STATUS.md from the latest reports, state and health |
| `predeploy.mjs` | static risk read of a commit before it ships |
| `record.mjs` | appends a report and advances checkpoints (`--health` records without advancing) |
| `server.mjs` | the dashboard |
