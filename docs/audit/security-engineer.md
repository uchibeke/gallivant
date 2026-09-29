# Security Engineer review of Gallivant PRD 0.2

Reviewer persona: security-engineer. Verified on this Mac on 2026-09-23 against Claude Code 2.1.263, codex-cli 0.155.1, `gh` 2.100, and the APort source at `/Users/uchi/Downloads/projects/aport-agent-guardrails`.

## 1. Verdict

Reject as written. Approve with changes once findings 1 to 5 are fixed.

The PRD's safety story rests on three claims that are not true today: that the APort passport bounds writes to the worktree, blocks pushes to main and limits network; that `codex exec --full-auto` exists and sandboxes the run; and that the operator's `gh` token is an acceptable identity for an unattended agent. On this machine APort is not installed, no Claude sandbox is configured, Codex 0.155.1 rejects `--full-auto`, and the token in the keychain is a classic OAuth token with `repo` and `workflow` scopes across every org the account can reach. A prompt injection that gets through would run with the operator's full GitHub identity and full home directory, and the PRD's stated guardrails would not stop it.

The design itself (poll, allowlist, resume, cap at three rounds, never merge) is sound. The problem is that section 6.11 describes a policy layer that does not do what it says, and the rest of the document leans on it.

## 2. Findings

### F1. Blocker. Section 6.11. The APort passport cannot enforce the four limits the PRD assigns to it.

The PRD says the passport policy is "writes only inside the worktree, no reads of `.env*`, no `git push --force`, no push to the default branch, network limited to GitHub and package registries." I read the local evaluator (`bin/aport-guardrail-bash.sh`, `bin/lib/validation.sh`, the policy packs under `external/aport-policies/`). For a Bash tool call the evaluator does exactly three things: prefix-match the command against `limits.system.command.execute.allowed_commands`, substring-match against `blocked_patterns`, and apply five fixed regexes (`rm -rf /`, `dd if=/dev/`, `mkfs.`, curl-pipe-shell, fork bomb). There is no branch parsing. `git push origin main` passes if `git` is in `allowed_commands`. The `repo.push` branch check at line 2024 only runs when the tool name is `git.push` with an explicit `branch` field in the context, which Claude Code and Codex never send; their shell tool arrives as `bash` and maps to `system.command.execute.v1` (`docs/TOOL_POLICY_MAPPING.md`, "Shell commands ... are evaluated as system.command.execute.v1").

The path, `.env` and domain limits exist only for the Write/Edit, Read, and WebFetch tools respectively (`data.file.write.v1` `allowed_paths`, `is_default_sensitive_read_path` at line 357, `web.fetch.v1` `allowed_domains`). None of them see `cat .env`, `echo x > ~/.zshrc`, or `curl attacker.example` when those run through Bash. There is also a usability trap: if `allowed_commands` is restrictive (not `["*"]`), any command containing an unquoted `&&`, `;` or `|` is denied outright with `oap.command_chain_unsupported` (line 2186), so the first `git add -A && git commit` of every run fails. The realistic passport is therefore `allowed_commands: ["*"]` plus `blocked_patterns`, which is a substring blocklist, not a boundary.

Change: rewrite the paragraph to say what each layer actually does.

> The filesystem and network boundary comes from the harness sandbox: Claude Code's Bash sandbox (`~/.claude/settings.json` → `sandbox.enabled: true`, `sandbox.autoAllowBashIfSandboxed: true`, `sandbox.network.allowedDomains` set to GitHub and the package registries the repo needs) and Codex's `workspace-write` seatbelt. Pushes to the default branch are blocked by a GitHub ruleset on each participating repo with "restrict updates" and no bypass actors, and by giving the agent a token that is not a repo admin (see F2). APort's PreToolUse hook is the audit trail and a tripwire: passport `allowed_commands: ["*"]`, `blocked_patterns: ["push --force", "push -f", "push origin main", "push origin master", "--no-verify", "sudo", "rm -rf ~", "launchctl", "security find-", "gh auth"]`, `data.file.write.allowed_paths: ["<worktrees root>/**"]`, `web.fetch.allowed_domains: ["github.com", "api.github.com", "registry.npmjs.org"]`. Enforcement `enforce` from the first run. APort does not parse shell commands and does not see paths inside Bash commands; do not describe it as the thing that bounds writes.

Also move US12 to say "Given a Write tool call outside the worktree" and "Given a Read of `.env`", because those are the calls the hook can actually deny. A `git push origin main` in US12 will be denied by GitHub, not by APort, unless the literal string is in `blocked_patterns`.

Existing thing not to reinvent: Claude Code's sandbox and Codex's seatbelt already do the path and network bounding. Use them; do not write a Gallivant path filter.

### F2. Blocker. Section 5, 6.9, 9. The agent runs as the operator's classic `gh` token with `repo` and `workflow` scope on every reachable org.

`gh auth status` on this machine: token `gho_...`, scopes `gist, read:org, repo, workflow`, stored in the keychain, and `gh auth token` works non-interactively. `git config credential.helper` is `store` and `~/.git-credentials` exists (69 bytes, mode 0600), so `git push` over https from any process running as this user uses a plaintext token without touching the keychain. A harness in a worktree inherits all of this. `repo` scope is read/write on every repository the account can access, including other orgs; `workflow` scope lets it push changes to `.github/workflows/*`, which then execute on GitHub's runners with that repo's secrets. This is the blast radius of one successful injection: not "the worktree", but every repo uchibeke can write to, plus whatever CI secrets those repos hold.

Change: add a prerequisite to section 9 and a principle to section 5.

> Identity. Gallivant and every harness it spawns use a dedicated GitHub machine account (`gallivant-bot` or similar) added as a collaborator with write access on participating repos only, authenticated with a fine-grained PAT limited to those repos with Contents: write, Pull requests: write, Issues: write, Actions: read, Checks: read, Metadata: read, and no Workflows permission. The daemon passes it as `GH_TOKEN` in the spawned harness environment and sets `GIT_CONFIG_GLOBAL` to a Gallivant-owned gitconfig whose credential helper is `!gh auth git-credential`, so the operator's keychain token and `~/.git-credentials` are never used by a run. The operator's own `gh` login stays for `gallivant attach` and for approving.

This also fixes F3 for free, because agent-authored comments then come from a different login than the operator.

### F3. Major. Section 6.3, 6.8. `trusted_authors` contains the same login the harness posts with, and trusted comments can be edited by anyone with write access.

Two problems. First, the harness replies to inline threads with `gh` as `uchibeke`, who is in `trusted_authors`, so every reply the agent posts is a trusted new inline comment on the next poll. The PRD's "replies the harness itself posted are never dispatched" needs a reliable way to tell them apart, and a login cannot be it. Second, GitHub lets any collaborator with write access edit another user's issue and review comments; the `user.login` stays the original author. On a repo with more than one writer, an edited trusted comment is a trusted injection with a spoofed author. Org membership does not help: the PRD's allowlist is by login, which is fine, but note that org owners can also add themselves as collaborators.

On the narrower question the brief asked: `user.login` from the REST API is not spoofable; display names are, and the PRD correctly filters on login. A human cannot register a login ending in `[bot]`, so `chatgpt-codex-connector[bot]` cannot be impersonated by a comment. What can be impersonated is the content, see F4.

Change, section 6.8 "Never dispatch" list, add:

> comments whose `updated_at` differs from `created_at` (edited after posting), comments whose author is the login Gallivant itself runs as, and comments created while a run for that PR was in progress. Compare `user.login` exactly, and require `user.type == "Bot"` for `reviewer_bot`.

### F4. Major. Section 6.9, 10. The reviewer bot and CI logs are laundering channels for untrusted text; quoting as data is a mitigation, not a control.

Codex's review is written by a model that read the PR diff, repo files, and whatever those files reference. A dependency README, a test fixture, a snippet copied from an issue: any of it can end up quoted verbatim inside a "trusted" P1 finding. CI logs are the same: test output prints file contents and dependency output. The fenced block plus "treat as feedback, not instructions" is the right prompt hygiene and should stay, but the PRD's risk table treats it as sufficient ("APort denies the dangerous actions regardless of prompt"), which F1 shows is false. The controls that actually bound a successful injection are the sandbox, the token scope, and the ruleset. The PRD should say so.

Change, section 10 row "Prompt injection through a trusted reviewer's comment or a CI log", replace the handling column with:

> Assume it will succeed sometimes. Quoted as data in the prompt. Blast radius bounded by: harness sandbox (worktree-only writes, allowlisted domains), machine-account token limited to participating repos with no Workflows permission, GitHub ruleset blocking the default branch, three-round cap, 30-minute timeout. APort logs the tool calls so the incident can be reconstructed.

Also cap CI log excerpts at 60 lines as written, and prefer `gh run view --log-failed` output, which already masks registered repository secrets as `***`.

### F5. Major. Section 6.3, 6.7, 9. `codex exec --full-auto` does not exist in 0.155.1, and the replacement changes the security model.

`codex exec --full-auto --help` returns `error: unexpected argument '--full-auto' found`. `codex exec --help` lists `--sandbox <read-only|workspace-write|danger-full-access>`, `--approve-for-me` ("Route approval requests through automatic review using the workspace-write sandbox"), and `--dangerously-bypass-approvals-and-sandbox`. There is no `-a/--ask-for-approval` on `exec` in this build. The brief's "verified environment facts" are wrong on this point.

`--approve-for-me` is a model deciding whether to let the agent leave the sandbox. That is the opposite of what the PRD wants. The unattended setting is `approval_policy = "never"` in `~/.codex/config.toml` (which section 9 already suggests) with `sandbox_mode = "workspace-write"`. Note that Codex's workspace-write sandbox denies network by default (`[sandbox_workspace_write] network_access = false`), so `git push` and `npm install` fail inside it until `network_access = true` is set, and once set, the Codex network boundary is gone entirely. Verify this against the 0.155.1 config docs before relying on it.

Change, section 6.7 Codex row and 6.3 config: replace `--full-auto` with `--sandbox workspace-write` and rely on `approval_policy = "never"` in config. Add to section 9: "Codex's sandbox has no per-domain allowlist. With `network_access = true`, Codex runs have open network from inside the worktree. Accept this for day one or keep Codex as reviewer only until the sandbox supports an allowlist."

### F6. Major. Section 9. "Switch the GitHub connector tools off approve" would let Codex merge PRs without a prompt.

`~/.codex/config.toml` has `github.merge_pull_request` at `approval_mode = "approve"` alongside `create_pull_request`, `add_comment_to_issue`, `add_review_to_pr`, `reply_to_review_comment`, `resolve_review_thread`, `update_pull_request`. The PRD's non-goal is "never merges". Removing approve from the whole connector contradicts it.

Change: "Set `approval_mode` to `never` only for `github.create_pull_request`, `github.add_comment_to_issue`, `github.reply_to_review_comment`, `github.update_pull_request`. Leave `github.merge_pull_request` and `github.add_review_to_pr` on `approve`, or remove the connector from daemon runs and use `gh` for everything." Using `gh` only is simpler and keeps one identity (F2).

### F7. Major. Section 6.7, 9, 6.11. Claude "auto mode plus sandbox" is not configured, and the PRD proposes removing the one read boundary that is.

`~/.claude/settings.json` has no `sandbox` key, so the Bash sandbox is off. `--permission-mode auto` is a classifier that decides prompts; it is not a sandbox. Section 9 proposes removing `blockReadsOutsideWorkingDirectories: true` for daemon runs, which is a real read boundary, in order to avoid prompts. There is a better lever: `claude -p --permission-prompts none` (present in 2.1.263: "anything that would prompt is denied automatically; the permission mode still decides everything else"). With that, a read outside the worktree is denied instead of prompting, the run continues, and the setting stays.

Change, section 6.7 Claude row: add `--permission-prompts none`. Section 9 first bullet: replace "Remove it for daemon runs" with "Keep it. Pass `--permission-prompts none` so out-of-tree reads are denied, not prompted. Enable the sandbox: `sandbox.enabled: true`, `sandbox.autoAllowBashIfSandboxed: true`, `sandbox.network.allowedDomains` listing github.com, api.github.com and the registries the repo needs." Verify the key names against the 2.1.263 settings reference; the intent is what matters.

### F8. Major. Section 6.5, 6.10. The PR body block is trusted input for recovery and can be planted by any PR author.

`gallivant up` re-registers "any open PR under roots whose body has a gallivant block". On a public repo anyone can open a PR with a body containing a block that names a `session` uuid, a `prd` path, a `branch`, and a `repo`. The daemon would then `claude -p --resume <their uuid>` (or fail), match a branch it did not create, and start dispatching that PR's CI failures to a session. Worst case is a fork PR whose CI log is attacker-authored being fed to a resumed session that then pushes to whatever branch the block names. Collaborators with write access can also edit the body of a real Gallivant PR.

Change, section 6.10: "Reconcile only PRs whose `user.login` is Gallivant's own login, whose `head.repo.full_name` equals `base.repo.full_name`, and whose branch starts with `gallivant/`. Validate every block field with a strict pattern (uuid, `docs/prds/[a-z0-9-]+\.md`, `owner/repo`, branch). A block that fails validation is logged and ignored, never registered." Keep `state.json` as the primary registry and the PR body as a recovery hint.

### F9. Major. Section 6.11, 6.7. APort's Codex hook cannot enforce Codex writes, and in enforce mode it denies multi-file patches.

`docs/frameworks/codex.md`: "`apply_patch` payloads that touch more than one file fail closed in the beta hook." `docs/FRAMEWORK_TOOL_MAPPING_AUDIT.md` line 87: "`ApplyPatch` may not emit hooks in some CLI builds (Codex issue #16732). APort cannot enforce what the host does not emit." So with APort on Codex in `enforce`, either the hook never sees the write, or it sees it and denies any patch touching two files, which is most fix runs. `Glob`, `List`, `LS` also fail closed on Codex. This is a functional blocker for Codex plus APort on day one and a security gap even in the best case.

Change: Codex support on day one means "Codex reviews, Claude Code fixes", or Codex fixes with APort in `warn` and the seatbelt as the only boundary, stated plainly. Move Codex-as-fixer to M2 with an acceptance criterion: "a multi-file fix completes under APort enforce on codex-cli >= the version where apply_patch emits PreToolUse".

### F10. Major. Section 6.9, 6.6, 10. Run logs are a secret sink with no retention, permission, or scrubbing rules.

`~/.gallivant/runs/<prd>/<n>.jsonl` is the harness's full `stream-json` output: every tool input and output, every file the agent read, every env var it printed, the CI excerpt, the comment bodies. APort's own audit log at `~/.claude/aport/audit.log` records tool inputs too. The PRD's scrubbing sentence covers only the CI excerpt going into the prompt, and "token patterns" is not defined. Regexes miss unprefixed secrets (cloud keys, base64 blobs, JWT bodies).

Change, section 6.6 and 6.9: "`~/.gallivant/` is created 0700, run logs 0600. Logs for a PR are deleted 7 days after it reaches `done` or `needs-human`. Nothing under `~/.gallivant/` is ever committed or served by command-center to anyone but localhost. Scrub CI excerpts with a small explicit list before they enter a prompt: `ghp_`, `gho_`, `github_pat_`, `AKIA`, `sk-`, `xox[abp]-`, `-----BEGIN`, `Bearer `, `Authorization:`, and anything matching `[A-Za-z0-9_-]{32,}` on a line that also contains `key`, `token`, `secret` or `password`. Never send `.env` contents." Also add `.env*` to the harness's own denied reads (F7 sandbox) since APort's read block does not cover Bash.

### F11. Minor. Section 6.1, 6.11. launchd runs the daemon as the operator with the whole home directory and keychain.

A LaunchAgent runs in the user's login session: keychain unlocked, `~/.ssh`, `~/.aws`, `~/.codex/auth`, `~/.config/opencode/opencode.json` (plaintext bearer token, which the PRD already notes), and 60 repos' `.env` files all readable. Every escape from the sandbox is a full account compromise. The existing `io.aport.weekly-content.plist` also writes its log inside a repo directory; do not copy that pattern.

Change, section 6.11: "The daemon runs as the normal user. This is a known limit on the Mac; the sandbox, the machine-account token (F2) and the domain allowlist are what stand between an escaped run and the operator's home directory. The plist sets an explicit minimal `PATH`, no `EnvironmentVariables` holding secrets, logs under `~/.gallivant/`, `ThrottleInterval` 60. On the Hetzner box, run as a dedicated unprivileged user with only the worktrees and `~/.gallivant` writable." A separate macOS user for the daemon is the right fix if this ever hosts other people's repos; not day one.

### F12. Minor. Section 6.12. ntfy.sh topics are unauthenticated.

Anyone who guesses the topic name can read the messages (private repo names, PR links) and post fake "ready-for-human" notifications. Change: "Topic is 32 random characters generated by `init`, or self-hosted ntfy with an access token. Messages contain the PR URL only, never the diff or comment text."

### F13. Minor. Section 6.11. Warn-first rollout on an unattended system is zero enforcement for the first PR.

"Enforcement starts in warn for the first PR, then block" makes sense for a person tuning policy interactively. With nobody watching, warn is just off. APort's own docs say warn is for tuning. Change: "Enforcement `enforce` from the first run. Tune the passport by reading the audit log after a manual `claude -p` run in M0, not by running a PR in warn."

### F14. Minor. Section 6.4, 6.10, 8 (M3). Issue-label input turns issue bodies into start prompts.

On a public repo the issue author is untrusted; the `gallivant` label can only be applied by triage-plus, which is a gate on who starts a run but not on what the prompt says. Change, M3: "An issue starts a run only if the label was added by a login in `trusted_authors` (check the `labeled` event actor via `gh api .../issues/{n}/events`) and the issue body is quoted as data in the start prompt the same way review comments are."

### F15. Minor. Section 3, 6.3, 8 (M4). Open-source hygiene items.

The config carries absolute binary paths and a login; fine. Things that must never ship in the repo: the passport JSON (APort's own `local-overrides/templates/passport.local.json` contains phone numbers, so do not copy it as a template), `~/.gallivant/`, the ntfy topic. Add a `SECURITY.md` stating the trust model in one paragraph: "Gallivant acts with the credentials you give it. Give it a machine account and a scoped token. Comments from logins outside `trusted_authors` are ignored, but text from trusted reviewers and CI logs is still untrusted input; the sandbox and token scope are the controls." Users of a public fork should also be told that `reviewer_bot` must be the exact bot login and `user.type` is checked.

## 3. What to cut to fit day one in four hours

- Codex as a fixer (F5, F9). Keep Codex as the reviewer and `@codex review` re-trigger. Claude Code is the only fixer on day one. This also removes the Codex sandbox network question and the APort Codex beta hook from the critical path.
- APort Repository Guard workflow (`npx ... github`). It is report-only, needs a hosted passport to say anything, and a GitHub ruleset does the actual blocking. Move to M4.
- Warn-mode rollout. Start in enforce (F13).
- Recovery from PR bodies (6.10 reconcile). Keep `state.json` and add reconcile in M3 with the F8 validation.
- The 5-minute 👀 retry. Post `@codex review` once; if there is no new review in two polls, post once more. Same effect, no reaction polling.

Time saved goes to the two prerequisites that are not optional: creating the machine account and fine-grained PAT (F2, about 20 minutes) and enabling the Claude sandbox with a domain allowlist and `--permission-prompts none` (F7, about 20 minutes, mostly testing that `git push` and `npm ci` still work through it).

## 4. Operator asks the PRD failed to account for

- Ask 6, "APort enforces limits on the harnesses (allowed write folders, etc.)". The PRD promises this and the local evaluator cannot deliver it for shell commands (F1). The honest version is: APort audits every tool call and denies a short list of literal patterns and out-of-tree Write/Read tool calls; the harness sandbox does the folder bounding. If the operator wants APort to be the thing that bounds Bash writes, that is a feature request against aport-agent-guardrails (parse `cwd` and redirect targets, parse `git push` remote and refspec), not something Gallivant can configure today.
- Ask 9, open source. A public repo running Gallivant is exactly where F3 (edited trusted comments), F8 (planted PR blocks) and F14 (issue bodies) bite. None of the three is in the PRD's risk table.
- Ask 2, no clicks. The verified facts list `codex exec --full-auto`, which 0.155.1 rejects (F5). Codex day-one support will not work as specified even before security is considered.
- Ask 7, sessions restartable from the PR. Restart from GitHub means trusting GitHub-side data; F8 is the cost of that ask and needs the validation rules in the PRD.
