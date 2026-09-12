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
| **Prod MySQL (read-only)** | Did the migration land? Is the new column/table being written? |
| **The code itself** | Does it do what the PR title claims, and is the new path even reachable (flag, bucket, app-version gate)? |

Each feature gets the same four lines: **what it is**, **what it cost us** (quantified, or "none"), **what was checked** (every probe with its number), **verdict**.
Every report closes with two health sections: *is the new code breaking anything* and *overall backend health*.

## Verdicts

`✅ LIVE-PROVEN` · `🟡 LIVE-NO-SIGNAL` · `⏳ NOT-DEPLOYED` · `🔁 REVERTED` · `⚪ NO-RUNTIME-SURFACE` · `🔴 SUSPECT`

A verdict without a quoted number or log line is not allowed — no evidence means `🟡 could not prove`, never `✅`.

## The dashboard

```bash
node scripts/server.mjs          # first free port from 8999
```

- one button: **Run audit**
- no new commits → it says so and runs only the backend health check; no per-feature analysis, no checkpoint move
- every run is stored with its outcome, token usage, cost and duration; the **Last 7 days** tab lists them
- reports render as collapsible sections — summary, features, health
- each report has a **discussion**: ask the AI about it, and anything you say "from now on…" is saved to `PREFERENCES.md`, which every future run reads
- **Controls**: pick repos, override the start point, move or clear a checkpoint, fire ad-hoc Loki probes

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

Requires: Node 20+, `git`, `gh`, `jq`, a Grafana token in the environment, and Claude Code logged in (the dashboard shells out to `claude -p`).

## Scripts

| Script | Does |
|---|---|
| `collect.mjs` | merged commits since the checkpoint → files, diffs, module names, event names, env flags, migrations, revert links, and live/deploy time per commit |
| `grafana.mjs` | prod Loki queries by module / level / text, lines or counts |
| `crashscan.mjs` | greps prod for crash-shaped errors across every app |
| `record.mjs` | appends a report and advances checkpoints (`--health` records without advancing) |
| `server.mjs` | the dashboard |
