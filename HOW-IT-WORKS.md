# How this works, and how to build it again

This is the reasoning behind the tool, not a tour of the code. If you ever want the same thing for a different system, read this and rebuild it — the code is one afternoon; the decisions below are what took the time.

---

## 1. The problem it actually solves

You merge things all week. Some reach production, some sit waiting for approval, some get reverted. Days later somebody asks "is that working?" and the honest answer is "probably".

The tool answers one question, repeatedly and with evidence: **everything that shipped since I last looked — is it doing what it was supposed to do in production?**

Two constraints shaped everything else:

- **You cannot trust "merged" to mean "live."** Production deploys here need manual approval; a PR can sit merged for days. Every claim about production has to be anchored to the moment the code actually arrived there.
- **You cannot trust a claim without a number.** "Looks fine" is worthless. Every verdict carries a query and the count it returned.

---

## 2. The one principle everything hangs off

> **Scripts collect evidence. The model decides. Never the other way round.**

Scripts are deterministic and cheap, so they do the gathering: list commits, resolve deploy times, pull logs, run SQL, read diffs. They never emit a verdict — not even "looks healthy".

The model reads that evidence, picks which probes are worth running, and writes the judgement. That split is why the output is trustworthy: a script cannot rationalise, and a model with raw evidence in front of it cannot hand-wave.

The proof this matters: an early run concluded a fix "recovered an outage of ~130 lost events". A later pass, re-checking the same window against a second source, found the outage never existed — those two days had no inward scans at all. A script would have reported the first answer forever. The model, told to verify with a second source, caught its own claim.

---

## 3. Five sources, and why each one is load-bearing

| Source | The question only it can answer | How to find the equivalent in your stack |
|---|---|---|
| **CI deploy job** | Did this commit reach production, and at what minute? | Whatever job actually rolls out. Read it at **job** level, not run level — here the run's conclusion stays empty while a sibling approval is pending, so run-level status lies. |
| **Logs** | Is this code path executing, and is it erroring? | You need a stable key per source file. Here every file declares `createModuleLogger('services.v1.x.y')`, so a changed file maps straight to a log filter. If your code lacks that, add it — it is the single highest-leverage thing for making a system auditable. |
| **Analytics events** | Is the new event/property actually arriving, and on what share of traffic? | Group the event by the new property and watch `(none)` collapse at the deploy minute. That single chart proves coverage better than any log. |
| **Production database** | Did the migration land? Is the column being written? Did the funnel move? | Read-only account. This is the only lens that catches a feature that runs perfectly and produces wrong numbers. |
| **The code** | Does it do what the PR title claims, and is the path even reachable? | Read the diff. Gates, buckets and version checks decide whether "deployed" means "running". |

Miss any one and you get a blind spot with a confident tone. Logs alone was the original design, and it would have passed a backend whose order funnel had halved.

---

## 4. The mechanisms that took real work to find

Each of these cost an hour of digging. The generic lesson is worth more than the specific fact.

**Deploy truth lives in the job, not the run.** The workflow's overall conclusion stayed empty while a CMS approval waited, even though the backend had deployed successfully. Anchor: a property appeared in production data 53 seconds after its deploy job finished — that is how you validate your deploy-detection before trusting it.
*Lesson: prove your "when did it go live" signal against a dated fact in the data, once, before building on it.*

**Changed file → log filter.** `createModuleLogger('…')` strings extracted from the changed files give an exact log query per change. No guessing, no full-text search.
*Lesson: find the naming convention that already links code to telemetry, and automate on top of it.*

**Event names are not what you think.** The project stores `order_placed`, not "Order Placed". Guessing wasted a query every time.
*Lesson: resolve names from the taxonomy API before querying; never from memory.*

**Feature flags were not where they were supposed to be.** The secret store had no entry for these repos. But the code logs `feature.flag.eval` with the resolved value per request — a better source anyway, because it shows what production actually decided, not what config claims.
*Lesson: when config is unreachable, look for the decision in the logs.*

**Reverts inside the window.** A feature merged and reverted the same day is not a finding. Link `revert-<N>-…` branches back to their PR and mark the pair, or you will waste probes chasing something that no longer exists.

**Stage traffic pollutes production analytics.** Small event counts proved nothing. A value that appeared *before* its deploy was the giveaway.
*Lesson: timestamp every claim against the deploy minute; anything earlier is someone else's traffic.*

---

## 5. State: three files, each with one job

| File | Holds | Rule |
|---|---|---|
| `state.json` | per-repo checkpoint — the last analysed commit | Moves only when a report is actually written |
| `FINDINGS.md` | append-only report log | Never rewritten; a correction is appended to the same report, not published as a second one |
| `PREFERENCES.md` | learnings | Every "known, stop reporting this" written as *what — why — how to apply — threshold to re-open* |

The learnings file is what keeps the tool from becoming noise. The OTP provider throws ~2,700 "retrying too early" errors a day. Explained once, recorded with a 5,000/day re-open threshold, and every later run counts them silently. Without that, a third of every report would be the same paragraph.

---

## 6. What one run does

1. **Pull first.** Each repo has a checkout the audit owns (`…-3`), put on `main` and pulled before anything is read. Never read a checkout a human works in — it will be on whatever branch they left it.
2. **Collect.** First-parent commits since the checkpoint; per commit: files, diff signals (logger modules, event names, env flags, routes, migrations), revert links, and whether the deploy job succeeded.
3. **Static risk, before any probe.** Read each diff for calls to methods the target file does not define, migrations riding with the code, env vars with no fallback. This one is worth building first — on the real bug this was written for it named the missing method straight from the diff, a bug that otherwise took two days and 44 production errors to surface, and across fifteen commits it produced four findings total.
4. **Probe what matters.** Not every change deserves five queries. A revert gets none. A one-line copy change gets one. Anything touching money, orders, events or migrations gets the full set.
5. **Publish section 1 immediately** and move the checkpoint. The feature verdicts are what someone is waiting for; the health sweep can land a few minutes later and append to the same report.
6. **Health, in three lenses** — logs, data, events — then append.

Each feature is written the same way every time: **Matlab** (one plain line anyone can act on), **Kya hai**, **Loss** (quantified, or "none" with what would have shown it), **Checked** (every probe with its number), **Verdict**. Fixed shape means it can be skimmed, and an omission is obvious.

---

## 7. The dashboard, and what it is not

One button with two modes. The default asks only what shipped since the checkpoint; the full audit adds the backend health pass, which is the expensive half and rarely changes between two merges on the same day. Either way it collects first: if nothing new has landed, the full mode says so and runs only the health sweep, and the cheap mode stops before the model is started at all — no tokens spent proving that nothing changed. Otherwise it shells out to the CLI and streams the steps, showing phase and percent, so a long run is legible rather than a spinner.

**Nothing starts a run except the person.** No schedule, no deploy trigger. Model time is spent when it is asked for.

Every run is stored with its token usage and cost. Lead with **tokens written** — a run reads over a million tokens and writes about eighteen thousand; showing the total makes the number meaningless.

---

## 8. The monitor: keep the tool alive, nothing more

Every five minutes, from a launchd agent: restart the dashboard if it died, stop a run that has produced no output for eight minutes, check each repo is on its own branch, verify the state file parses, probe the log backend.

It earned its place on the first pass by reviving a dashboard nobody noticed was down. It raises no product alerts and never starts a run — scope creep here turns a watchdog into a second source of noise.

---

## 9. What went wrong while building it

Every one of these is now a rule in the skill file.

- **The agent fixed the bug it found.** It created a branch, committed, and left the repo checked out there — breaking the workspace. Fixes are now described in the report, never applied. Absolute no-git rule, with the monitor's branch check as backstop.
- **An API key in the environment silently overrode the CLI login.** Every headless run died with a 401. Strip auth env vars from the child process.
- **A dead child process did not always emit `close`.** The job stayed "running" forever and blocked the next one. Listen for `exit` too, add a no-output stall detector and a hard watchdog.
- **Large probe payloads killed the run.** A 1000-line log pull flooded the context and the process died mid-way. Cap sweeps; use counts when a number is all you need.
- **One run published two reports.** It found its own earlier conclusion wrong and re-published instead of correcting. One recorded report per run; corrections append.
- **The first bug report overstated the damage.** "Attribution dead on 100% of links" became, after following the value three files further, "the deep link falls back to a default id, so campaign widgets are wrong for 25% of products, no money impact." *"Field is null" is not "feature is dead" — follow the value to its consumer.*

---

## 10. Building it again, in order

Each step is useful on its own; stop wherever the value runs out.

1. **Deploy truth.** One script: for a commit, did the deploy job succeed, and when. Validate it against a dated fact in production data. Everything else anchors here.
2. **Checkpoint + append-only log.** Two files. Now "since I last looked" has meaning.
3. **Collector.** Commits since the checkpoint, plus whatever signals your codebase already exposes — logger names, event names, env vars, migrations.
4. **Static risk read.** Missing methods, migrations, unset config. Highest catch-rate per line of code in the whole tool.
5. **One probe script per source.** Logs, then events, then database. Keep them dumb and composable — flags in, JSON out.
6. **The instruction file.** Where the model is told the report's shape, the four lines per feature, the verdict vocabulary, and the rule that no evidence means "could not prove", never "fine".
7. **Learnings file.** The day you find yourself explaining the same error twice.
8. **Dashboard.** Only once the command line version is genuinely useful. It changes who can run it, not what it can do.
9. **Monitor.** Last. It exists to keep steps 1–8 breathing, nothing else.

The order matters. Every step that was built out of sequence — the dashboard before the report shape settled, the monitor before the runs were reliable — had to be rebuilt.
