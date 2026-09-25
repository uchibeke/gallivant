# Staff Engineer audit of Gallivant PRD 0.2

Persona: staff-engineer. Reviewed 2026-09-23 against the PRD, the audit brief, command-center on disk, the aport-agent-guardrails repo on disk, and `--help` output from Claude Code 2.1.263, Codex 0.155.1 and OpenCode 1.18.31 on this Mac.

## 1. Verdict

Approve with changes. The shape is right (poll `gh`, resume by session id, APort hooks, ntfy, launchd, no server) but the Codex command lines in the PRD do not run on the installed version, the APort Codex hook will deny ordinary Codex edits in enforce mode, and the state model has roughly twice the moving parts it needs. Fix those on paper before the first line of code, and M1 fits in three hours.

## 2. Findings

### F1. Blocker. Sections 6.3, 6.7. The Codex commands do not work on 0.155.1.

`codex exec --full-auto` fails with `error: unexpected argument '--full-auto' found`. I ran it. `codex exec --help` offers `-s/--sandbox`, `--approve-for-me` and `-c key=value`; `codex exec resume --help` offers `--json` and `-c` but neither `-s` nor `--approve-for-me`. So the start and resume commands need different flags unless you use config overrides, which both accept.

Change: replace the Codex rows in 6.3 and 6.7 with `codex exec --json -c approval_policy="never" -c sandbox_mode="workspace-write" "<prompt>"` and `codex exec resume <id> --json -c approval_policy="never" -c sandbox_mode="workspace-write" "<prompt>"`. Or set those two keys in `~/.codex/config.toml` (section 9 already says to) and pass only `--json`. Add to M0: confirm that `git push` works from a Codex workspace-write sandbox, because that sandbox turns off network by default and needs `[sandbox_workspace_write] network_access = true`. Also update the brief's "verified environment facts", which repeat the bad flag.

### F2. Blocker. Section 6.11. APort's Codex hook in enforce mode will block normal Codex work, and the passport is global per harness, not per Gallivant.

`docs/frameworks/codex.md` says the beta hook fails closed on `apply_patch` payloads touching more than one file and on `Glob`, `List` and `LS`. A Codex session fixing a review will hit both within minutes. Separately, the Claude Code passport lives at `~/.claude/aport/passport.json` and the hook is registered with matcher `*` in `~/.claude/settings.json`, so the "writes only inside the worktree" policy in 6.11 would also apply to the operator's own interactive sessions in every repo.

Change: Codex starts in `--enforcement=warn` on day one and stays there until the multi-file patch case is fixed in APort (the operator owns that repo; file it there). Rewrite the passport paragraph: one passport per harness shared by daemon and interactive use, with `limits.data.file.write.allowed_paths` covering the projects root and the worktrees root, `blocked_paths` for `.env*` and key files, and `system.command.execute.blocked_patterns` including `git push --force` and `git push origin main`. Enforce mode for Claude Code is fine because that hook is released. Note that neither hook is installed yet (`~/.claude/aport` and `~/.codex/hooks.json` are absent), so M0 is real work, not a checkbox.

### F3. Major. Sections 6.7, US11. Headless Claude Code can still block on a prompt.

`--permission-mode auto` decides most calls but anything it will not decide goes to a prompt, and under `-p` with no host that hangs until the 30-minute timeout. Claude 2.1.263 has `--permission-prompts none`: "anything that would prompt is denied automatically; the permission mode still decides everything else".

Change: the Claude argv becomes `claude -p --session-id <uuid> --output-format stream-json --permission-mode auto --permission-prompts none --max-budget-usd <n> "<prompt>"`. State in US11 that a denied prompt shows up as `permission_denials` in the final `result` event and counts as a failed round, not a hang. Add `--max-budget-usd` to config; it is the cheapest runaway guard you will get.

### F4. Major. Section 6.8. The harness and the trusted human are the same GitHub login, so "never dispatch replies the harness posted" has no implementation.

Every `gh` call, including the harness's inline replies and the daemon's own `@codex review` comment, is authored by `uchibeke`, who is also in `trusted_authors`. On the next tick those are new trusted events and the loop feeds itself.

Change: two rules, both cheap. After a run ends, set the cursor to the run's end time so everything posted during the run (harness replies, the re-review comment) is behind it. Skip inline review comments from the daemon's own login when `in_reply_to_id` is set; the operator's own top-level inline comments still dispatch. Fetch the daemon's login once with `gh api user`. Drop the sentence about "replies the harness itself posted"; the rule above is the definition.

### F5. Major. Sections 6.8, 6.9. Run-in-progress and post-run bookkeeping must be driven by a pid on disk, not by the daemon's memory.

A run lasts up to 30 minutes and the daemon polls every 2; the daemon will also be restarted mid-run (launchd, laptop lid, `gallivant up` by hand). The PRD says "anything while a run is in progress" is never dispatched but never says how progress is known after a restart, and the "on exit, if the head sha changed, post the comment" step lives in an exit handler that dies with the daemon. The timeout has the same problem.

Change: copy command-center's `lib/run.mjs` (100 lines, zero deps, same author) and instantiate `makeRunner(~/.gallivant/runs/<prd>)` per PRD. It already spawns detached with `unref`, writes `job.json` with the pid, answers "running" with `process.kill(pid, 0)`, and throws `busy` if that PRD has a live run, which is exactly the per-PR concurrency guard. Then make the tick the only actor: for a PR with a finished run whose outcome is not yet recorded, compare the head sha now against `fixed_sha`, post the re-review comment if it moved, bump iteration, record it. Timeout is `now - startedAt > timeout` checked in the tick, then `process.kill(-pid)`. Nothing happens in exit handlers. Use `setTimeout` chaining, not `setInterval`, so ticks never overlap, and write `state.json` via temp file plus rename.

### F6. Major. Sections 6.6, 6.8. Four cursor fields where one timestamp does the job, and four API calls where two do.

`last_review_id`, `last_comment_id`, `last_head_sha`, `last_fixed_sha`: review ids, review-comment ids and issue-comment ids are three id spaces, so two id cursors are already wrong, and `last_head_sha` only serves the "superseded sha" rule, which is a judgement the harness can make better than the daemon.

Change: cursor is `{ since: ISO, fixed_sha }`. Per tick, `gh pr view <n> --repo <r> --json headRefOid,mergeable,isDraft,state,statusCheckRollup,reviews,comments,labels,body` (one call, covers head, conflicts, checks, reviews, issue comments) plus `gh api repos/{r}/pulls/{n}/comments?since=<since>` for inline comments. Dispatch if any qualifying event has `created_at > since`. On dispatch, set `since` to the max event time. Delete the "comments on a superseded head sha" rule and the rate-limit back-off row; 20 PRs at 2 calls every 2 minutes is 1,200 calls an hour.

### F7. Major. Sections 6.3, 6.10, open question 1. Worktrees under `~/.gallivant` contradict US8 and break Claude resume.

US8 deletes `~/.gallivant`. That also deletes every worktree, and Claude Code stores session transcripts under `~/.claude/projects/<slug of cwd>/`, so a session resumed from a different path is at best a fresh context. Codex resolves resume by UUID regardless of cwd, so it survives; Claude does not.

Change: answer open question 1 with a sibling directory outside the state dir, for example `~/Downloads/projects/.worktrees/<repo>/<prd>` configured as `worktrees`, and say worktrees are durable and only removed on `done`. On recovery, if the worktree is missing, recreate it from the PR branch at the same path (`git fetch && git worktree add <path> <branch>`). Keep Gallivant-managed worktrees rather than `claude -w` or `codex exec --worktree`, because the daemon needs to own the path.

### F8. Major. Sections 6.4, 6.5. Mutable counters in the PR body and the daemon committing status to the PR branch.

`iteration` and `last_fixed_sha` in the HTML block make `gh pr edit --body` a write on every round, racing the harness and any human editing the description, and the PRD already calls GitHub the truth and the local file a cache, which is backwards for counters. Section 6.4 also has the daemon writing PRD status changes "on the PR branch", which adds commits that trigger CI and a Codex review and can collide with the session's own commits.

Change: the block is write-once identity: `prd, harness, session, branch`. Counters live in `state.json`. On recovery, `iteration` is the count of issue comments by the daemon's login whose body equals `rereview_comment`; that is free and exact. Cut the status write-back to the branch; `gallivant status` and the PR labels are the status.

### F9. Major. Sections 6.2, US6, US7. Iteration cap and `ready-for-human` are not defined tightly enough to code.

The diagram labels `needs-human` at `iteration == 3` immediately after the third push, even if that push was clean; US6 says the cap bites when another event arrives after three rounds. US7's "no P0/P1 and all checks green" is silent on repos with no checks and repos where Codex review is not installed, and on what happens after `needs-human` when a human comments.

Change: `iteration` counts dispatched runs of any kind. A dispatch is refused when `iteration >= max_iterations`, and that refusal is the transition to `needs-human`. `ready-for-human` means: not draft, `mergeable != CONFLICTING`, every check in `statusCheckRollup` concluded success, neutral or skipped (an empty rollup counts as green), and the newest `reviewer_bot` review submitted after `fixed_sha` has zero inline comments and is not `CHANGES_REQUESTED`; if no bot review arrives after two re-triggers, treat the reviewer as absent and go to `ready-for-human` with reason `no-reviewer`. `needs-human` stops watching; `gallivant resume <pr>` resets `iteration` to 0 and re-enters `pr-open`. Redraw the diagram to match.

### F10. Minor. Section 6.5. Three ways to get the metadata block onto the PR; one is enough.

The session is told to append it, a PostToolUse hook may call `gallivant register`, and branch reconciliation is the fallback. Codex does not know its own thread id when it writes the PR body; the daemon does, from the first `thread.started` line.

Change: the daemon writes the block. After the start run ends, `gh pr list --repo <r> --head <branch> --json number,body`; if a PR exists and lacks the block, `gh pr edit --body` once. Cut the prompt instruction and both hooks from the PRD.

### F11. Minor. Sections 6.9, 10. The 👀 reaction check adds an API and a timer for a heuristic the tick already computes.

Change: after posting `rereview_comment`, record `rereview_at` and `rereview_count`. On any tick where no `reviewer_bot` review is newer than `fixed_sha` and `now - rereview_at > 6 minutes` and `rereview_count < 2`, post again. No reactions call.

### F12. Minor. Section 6.9. Log tails and secret scrubbing in the prompt are unnecessary.

The harness runs in a worktree with `gh` authenticated. Change: the prompt names the failing check and its run id and says "run `gh run view <id> --log-failed` for the log". Cut the 60-line tail and the scrubber. The daemon never handles log text.

### F13. Minor. Sections 6.10, US8. Recovery with `since = now` strands PRs that had unaddressed feedback at restart.

Change: on recovery, `since = max(created_at of the daemon's last own comment on the PR, committer date of the head commit)`. That replays only feedback nobody has acted on, and nothing else. `fixed_sha = head`.

### F14. Minor. Operator ask 7. Hand-started sessions cannot join the loop.

The operator says sessions open in iTerm and a pre-PR hook "may" start the watcher. The PRD only knows PRs that `gallivant start` opened or that already carry a block. Change: add `gallivant register <pr> --harness claude --session <uuid>` (M1, ten lines: writes the block and the state entry). Claude Code's own PR linking is interactive-only via `--from-pr`, so it cannot be read by the daemon.

### F15. Minor. Sections 6.1, 6.7, 10. Reuse what exists; drop what pretends to be safety.

Reuse, verified on disk: command-center `config.json` `harnesses` block already has the adapter shape (`run` argv with `{prompt}`, `modelFlag`, `format`, `authCmd`), so `lib/harness/claude.mjs` and `codex.mjs` should be config entries in that shape plus a `resume` template with `{session}`, not modules. The only per-harness code is session id extraction: Claude needs none because `--session-id` chooses it; Codex is one regex on the first `thread.started` line for `thread_id`. Note command-center's block is stale (Claude uses `--allowedTools` with no permission mode; the Codex note says "no --sandbox" but 0.155.1 has it), so Gallivant should own the block and command-center read it later. `lib/projects.mjs` `discovered()` is the `roots` scan for M3. `lib/run.mjs` is F5. APort's OpenCode installer is gated and exits (`docs/frameworks/opencode.md`), so M2 cannot claim guardrails on OpenCode without APort work.

Cut: adapters probing `--help` at daemon start (run the real command and surface stderr instead), the rate-limit back-off row, `--fork-session` on the last round, `pause`. Move the APort GitHub Repository Guard from M0 to M4; it is report-only, needs OIDC, and does nothing for the no-prompt goal. Branch protection via `gh api` is the actual guard on day one.

## 3. What to cut for four hours, and the M1 I would build

Day one is M0 (one hour) plus M1. M0 as written, with F1 and F2 applied: config.toml keys, Claude settings edit, APort Claude hook in enforce, APort Codex hook global in warn, branch protection on one repo, ntfy topic, and one manual `claude -p` and one `codex exec` fix on a real PR.

M1 in three hours, zero-dependency Node 22 ESM, about 350 lines:

- `bin/gallivant.mjs`: `up`, `tick`, `start <prd>`, `register <pr>`, `resume <pr>`, `status`. `up` is `tick` on a `setTimeout` chain. Forty minutes including config and atomic state.
- `lib/run.mjs`: copied from command-center, one runner per PRD dir. Ten minutes.
- `lib/gh.mjs`: `execFile("gh", ...)` returning parsed JSON, five helpers (view, inline comments since, comment, label, edit body). Twenty minutes.
- `lib/harness.mjs`: argv from the config templates, `sessionIdFrom(line)` for Codex, sign-in probe by running `authCmd`. Fifteen minutes.
- `lib/tick.mjs`: the per-PR state machine from F5, F6, F9, F11, with `gh` injected so `node --test` covers dispatch, dedup, the cap and the conflict path with a fake. Seventy minutes.
- `lib/notify.mjs`: one `fetch` POST to ntfy. Five minutes.
- `launchd/com.gallivant.plist` with `PATH` set, plus `caffeinate -i` around the harness spawn. Ten minutes.
- Thirty minutes to run one real PR through the loop.

Left out of M1 on purpose: `ready` and PRD lint, `roots` scanning, issue input, `attach`, `pause`, the `init` wizard (hand-write `config.json`), the reaction check, log scrubbing, PRD status write-back, `--help` probing, back-off, OpenCode, the APort GitHub action, `--fork-session`, the morning digest, and the SSE viewer (command-center already streams any `runs/<id>/job.log` in this layout, which is why F5 matters for M5 too).

## 4. Operator asks the PRD does not account for

- Ask 3, email or text: ntfy forwards a notification to email with one `X-Email` header on the POST, so the "add-on" is one config field; say so instead of leaving it abstract. SMS needs Twilio or ntfy's paid calls; name the choice.
- Ask 7, sessions opened in iTerm and the pre-PR hook: no way to register a hand-started session (F14).
- Ask 7, command-center showing live sessions: possible only if `~/.gallivant/runs/<prd>/<id>/job.json` and `job.log` use command-center's runner layout. The PRD names a different file layout (`003.jsonl`). Adopt the runner's.
- Ask 6, APort from day one on Codex: true only in warn mode until the multi-file `apply_patch` case is fixed (F2). The PRD claims enforce after the first PR.
- Ask 10, productive within hours: the Codex flags in the PRD would have cost the first hour of debugging (F1). Section 9 also omits that `~/.claude/settings.json` on this machine carries an `autoMode.environment` block naming aport-vault's default branch as `master`; a daemon that assumes `main` from config will pick the wrong base. Read the default branch from `gh repo view --json defaultBranchRef` instead of a PRD field.
- The brief's "verified environment facts" need correcting for Codex `--full-auto` and for `codex exec resume` lacking sandbox flags.
