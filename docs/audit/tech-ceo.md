# Tech CEO audit of Gallivant PRD v0.2

Auditor: Tech CEO persona. Date: 2026-09-23. Everything below was checked against the machine, not the brief: `claude --help` (2.1.263), `codex exec --help` (0.155.1), the APort source at `/Users/uchi/Downloads/projects/aport-agent-guardrails`, and command-center's `config.json` and `lib/run.mjs`.

## 1. Verdict

Approve with changes. The shape is right (poll GitHub with `gh`, resume the session that opened the PR, APort hooks instead of prompts, one ntfy message per transition), but day one is two to three times bigger than four hours, one of the two "verified" harness commands does not parse, and the APort Codex hook in its current beta cannot carry an unattended coding run. Cut Codex-as-fixer, launchd, the GitHub guard, the wizard and the PRD write-back from tonight, and the four-hour version exists.

## 2. Fund it, or use Claude Code auto-fix plus a ten-line workflow?

Both, in that order. The ten-line version covers two of the operator's three pains tonight with no Gallivant code:

- Pain 1 (clicks): `claude -p --permission-mode auto --permission-prompts none --settings '{"permissions":{"blockReadsOutsideWorkingDirectories":false}}'` and, for Codex, `approval_policy = "never"` plus `sandbox_mode = "workspace-write"` in `~/.codex/config.toml`. Config, not software.
- Pain 2 (`@codex review` after every push): a workflow on `pull_request: [synchronize]` that runs `gh pr comment "$PR" --body "@codex review"` when the branch starts with `gallivant/`. It runs on GitHub, so it works with the laptop closed and with any harness. One unknown: Codex may ignore triggers posted by `github-actions[bot]`. That is a five-minute test on one PR. If it fails, the daemon posts the comment instead, which is one line.
- `/autofix-pr` on any PR Claude Code opened handles the fix loop from the cloud.

What that path does not give the operator, and why Gallivant is still worth two evenings: no APort in the loop (cloud auto-fix runs on Anthropic's machines, outside the PreToolUse hook), no session resume for Codex, no local execution, and no "PRD marked ready becomes a session". Asks 4, 6 and 7 in the brief are exactly the gap. I would fund Gallivant as a small local daemon on top of the ten-line setup, not instead of it, and mainly because it becomes the reference deployment of APort for unattended agents. That is the operator's business. As a standalone product it competes with gh-aw, Cyrus, sortie and no_human on a thin margin (local plus resume plus guardrails); as the demo of why guardrails belong outside the prompt, it is worth more than its code.

## 3. Findings

**F1. Blocker. Section 6.7, 6.3, and the brief. `codex exec --full-auto` does not exist.**
`codex exec --full-auto --help` on 0.155.1 returns `error: unexpected argument '--full-auto' found`, and `-a never` fails the same way on `exec`. The matrix says "verified on this machine on 2026-09-23"; it was not run. Replace both Codex rows and the config sample with `codex exec --json --sandbox workspace-write -c 'approval_policy="never"' --skip-git-repo-check "<prompt>"` and `codex exec resume <id> --json --sandbox workspace-write -c 'approval_policy="never"' "<prompt>"` (both parse). Command-center already carries a working Codex argv at `config.json` line 1213 (`codex exec --approve-for-me --skip-git-repo-check --json`); copy from there rather than re-deriving. Note that `--approve-for-me` routes approvals through an automatic reviewer, which is not the same as never asking; `approval_policy="never"` is the deterministic one.

**F2. Blocker. Sections 6.11 and 8. The APort Codex hook cannot carry an unattended coding run today.**
`docs/frameworks/codex.md` in the APort repo says the beta hook fails closed on `apply_patch` payloads touching more than one file, on `Glob`/`List`/`LS`, and on `WebSearch` without a URL, and these are pre-evaluation denials, so warn mode does not lift them (`bin/lib/command-hook-adapter.sh` line 472 emits `oap.multi_path_write_unsupported`). A coding agent writes multi-file patches on most turns, so a Codex fix run under APort enforce or warn will stall on its first real edit. Decision: day one fixer is Claude Code only, Codex stays the reviewer it already is. The Codex adapter moves to M2 and is gated on an APort change the operator owns (evaluate each path in a multi-file patch, or allow with a warning). File that issue on aport-agent-guardrails tonight; it is the first thing dogfooding found.

**F3. Major. Section 8. Four hours is not credible as written.**
APort has never been installed on this Mac (`~/.claude/aport/` and `~/.codex/hooks.json` do not exist), the passport has to be authored with `allowed_paths` and five capabilities, the Codex hook needs an interactive `/hooks` trust step, the GitHub guard needs a workflow PR merged, and branch protection is per repo. M1 lists twelve features and two adapters, and every end-to-end test waits several minutes for a real Codex review. As written this is eight to ten hours. Re-estimate M0 at 1.5 hours and M1 at 2.5 hours with the cuts in section 4 below, and say in the PRD that the Codex fixer, launchd, the wizard and the GitHub guard are evening two and three.

**F4. Major. Section 6.7 (Claude row) and Section 9. The Claude command is missing two flags and one setting override.**
`--permission-prompts` defaults to `host` in `-p` mode; with no SDK host attached, what happens when something would prompt is undefined for a daemon. `--max-budget-usd` exists and the PRD has a 30-minute wall clock but no dollar cap for a session that loops overnight across 60 repos. Replace the start and resume commands with `claude -p --session-id <uuid> --permission-mode auto --permission-prompts none --max-budget-usd <n> --settings '{"permissions":{"blockReadsOutsideWorkingDirectories":false}}' --output-format stream-json "<prompt>"`, and change section 9 from "remove `blockReadsOutsideWorkingDirectories`" to "override it per run with `--settings`", so the interactive setting stays as the operator has it.

**F5. Major. Section 6.8. Four `gh api` calls per PR reinvents `gh pr view --json`.**
`gh pr view <n> --json reviews,comments,statusCheckRollup,mergeable,headRefOid,state,isDraft,labels,body` returns everything the watcher needs in one call, including check conclusions for the head. The only thing it lacks is inline review comments (`gh api repos/{repo}/pulls/{pr}/comments`), so the poll is two calls, not four, and the rate-limit row in section 10 can go. Failing logs stay `gh run view --log-failed`.

**F6. Major. Section 6.4. The daemon writing status into the PRD file on the PR branch should be cut.**
It puts daemon commits on the same branch the harness is committing to (a race on every fix round) and carries PRD status churn into `main` with every merge. State lives in `state.json` and PR labels; the PRD file changes exactly once, `draft` to `ready`, by hand. The operator's ask that "the PRD/PR carries what is needed to restart" is met by the PR body block, which is already in the design.

**F7. Major. Section 6.11. The GitHub Repository Guard does nothing for Gallivant on day one, and the passport is underspecified.**
`docs/GITHUB_PROTECTION.md` says the current action is the `code.repository.merge.v1` slice, report-only by default, and Gallivant never merges; it also needs a workflow PR merged per repo. Defer it to M4. Branch protection (required checks, no direct push to the default branch) is what stops a bad push tonight; keep that in M0. Replace the one-paragraph "passport policy" with the actual limits: capabilities `data.file.read`, `data.file.write`, `system.command.execute`, `agent.session.create` (without it every subagent call is denied, fail-closed), `web.fetch`; `data.file.write.allowed_paths: ["~/.gallivant/worktrees/**"]`; `data.file.read.blocked_paths` for `.env*` and key files; `system.command.execute.allowed_commands: ["*"]`, `blocked_patterns: ["git push --force", "git push -f", "--force-with-lease", "rm -rf", "sudo"]`, `allowed_working_directories: ["~/.gallivant/worktrees"]`. "No push to the default branch" is not reliably expressible as a command pattern (`git push -u origin HEAD` from a detached state passes any substring check); branch protection owns that rule, and the PRD should say so.

**F8. Major. Section 11 and scope. The re-review trigger is a workflow, not daemon logic, if Codex accepts it.**
See section 2 above. Test once whether `@codex review` from `github-actions[bot]` triggers a review. If yes, delete the re-trigger and the retry from the watcher and ship the workflow to the first repo tonight. If no, the daemon posts the comment and the retry in F10 applies.

**F9. Minor. Section 6.1. launchd is a known hour, not a line.**
Node lives under nvm and `gh` auth lives in the user's keychain; getting both into a launchd environment is the classic detour. The operator said iTerm sessions are acceptable. Tonight: `caffeinate -i node bin/gallivant.mjs up` in a tab. launchd ships in M4 with the README.

**F10. Minor. Section 6.9. The eyes-reaction retry is unverified.**
Nothing on disk or in the brief shows the Codex bot reacts with an emoji. Replace with: if no review from `reviewer_bot` on the new head arrives within ten minutes of the comment, post once more, then stop and let the iteration cap handle it.

**F11. Minor. Sections 6.3, 6.10 and 10. `init` wizard, `pause`, `resume`, `attach`, `ready` lint, and `--help` probing at daemon start are all evening two or later.**
`attach` for Claude Code is `claude --from-pr <n>`, which already exists; for Codex it is `codex resume <id>`. Do not wrap either. Tonight the config file is written by hand, and `ready` is editing one frontmatter line. The adapter `--help` probe in section 10 is speculative; a failed run with a clear stderr is enough.

**F12. Minor. Section 6.12 and open question 3. ntfy already does email.**
Publishing to ntfy with an `Email:` header forwards the message to that address; that is the whole "email add-on". SMS is a Twilio curl later if it is ever wanted. Answer OQ3 as: ntfy plus the email header from day one, SMS never unless asked again.

**F13. Minor. Section 6.7 notes. Resume needs the worktree to still exist.**
Claude Code stores sessions per project directory, so `claude -p --resume <uuid>` must run with the original worktree as cwd; Codex filters by cwd the same way. The PRD never says when worktrees are pruned. Add one sentence: a worktree lives until its PR is `done`, and cleanup is a later `gallivant gc`.

**F14. Minor. Sections 3, 4 and M4. Open source is an asset in a month and a distraction tonight.**
Keep the repo public from the first commit; that is free and it keeps personal paths and tokens out of the code, which is worth having anyway. Drop US13, the init wizard and "usable by someone who is not the author" from day-one acceptance. The audience for the README is not a community, it is people evaluating APort who want to see unattended agents bounded by a hook rather than a prompt. Write that README after Gallivant has run for a week and there is an audit log to show.

**F15. Minor. Section 6.13. Command-center is the right thing to reuse for argv defaults and the wrong thing for the runner.**
`lib/run.mjs` line 40 refuses a second job (`busy`, 409), so it cannot host parallel PR runs; the PRD is right to keep the daemon separate. Its `harnesses` table in `config.json` (lines 1188 onward) is the correct source for adapter defaults, including the Codex flags that F1 corrects.

## 4. What to cut so day one fits in four hours

Hour 1, M0, config only:

- Claude: use the `--settings` override per run (F4). No global settings edit.
- Codex: `approval_policy = "never"` and `sandbox_mode = "workspace-write"` in `~/.codex/config.toml`, so a manual `codex exec` works tonight even though the daemon will not drive it yet.
- APort: `npx @aporthq/aport-agent-guardrails claude-code --enforcement=warn` with a local passport carrying the limits in F7. Skip the Codex hook and the GitHub guard.
- ntfy topic, one `curl` to prove it, `Email:` header if wanted.
- Branch protection on the first repo.
- One manual `claude -p --resume` fix run on a real PR with zero prompts and an APort audit line. That is the M0 exit test and it is the only one.

Hours 2 to 4, M1, one file `bin/gallivant.mjs`, Claude Code only:

- Read `~/.gallivant/config.json` (hand-written) and `state.json`.
- `start <prd>`: `git worktree add`, `claude -p --session-id`, prompt includes the PRD text and the metadata block instruction, record session id.
- `up`: every two minutes, for each `pr-open` entry: `gh pr view --json` plus the inline comments call (F5), filter to `trusted_authors` and `reviewer_bot`, dispatch `claude -p --resume` with the quoted batch, on head change post `@codex review` (unless F8's workflow does it), bump iteration; at three or `mergeable: false` label `needs-human` and notify once; green checks and no P0/P1 in the latest bot review label `ready-for-human` and notify once.
- `status`: print the table.
- Run under `caffeinate -i` in an iTerm tab.

Deferred to evening two and three, in this order: Codex adapter (after the APort multi-path fix), US8 reconciliation from GitHub, `ready` lint and `start` with no argument, launchd, the wizard, the Codex hook and the GitHub guard, README and npm.

Cut outright: PRD status write-back on the PR branch (F6), the eyes-reaction check (F10), the `--help` probe (F11), the four-call poll (F5).

## 5. Operator asks the PRD did not account for, or accounted for in a way the operator should confirm

- Ask 8 (Claude Code and Codex from day one) and ask 10 (productive in the next few hours) conflict once F1 and F2 are known. This report chooses ask 10 and moves the Codex fixer to evening two. The adapter interface and the PR block keep ask 4 (no lock-in) intact; nothing in the day-one code is Claude-specific except the one adapter file.
- Ask 7 says "sessions poll for comments". The PRD moves polling into the daemon and resumes the session only when there is work. That is the better design (a sleeping session costs nothing and cannot wander) but it is a change from what was asked, and the PRD should say so in one line.
- Ask 7 also says "a script starts sessions daily after PRDs are ready". Open question 4 leaves it open. Decide now: the operator runs `gallivant start` at the end of the PRD window; no morning cron until M3.
- Ask 1 ("opened issues get picked up too") is M3. Correct, but the summary in section 1 of the PRD reads as if issues work on day one. Say M3 there.
- Ask 2, third item (PRDs must carry user stories and acceptance criteria) is enforced by `gallivant ready` in M3. Tonight the enforcement is the template and the operator's eyes. Fine, but it should be stated.
- The `vibe` wrapper from vibetime-cli is bypassed by calling binaries by absolute path (section 6.7). That also means the session tracker never sees daemon runs. If the operator wants overnight runs counted, the daemon should call the wrapper or write to vibetime itself. Ask the operator; the PRD assumes bypass is fine.
- Nobody asked for a spend cap, and a CEO should: add `--max-budget-usd` per run (F4) and a `max_runs_per_day` in config before the first unattended night across more than one repo.
- Open question 1 (worktree location): keep `~/.gallivant/worktrees`; putting them inside each repo trips `blockReadsOutsideWorkingDirectories`-style rules and dirty-checkout scans. Close it.
- Open question 2 (trusted human comment on a `ready-for-human` PR reopens the loop): yes, automatically. A human commenting on a PR they were told is ready is a review; making them also type `@gallivant fix` is a click of the kind this project exists to remove.
