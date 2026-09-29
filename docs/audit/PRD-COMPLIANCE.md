# Compliance audit: SPEC.md section 7 against the code on disk

Audited 2026-09-25 against the working tree at `/Users/uchi/Downloads/projects/gallivant` (HEAD `777bede`, plus
uncommitted changes). Read-only: nothing was changed.

Two other agents were editing the tree during this audit. A sources refactor is in flight across `lib/prd.mjs`,
`lib/sources/`, `lib/commands/start.mjs`, `lib/deliverable.mjs`, `lib/fs.mjs`; a web viewer is in flight under
`lib/tracker/` and `lib/commands/serve.mjs`. The suite moved while this was being written: it opened at 143 tests with
one failure (`VERSION is not defined` in `test/deliverable.test.mjs`, in-progress breakage, not a defect) and closed at
189 tests, all passing. Three test files that close gaps this audit was going to report as untested appeared during it,
and are named where they matter. Where a verdict rests on a file that was being edited it says so.

Verdict vocabulary: **MET** means the code does the thing and a named test would fail if it stopped. **MET-UNTESTED**
means the code does the thing and nothing pins it. **PARTIAL** names what is missing. **NOT MET** means the behaviour
is absent or different.

## Summary

36 criteria, reading the 15 user stories as their individual Given/When/Then bullets. One more (US8.2) is an
operational claim about a live APort hook and a real Codex push; no code can satisfy it, so it is reported and not
counted.

| Verdict | Count | Criteria |
|---|---|---|
| MET | 25 | 1.1, 2.1, 3.1, 3.2, 3.3, 4.1, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.3, 7.1, 7.2, 7.3, 8.1, 9.1, 9.3, 9.4, 10.1, 10.2, 12.2, 14.2, 15.1 |
| MET-UNTESTED | 5 | 2.2 (the notification half only), 5.6, 11.1, 13.1, 15.2 |
| PARTIAL | 5 | 4.2, 6.2, 9.2, 12.1, 14.1 |
| NOT MET | 1 | 1.2 |
| Not code | 1 | 8.2 |

The loop itself, which is what the tool is, is in good shape: the tick's state machine, the event rules, the cursor,
the iteration cap, the stall stops and the notification-once property are all implemented and pinned by named tests.
Thirty of 36 criteria are satisfied by code that a test would catch breaking or by code that plainly does the thing.

Where it is weaker, it is weaker in three specific places. The guardrail claims in 6.11 are partly carried by a
passport template that does not match the text (12.1). The spec and the code disagree about edited comments, and the
spec's version is the one the security sign-off credits (9.2). And several config keys, reasons and cursor fields the
code depends on are not in the spec at all, which makes the spec unreliable as a description of the thing on disk
even where the thing on disk is correct.

Coverage moved during this audit. `test/recovery.test.mjs` (13 tests), `test/why.test.mjs` (12) and
`test/status.test.mjs` (14) were written by another agent between 09:08 and 09:11 on 2026-09-25, while this file was
being drafted, and they turn US7, 5.6 and 14.x from untested into tested. The verdicts above reflect the files that
are on disk now. `makeNotifier` and its six-hour error throttle remain the one significant behaviour with no test of
any kind.

## Criterion by criterion

### US1. Kickoff

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1.1 | `start` makes the worktree, registers `running` with a session id, leaves the operator's checkout alone | MET | `lib/commands/start.mjs:41-56` builds `branchFor(id)`, `git.create`, `newEntry(... STATES.running)` with `session` from `adapter.newSession()`. Worktree path is `lib/git.mjs:13` `<worktrees>/<owner>/<repo>/<prd id>`. Test: `test/commands.test.mjs` "start writes the PRD into the fresh checkout, so the branch carries the brief the PR block points at" and "start follows the repo, base branch and relative path the request names". |
| 1.2 | A signed-out harness sends the entry to `needs-human` with reason `not-signed-in` | NOT MET | `lib/commands/start.mjs:35-36` throws `"<harness> is not signed in"` and returns before `state.put`. No entry is created, so there is no entry in `needs-human` and no reason `not-signed-in`. `not-signed-in` is listed as a reason in SPEC 6.6 and appears nowhere in `lib/` except a test fixture (`test/tick.test.mjs:251`). Nothing else is affected, which is the second half of the criterion, but the stated outcome is not what happens. |

Note on 1.1: the worktree path is `<worktrees>/<owner>/<repo>/<prd id>`, three segments. SPEC 6.6, 6.10 and US1 all
write it as `<worktrees>/<repo>/<prd id>`. Harmless, but the spec and the code disagree.

### US2. PR carries its origin

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 2.1 | After a start run with an open PR, the body has a valid block with the registry's session id and the entry is `pr-open` | MET | `lib/tick.mjs:107-121`: `prListByHead`, skip cross-repository, `upsertBlock` when `parseBlock` finds none, then `save(... STATES.prOpen ...)`. Block shape and strict parse in `lib/block.mjs:8-38`. Test: `test/tick.test.mjs` "a start run that opened a PR enters pr-open with the block written and the PR's creation time as the reviewer clock", which matches the exact four-line block including the session uuid. |
| 2.2 | No PR on the branch means `needs-human`, reason `no-pr`, one notification | MET-UNTESTED (notification half) | `lib/tick.mjs:110` `if (!pr) { await needsHuman(id, "no-pr", ...) }`; `needsHuman` at `lib/tick.mjs:38-45` always calls `notify.needs`. Test `test/tick.test.mjs` "a start run with no PR stops with no-pr; a codex start records the thread id" asserts the reason but never looks at `notify.sent`. A test would have to assert `w.notify.sent` deep-equals `[["needs", null, "no-pr"]]` after that tick and stays length 1 on a second tick. The exactly-once property of `needsHuman` itself is pinned by the conflict test, so this is a coverage gap on one branch, not an unverified mechanism. |

### US3. Reviewer findings get fixed and re-reviewed

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 3.1 | A reviewer review with an inline comment resumes the original session in the original worktree with the comment quoted; the push gets a round comment | MET | Dispatch at `lib/tick.mjs:246-250`; resume argv at `lib/harness.mjs:41`; `cwd: entry.worktree` at `lib/tick.mjs:75`; quoting at `lib/prompt.mjs`. Round comment after a push at `lib/tick.mjs:130-140`. Tests: `test/tick.test.mjs` "reviewer findings resume the original session and move the cursor" and "a fix run that pushed posts the round comment, bumps iteration, resets the reviewer wait". |
| 3.2 | The same review on a later tick starts no second run | MET | `cursor.since` plus `cursor.dispatched` in `lib/events.mjs:46`. Test: `test/tick.test.mjs` "the same review on the next tick does not start a second run", plus four cursor-boundary tests at `test/tick.test.mjs:372-455`. |
| 3.3 | A reviewer silent for `rereview_minutes` gets `rereview_comment` once more, never a third time | MET | `lib/tick.mjs:290-296`; `commentOnce` at `lib/tick.mjs:65-70` re-reads GitHub so an interrupted tick does not double-post. Test: `test/tick.test.mjs` "a silent reviewer is nudged once after rereview_minutes and stops after stall_hours", which asserts `nudges().length === 1` twice. |

### US4. Check failures get fixed

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 4.1 | A `failure` check on a head that is not `fixed_sha` resumes the session with the check name and run id | MET | `lib/events.mjs:87-94` gates on `pr.headRefOid !== entry.cursor.checks_sha`; `failingChecks` at `lib/events.mjs:106-118` pulls the name and the Actions run id out of `detailsUrl`. Prompt names them without pasting logs (`lib/prompt.mjs`, pinned by `test/units.test.mjs` "the fix prompt groups inline comments under their review and names checks without pasting logs"). Test: `test/tick.test.mjs` "a failing check on a head the loop itself pushed is dispatched once, then stops with checks-red". |
| 4.2 | A failure on `fixed_sha` dispatches nothing | PARTIAL | The code uses a different cursor than the spec: `cursor.checks_sha` (the head whose failures were already dispatched), not `cursor.fixed_sha` (the head when the last run started). They are set at the same moment on a check dispatch (`lib/tick.mjs:250`) but diverge everywhere else: after a push, `fixed_sha` moves and `checks_sha` does not, and `register`/`reconcile` set them to different values. The behaviour the criterion is reaching for (a known failure is not re-dispatched) holds and is tested; the mechanism the criterion names is not the one in the code. The spec never mentions `checks_sha`, which is the substantive divergence. See the divergence list. |

### US5. The loop stops with a reason

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 5.1 | `iteration == max_iterations` plus an event gives `needs-human`, reason `iterations`, label set, one notification, no run | MET | `lib/tick.mjs:167` `fixOrStop`. Label in `needsHuman` at `lib/tick.mjs:42`. Test: `test/tick.test.mjs` "the iteration cap stops the loop before a run starts" asserts `runner.started.length === 0`, the reason, and `notify.sent.length === 1`. |
| 5.2 | `mergeable: CONFLICTING` gives reason `conflict`, one notification | MET | `lib/tick.mjs:222`. Test: `test/tick.test.mjs` "conflict, merged and closed are terminal", which also asserts the second tick sends nothing more. |
| 5.3 | A run past `run_timeout_minutes` is killed, reason `timeout`, one notification | MET | `lib/tick.mjs:96-101`, `runner.kill(cur.id)`. Test: `test/tick.test.mjs` "a run past the timeout is killed and the entry stops". The kill is `runner.kill`; `lib/run.mjs` is what decides whether that is a process-group kill. |
| 5.4 | A run that ended without moving the head gives `no-push` or `harness-error`, one notification | MET | `lib/tick.mjs:142`, chosen by `outcome.ok`. Test: `test/tick.test.mjs` "a fix run that did not push stops with no-push; a failed run stops with harness-error", which asserts `notify.sent` deep-equals one entry and the label was added. |
| 5.5 | No reviewer review for `stall_hours` after the last request gives reason `reviewer-silent`, one notification | MET | `lib/tick.mjs:289`. Test: `test/tick.test.mjs` "a silent reviewer is nudged once after rereview_minutes and stops after stall_hours" asserts the reason. The notification is not asserted on this branch, but `needsHuman` is the single path and its exactly-once behaviour is pinned by 5.1, 5.2 and 5.4. |
| 5.6 | `gallivant why <handle>` shows the reason, the dispatched event, the harness's last message and APort denials in the run window | MET-UNTESTED | `lib/commands/why.mjs:18-32` prints all four: state plus reason, `last.event`, `outcome.lastMessage` (parsed from JSONL by the adapter, not raw JSON), `outcome.denials`, and `auditEntries(aportDir, { fromMs: job.startedAt, toMs: job.endedAt })` filtered to `/allow=false\|den\|block\|warn/i`. No test imports `lib/commands/why.mjs`. A test would have to seed a registry entry, a run folder with claude JSONL and a fake APort audit file, then assert the rendered string carries the reason, `last.event`, the assistant text (and not the JSON envelope), and one audit line inside the window while excluding one outside it. |

### US6. Ready for a human

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 6.1 | Green checks plus a reviewer whose latest review after the last request is neither `CHANGES_REQUESTED` nor carrying a `blocking_pattern` inline comment sets the `gallivant:ready-for-human` label and sends one notification with the PR link | MET | `lib/tick.mjs:259-282`; `reviewerVerdict` at `lib/events.mjs:131-144`; `isGreen` at `lib/events.mjs:121-124` accepts `SUCCESS`, `NEUTRAL`, `SKIPPED`. Link is `entry.url` in `lib/notify.mjs:16`. Tests: `test/tick.test.mjs` "green checks and a clear reviewer make it ready, once, with a label" (asserts label, one notification, and that a second tick adds none) and `test/events.test.mjs` "reviewer verdict: waiting, blocking by state, blocking by pattern, clear, none". |
| 6.2 | `reviewer: null` plus green checks means `ready-for-human` after the first push, no reviewer wait | PARTIAL | The no-reviewer half works: `reviewerVerdict` returns `"none"` and `lib/tick.mjs:262` accepts it. "After the first push" does not: with an empty `statusCheckRollup` the code holds the entry for `checks_grace_minutes` (default 5, `lib/config.mjs:26`) via `checksSettled` at `lib/tick.mjs:196-201`, and then also runs the completion gate, which can start a receipt round instead. The pinning test says so in its own name: `test/tick.test.mjs` "no checks at all is green only after the grace window". The grace window is defensible (an empty rollup seconds after a push means "not reported yet"), but `checks_grace_minutes` is not in SPEC 6.3 and SPEC 6.8 step 7 says flatly that an empty rollup counts as green. |
| 6.3 | A `ready-for-human` PR returns to `pr-open` on a trusted inline comment or `@gallivant fix` and dispatches; a plain issue comment does nothing | MET | `lib/tick.mjs:241` dispatches from any state that reaches it, and `dispatch` sets `STATES.prOpen` and removes the ready label at `lib/tick.mjs:180`. `@gallivant fix` matching at `lib/events.mjs:10,83`; plain comments never match. Tests: `test/tick.test.mjs` "a ready PR reopens on a trusted inline comment and drops the label"; `test/events.test.mjs` "@gallivant fix from a trusted author is a command; own markers, bots and strangers are skipped" and "trusted human inline comment and CHANGES_REQUESTED dispatch; plain comments do not". |

### US7. Recover from GitHub

Recovery is covered by `test/recovery.test.mjs`, which a concurrent agent added during this audit (file timestamp
09:08 on 2026-09-25). It passes. Verdicts here are against that file.

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 7.1 | With `state.json` gone, three open operator PRs on `gallivant/*` with valid blocks are all registered, `iteration` equals the round-comment count, and nothing older than the daemon's last own comment is re-dispatched | MET | `lib/commands/up.mjs:34-69`: `prListMine` per repo, skip cross-repository and non-`gallivant/` branches, `parseBlock`, `countRounds(comments, ownLogin)`, `cursor.since = later(lastOwn, headDate ?? pr.createdAt)`. `countRounds` at `lib/events.mjs:157-161` counts round markers since the last reset marker. Tests: `test/recovery.test.mjs` "an open PR of ours with a valid block is adopted with its identity taken from the block and the PR", "the recovered iteration is the count of our own round comments since the last reset comment", "the recovered cursors sit at the head and the last own comment, so no history is replayed". |
| 7.2 | A block naming a non-uuid session, or a fork head, is logged and not registered | MET | `lib/block.mjs:12` uuid rule; `lib/commands/up.mjs:41` skips `isCrossRepository`. Test: `test/recovery.test.mjs` "a PR whose head is on a fork is ignored" and "a PR with a missing or malformed block is ignored and the reason is logged", whose table includes `invalid session: not-a-uuid`. |
| 7.3 | A registered PR whose worktree is missing has it recreated from the PR branch at the recorded path before the next run | MET | `ensureWorktree` at `lib/tick.mjs:55-57` is called at the top of `dispatch` (`lib/tick.mjs:178`), so it runs before every spawn. `git.fromBranch` clones the PR branch at the recorded `entry.worktree`. Tests: `test/tick.test.mjs` "with no events to bound it, the cursor moves to the time captured before the reads, not after the spawn" drives `git.exists: () => false` through `fromBranch`; `test/units.test.mjs` "fromBranch reuses an existing checkout only when origin is exactly the repo" pins the clone-or-reuse decision. |

What recovery does **not** rebuild, against SPEC 6.6's field list: `receipt_hash` is set to `null`
(`lib/commands/up.mjs:60`) rather than hashed from the PR body, so on the first fix round after a boot a receipt
already in the body reads as "the receipt changed" and can be credited as progress that did not happen. `reason` is
reset to `null` for every recovered PR, so a PR the previous daemon stopped for `conflict` comes back as `pr-open`
and is re-evaluated. Both are minor and arguably right, but neither is what SPEC 6.6 describes.

### US8. Both harnesses

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 8.1 | `harness: codex` starts with `codex exec` and the 6.7 flags, records the thread id from `thread.started`, and resumes with `codex exec resume <id>` and the same `-c` overrides in the worktree. Same for claude with `--session-id` and `--resume` | MET | `lib/harness.mjs:12-17` (`CODEX_OVERRIDES`), `:64-65` (start and resume argv), `:67` (`thread.started` -> `thread_id`), `:40-41` (claude `--session-id` / `--resume`), `:105` (`cwd` is the worktree via `startRun`). Tests: `test/units.test.mjs` "harness argv: claude resumes with --settings and no dangerous flags; codex resumes with -c overrides"; `test/tick.test.mjs` "a codex fix resumes with exec resume and the config overrides"; `test/tick.test.mjs` "a start run with no PR stops with no-pr; a codex start records the thread id" pins the thread-id capture. |
| 8.2 | A Codex run that pushes with the APort hook in warn mode leaves audit entries and the push goes through | Out of scope for code | This is an operational claim about a real Codex run against a real APort hook. Nothing in the tree can satisfy or refute it. `doctor`'s `codex hook` check (`lib/commands/doctor.mjs:148-157`) verifies the hook is wired into `~/.codex/hooks.json` and reports the enforcement mode, and `lib/aport.mjs:40-54` reads the audit log, which is as far as code can go. Not counted in the verdict totals. |

Argv diff against the SPEC 6.7 table, both for the record: the Claude commands add `--verbose` (`lib/harness.mjs:22`),
which the table does not list, and put `--session-id`/`--resume` before `-p` rather than after. Both are harmless; the
table is the thing that is out of date. The Codex commands match the table exactly, `--skip-git-repo-check` included.

### US9. Untrusted and self-generated input is ignored

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 9.1 | A comment from a login outside `trusted_authors` and not the reviewer dispatches nothing | MET | `lib/events.mjs:18-20` `makeTrust`: `isTrusted` requires membership **and** `!bot`, `isReviewer` requires `bot` and an exact login match. Gates at `lib/events.mjs:60-61,75,83`. Test: `test/events.test.mjs` "approvals, untrusted authors and own replies never dispatch". |
| 9.2 | A trusted comment edited after posting, **or** a comment created while a run was in progress, dispatches nothing | PARTIAL | The during-a-run half holds: `settleRun` returns `true` while a run is alive and `tickEntry` returns immediately (`lib/tick.mjs:99,205`), so nothing is read, let alone dispatched, while a run is up. The edited half is **deliberately inverted**. `lib/events.mjs:41` says so in the source: "Editing an item later does not make it new again: the comparison is on `created_at`, never on `updated_at`." A comment created after the cursor and then edited **is** dispatched, and `test/events.test.mjs` "an edited comment is new when it was created after the cursor, and not when it was only edited after it" asserts exactly that, as does the `edited: true` row in the `@gallivant fix` test. The code's rationale is sound (an editor typo-fixing their own fresh comment should not silence it), but SPEC 6.8 step 5 and US9 both say edited comments are skipped, and the security-engineer audit credits this as an applied fix. The spec is wrong or the code is; they cannot both stand. |
| 9.3 | The daemon's own round comment and the harness's inline replies dispatch nothing | MET | Markers at `lib/events.mjs:24,81`; own inline replies at `lib/events.mjs:74` (`in_reply_to_id` set **and** `trust.isOwn`). Tests: `test/events.test.mjs` "approvals, untrusted authors and own replies never dispatch" (id 12, reply by `me`) and "@gallivant fix from a trusted author is a command; own markers, bots and strangers are skipped". |
| 9.4 | An injection-carrying trusted comment reaches the harness inside a fenced block, and a push to the default branch is rejected by the ruleset | MET (code half) | `lib/prompt.mjs:8-11`: four-backtick fence, internal `````+` runs collapsed to three so the quote cannot be closed, capped at 4,000 characters. Test: `test/units.test.mjs` "quoted feedback cannot close its fence and is capped". The ruleset half is GitHub-side; the code contributes `rulesetBody()` (`lib/commands/doctor.mjs:183-188`, with `deletion`, `non_fast_forward` and `bypass_actors: []`) and a `doctor` check per repo in `repos` (`lib/commands/doctor.mjs:164-169`). That check only asserts *some* ruleset is `enforcement: "active"`; it never verifies the ruleset targets the default branch or blocks force pushes, so an unrelated active ruleset passes it. |

### US10. Hand-started sessions join the loop

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 10.1 | `register <pr-url> --harness claude --session <uuid> --worktree <dir>` makes the next qualifying event resume that session in that directory | MET | `lib/commands/register.mjs:38` refuses `--session` without a worktree, `:40` verifies the checkout is the same repo on the PR branch, `:63` stores both; `lib/tick.mjs:72-73` resumes when `entry.session` is set, with `cwd: entry.worktree`. Tests: `test/commands.test.mjs` "an explicitly supplied --worktree is accepted only when it is the same repo on the PR's branch", "a --worktree pointing at another repository, another branch, or nothing at all is refused" (six cases), "a relative --worktree is resolved against the calling directory before it is checked or stored". |
| 10.2 | `register <pr-url>` with no session makes the first fix run start a new session that reads the PR and pushes | MET | `lib/tick.mjs:72-74`: with no session the prompt is `registerPrompt` prepended to `fixPrompt`, and `startRun` (`lib/tick.mjs:71`) picks `mode: "start"` with a fresh uuid. `registerPrompt` (`lib/prompt.mjs:35-41`) tells it to run `gh pr view` and `gh pr diff`, and the shared `RULES` say to commit and push to this branch. Test: `test/tick.test.mjs` "a registered PR without a session starts a fresh session that reads the PR first", which asserts `--session-id` is in the argv and the prompt matches `/taking over pull request #142/`. |

### US11. No permission prompts

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 11.1 | With `doctor` passing, a fix run completes with no prompt, and the Claude `result` event has an empty `permission_denials` or the denials show in `why` | MET-UNTESTED | `--permission-prompts none` is unconditional in `claudeCommon` (`lib/harness.mjs:20`), so nothing can prompt. Denials are parsed at `lib/harness.mjs:52` and printed by `why` at `lib/commands/why.mjs:26`. `doctor --probe` runs a real Claude process that must write inside and be denied outside (`lib/commands/doctor.mjs:191-216`) and reports the `permission_denials` blob it found. Nothing tests the `why` rendering of denials. A test would have to feed `why` a run folder whose JSONL `result` event carries a `permission_denials` entry and assert the rendered text contains a "permission denials:" section naming the tool. |

### US12. Guardrails hold where they apply

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 12.1 | A Claude Write outside the worktree, or a Read on `.env`, is denied by APort; the run continues; the denial is in the audit log | PARTIAL, and untestable from the tree | The write half is what `doctor --probe` actually exercises, and it exercises it well: `probeRun` (`lib/commands/doctor.mjs:191-216`) prompts a real Claude run to write inside and outside, then distinguishes three failure modes ("the hook never ran", "the hook ran and a hosted passport allowed it", "the hook ran and the local passport allowed it") using the audit log. The read half is not probed at all. And `templates/passport.gallivant.json` does not carry everything SPEC 6.11 claims: `data.file.read.blocked_paths` covers `.env*`, `.ssh`, `.aws`, `.gallivant`, `.config/opencode` and `auth.json`, but **not** `*.pem` or `*.key`, which 6.11 names explicitly, and not `~/.claude` or `~/.codex` (those are write-blocked only, so a run can read its own guardrail config even though 6.11 says `blocked_paths` "for both read and write" cover the control plane). `doctor`'s passport check (`lib/commands/doctor.mjs:134-139`) validates only `data.file.write`, so it would pass a passport with no read limits at all. |
| 12.2 | A `git push --force origin main` through Bash is rejected by the ruleset, the run continues, and the APort log shows the Bash call plus, if the literal pattern matched, the denial | MET (code half) as far as code reaches | `blocked_patterns` in `templates/passport.gallivant.json` covers `push --force`, `push -f`, `push origin main`, `push origin master`, `HEAD:main`, `HEAD:master`, plus extras the spec does not list (`--force-with-lease`, `--no-verify`, `sudo`, `gh auth token`, `security find-`, `launchctl`, `printenv`). The ruleset half is the `doctor` check discussed under 9.4, which is weaker than the spec's wording. `lib/aport.mjs:40-54` reads the audit log for `why`. Nothing here can be tested without a live hook. |

### US13. Someone else can install it

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 13.1 | On a fresh Mac with `gh`, `jq`, Node 22 and one harness, a new user follows `doctor` to a clean pass, `status` prints an empty table with no error, and nothing in the repo or the defaults refers to the author | MET-UNTESTED | `lib/config.mjs:22-42` `DEFAULTS` holds nothing machine-specific: `trusted_authors: []`, `worktrees: null`, `harness: {}`, `github_token_file: null` all force an explicit value, and `validate` (`lib/config.mjs:61-85`) rejects each empty one by name. `suggestedConfig` (`lib/commands/doctor.mjs:35-50`) fills every value from `gh api user` and `zsh -lc 'whence -p ...'` on the running machine. A grep for `uchi` across `bin/`, `lib/`, `templates/` and `package.json` finds only the repository URL in `package.json:15`, which is correct. `status` with an empty registry renders the header plus two `(none)` sections (`lib/commands/status.mjs:45-55`) and is pinned for structure by `test/status.test.mjs`, but the criterion's own condition, "no error", is exit 1 when no daemon is alive (`lib/commands/status.mjs:62`), which is the behaviour US14 demands. The two criteria read as if they contradict; in practice `status` on a fresh install prints "daemon DOWN" and exits 1. A test would have to run `doctor` end to end on a clean `GALLIVANT_HOME` and assert every FAIL line carries a fix string, which is most of what is not covered here. |

The default `reviewer.login` is `chatgpt-codex-connector[bot]` (`lib/config.mjs:33`). That is a product default the spec
prescribes in 6.3, not an author-specific one, so it is fine.

### US14. Status without a UI

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 14.1 | With the daemon running, `status` shows a health header and the sections needs-you, running, queued, each row with a handle | PARTIAL | Header and the first two sections are there: `lib/commands/status.mjs:38-55` renders daemon liveness, probe states, next-tick countdown, latest error, then `NEEDS YOU` and `RUNNING`, with `handleFor(id, e)` first on every row. There is **no queued section**. SPEC 6.12's sample output has a third `QUEUED` block listing ready PRDs not yet started, and `lib/commands/status.mjs` renders only `needs_you`, `running` and (behind `--all`) `done`. The registry has no concept of a queued PRD, which is consistent with SPEC 6.4 putting the ready-PRD queue in M2, so this is the spec's sample output overreaching what M1 builds. Tests: `test/status.test.mjs` "the rendered text carries each entry's handle, label and round, under the section it belongs to" and six row-classification tests. |
| 14.2 | A stopped daemon makes the first line say so and the exit code 1 | MET | `lib/commands/status.mjs:38` and `:62`; liveness is `process.kill(pid, 0)` through `alive()` (`lib/commands/up.mjs:19`), not the file's own claim. Tests: `test/status.test.mjs` "a daemon file left behind by a dead process reports dead, because liveness is asked of the operating system", "a down daemon is the first thing the text says, with the command that starts one", "status exits 1 when no daemon is alive and 0 when one is, so a shell can tell". |

### US15. Rare notifications

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 15.1 | A night with four PRs (two `ready-for-human`, one `needs-human`, one merged) sends exactly three notifications | MET, by parts, not as a scenario | The claim decomposes into three guards and each is pinned. `ready` notifies once because `lib/tick.mjs:258` returns early for any state that is not `pr-open`, so an entry already `ready-for-human` never re-enters the branch: `test/tick.test.mjs` "green checks and a clear reviewer make it ready, once, with a label" ticks twice and asserts `notify.sent.length === 1`. `needs-human` notifies once because `lib/tick.mjs:220` returns before every notifying branch once the state is `needs-human`: `test/tick.test.mjs` "conflict, merged and closed are terminal" ticks twice and asserts the same. A merged PR notifies nothing because `lib/tick.mjs:219` saves `done` and returns before any `notify` call: the same test asserts `notify.sent.length === 0` for `MERGED` and `CLOSED`. So the arithmetic in US15 is 1 + 1 + 1 + 0 = 3 and each term is tested. No test walks four entries through one tick loop and counts, so the composed claim rests on the three parts rather than on a scenario. One real path can raise the count above three that the criterion does not consider: a receipt round from the completion gate can take an entry from `pr-open` to `needs-human` with reason `iterations` on the way to ready, which is a fourth notification with the same four PRs. That is gate behaviour SPEC 7b introduced after US15 was written. |
| 15.2 | `gh` auth expiring at 02:00 sends one `gallivant: gh not authenticated` message and none again before 08:00 | MET-UNTESTED | `lib/commands/up.mjs:94-97`: `probeAll` runs before every tick, and while any probe fails the tick is skipped and `notify.error("<probe> not ready", FIX[...])` is called for each failing probe. `notify.error` (`lib/notify.mjs:49-55`) keys a throttle file on the class string and returns false inside six hours (`ERROR_THROTTLE = hours(6)`, `lib/notify.mjs:7`). The class string is `"gh not ready"`, not the spec's `"gh not authenticated"`, so the title reads `gallivant: gh not ready`. Nothing tests `makeNotifier` at all: `test/units.test.mjs` covers only `messages`, the pure text shapes. A test would have to call `notify.error("gh not ready", "...")` twice with a fake clock and a temp home, assert one `fetch` with `Title: gallivant: gh not ready` and `Priority: high`, advance under six hours and assert no second `fetch`, advance past six hours and assert a second one. It should also assert `Email` is attached only when `config.notify.email` is set, which is the only place SPEC 6.3's `notify.email` promise is kept. |

## Spec promises absent from, or different in, the code

Ordered by how much they would matter to an operator who read the spec and expected it.

1. **`not-signed-in` never happens.** SPEC 6.6 lists it as a reason and US1 says a signed-out harness puts the entry
   in `needs-human` with that reason. `lib/commands/start.mjs:35-36` throws before `state.put`, so no entry exists to
   carry the reason. The string appears in `lib/` nowhere. Either drop it from 6.6 and rewrite US1's second criterion
   as "start refuses and records nothing", or make `start` record the entry first.

2. **Edited comments are dispatched, not skipped.** SPEC 6.8 step 5 and US9 both say a comment whose `updated_at`
   differs from `created_at` never dispatches, and the security-engineer sign-off in section 13 lists the
   "edited-comment skip" as applied. `lib/events.mjs:41,46` compares `created_at` only, by design, and
   `test/events.test.mjs` asserts the opposite of the spec. This is the one divergence where the spec claims a
   security control the code does not implement. Pick one and change the other.

3. **The reviewer-silence and ready paths run on more than four GitHub calls, and `reviews` is unfiltered.**
   SPEC 6.8 step 2 says "Fetch, four calls" and the rate note computes 2,400 calls an hour from it. The tick actually
   issues `prView`, `reviews` (`--paginate`, no `since`, so one call per 100 reviews), `inlineComments`,
   `issueComments`, plus `commitDate` whenever the rollup is empty (`lib/tick.mjs:198`) and `prDiff` whenever the
   completion gate runs with `scan_output` (`lib/tick.mjs:268`). That is five or six on the path to ready, not four.
   The limit is still not close, but the number in the spec is wrong and `reviews` growing without bound on a
   long-lived PR is the part worth noting.

4. **`checks_grace_minutes` is undocumented and contradicts 6.8 step 7.** The spec says an empty `statusCheckRollup`
   counts as green. `lib/tick.mjs:196-201` holds the entry for `config.checks_grace_minutes` (default 5,
   `lib/config.mjs:26`) when the rollup is empty and the head is young. The key is in neither the 6.3 config block nor
   section 9's config check list.

5. **Two reasons the spec's list does not have.** SPEC 6.6 enumerates `conflict`, `iterations`, `timeout`,
   `harness-error`, `no-push`, `no-pr`, `reviewer-silent`, `not-signed-in`. The code also produces
   `reviewer-blocking` (`lib/tick.mjs:284`) and `checks-red` (`lib/tick.mjs:294`). Both are sensible stops that the
   spec's state machine has no exit for: the diagram loops forever on a blocked reviewer with no new event.

6. **`status` has no QUEUED section.** SPEC 6.12's sample output shows three sections and names the third.
   `lib/commands/status.mjs` renders two plus `--all` DONE. Consistent with the PRD queue being M2, but the sample
   output in 6.12 is presented as M1's.

7. **Doctor's ruleset check is weaker than section 9 describes.** Section 9 says the check confirms "a ruleset on the
   default branch blocking updates and force pushes". `lib/commands/doctor.mjs:166-167` asserts only that some
   ruleset on the repo has `enforcement: "active"`. An active ruleset on a release branch passes it. The fix command
   it prints is correct; the verification is not.

8. **Doctor has no argv-safety line.** Section 9 lists "Argv safety: no `--dangerously-*` in either resolved argv" as
   a check. `assertSafeArgv` (`lib/harness.mjs:89-93`) enforces it at spawn time and `test/units.test.mjs` pins it,
   but `doctor` never prints a line for it, so a reader following section 9 will look for a check that is not there.

9. **The passport's read blocks do not match 6.11.** 6.11 says APort denies reads on `.env*`, `.ssh`, `.aws`,
   `*.pem`, `*.key` plus the passport's extras, and that `blocked_paths` cover the control-plane directories "for both
   read and write". `templates/passport.gallivant.json` has no `*.pem` or `*.key` under `data.file.read`, and
   `~/.claude` and `~/.codex` are write-blocked only, so a run can read its own hook configuration. `doctor`'s
   passport check validates `data.file.write` only (`lib/commands/doctor.mjs:134-139`), so it cannot catch this.

10. **Claude sign-in is checked differently than section 9 says.** Section 9: "Claude: `claude -p "echo ok"` in a temp
    dir exits 0". The adapter uses `claude auth status` and greps for `"loggedIn": true` (`lib/harness.mjs:57`). The
    adapter's version is faster and cheaper and arguably better, but it tests a different thing (a valid credential,
    not a working inference round trip) and the daemon calls it before every tick (`lib/probe.mjs:38`).

11. **The error class string is not the one in 6.12.** 6.12's example is `gallivant: gh not authenticated`.
    `lib/commands/up.mjs:97` builds the class as `` `${k} not ready` ``, so the title is `gallivant: gh not ready`.
    Cosmetic, but US15's second criterion quotes the spec's string.

12. **Recovery does not restore `receipt_hash` or preserve `reason`.** Noted in full under US7 above.

13. **`worktrees` path shape.** Code: `<worktrees>/<owner>/<repo>/<prd id>` (`lib/git.mjs:13`). Spec, in 6.6, 6.10,
    6.12 and US1: `<worktrees>/<repo>/<prd id>`. The code's version is the right one (two repos named `widget` under
    different owners would collide otherwise); the spec should be fixed.

## Code behaviour the spec never describes

1. **The completion gate is much larger than 6.8 step 7b.** `lib/deliverable.mjs` is 232 lines implementing a local
   rule engine plus a hosted APort evaluator (`evaluator`, `api_url`, `on_unreachable`, `require_summary`,
   `min_summary_words`, `require_tests_passing`, `scan_output`, `blocked_patterns`), a per-task passport, a receipt
   hash, a receipt-round prompt, and a pending state that holds the entry across ticks when APort is unreachable
   (`lib/tick.mjs:270`). SPEC 6.8 7b describes the shape of the receipt and says `deliverable: null` disables it; the
   eight-key config object, the two evaluators, the wait-versus-local outage policy and `receipt_hash` as a fourth
   cursor are all new. Well tested (`test/deliverable.test.mjs`, 20 tests), entirely undocumented in 6.3.

2. **`gallivant serve`.** A read-only localhost web viewer (`lib/commands/serve.mjs`, `lib/tracker/`,
   `templates/tracker/`, `test/tracker.test.mjs`) with SSE log streaming, CSP headers and escaping. SPEC 6.13 says
   "Gallivant has no UI code" and that any UI reads `status --json` and shells out to the CLI. This is in flight from
   another agent as of this audit, so it is a spec question to settle, not a defect.

3. **`gallivant remove`.** In the CLI (`bin/gallivant.mjs:70`) and the README, in no section of the spec.

4. **`gallivant ready` is built.** SPEC 6.10 lists it under "Later" and section 8 puts it in M2. It exists
   (`lib/commands/ready.mjs`, `lib/prd.mjs`, `lib/deliverable.mjs` `decidePrdReady`) with 20-plus tests. The spec's
   6.4 does describe its contract, so this is a milestone-table lag, not an undescribed behaviour.

5. **The `gallivant:needs-human` label.** `lib/gh.mjs:13` defines it and `needsHuman` sets it on every stop
   (`lib/tick.mjs:42`). The spec only ever names `gallivant:ready-for-human`. Labels are also created per repo on
   first watch via `ensureLabels` (`lib/gh.mjs:99`), which the spec does not mention.

6. **A reset comment marker.** `RESET_MARKER` (`lib/gh.mjs:11`) is posted by `register` on an existing entry
   (`lib/commands/register.mjs:56`) so `countRounds` can find the reset boundary during recovery
   (`lib/events.mjs:159`). SPEC 6.8 step 10 describes the reset but not that it leaves a comment, and 6.5's "iteration
   is recovered by counting round comments" does not mention the reset boundary that makes the count correct.

7. **A receipt-only round counts as a round and posts its own comment.** `lib/tick.mjs:130-140` treats a changed
   `receipt_hash` with no push as progress, posts `receiptRoundComment()` ("Completion receipt updated.") with the
   round marker, and increments `iteration`. 7b says a receipt-only round counts against `max_iterations` "without a
   re-review request", which it honours, but does not say it posts a comment or that the round marker is what makes
   the recovered count include it.

8. **`cursor.dispatched` and `cursor.checks_sha`.** SPEC 6.6 shows a two-field cursor (`since`, `fixed_sha`). The code
   carries four plus `dispatched`: `since`, `dispatched` (event keys handled at the boundary second),
   `fixed_sha`, `checks_sha`, `receipt_hash`. `dispatched` exists because GitHub timestamps are second-precision and
   the comparison had to become inclusive (`lib/events.mjs:36-39`, `lib/state.mjs:96-109`). This is careful work,
   pinned by five tests at `test/tick.test.mjs:322-455`, and it is the single biggest gap between 6.6 and the code.

9. **Per-entry concurrency of four.** `CONCURRENCY = 4` (`lib/tick.mjs:23`) walks the registry four entries at a time
   with a shared queue. SPEC 6.8 says "one pass over the registry, in this order, for each entry" and the
   staff-engineer sign-off credits a "single-actor tick". Entries are independent and the registry serialises writes
   under a lock (`lib/state.mjs:38-52`), so this is safe, but it is not what the spec says.

10. **A `PENDING` review is excluded from the verdict.** `lib/events.mjs:133`. Correct, undocumented.

11. **A review naming an older commit does not clear the head.** `reviewedCommit` parses `**Reviewed commit:** \`sha\``
    out of the review body (`lib/events.mjs:146`). SPEC 6.8 step 2 says Codex names the commit it reviewed and that an
    older review never clears the current head, so the behaviour is specified; the exact string the parser depends on
    is not, and a Codex wording change would silently turn every review into `waiting`.

12. **`GALLIVANT_HOME`.** `gallivantHome()` in `lib/fs.mjs` reads an environment variable the spec never mentions
    (the spec hardcodes `~/.gallivant` everywhere). The CLI help line in `bin/gallivant.mjs:29` documents it.

13. **A daemon health file.** `~/.gallivant/daemon.json` (`lib/commands/up.mjs:15-20`) holds the pid, start time, last
    and next tick, probe results and last error, and `status` reads it. SPEC 6.10 says the daemon "holds a pidfile
    under `~/.gallivant`"; this is a pidfile plus the whole status header's data.

14. **`caffeinate` is spawned by the daemon itself.** `lib/commands/up.mjs:113-116`. The spec tells the operator to
    run the daemon under `caffeinate -i` by hand, in 6.1, 6.2 and the day-one table.

## What would have to change to claim the spec is met

Five code changes and one decision. The decision comes first because two of the code changes depend on it.

**Decide the edited-comment rule (9.2).** The spec says an edited comment never dispatches. The code says a comment
created after the cursor dispatches whether or not it was edited, and has a test asserting that. The spec's rule is
the safer one against a trusted account whose comment is rewritten after the daemon has read the PR but before it has
dispatched; the code's rule is the kinder one to an operator fixing a typo. If the spec wins, add
`c.updated_at === c.created_at` to `isNew` in `lib/events.mjs:46` and invert the two assertions in
`test/events.test.mjs` "an edited comment is new when it was created after the cursor...". If the code wins, delete
the rule from SPEC 6.8 step 5 and US9's second bullet, and strike it from the security-engineer row in section 13,
because that row currently claims a control that does not exist.

**Make `not-signed-in` real, or delete it (1.2).** One `state.put` before the sign-in probe in
`lib/commands/start.mjs`, followed by `needsHuman`, or five words removed from SPEC 6.6 and US1. Deleting it is
probably right: an entry in `needs-human` with no PR and no worktree is a row in `status` that the operator can do
nothing with except re-run `start`, which is what the thrown error already tells them.

**Fill in the passport's read limits (12.1).** Add `**/*.pem`, `**/*.key`, `{{home}}/.claude/**` and
`{{home}}/.codex/**` to `data.file.read.blocked_paths` in `templates/passport.gallivant.json`, then extend `doctor`'s
passport check (`lib/commands/doctor.mjs:120-141`) to validate `data.file.read` the way it already validates
`data.file.write`. Without the second half the template can drift again and nothing notices. A read probe in
`probeRun` (write a `.env` in the temp dir, ask the run to read it, assert it was denied) would close the other half
of 12.1, and is maybe fifteen lines.

**Tighten `doctor`'s ruleset check (9.4, and section 9's own text).** `lib/commands/doctor.mjs:166` should look at the
matching ruleset's `conditions.ref_name.include` for `~DEFAULT_BRANCH` and its `rules` for `non_fast_forward`, not
just at `enforcement`. Two lines of filtering. As it stands the check can pass on a repo with no default-branch
protection at all, which makes US9's last bullet and US12's second bullet rest on nothing the tool verified.

**Test `makeNotifier` (15.2, 2.2).** One file, six assertions: the two headers and the `Email` header only when
configured, one message inside six hours, a second after. This is the last behaviour in the tool with no test, and it
is the one the operator notices first when it breaks, because the failure mode is silence.

**Then reconcile the spec with the code.** The divergence lists above are thirteen spec edits and fourteen additions,
none of them large. The ones that change what an operator can predict are `checks_grace_minutes` (a PR with no CI is
not ready for five minutes, and the spec says it is ready at once), the two extra reasons (`reviewer-blocking` and
`checks-red` are stops the spec's state diagram has no arrow for), the real per-tick call count, and the completion
gate's eight config keys. The worktree path shape (`<owner>/<repo>/<prd id>`) should be corrected in the spec rather
than the code.

Nothing in this list is architectural. The tick, the cursor and the event rules are the hard parts and they are
right.
