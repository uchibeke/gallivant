# Gallivant

Write a PRD, mark it ready, go outside.

Gallivant starts a coding-agent session for a PRD, and then keeps the pull request moving on its own: it watches for reviewer findings, human review comments and failed checks, resumes the session that opened the PR to fix them, pushes, asks the reviewer to look again, and stops with one notification when the PR is ready for a person or stuck.

It implements adapters for Claude Code, Codex, Gemini CLI, OpenCode and Goose, with [APort](https://github.com/aporthq/aport-agent-guardrails) hooks on Claude Code and Codex. Claude/Codex have production evidence; the current Gemini, OpenCode and Goose coding probes have blocked or failed results from native permissions, provider setup, and live-test defects. See the [version/provider support matrix and live evidence](docs/audit/harness-live-validation.md) before selecting a harness. The loop resumes the recorded session that opened the PR. Every PR carries the harness and session id in its body, so the loop can be rebuilt from GitHub after local state is lost.

Node 22, `gh` for all GitHub access, ntfy for notifications. One bundled TOML parser preserves Codex configuration during isolated preparation. No GitHub App, webhook server or database.

Repository review learning adds bounded collection and exact candidate review through
`gallivant learn`. Approved-memory signing and activation are tested with disposable
OpenSSH keys, but production learning remains **UNQUALIFIED and collection only**:
installed worker/extractor isolation still needs implementation and live qualification.
Learning defaults off, requires human review, and cannot change task or completion
gates. See [learning](docs/learning.md) and its [qualification record](docs/audit/learning-qualification.md).

With Claude or Codex configured, you can also start from natural language:
`gallivant task "Add CSV export without new dependencies" --harness claude`
prepares an isolated, validated brief. Add `--run` to authorize
implementation once material questions are resolved. [Task operations](docs/tasks.md)
cover preparation adapter restrictions, stdin, resumable questions, structured
exports and separate live qualification.

## Five-minute path

```bash
git clone https://github.com/uchibeke/gallivant && cd gallivant
npm link                               # puts `gallivant` on your PATH; see Install below for the alternatives
gallivant doctor                       # prints the config to write, from your machine's values
# write ~/.gallivant/config.json, then follow each FAIL line until doctor passes
cd path/to/your/repo                   # every command below works from anywhere inside it
gallivant new your-prd                 # writes docs/prds/your-prd.md from the packaged template
gallivant ready docs/prds/your-prd.md  # the contract; flips it to ready when it passes
gallivant start docs/prds/your-prd.md  # runs the session and brings the daemon up to watch it
gallivant status                       # what needs you, what is running, whether the daemon is alive
```

## Install

Use Node 22 or newer. npm installs the locked TOML parser; packed releases include
it. Run `npm ci` before running directly from a fresh source checkout.

```bash
npm link                    # from the clone: a symlink into your node bin directory. Undo with `npm unlink -g gallivant`.
npm i -g .                  # a copy rather than a link, so edits to the clone do not take effect until you rerun it
npm i -g github:uchibeke/gallivant   # straight from the repository, no clone
```

`npm link` is the one to use while the tool is still changing, because the command always runs the working tree. If
you would rather not touch your global node directory at all, `alias gallivant="node ~/path/to/gallivant/bin/gallivant.mjs"`
in your shell profile does the same job.

Check it with `gallivant --help` from a directory that is not the clone. If the shell cannot find it, your npm
global bin is not on PATH: `npm prefix -g` names the directory, and its `bin` subdirectory is what has to be there.

Gallivant is not published to the npm registry. It reads `~/.gallivant/config.json` wherever it runs from, so the
command works in any directory and always acts on the same registry.

The full setup, including the scoped token, the branch ruleset and the APort installs, is in [docs/install.md](docs/install.md). It takes about an hour the first time.

## How the loop runs

```
PRD (status: ready)  →  gallivant start  →  session in its own checkout  →  PR opened
                                                                              │
              ┌───────────────────────────────────────────────────────────────┘
              ▼
      tick every 2 minutes: reviewer review, trusted inline comment, failed check, /fix
              │
              ▼
      resume the session with the feedback  →  push  →  ask the reviewer again  →  round += 1
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
| `gallivant chain <name> <first.md> <next.md> ...` | Queue ready PRDs in order. Start each successor only after you merge the preceding PR. |
| `gallivant register <pr-url>` | Watch a PR you opened by hand, or reset a stopped one. |
| `gallivant up` | The daemon. Recovers from GitHub on boot, then ticks. |
| `gallivant status [--all] [--json]` | What needs you, what is running, whether the daemon is alive. |
| `gallivant serve [--port 8791]` | Local tracker with every run, live logs, PR recheck and session updates. |
| `gallivant recheck <handle>` | Recheck a stopped PR without resetting its round budget. |
| `gallivant say <handle> --note "..."` | Queue an update for the same session after its active run finishes. |
| `gallivant why <repo>#<pr>` | Why a PR stopped, what was dispatched, what the harness last said. |
| `gallivant remove <repo>#<pr>` | Forget an entry. The PR and the checkout are left alone. |

The PRD contract is in [docs/prd.md](docs/prd.md). Details in [docs/commands.md](docs/commands.md), config keys in [docs/config.md](docs/config.md), what the guardrails do and do not cover in [docs/guardrails.md](docs/guardrails.md), and the module map in [docs/architecture.md](docs/architecture.md). The product spec is [SPEC.md](SPEC.md); the audit that shaped it is under `docs/audit/`.

## Plan a sequence

Gallivant automates the work; a human accepts each milestone into the base branch. Prepare two or more ready PRDs
in the same repository, then queue them once:

```sh
gallivant chain launch docs/prds/foundation.md docs/prds/integration.md docs/prds/launch.md
gallivant chain launch
```

The existing daemon starts the first PRD and handles its implementation, checks and review. You merge its PR; the
daemon confirms that merge on the planned base and starts the next PRD from the updated base. Closing a PR without
merging stops the chain. Gallivant never merges for you, and marking a run ready does not unlock its successor.

A multi-day plan can wait while you are away from a merge decision. Make each PRD a cohesive, reviewable milestone
so small implementation steps do not each demand approval. Independent work can still run alongside a chain.
See [chains](docs/chains.md) for editing the queued plan, recovery and cancellation.

## Status

Version 0.1. Five implemented adapters, the review and CI loop, recovery from GitHub, ntfy notifications, the local tracker with recovery controls, and sequential PRD chains gated on human merges. Adapter implementation does not establish access through a provider subscription. The [latest audit](docs/audit/harness-live-validation.md) distinguishes production evidence, blocked live attempts and fixtures, including the configured Claude binary (2.1.263) versus the older PATH binary (2.1.177). Gemini, OpenCode and Goose are not yet verified for unattended coding and same-session Git pushes on this machine.

After resolving the documented blockers, repeat the opt-in live suite from a source checkout with `npm run test:live-harnesses -- --live`. The report also gives exact commands for the named Goose and OpenCode Console BYOK batches; these connections are separate from Zen/Go subscriptions. DeepSeek is excluded from new calls; Tencent remains deferred. The suite uses existing settings, performs sequential bounded model calls, and keeps raw logs privately outside the repository. `npm test` never runs this suite. These disposable local-remote tests do not prove GitHub review/completion behavior: the next step is an authorized Gallivant PRD through PR creation, review/CI-triggered continuation and the completion gate, as described in the report.

Not yet: mid-turn message delivery, Telegram, GitHub-issue input, cursor-agent (its event stream is unverified), or a service installer. See the milestones in the PRD.

Apache-2.0.

Managed coding sessions through the Agents API are available as an explicit
`openai-agents` selection. See [account/environment setup, recovery and verification](docs/openai-agents.md). Live qualification is separately opt-in and remains unverified when access prerequisites are absent.

`codex-cloud` uses the supported Codex 0.160.0 Cloud CLI on a trusted operator
worker, with new dispatch unavailable until a supported interface verifies the
selected environment's connected repository. Owned-task inspection and recovery
remain available; offline fixtures cover approved snapshots, successor corrections
and one task/PR. See
[Cloud setup, supported controls and recovery](docs/codex-cloud.md). Native
continuation/cancellation and delegated public authentication are unavailable;
live qualification remains unverified.
