---
name: feature-audit
description: Audit everything that shipped since the last audit checkpoint — merged PRs on ecommerce-backend / ecom-cron-worker / ecommerce-async-worker, verified against prod Amplitude events, prod Grafana logs, Vault flags and the code itself. Use when the user says /feature-audit, "jo features gaye hain unko check karo", "kya kya ship hua since last time", "post-deploy verification", "audit what shipped", or asks whether recent PRs are actually working in production.
---

# Feature audit

Walks every change merged since the last checkpoint and decides, **with proof**, whether it is actually doing what it was supposed to do in production.

## The one hard rule

**The scripts never produce a verdict. You do.**

`collect.mjs` gathers deterministic facts (merged commits, changed files, deploy times, module names, event-name candidates, env flags). Every "is this working?" decision comes from you, after you run probes and read code. Never copy a script field into a verdict without an independent probe. If you cannot prove something, the verdict is "unknown" — never a guess.

## State

- Checkpoints + deploy cache: `~/Desktop/IMP/feature-audits/state.json`
- Findings (append-only, newest run at the bottom): `~/Desktop/IMP/feature-audits/FINDINGS.md`
- Repos, Loki apps, Grafana endpoints, Amplitude project: `~/.claude/skills/feature-audit/config.json`

Checkpoint advances **only** through `record.mjs`, and only for repos you actually analyzed in this run.

## Health-only mode (no new commits)

If `collect.mjs` reports **0 pending changes** for every repo, do **not** skip the run. Skip Steps 2–4 (there is nothing new to verify) and produce **only** the `### Overall backend health` section:

- `node scripts/crashscan.mjs --from now-24h` across all repos;
- an error sweep per app (`node scripts/grafana.mjs --repo <name> --level error --from now-24h --limit 1000`) for the top modules by error count;
- separate real failures from benign business validation, with counts, and name anything failing continuously.

Record it with `node scripts/record.mjs --body <scratch>.md --health` — that appends the report **without touching any checkpoint**. Open the chat reply with "No new commits since the last check" and then the health verdict.

## Step 0 — Read the learnings and the last report

`~/Desktop/IMP/feature-audits/PREFERENCES.md` is the audit's **learnings file** — what it has been told and what it must do about it: errors already known and not worth raising again, things to always check, how the user wants things reported. Each bullet is *what — why — how to apply*.

Also read the **last report at the bottom of `FINDINGS.md`** before starting — **for your own context, not to reprint.** It tells you what is already known, what was left open, and what has already been ruled out. Use it to:
- re-probe anything left 🔴 or 🟡 and fold the result into that feature's own lines this time ("still broken since 10-Sep", "was no-signal last run, now proven") — no separate recap section, no "previous run said…" block;
- avoid re-litigating what the last report closed as ✅ or ⚪ unless new evidence contradicts it;
- avoid repeating an ambient error you already reported unless its volume or shape changed.

The user reads the report for *this* run's features and the current health picture. History is your input, not his output.

**Read PREFERENCES.md before every run and apply it.** It is the user's voice, so where it conflicts with this file, it wins. In the report's summary add one line — `Applied learnings: <n>` — naming which ones changed what you reported (e.g. "suppressed the Karix webhook errors, known since 12-Sep"). If a learning looks stale (the error it excuses has changed shape, or its "stop applying when" condition is met), say so in that line instead of silently dropping it. If the file does not exist yet, nothing to do.

## Step 1 — Collect

```
cd ~/.claude/skills/feature-audit
node scripts/collect.mjs                     # all repos, since each repo's checkpoint
node scripts/collect.mjs --repo ecommerce-backend --since 21086e41   # override window
node scripts/collect.mjs --status            # just show current checkpoints
```

Write the JSON to a scratch file and read it from there — it is large.

Per change you get: `sha`, `pr`, `branch`, `kind`, `subject`, `files`, `stat`, `live`, `liveSince` (+IST), `revertsPr`, `revertedInWindow`, and `signals`:

| signal | meaning | probe it unlocks |
|---|---|---|
| `modules` | `createModuleLogger('…')` strings inside the changed files | Grafana: is this code path running / erroring in prod |
| `amplitudeEvents` | event-name string literals added in the diff | Amplitude: is the event arriving, with the new property |
| `envFlags` | `process.env.X` added in the diff | Vault: is the flag actually ON in prod |
| `routes` | routes added in the diff | Grafana: handler hits + 5xx |
| `crons`, `migrations`, `sqlTouched`, `redisKeys`, `tests` | surface hints | pick the matching probe / note the DDL dependency |

`live: false` means **the prod deploy job never succeeded for that commit** (usually still waiting for approval). `liveSince` is the exact prod deploy timestamp — use it as the lower bound for every prod probe. Never probe prod for a window before `liveSince`.

## Pace

Keep a run proportional to what landed: roughly **2–4 probes per change**, and section 1 published within ~10 minutes of starting. Depth is for the changes that can actually hurt — money, orders, events, migrations, gates. A one-file copy change gets one probe and one line. When a probe needs more than two follow-ups to settle, stop and write `🟡 could not prove — <what would settle it>`; an honest unknown beats a long chase. **Answer at the coarsest resolution that settles the question** — daily counts before hourly, one query before a timeline. Pinning an exact recovery minute is almost never worth the round-trips; "back to normal on 9-Sep, was zero on 8-Sep" is the finding. Section 2's crashscan is one command — run it once, across all repos, and read the output rather than re-querying each pattern by hand.

## Step 2 — Triage each change

Classify before probing, so you only run probes that can actually prove something:

- `revertedInWindow: true` → the change was reverted inside this same window. Verdict `🔁 REVERTED`. Note both PR numbers, do not probe prod.
- `kind: revert` → check what it reverted and whether the revert itself is live.
- `live: false` → verdict `⏳ NOT-DEPLOYED`. **Do not** call missing Amplitude/Grafana signal a bug. Say what is waiting and since when.
- no `modules` / `routes` / `amplitudeEvents` / `crons`, and files are tests/docs/workflows only → `⚪ NO-RUNTIME-SURFACE`, one line, move on.
- everything else → probe.

## Step 3 — Probes (only the relevant ones)

**Grafana (prod logs).** Logs are pino JSON: `level, service, env, module, event, handler, requestId, userId, platform`.

```
node scripts/grafana.mjs --repo ecommerce-backend --module services.v1.refund.initiateRefund --from now-24h --limit 200
node scripts/grafana.mjs --repo ecommerce-backend --module services.v1.refund.initiateRefund --level error --from now-24h
node scripts/grafana.mjs --repo ecommerce-backend --grep "someDistinctString" --from now-6h
node scripts/grafana.mjs --repo ecom-cron-worker --module <module> --from now-24h --count
```
Set `--from` from `liveSince` (round to `now-Nh` covering it). Read `levels`, `events`, `modules`, and the `samples`. An error sample that names the changed module after `liveSince` is a finding — quote the `msg`/`err` in the report.

**Amplitude (prod events).** Project `760327` (DealShop).
- Event names in this project are **snake_case** (`order_placed`, `payment_success`). Never guess a name — resolve it first with `search_amp_data_taxonomy` (projectId `760327`).
- Then `query_amplitude_data` with a typed segmentation chart: `events: [{event: "<name>"}]`, `measured_as: {as: "event_totals"}`, `interval: "day"`, `date_range: {relative: "Last 7 Days"}`.
- For a new **property**, add a `where` filter on it (`op: "is not"`, `values: ["(none)"]` = has a value) and compare against the unfiltered count — that proves the property is populated, not just that the event fires.
- Trap: stage/local runs also land in project 760327, so a handful of events is not proof of prod traffic. Volume + timing against `liveSince` is the proof.

**Vault (flags).** For each `envFlags` entry that gates the feature, use the `crafto-vault-secrets` skill to read the **prod** value for that repo. A feature behind an OFF flag is `🟡 LIVE-NO-SIGNAL (flag off)` — correct, not broken. Never read `sensitive/` paths.

**Code.** Read the real diff and the current file, do not rely on the signal lists:
```
git -C <repo path> show --stat <sha>
git -C <repo path> diff <sha>^1 <sha> -- <file>
```
Ask: does the code do what the PR title claims? Is the new path reachable (gate, bucket, version check)? Does it need a migration that has not run? Does it write to a column/redis key that other code reads?

**DB (optional, when a change writes data).** Prod DB reads are pre-approved and read-only. A dated marker column is the cheapest liveness proof (e.g. a new `product_snapshot` key starts appearing at the deploy minute). Never write to prod.

## Step 4 — Verdicts

| verdict | when |
|---|---|
| `✅ LIVE-PROVEN` | deployed **and** a prod probe after `liveSince` shows the new behaviour (events flowing / handler hits / logs of the new path) |
| `🟡 LIVE-NO-SIGNAL` | deployed, no errors, but nothing proves it ran — flag off, seasonal path, or zero traffic. Say **which** and what would prove it |
| `⏳ NOT-DEPLOYED` | prod deploy job never succeeded for that commit (approval pending) |
| `🔁 REVERTED` | reverted inside this window, or by a later commit |
| `⚪ NO-RUNTIME-SURFACE` | tests/docs/CI only |
| `🔴 SUSPECT` | prod evidence contradicts intent — errors naming the changed module after deploy, event missing while traffic exists, property empty, gate unreachable. Always quote the evidence |

Every non-⚪ verdict carries at least one **quoted number or log line** with its query. No evidence → the verdict is `🟡` with "could not prove", never `✅`.

## Step 5 — Write findings and advance the checkpoint

Write the block to a scratch `.md` file. **The report always has the same shape: a summary at the top, then exactly two sections, and the second has two subsections.**

```
**Window:** 05 Sept → 12 Sept 2026 · 45 changes (40 backend, 4 cron-worker, 1 async-worker)
**Tally:** 🔴 1 broken · 🟡 8 no-signal · ⏳ 1 never deployed · 🔁 5 reverted · ✅ 9 proven · ⚪ 21 no surface
**Prod heads:** ecommerce-backend 12 Sept 14:14 IST · ecom-cron-worker 08 Sept 20:52 IST
**Bottom line:** one sentence — is anything broken, is anything at risk, is the backend otherwise healthy.

### 1. Features shipped

#### 🔴 Broken in production
**Share links resolved through a new endpoint** (PR #891, live 10 Sept 19:45 IST) — 🔴 BROKEN
- **Kya hai:** the controller resolves a share code to a product to attach fbAdId to the deep link.
- **Loss:** fbAdId null on 100% of shared links since 10-Sep — attribution dead. No order/payment impact. 44 failures in 48h.
- **Checked:** (1) Loki `module="controllers.v1.productShare" | level="error"` 48h → 44 lines, err `getSharedProduct is not a function`;
  (2) read main's controller + service — method absent; (3) `git log -S getSharedProduct` — PR #888 deleted it, PR #891 re-added the caller.
- **Verdict:** 🔴 confirmed, still live on main.

#### ✅ Shipped and proven working
… same four-line block per feature …

### 2. Health

#### 2.1 Naya code kuch tod to nahi raha
… window-scoped crash check …

#### 2.2 Overall backend health
… app-wide error picture …
```

Rules:

- **Name the feature, never the commit hash.** The headline is what the change *does*, in plain words — take the PR title and make it readable ("Share links resolved through a new endpoint", not `85711d16`). PR number and live date follow in brackets. Shas belong only inside **Checked**, as part of a command someone would re-run.
- **Section 1** groups features under `#### <emoji> <group name>` headings (Broken / Proven working / Live but unproven / Never deployed / Reverted / No runtime surface). Every feature carries the same four lines — **Kya hai**, **Loss**, **Checked**, **Verdict** — no free-form summaries.
- **Loss** is mandatory even when nothing was lost — then write `Loss: none — <what would have shown it>`. Quantify whenever the data allows: how many events, orders, rupees, users, over what window. Never "may be affected" without a number or an explicit "could not quantify, here is why".
- **Checked** is the audit trail: every probe you ran, numbered, each with the query/command *and* the number it returned. An empty probe still belongs there — an empty probe is evidence.
- **2.1 Naya code kuch tod to nahi raha** — run `node scripts/crashscan.mjs --from now-24h` (it greps prod for `is not a function`, `Cannot read propert`, `is not defined`, `TypeError`, `Unknown column`, missing table, MySQL `ER_` codes, `ECONNREFUSED`, `ETIMEDOUT`, HTTP timeouts, `unhandledRejection`, `uncaughtException`, OOM, `MODULE_NOT_FOUND`) and cross-match every hit's module against the files this window touched. Say it plainly: **kuch tut raha hai / tut sakta hai / kuch nahi**. Include what logs cannot show yet — a query against a column prod does not have, a call to a method that no longer exists on a rarely-hit path, a new env var nobody set.
- **2.2 Overall backend health** — app-wide, regardless of this window: total prod errors per app over 24h, top modules by error count, and which of those are real failures versus benign business validation (`Product not found`, out-of-stock, `validation.failed` are noise — say so, so nobody chases them). Name anything failing continuously even if it predates this window, with counts.
- Close with a short **Needs attention** list (🔴 first, then the 🟡s that look wrong).

**Publish in two passes — section 1 must not wait for section 2.** The moment section 1 is finished, record it and move the checkpoints; the health section is appended to the same report afterwards.

```
node scripts/record.mjs --body <section1>.md --advance ecommerce-backend=<sha>:<pr> --advance ecom-cron-worker=<sha>
# … now run crashscan + the error sweep, write section 2 …
node scripts/record.mjs --body <section2>.md --append
```

`--append` folds the new text into the report block already written, so the user sees the features immediately and the health picture lands a few minutes later. Use `--dry` on either call when unsure.

Advance to the newest **analyzed** sha per repo (usually `head.sha` from the collect output). Skip `--advance` for any repo you did not finish — it simply shows up again next run. Run `--dry` first when unsure. (The dashboard auto-advances a checkpoint if a report was appended and the AI forgot, so never advance a repo you did not actually analyse.)

Finally, tell the user in chat: the bottom line, the counts, and only the 🔴/🟡-worth-reading items in full. Point at `FINDINGS.md` and the dashboard for the rest.

## UI

`node ~/.claude/skills/feature-audit/scripts/server.mjs` serves a local dashboard on the first free port from **8999**. It has exactly one action button — **Run audit** — plus Stop while a run is live.

What a UI run does, in order:
1. runs `collect.mjs` and prints every change found since the checkpoint, with the probes each one unlocks;
2. if nothing new has landed, it stops there and says **"No new commits since the last check"** — no AI call, no report, no checkpoint move;
3. otherwise it spawns `claude -p "/feature-audit" --output-format stream-json --verbose`, which is this skill end to end, and streams its steps live.

Every run is written to `<dataDir>/runs/<id>.{log,json,meta.json}`. The meta file carries the outcome, the number of changes, the report number it produced, the **token usage and cost**, and how long it took. The **Last 7 days** tab lists those runs newest-first; the header totals their tokens and cost.

The **Controls** tab drives everything else: pick which repos a run covers, override the start point, add a note to the AI, mark it a dry run, move or clear a repo's checkpoint (with a commit picker), and fire ad-hoc Loki probes against prod.

## Parallelism

More than ~6 changes to analyze: dispatch one subagent per change (or per repo) with the change's JSON slice plus this file's Step 3–4, and have each return a finished markdown block + verdict. Merge the blocks in PR order. Keep the Amplitude MCP calls in the main session if subagents cannot reach it.

## Traps (learned the hard way)

- **Merged ≠ live.** Prod deploy is a manual-approval job; a PR can sit merged for days. `liveSince` is the only truth.
- **A revert can land in the same window** — always check `revertedInWindow` before probing.
- **Stage/local events reach prod Amplitude (760327)** — small counts prove nothing.
- **`ORDER_FAILED`** is a real order status (pincode not serviceable) — exclude it from "orders" comparisons.
- **Timestamps**: Loki/GitHub return UTC, report IST (`liveSinceIst`, `dateIst` are already IST).
- **Never write scratch files into a repo.** Temp scripts, JSON dumps and findings drafts go to the session scratchpad or `/tmp`, never inside `ecommerce-backend/` or any other checkout — a stray file there shows up in the user's `git status`.
- **Never touch git state** (no commit/push/checkout/branch) and never write to prod DB or Redis. Read-only everywhere.
- Grafana tokens come from `~/.zshrc` (`GRAFANA_TOKEN_PROD`; the stage token has been expired since 24-Aug).
- The dashboard's report discussion writes standing instructions into `PREFERENCES.md`. When answering there, append any "from now on…" instruction to that file yourself and confirm it in one line.
- `gh` runs with the `gho_` token from `git credential fill` — the shell `GITHUB_TOKEN` is `read:org` only and will 404.
