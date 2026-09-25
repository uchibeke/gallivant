# Audit: open-source user

Persona: someone who finds Gallivant on GitHub, has a Mac, their own repos under `~/code`, one harness signed in (say Claude Code only), a reviewer bot that is not Codex (CodeRabbit, Copilot, or just humans), and no APort account. Audit target: PRD.md version 0.2.

Everything below was checked against the machine on 2026-09-23: `claude` 2.1.263 and 2.1.177 (both installed), `codex` 0.155.1, `opencode` 1.18.31, aport-agent-guardrails 1.0.33 source at `/Users/uchi/Downloads/projects/aport-agent-guardrails`, command-center at `/Users/uchi/Downloads/projects/command-center`.

## 1. Verdict

Approve with changes. The core loop (poll a PR with `gh`, resume the session that opened it, re-request review, notify once) is the right size and mostly reuses what exists. But as written, a stranger cannot install it: `init` runs three APort installers by default, the first of which asks them to create a hosted aport.io passport by email and rewrites their global Claude settings; the reviewer logic is Codex-specific; the config example contains the author's GitHub login and folder layout; and section 9 is an audit of the author's laptop. Fix the six blockers/majors below and the design holds up.

## 2. Findings

### F1. Blocker. Section 6.11, 7 (US13), 8 (M0). APort is mandatory and the default install path requires an aport.io account.

`gallivant init` calls `npx @aporthq/aport-agent-guardrails claude-code`, `codex`, and `github`. Verified in `bin/lib/quick-hosted.sh` lines 183 to 189: the wizard's first and default choice is "Create hosted APort passport now", which asks for an email and issues a hosted passport; the documented non-interactive form (`--quick-hosted --email ...`) is hosted only. A stranger who wanted a PR watcher now has an account with a third party, a hook with matcher `*` in their global `~/.claude/settings.json` that runs before every tool call in every Claude session they ever start (not only Gallivant's), and, per `bin/aport-claude-code-hook.sh` line 88, every tool call denied with "jq is required" if `jq` is not installed. Goal "Usable by someone who is not the author" and US13 ("APort installers run") contradict each other.

Change: add a config key `"guardrails": "aport" | "none"` (default asked in the wizard, `none` when `--non-interactive`). Replace the US13 acceptance line with: "Given a fresh Mac with `gh`, Node 22 and one harness signed in, when a new user runs `npx gallivant init --guardrails none`, then config is written and `gallivant status` prints an empty table with no error. Given `--guardrails aport`, then the APort local-passport path is used, `jq` is checked first, and the hook is loaded per run via `claude --settings ~/.gallivant/claude-settings.json` rather than written into `~/.claude/settings.json`." `claude --settings <file-or-json>` exists in 2.1.263 (verified in `--help`) and is the right scoping tool. Keep the operator's own default (`aport`) in their config, not in the code.

### F2. Blocker. Section 6.7, 9. `codex exec resume` has no `--full-auto`, so Codex fix runs will prompt or die.

Verified with `codex exec resume --help` on 0.155.1: the flags are `-c`, `--last`, `--all`, `-m`, `--json`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--worktree`, `--skip-git-repo-check`, `--ephemeral`, `--output-schema`, `-o`. No `--full-auto`, no `--sandbox`, no `-C`. Section 9's escape hatch "or always pass `--full-auto`" therefore only covers the start command, and the resume command, which is the one that runs unattended overnight, depends on `~/.codex/config.toml` being edited.

Change: in the harness matrix, make the Codex resume command `codex exec resume <id> --json -c approval_policy=never -c sandbox_mode=workspace-write "<prompt>"`, spawned with `cwd` set to the worktree (there is no `-C` on resume). Put the `-c` pairs in the adapter, not in user config, so nobody has to edit `config.toml` to get a working install. Add a sentence to 6.7: "Codex `exec resume` accepts `-c` overrides but not `--full-auto`; the adapter passes approval and sandbox policy through `-c`."

### F3. Major. Section 6.11. APort's Codex hook in enforce mode will stall an unattended Codex session on ordinary edits.

`docs/frameworks/codex.md` in the APort repo says the beta hook fails closed on `apply_patch` payloads that touch more than one file, and on `Glob`, `List`, and `LS`. A coding agent patches several files per turn and lists directories constantly. The PRD says enforcement starts in `warn` for the first PR then moves to `block`; that schedule assumes the denials are policy-tuning problems, but these are structural to the beta hook and will not go away by editing the passport. This conflicts with the operator's first ask (work continues while they sleep).

Change: state plainly in 6.11 that on day one the Codex hook runs in `warn` only, and that `block` for Codex waits for APort to lift the multi-file `apply_patch` and directory-listing limits. Add a row to the risk table: "APort Codex hook denies multi-file apply_patch and LS in enforce mode. Handling: warn mode for Codex until fixed upstream; enforce for Claude Code only."

### F4. Major. Section 6.3, 6.8, 6.9, 7 (US7). The reviewer is Codex in everything except the config key name.

`reviewer_bot` and `rereview_comment` are configurable, which is good, but `ready-for-human` is defined as "no P0/P1" (Codex's severity vocabulary), the retry logic waits for a 👀 reaction (Codex's acknowledgement), and section 6.11 assumes the Codex GitHub app is installed on the repo. A user with CodeRabbit (`coderabbitai[bot]`), Copilot review (`copilot-pull-request-reviewer[bot]`), the Claude Code review action, or only human reviewers gets a watcher that never reaches `ready-for-human`. This is provider lock-in on the review side, which the operator's ask 4 rules out.

Change: replace the two keys with a `reviewer` object and a generic readiness rule.

```json
"reviewer": {
  "login": "chatgpt-codex-connector[bot]",
  "rereview_comment": "@codex review",
  "blocking_pattern": "\\bP[01]\\b",
  "ack_reaction": "eyes"
}
```

Allow `"reviewer": null` (human and CI only). Readiness rule: "the latest review by `reviewer.login`, if any, is not `CHANGES_REQUESTED` and contains no inline comment matching `blocking_pattern`; no new trusted inline comments since `last_fixed_sha`; every check run on the head sha is `success`, `neutral` or `skipped`, and zero check runs counts as green." That last clause matters: most personal repos have no CI, and without it `ready-for-human` never fires. Ship three presets in `templates/reviewers/` (codex, coderabbit, none) and stop there.

### F5. Major. Section 6.3, 6.7 note 3, 9. Author-specific values baked into the PRD.

`"roots": ["~/Downloads/projects"]` copies command-center's `discover.base` (`/Users/uchi/Downloads/projects` in its `config.json`). `"trusted_authors": ["uchibeke"]` is the author's login. The 6.7 note about "the `vibe` function on this machine" is about one laptop's `.zshrc`. Section 9 is titled "Prerequisites on this Mac" and describes the author's Claude, Codex and OpenCode settings files. The PRD says "no personal paths in code"; these will end up in the wizard defaults and the README if they stay in the spec.

Change: `roots` defaults to the current directory's git root at `init` time, and the wizard asks. `trusted_authors` defaults to `gh api user --jq .login`. Delete the `vibe` sentence and replace with: "The daemon calls binaries by absolute path so shell aliases and wrapper functions are bypassed." Move section 9 out of the PRD into `docs/setup-notes.md` and replace it with a `gallivant doctor` command (see F7). Use neutral example ids in 6.4 to 6.6 (`example-widget-2026-09`, `acme/widget`) or keep the APort ones but do not let them leak into templates.

### F6. Major. Section 6.7, 6.3. "Absolute path in config" is only safe if `init` resolves the right binary.

This machine has `~/.local/bin/claude` at 2.1.177 and `~/.nvm/versions/node/v22.22.0/bin/claude` at 2.1.263. `which claude` in a login shell returns a function, not a path, because of the wrapper. A user who pastes the wrong one gets a version without `--permission-mode auto` semantics the PRD relies on, and nothing tells them.

Change: `init` resolves each harness with `zsh -lc 'whence -p claude'` (or `bash -lc 'type -P'`), runs `<bin> --version`, prints both, and refuses versions below the matrix minimum. `gallivant doctor` repeats the check at daemon start (the PRD's risk table already says adapters probe `--help`; make it `--version` plus one known flag).

### F7. Major. Section 9, 8 (M0). The click-causing settings are found by hand on one machine; a stranger will hit their own variant and give up.

Section 9 lists three settings on the author's laptop that cause prompts. Another user's `~/.claude/settings.json` will have different `permissions` entries, a different `approval_policy`, or a GitHub connector set to approve. The PRD has no way to detect this on another machine; US11 just says "prerequisites applied".

Change: add `gallivant doctor` to M1 with these checks, each printing a one-line fix: `gh auth status`; harness binaries and versions; `jq` if guardrails is `aport`; Claude `permissions.blockReadsOutsideWorkingDirectories`; Codex `approval_policy` and `sandbox_mode` (informational, since F2 passes them via `-c`); OpenCode `permission` block; a dry `claude -p --permission-mode auto "echo ok"` in a temp dir that must complete without a permission event in stream-json. Make US11 "Given `gallivant doctor` passes, when a fix run executes, then no permission prompt."

### F8. Major. Section 6.11, 1, 5. The PRD is honest about reusing APort's installers but not about what APort can actually enforce, and the "policy" it describes is Gallivant's, not APort's.

"Writes only inside the worktree, no reads of `.env*` or key files, no `git push --force`, no push to the default branch, network limited to GitHub and package registries." Checked against APort's local passport (`local-overrides/templates/passport.local.json`, `docs/OPENCLAW_TOOLS_AND_POLICIES.md`): write and read path allowlists and `.env` blocking exist; `git push --force` and "push to main" would be `blocked_patterns` string matches on the Bash command text, which `git push -f` or a pushed alias walks around; the network limit applies to `WebFetch`/`WebSearch` tool calls through `web.fetch.v1`, not to `curl` inside Bash or to git's own network traffic. Nobody ships this passport; Gallivant would have to write it.

Change: ship `templates/passport.gallivant.json` in the repo and say in 6.11: "Gallivant writes this passport. APort enforces path allowlists on file tools and pattern blocks on shell commands. It does not see git's network traffic or `curl` inside Bash; the default-branch guarantee comes from GitHub branch protection, which Gallivant also does not install. Enforcement lives in the hook, policy in this file." Drop "network limited to GitHub and package registries" or move it to a future-work line.

### F9. Major. Section 6.1, 6.10, 8. Mac-only daemon on day one, Linux "later", but the daemon is a plain Node process.

launchd is the only documented way to run `gallivant up`. The operator's own plan is a Hetzner box later, and a chunk of the GitHub audience runs Linux. Nothing in the daemon needs launchd.

Change: document `gallivant up` in the foreground as the primary way to run it, with `caffeinate -i gallivant up` on a Mac. Ship `templates/com.gallivant.plist` and `templates/gallivant.service` as optional installers (`gallivant service install`). Goal line "Moving to a Hetzner or Contabo box later changes one config file and one service definition" then becomes true on day one.

### F10. Minor. Section 6.4, 6.10. Writing PRD status back on the PR branch reinvents PR labels and makes the daemon a committer.

The daemon would commit and push status flips to the PR branch, interleaved with the agent's commits, and needs a git identity to do it. GitHub labels already exist and the PRD already uses them for `ready-for-human` and `needs-human`.

Change: cut the write-back. State is the registry plus labels `gallivant:running`, `gallivant:pr-open`, `gallivant:ready-for-human`, `gallivant:needs-human`. The PRD file flips from `draft` to `ready` by the user's hand (or `gallivant ready`) and from `ready` to `running` at kickoff; nothing after that.

### F11. Minor. Section 6.9. The 👀 retry needs a reactions API call per poll and is a Codex quirk.

`gh api repos/{repo}/issues/comments/{id}/reactions` per dispatched PR every poll, for one bot's habit. Handle it with the generic rule instead.

Change: "If no review by `reviewer.login` arrives within `rereview_timeout_minutes` (default 10) after `rereview_comment` is posted, post it once more. Never a third time." Drop `ack_reaction` unless someone asks.

### F12. Minor. Section 6.13, 6.1. Command-center coupling is already optional, but two claims about it are wrong.

Command-center's `lib/run.mjs` header says "one background job at a time", so "tails run logs through its existing SSE runner" works for reading log files but cannot start or track several Gallivant sessions. Its README calls the app "Content pipeline"; its auth allowlist is `@aport.io`. None of that belongs in an open-source PRD.

Change: shorten 6.13 to: "Any UI reads `~/.gallivant/state.json` and `~/.gallivant/runs/*.jsonl` and shells out to the CLI. The author's own dashboard will do this. Gallivant has no UI code." Delete the component-table row for command-center.

### F13. Minor. Section 8 (M2). OpenCode support cannot include APort.

APort's `docs/frameworks/opencode.md` says the target is gated and the installer exits with an explanation. M2 as written implies parity with Claude Code and Codex.

Change: M2 done-when reads "US9 for OpenCode; guardrails `none` or the harness's own `permission` block, since APort has no OpenCode hook."

### F14. Minor. Repo hygiene. No LICENSE file, no commits, README promises three harnesses.

The repo has zero commits and no `LICENSE`; the PRD says Apache-2.0. `npm view gallivant` returns 404, so the name is free; claim it early. `gallivant up` versus `gallivant start` will be confused in every issue thread.

Change: first commit is `LICENSE` (Apache-2.0), `README.md`, `PRD.md`. Rename `start` to `kickoff` or rename `up` to `daemon`; either, not both. README should say "Claude Code and Codex today, OpenCode planned" until M2 lands.

### F15. Minor. Section 6.3, 6.12. Notifications and worktree location.

`notify` must be allowed to be absent (log only). `~/.gallivant/config.json` will hold an ntfy topic URL, which is effectively a secret for public topics; say so and `chmod 600` it. Open question 1: keep worktrees outside the repo; it is the only option that leaves a dirty checkout untouched (US2) and avoids `.gitignore` edits in sixty repos.

Reinvention flags, collected: F10 (labels), F11 (reactions), F7 note that `gh pr checks` already summarises check state and could replace the `check-runs` call for the green test; `git worktree` and `gh` are used, not rebuilt, which is right. The watcher and dispatcher are genuinely built; they are the same shape as Claude Code's `/autofix-pr` and gh-aw but local and harness-neutral, and section 11 says so. Frontmatter parsing exists in command-center's `lib/frontmatter.mjs` and can be copied, not depended on.

## 3. What to cut to fit day one in four hours

- APort for Codex and the GitHub Repository Guard. Keep the Claude Code hook in `warn` via `--settings`, local passport, behind `guardrails: aport`. The Repository Guard in its free report-only mode changes nothing about unattended safety; branch protection does that work and takes two minutes in the GitHub UI.
- PRD status write-back on the branch (F10).
- The 👀 retry (F11).
- `attach`, `pause`, `resume`. `claude --resume <id>` and `codex resume <id>` typed by hand are the day-one version.
- launchd. Run `caffeinate -i gallivant up` in a terminal the first night.
- Human-review reopen on `ready-for-human` (open question 2). Day one: only `@gallivant fix` reopens.
- Section 9 edits become `gallivant doctor` output rather than a spec section.

What stays: config, registry, PR block with branch reconciliation, poll, trusted-author filter, two adapters, `rereview_comment`, iteration cap, conflict detection, ntfy, `status`, `doctor`. That is the four hours.

## 4. Operator asks the PRD did not account for

- Ask 1 (works while asleep) against ask 6 (APort from day one): the Codex hook's fail-closed behaviour on multi-file patches (F3) means both cannot be true for Codex on day one. The PRD needs to pick warn mode for Codex and say so.
- Ask 4 (no provider lock-in): satisfied for the fixer, not for the reviewer (F4).
- Ask 9 (open source): the goal is stated, but US13, the config example, section 9 and the 6.7 note all assume the author's machine (F1, F5, F6, F7).
- Ask 10 (productive in hours): M0 as written is three APort installers, branch protection, an ntfy topic and three settings-file edits before any Gallivant code runs. With the cuts above M0 is `doctor` plus branch protection.
- Ask 7 (restartable, PR carries what is needed): handled well. One gap: `codex exec resume` filters sessions by cwd (`--all` disables it), so the registry's `worktree` path must survive a `~/.gallivant` wipe; it does not, because worktrees live under `~/.gallivant/worktrees`. US8 should say "and worktrees are recreated from the PR branch if missing".
- Ask 11 (reuse): mostly honoured. The one place the PRD claims reuse it does not get is the guardrail policy itself (F8): APort supplies the hook, Gallivant has to author the passport.
