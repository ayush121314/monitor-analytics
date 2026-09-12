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

Each feature gets the same four lines: **what it is**, **what it cost us** (quantified, or "none"), **what was checked** (every probe with its number), **verdict**.

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

## Knowing before you ask

The audit is the deep pass; these three layers are what tell you a feature broke without you running anything.

| Layer | Catches | When |
|---|---|---|
| `predeploy.mjs` | a call to a method the target file does not define, a migration shipping with the code, a new env var with no fallback — read straight from the diff | **before the code is deployed** |
| `watch.mjs` — new signature | a prod error whose shape has never been seen before | within 5 minutes of the first occurrence |
| `watch.mjs` — spike | a module 3× over its own rolling median | within 5 minutes |

Every alert names the PR that last touched that module, raises a macOS notification, and shows as a red banner on the dashboard. A fresh `Deploy to prod` starts an audit on its own; if nothing has run by 10:00 IST, the monitor starts one anyway.

Tested against the real bug this was built after: run `predeploy.mjs --sha 85711d16` on the share-link commit and it reports the missing `getSharedProduct` from the diff alone — the same bug that took two days and 44 production errors to surface the slow way. Across fifteen recent commits it produced four findings in total, so it is quiet enough to trust.

## The monitor (self-healing)

`scripts/monitor.mjs` runs every five minutes from a launchd agent (`com.primetrace.feature-audit-monitor.plist`, installed once with `launchctl bootstrap gui/$UID <plist>`; `start.sh` re-arms it if it ever gets unloaded). Each pass:

- dashboard not answering on any port from 8999 → **starts it**
- a run with no output for more than eight minutes → **stops it**, so the next run is not blocked
- `state.json` parses and every repo has a checkpoint
- every repo is still on its own branch — an audit that leaves a checkout switched is a failure
- prod Loki answers a probe query
- runs the prod error watcher, starts an audit when a new prod deploy lands, and keeps a daily floor of one run

Results go to `health.json` and `monitor.log`, and the dashboard header shows **● monitor ok** with the per-check detail on hover.

## State

| File | Purpose |
|---|---|
| `<dataDir>/state.json` | per-repo checkpoint (last analysed commit) + deploy cache |
| `<dataDir>/FINDINGS.md` | append-only report log, newest run at the bottom |
| `<dataDir>/PREFERENCES.md` | standing instructions honoured by every run |
| `<dataDir>/runs/` | per-run log, collected evidence, and metadata (tokens, cost) |
| `<dataDir>/discussions/` | per-report chat threads |

## Install

```bash
./install.sh                     # copies into ~/.claude/skills/feature-audit
```

Then edit `config.json`: repo paths, the Loki app label per repo, the deploy workflow file and its prod job name, and `dataDir`.

Requires: Node 20+, `git`, `gh`, `jq`, the `mysql` client, a Grafana token in the environment, and Claude Code logged in (the dashboard shells out to `claude -p`).

For the database lens, put a read-only account in `<dataDir>/db.json` (`{host, user, password, database}`) or set `FA_DB_HOST` / `FA_DB_USER` / `FA_DB_PASS` / `FA_DB_NAME`. That file lives outside the repo and is gitignored — never commit credentials.

## Scripts

| Script | Does |
|---|---|
| `collect.mjs` | merged commits since the checkpoint → files, diffs, module names, event names, env flags, migrations, revert links, and live/deploy time per commit |
| `grafana.mjs` | prod Loki queries by module / level / text, lines or counts |
| `crashscan.mjs` | greps prod for crash-shaped errors across every app, all patterns in parallel |
| `prodhealth.mjs` | read-only prod SQL: seven-day series for orders, deliveries, returns, refunds, plus stuck-work counts |
| `monitor.mjs` | the five-minute self-heal pass |
| `watch.mjs` | rolling prod error baseline: new signatures, spikes, pre-deploy risks, deploy detection |
| `predeploy.mjs` | static risk read of a commit before it ships |
| `record.mjs` | appends a report and advances checkpoints (`--health` records without advancing) |
| `server.mjs` | the dashboard |
