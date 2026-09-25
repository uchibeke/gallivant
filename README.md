# Gallivant

Write a PRD, mark it ready, go outside.

Gallivant starts a coding-agent session for a PRD, and then keeps the pull request moving on its own: it watches for reviewer findings, human review comments and failed checks, resumes the session that opened the PR to fix them, pushes, asks the reviewer to look again, and stops with one notification when the PR is ready for a person or stuck.

It supports Claude Code and Codex as fixers, with [APort](https://github.com/aporthq/aport-agent-guardrails) hooks on both. The session that opened the PR is the session that fixes it, resumed by session id. Every PR carries the harness and session id in its body, so the loop can be rebuilt from GitHub after local state is lost.

Node 22, zero dependencies, `gh` for all GitHub access, ntfy for notifications. No GitHub App, no webhook server, no database.

## Five-minute path

```bash
git clone https://github.com/uchibeke/gallivant && cd gallivant
node bin/gallivant.mjs doctor          # prints the config to write, from your machine's values
# write ~/.gallivant/config.json, then follow each FAIL line until doctor passes
cp templates/prd.md path/to/repo/docs/prds/your-prd.md   # write it
node bin/gallivant.mjs ready path/to/repo/docs/prds/your-prd.md    # the contract; flips it to ready when it passes
node bin/gallivant.mjs start path/to/repo/docs/prds/your-prd.md
node bin/gallivant.mjs up              # in a terminal tab; on a Mac it holds off sleep itself
node bin/gallivant.mjs status
```

The full setup, including the scoped token, the branch ruleset and the APort installs, is in [docs/install.md](docs/install.md). It takes about an hour the first time.

## How the loop runs

```
PRD (status: ready)  →  gallivant start  →  session in its own checkout  →  PR opened
                                                                              │
              ┌───────────────────────────────────────────────────────────────┘
              ▼
      tick every 2 minutes: reviewer review, trusted inline comment, failed check, @gallivant fix
              │
              ▼
      resume the session with the feedback  →  push  →  "@codex review"  →  round += 1
              │
              ├── checks green and reviewer clear   →  ready-for-human, one notification
              └── 3 rounds, conflict, no push, silence  →  needs-human, one notification, `gallivant why`
```

## Commands

| Command | What it does |
|---|---|
| `gallivant doctor [--send] [--probe]` | Install checklist and health probe. Every failing line prints its fix. |
| `gallivant ready <prd.md> [--check]` | Check a PRD against [the contract](docs/prd.md); flip it to ready only when every rule passes. |
| `gallivant start <prd.md>` | Start a session for a ready PRD in its own checkout. Refuses anything that fails the contract. |
| `gallivant register <pr-url>` | Watch a PR you opened by hand, or reset a stopped one. |
| `gallivant up` | The daemon. Recovers from GitHub on boot, then ticks. |
| `gallivant status [--all] [--json]` | What needs you, what is running, whether the daemon is alive. |
| `gallivant serve [--port 8791]` | The tracker: a read-only page on 127.0.0.1 with every entry, every run and live log tailing. |
| `gallivant why <repo>#<pr>` | Why a PR stopped, what was dispatched, what the harness last said. |
| `gallivant remove <repo>#<pr>` | Forget an entry. The PR and the checkout are left alone. |

The PRD contract is in [docs/prd.md](docs/prd.md). Details in [docs/commands.md](docs/commands.md), config keys in [docs/config.md](docs/config.md), what the guardrails do and do not cover in [docs/guardrails.md](docs/guardrails.md), and the module map in [docs/architecture.md](docs/architecture.md). The product spec is [SPEC.md](SPEC.md); the audit that shaped it is under `docs/audit/`.

## Status

Version 0.1. Claude Code and Codex fixers, the review and CI loop, recovery from GitHub, ntfy notifications, the read-only tracker. Not yet: PRD queueing, GitHub-issue input, OpenCode, a service installer. See the milestones in the PRD.

Apache-2.0.
