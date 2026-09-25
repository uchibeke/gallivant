# Audit brief (shared by all auditors)

> Note: the document these audits call `PRD.md` was renamed `SPEC.md` on 2026-09-25, because it is a product
> specification and does not meet the PRD contract this tool enforces. The audits are left as written.

Audit target: /Users/uchi/Downloads/projects/gallivant/PRD.md (version 0.2, pre-audit).

## What the operator asked for, in their own priorities

1. Give it a contract (PRD), go to bed, work continues. PRs get picked up and fixed on their own. Opened issues get picked up too.
2. Biggest pain today: clicking to approve in Claude Code, Codex and OpenCode. Second: Codex reviews new PRs, but a human must prompt a harness to address findings and then comment `@codex review` again after the push. Third: PRDs must have user stories and acceptance criteria; the operator will drive the PRD process by hand for 30 to 60 minutes a day for now, persona review of PRDs is later.
3. When a PR is ready after several review rounds, get an email or text (add-on).
4. No lock-in to Claude Code or any provider. Start locally on a Mac. A remote box (Hetzner/Contabo) later.
5. The existing OpenClaw-to-Telegram bot streams everything and gets ignored. Notifications must be rare.
6. APort (the operator's own product, aport-agent-guardrails) enforces limits on the harnesses (allowed write folders, etc.). Must be in from day one.
7. PRs carry harness + session id so a fix resumes the session with context. Sessions poll for comments and track the latest fixed one. A pre-PR hook may start the watcher. Sessions open in iTerm is acceptable. A script starts sessions daily after PRDs are ready. Restartable at any time; the PRD/PR carries what is needed to restart. Command-center (existing local tool) manages all PRDs and could show live sessions.
8. Claude Code and Codex supported from day one. OpenCode after.
9. It will be open source.
10. The operator wants to be productive with it within the next few hours.
11. Do not over-engineer. Do not reinvent the wheel. Most things exist; reuse them.

## Verified environment facts (2026-09-23)

- Claude Code 2.1.263: `claude -p --session-id <uuid>` to start, `claude -p --resume <uuid>` to resume headless, `--fork-session`, `--from-pr <n>` (interactive picker of sessions linked to a PR; sessions are auto-linked when Claude creates the PR), `--permission-mode auto`, Bash sandbox, `/autofix-pr` (cloud auto-fix that watches a PR for CI failures and review comments). PreToolUse hooks run even under bypass permissions.
- Codex 0.155.1: `codex exec --json --full-auto`, `codex exec resume <id> --json "<prompt>"`, `codex exec fork`, hooks via `.codex/hooks.json` (project hooks need the project `.codex` layer trusted) or global, `--dangerously-bypass-hook-trust` exists.
- OpenCode 1.18.31: `opencode run --format json --auto`, `opencode run -s <id>`, `--fork`.
- Codex GitHub review: automatic on PR open only; `@codex review` comment re-triggers; reviewer login `chatgpt-codex-connector[bot]`; only flags P0/P1; sometimes ignores the first trigger after inactivity; `@codex fix ...` starts a cloud chat that can push.
- APort aport-agent-guardrails (Apache-2.0, npm + PyPI): `npx @aporthq/aport-agent-guardrails claude-code` installs a PreToolUse hook with matcher "*" and passport at `~/.claude/aport/passport.json`, enforcement `enforce` default or `--enforcement=warn`; `... codex` installs a beta command hook (`.codex/hooks.json`, `--global` available); `... github` writes an APort Repository Guard workflow (report-only first). Local source: /Users/uchi/Downloads/projects/aport-agent-guardrails (docs/frameworks/claude-code.md, codex.md, GITHUB_PROTECTION.md).
- command-center: /Users/uchi/Downloads/projects/command-center, zero-dependency Node 22 ESM, localhost:8790, already has harness argv templates for claude/codex/opencode/cursor, detached runs with SSE log streaming (lib/run.mjs), auto-discovers git repos under ~/Downloads/projects. No GitHub polling, no Telegram, no Docker/systemd.
- `gh` 2.100 authenticated as uchibeke. Docker not installed. Postgres 14 installed. Node 22 via nvm. `claude` and `codex` are wrapped by a shell function from vibetime-cli (session tracker).
- Local config today: Claude settings has `blockReadsOutsideWorkingDirectories: true` (prompts even in auto/bypass on >= 2.1.257); Codex config has no approval_policy and GitHub connector tools set to approval_mode approve; OpenCode has no permission block.
- Existing alternatives already evaluated: Claude Code auto-fix, gh-aw (multi-engine markdown workflows on GitHub runners), Cyrus, sortie, no_human, Paperclip, OpenClaw.

## Output format for every auditor

Write your report to /Users/uchi/Downloads/projects/gallivant/docs/audit/<your-persona-slug>.md with:

1. Verdict in one line: approve / approve with changes / reject, and why.
2. Findings, most important first, at most 15. Each finding: severity (blocker / major / minor), PRD section, the problem in two sentences, and the concrete change (exact replacement text, a decision, or a cut). Flag any place the PRD reinvents something that already exists and name the existing thing.
3. What to cut to make day one fit in four hours, if anything.
4. Anything from the operator's asks above that the PRD failed to account for.

Do not edit PRD.md. Read whatever you need on disk (aport docs, command-center, harness --help) to verify claims. Be specific and blunt. Plain prose, no marketing language, no em-dashes.
