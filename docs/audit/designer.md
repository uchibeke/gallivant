# Designer audit: the operator's seat

> Note: the document these audits call `PRD.md` was renamed `SPEC.md` on 2026-09-25, because it is a product
> specification and does not meet the PRD contract this tool enforces. The audits are left as written.

Auditor: product designer (developer tools, CLIs). Target: PRD.md 0.2, pre-audit. Date: 2026-09-23.

## Verdict

Approve with changes. The engine (poll, resume, re-review, cap) is the right shape, but the parts the operator actually touches every day are unspecified: what `status` prints, what the one notification says, why a PR went to `needs-human`, what `attach` does to a PR that is mid-run, and what `init` really asks. Those gaps are where the operator stops trusting it, usually in the first week, and they are cheap to fix on paper before code exists.

## Findings

### 1. Blocker. Section 6.6, 6.12, US6. `needs-human` has no reason the operator can read.

The registry has `state` but no `reason`, no last event, no pointer to what the last run did, and the notification promises "one line of why" with no defined source. The operator's first question on every `needs-human` is "what did it try", and today the answer is to open a 2 MB stream-json file.

Change: add `reason` and `last` to the registry entry and make them the notification body.

```
"reason": "conflict | iterations | timeout | harness-error | guardrail-denied | not-signed-in | no-pr | reviewer-silent",
"last":   { "at": "2026-09-24T02:14:00Z", "event": "codex review 2201 dispatched", "run": "003.jsonl", "exit": 0 }
```

Add `gallivant why <handle>`: prints reason, the event that was dispatched, the harness's final assistant message from the run log (not raw JSON), and any APort denial lines from `~/.claude/aport/audit.log` or `~/.aport/codex/aport` for that run window. Also post the same text as one PR comment when the PR goes to `needs-human`, since GitHub is where the operator already is. Every reason above is a real path in the PRD (6.8, 6.9, US9, US12, risk table) that currently collapses into an unlabeled stop.

### 2. Blocker. Section 6.10, 6.8. Two silent stalls: a session that never opens a PR, and a PR Codex never reviews.

`start` flips the PRD to `running` and nothing in the watcher looks at `running` entries, so a session that exits without a PR (wrong branch, crashed, asked a question into the void) stays `running` forever with no notification. A PR where `@codex review` is posted and Codex never answers sits in `pr-open` forever; the operator wakes up, sees nothing happened, and cannot tell "working" from "dead".

Change: on session exit, if no open PR matches the branch within one poll, set `needs-human` reason `no-pr`, notify, include the last assistant message. Add `stall_hours: 6` to config: a `pr-open` PR with no new event for that long after the last `rereview_comment` goes to `needs-human` reason `reviewer-silent`. The 👀 retry in 6.9 covers 5 minutes; nothing covers 5 hours.

### 3. Major. Section 6.12, US6, US7. The notification text is unspecified, and `done` is noise.

"PR link and one line of why" leaves the only thing the operator reads to the implementer. Notifying on `done` tells the operator about a merge they just clicked themselves, which is exactly the Telegram-bot noise they asked to stop.

Change: cut `done` from the notify list. Specify the two messages using ntfy's `Title`, `Priority`, `Click` and `Tags` headers (all exist, no library needed):

```
ready-for-human   Title: aport-vault #142 ready for a human
                  Body:  Codex: no P0/P1 after round 2. Checks green. 3 files, +120/-14.
                  Click: <PR url>   Priority: default

needs-human       Title: aport-vault #142 needs you: merge conflict
                  Body:  Stopped in round 2. gallivant why aport-vault#142
                  Click: <PR url>   Priority: high
```

Body is the `reason` plus one fact, never more than two lines. Repo and PR number go in the title because the operator has 60 repos.

### 4. Major. Section 6.10, US14. `gallivant status` is the whole UI on day one and it is one sentence.

"Status, harness, PR link, iteration and last event time" is a column list, not a design. A flat table sorted by PRD id makes the operator scan 20 rows to find the two that need them, which is the same failure as the Telegram stream in a different font.

Change: specify the output.

```
gallivant  daemon up 6h  last poll 40s ago  next in 80s  claude ok  codex ok  ntfy ok

NEEDS YOU
  aport-vault#142     needs-human   conflict          round 2/3   12m ago   gallivant why aport-vault#142
  command-center#31   ready         no P0/P1, green   round 1/3   2h ago    <PR url>

RUNNING
  aport-guardrails#88 fixing        codex review      round 1/3   started 3m ago
  aport-vault#150     waiting       on codex review   round 0/3   posted 4m ago

QUEUED
  docs/prds/vault-benchmark.md   claude   starts next poll
```

Rules: needs-you first, then running, then queued; `done` hidden unless `--all`; a dead daemon prints a red first line and exits 1; `--json` for command-center; every row prints the handle (`repo#pr`) that the other commands accept. "waiting on codex review (4 min)" is the difference between the operator trusting a quiet night and killing the daemon.

### 5. Major. Section 6.10, 6.12. Errors when nothing is watching have no channel.

`gh` auth expiry, a harness signed out, rate limiting, ntfy unreachable, launchd restart loops, a poll that throws: none of these produce a state transition, so under the "one message per transition" rule they are invisible. The operator finds out three days later that nothing ran.

Change: add a daemon-health class of notification, one message per error class per 6 hours, subject "gallivant: gh not authenticated", body the fix command. Write every daemon error to `~/.gallivant/errors.log` and show the newest in the `status` header. If ntfy itself fails, the header is the fallback. Do a `probe` at daemon start and on every poll for `gh auth status`, harness sign-in, and config sanity, and refuse to dispatch anything while a probe fails rather than failing inside a run.

### 6. Major. Section 6.10. `attach` on a PR that is mid-run corrupts the session, and the operator's own pushes count as rounds.

Two processes resuming one Claude or Codex session at the same time is undefined. After the operator attaches, pushes a fix by hand, and detaches, the watcher sees a new head sha, posts `@codex review`, bumps `iteration`, and may then dispatch the operator's own review comments back to the harness.

Change: `attach` implies `pause` for that PR and refuses if a run is in progress ("run in progress, 4 min; `gallivant stop <handle>` to kill it, or wait"). While paused, cursors do not advance and nothing is dispatched; `resume` replays the missed events as one batch and asks before doing so if there are more than 3. Pushes made while paused do not count toward `max_iterations`. For Claude Code use `claude --resume <uuid>` in a new iTerm tab (interactive, same session); for Codex `codex resume <id>`. Note for the implementer: Claude Code 2.1.263 has `claude --bg`, `claude attach <id>`, `claude logs <id>` and `claude agents`; if runs can be started with `--bg --resume <uuid>` and still emit stream-json, `attach`, `logs` and a live list come for free and Gallivant should not build its own. Verify before M1.

Add the lightweight intervention the PRD hints at but never names: `gallivant tell <handle> "message"` posts `@gallivant <message>` as a PR comment, which is already a dispatch trigger in 6.8. No new mechanism, and it works from a phone.

### 7. Major. Section 6.4, 6.10, 8. The daily loop has two verbs and a scan where one verb and a queue would do.

Day one, the operator hand-edits frontmatter to `ready`, then runs `gallivant start <path>` per PRD, because `ready` and root scanning are M3. Open question 4 (morning schedule) would delay the evening's PRDs by hours, against ask 1 ("go to bed, work continues").

Change: `gallivant ready <path>` lints, flips `draft` to `ready`, and writes a `queued` entry into `state.json`. The daemon starts queued entries on its next poll. No filesystem scan across 60 repos, no morning job, no separate `start` in the daily path. Output of `ready`:

```
queued docs/prds/vault-benchmark.md (claude). Starts within 2 min. gallivant status
```

Keep `gallivant start <path>` as the by-hand shortcut that does `ready` and starts immediately. Move `ready` into M1; it is the front door.

### 8. Major. Section 6.4. Daemon writeback to the PRD file creates two truths.

The operator edits PRDs on `main`. The daemon writes `pr-open` and later states into the copy on the PR branch, so the file the operator opens still says `ready` or `running`, and after merge the PRD's status is whatever the branch last wrote. That is a second source of truth next to the registry, and it costs a commit per transition.

Change: cut writeback. The PRD file carries only `draft` and `ready`, both operator-owned. Every later state lives in the registry and on the PR (labels, metadata block). `status` is how the operator sees it. If a status in the file is wanted after merge, `done` can be written once by the operator or by a later `gallivant sweep`, not by the loop.

### 9. Major. Section 6.11, US13. `gallivant init` is not a short wizard on this machine.

APort is not installed for Claude Code or Codex here (`~/.claude/aport/` and `~/.codex/hooks.json` do not exist). Each APort installer opens its own three-way passport prompt (hosted, existing id, local file), the Codex hook then needs `/hooks` trust from inside the Codex TUI per APort's own doc, Claude Code needs a restart, section 9 needs three config edits, and there is still the ntfy topic, the launchd plist and branch protection. Hiding all that behind "init calls them" produces a wizard that stalls on a prompt the operator did not expect, with no idea which file got written.

Change: make `init` a checklist that runs the same checks as a `gallivant doctor`, idempotent, one line per step, pass or fail with the exact command:

```
[ok]   gh authenticated as uchibeke
[fix]  claude: blockReadsOutsideWorkingDirectories is set -> remove it or use --add-dir (section 9)
[run]  APort hook for Claude Code -> npx @aporthq/aport-agent-guardrails claude-code --enforcement=warn
[todo] Codex: open codex, run /hooks, trust the APort hook (cannot be automated)
[ok]   ntfy test message sent to https://ntfy.sh/<topic>; check your phone
[ok]   launchd job loaded
```

Run the APort installers as named steps with their prompts visible, never captured. End `init` with the M0 check itself: one dry fix run on a scratch branch. `doctor` is `init` without the writes, and its failures appear in the `status` header (finding 4).

### 10. Major. Section 6.11. Enforce mode on Codex will deny most real edits, and the operator will read it as "Gallivant is broken".

APort's Codex doc (docs/frameworks/codex.md, "Tool coverage") says multi-file `apply_patch` payloads fail closed in the beta hook, and `Glob`, `List`, `LS` fail closed too. A Codex session editing two files at once in enforce mode gets denied on the first edit, loops, and hits the cap; the operator sees `needs-human` with no reason and blames the loop.

Change: Codex stays in `--enforcement=warn` until APort's Codex hook leaves beta, with a note in config comments and in `doctor`. Any run whose log contains an APort deny gets reason `guardrail-denied` (finding 1) with the denied tool and path in `why`. Claude Code can go to enforce after the first PR as planned.

### 11. Major. Section 6.4. The PRD template is what the operator types every day, and it is tuned for the lint, not the writer.

Seven status values in the template when the writer owns two; a hand-typed unique `id`; a nested `gallivant:` key that yaml-in-frontmatter tools handle inconsistently; and the lint only checks that two headings exist, so an empty `## Acceptance criteria` passes. Missing are the things an unattended agent most often gets wrong: where to look, how to verify, what a finished PR looks like.

Change: flat frontmatter, id from filename, harness optional (default from config), and a `gallivant new <repo> <slug>` that writes this scaffold so the daily loop is `new`, write, `ready`:

```markdown
---
status: draft
harness: claude
base: main
---

# <title>

## Problem
One paragraph. Who hurts, what happens today.

## User stories
- As a <who>, I want <what>, so that <why>.

## Acceptance criteria
- Given <state>, when <action>, then <observable result>.

## Verify
Commands the session must run green before opening the PR, e.g. `npm test`.

## Where to look
Entry points, files, docs. Two to five lines.

## Out of scope
```

Lint: each required section has at least one list item or non-blank line; at least one criterion starts with "Given" or "- [ ]"; `Verify` has at least one fenced command. Print the failing section name and line. Keep the scaffold under 25 lines; if it takes longer to fill than to write the change, the operator will skip it.

### 12. Minor. Section 6.13, M5. The command-center Work app will become a second firehose unless the rules are written now.

Command-center's runner (`lib/run.mjs`) allows one job at a time and its runs view re-renders the full log every 4 seconds; neither fits 5 to 20 concurrent sessions. Raw stream-json is unreadable in a `<pre>`.

Change, for M5: the Work app has two lists, "Needs you" and "Running", fed by `gallivant status --json`, plus a queued list. One badge: the count of "Needs you". No toasts, no transition feed, no log open by default. The log view renders assistant text and tool names from the jsonl, not raw events; build that formatter once in `gallivant logs <handle>` for the terminal and reuse it. Buttons are exactly `attach`, `pause`, `resume`, `tell`, `why`. Command-center never streams a gallivant run through its own runner.

### 13. Minor. Section 6.10. Command handles are ambiguous across 60 repos.

`attach <prd|pr>` accepts a bare PR number, which collides the moment two repos both have a #12. The operator will type the wrong one at 11 pm.

Change: every command accepts `repo#pr` (short repo name, org optional), a PRD id, or a PRD path; a bare number is accepted only when it matches exactly one open entry, otherwise the command lists the matches. `status` prints the handle in its accepted form so it can be copied.

### 14. Minor. Open question 2, US7. Trusted comments on a `ready-for-human` PR must not restart the loop by accident.

If any trusted comment reopens the loop, the operator writing "LGTM, merging after lunch" starts a round, posts `@codex review`, and sends a new notification. That is one wasted round and one notification the operator learns to ignore.

Change: on a `ready-for-human` PR, only a review with `CHANGES_REQUESTED`, an inline review comment, or an issue comment starting with `@gallivant` reopens it. Plain issue comments never dispatch in any state (6.8 already says this; make US7 match).

### 15. Minor. Section 6.9. The retry rule leaks Codex's flakiness into the operator's mental model.

The 👀 reaction check is invisible to the operator, so "posted @codex review, waiting" and "Codex ignored us" look the same for 5 minutes and then differ silently.

Change: `status` shows `waiting on codex review (4 min, retried once)`; after the retry, if nothing arrives by `stall_hours`, finding 2 applies. Nothing else changes.

## What to cut for a four-hour day one

- PRD status writeback (finding 8). Saves a commit path and a merge hazard.
- The `done` notification (finding 3).
- Codex enforce mode; ship warn (finding 10).
- `--fork-session` on the last round. The cap already bounds context.
- The Claude PostToolUse and Codex `notify` registration hooks (6.5). Branch reconciliation is the guarantee; the hooks save at most one poll.
- Root scanning for `ready` PRDs; use the queue in finding 7.
- Section 6.13 entirely, until `status --json` and `logs` exist.

What must not be cut, because it is where trust lives: `reason` and `why` (finding 1), the `no-pr` and `reviewer-silent` stops (finding 2), the `status` header with daemon health (findings 4 and 5), and the notification text (finding 3). Together they are under an hour and are the difference between a tool the operator checks and a tool the operator forgets.

## Operator asks the PRD does not account for

- Ask 1, "PRs get picked up and fixed on their own": only PRs born from a Gallivant session are watched. A PR the operator opened by hand, or an old one, has no gallivant block and never enters the loop. Add `gallivant watch <pr url> [--harness claude]`: registers the PR with a fresh session whose first prompt is the PR diff and open review threads. Small, and it is the one command that makes the tool useful on the first night before any PRD exists.
- Ask 1, "opened issues get picked up too": deferred to M3, which is acceptable, but it is the first priority in the operator's list and should be M2, ahead of OpenCode.
- Ask 5, rare notifications: covered for state transitions, uncovered for daemon errors (finding 5) and over-covered by `done` (finding 3).
- Ask 7, "sessions open in iTerm is acceptable" and "command-center could show live sessions": the PRD has the commands but not the rule that attaching pauses watching (finding 6). Without it the first attach breaks a session and the operator concludes the resume story does not work.
- Ask 10, productive in a few hours: `init` as written will not finish in one sitting on this machine because of the APort prompts and the Codex `/hooks` trust step (finding 9).
