# Gallivant

**Give an agent a task. Let the review loop run. Go outside.**

Gallivant turns a repository task into a reviewed pull request. It runs a coding
agent in a separate checkout, opens the PR, watches CI and reviewer feedback, and
continues the same session until the PR is ready for you. You decide what merges.

```text
Your task → agent works → PR → review + CI → fixes → ready for you
                                 ↑___________|
```

## Set up in one command

Run this inside the Git checkout you want to work in:

```sh
npx --yes @uchibeke/gallivant init --harness codex    # or: --harness claude
```

The setup flow below requires **0.2.1 or newer**. At verification on 2026-10-20,
npm's `latest` was still 0.2.0, whose `init` only creates the config. A maintainer
must [publish 0.2.1](docs/releasing.md) before this command provides repository
registration, repeat safety and the diagnostic report described below.

`init` writes a private config at `~/.gallivant/config.json`, records this
repository, creates a separate directory for task checkouts, and ends with the
same report as `gallivant doctor`: one line per check and the exact fix for each
failing one. Run it again in another repository to add that repository; nothing
else in the config changes.

Before you run it you need:

| Prerequisite | Check | If it fails |
| --- | --- | --- |
| macOS or Linux, Node 22+, Git, jq | `node --version`, `git --version`, `jq --version` | install from your package manager |
| GitHub CLI signed in | `gh auth status` | `gh auth login` |
| Codex CLI 0.160.0+ signed in | `codex login status` | `codex login` |
| or Claude Code 2.1.263+ signed in | `claude auth status` | `claude auth login` |

A signed-out `gh` or harness stops `init` before it writes anything, and the
message repeats the login command above. `init` never asks for passwords, tokens
or browser cookies; sign in with each tool's own flow. Inference is billed to
your own provider account.

`npx` downloads and runs the package on demand. Nothing is installed globally
and no `gallivant` command is added to your PATH. If you want one:

```sh
npm install -g @uchibeke/gallivant
```

The rest of this page writes `gallivant`. With `npx`, read that as
`npx --yes @uchibeke/gallivant`. Contributors who want to run from a source
checkout: see [installing from source](docs/install.md#install-from-source).

## Finish what setup cannot do for you

`doctor` names these. `init` does not do them, because each needs a decision
from you or an account with a third party.

- **Reviewer.** The default loop waits for the Codex GitHub review integration
  (`chatgpt-codex-connector[bot]`). Enable it on the repository, configure
  another reviewer, or set `"reviewer": null` in the config to rely on CI and
  trusted human feedback. Without one of these, the first PR waits for a review
  that never arrives. See [the reviewer key](docs/config.md#the-reviewer-object).
- **Branch protection.** `doctor` prints the `gh api` call that creates a
  ruleset blocking direct and force pushes to the default branch. Run it
  yourself. Setup never changes repository settings.
- **Harness guardrails.** The APort hook for Claude or Codex is installed by its
  own `npx @aporthq/aport-agent-guardrails` command, and Codex asks you to trust
  the hook inside its own interface. Setup does not install hooks.
  [Guardrails](docs/guardrails.md) explains what each control covers.
- **Spend.** Defaults are 30 fix rounds per PR and a 5 USD per-run cap that
  only Claude enforces natively. Review [limits](docs/config.md) before
  unattended work.

## Run a first task

```sh
gallivant task "Document how to run the existing tests in CONTRIBUTING.md. Use the commands already defined in the repository. Change documentation only." \
  --harness codex --verify 'git diff --check' --run
gallivant start
```

What happens: `task` uses your harness to prepare a brief, which is a paid
inference call, and may ask you questions. `--run` authorizes implementation
once the brief is ready; omit it to read the draft first and follow the printed
`Next` action. The agent then works in a clone under `~/.gallivant-worktrees`,
pushes a branch, opens a PR against the default branch, and the daemon watches CI
and the reviewer, sending each round of feedback back to the same session.
`gallivant start` opens the dashboard at **http://127.0.0.1:8791** and keeps
the daemon running; closing the browser does not stop the work.

Expected outcome: a PR with a small CONTRIBUTING.md change and a completion
receipt in its body, and `gallivant status` showing the entry as **ready** once
checks, reviewer and the acceptance gate pass. You review and merge. Missing
access, failing checks or an exhausted round allowance produce an inspectable
stop instead; `gallivant why <handle>` explains it.

### Bring a written brief

```sh
gallivant new add-csv-export
# Edit docs/prds/add-csv-export.md: outcome, scope, acceptance criteria and checks.
gallivant ready docs/prds/add-csv-export.md --check
gallivant ready docs/prds/add-csv-export.md
gallivant start docs/prds/add-csv-export.md
```

You do not have to write a PRD yourself. Both entry points use a validated brief
and the same review loop. [Writing briefs](docs/prd.md) · [Task commands](docs/tasks.md).

## How the review loop runs

1. The agent implements the brief, runs the brief's verification commands and
   opens the PR.
2. Each tick (every two minutes by default) the daemon reads CI and reviewer
   state. A blocking review or a failing check starts a fix round in the same
   agent session, and the fix is pushed to the same PR.
3. Rounds stop at `max_iterations` (30 by default), when the reviewer stays
   silent for `stall_hours`, or when a run exceeds its timeout. Every stop is
   recorded with a reason you can read with `gallivant why`.
4. **Ready** means the configured checks, reviewer and acceptance gate passed.
   Nothing merges automatically. Natural-language tasks stop at a review
   handoff by default; choose `integrated` to keep watching until you merge.

## While it works

| What you need | Action |
| --- | --- |
| Follow runs | `gallivant start` or `gallivant status` |
| Correct the agent | **Send message** on its dashboard page; context and existing work are preserved |
| Inspect a stop | `gallivant why <handle>` |
| Continue after fixing a blocker | `gallivant resume <handle>` or **Resume agent** |
| Refresh review and CI | **Recheck PR**; this does not resume a failed agent |
| Keep the dashboard without opening a browser | `gallivant start --no-open` |
| Run only the daemon | `gallivant start --no-server` |
| Stop monitoring and the standalone dashboard | `gallivant down`; existing agent processes continue |

If services fail to start after a task is accepted, retry `gallivant start`
without the PRD path. Do not submit the same task again.

Temporary connection failures have bounded same-session recovery. For DNS errors,
use `gallivant doctor --network https://api.anthropic.com` with your provider's
actual HTTPS origin. [Recovery and troubleshooting](docs/network-recovery.md).

## More than one task

```sh
gallivant chain launch docs/prds/foundation.md docs/prds/integration.md docs/prds/launch.md
```

The next milestone starts only after its predecessor is merged into the planned
base. You can plan longer work while retaining the merge decision.
[Chaining tasks](docs/chains.md).

## Harness support

`init --harness` accepts `codex` and `claude`. Other adapters are configured by
hand in `config.json`; see [configuration](docs/config.md#execution-providers).

| Harness (`harness` key) | Runs on | Prepare requests | Implementation status |
| --- | --- | --- | --- |
| Claude Code (`claude`) | Your host | Yes | Recommended; live usage evidence |
| Codex CLI (`codex`) | Your host | Yes, 0.160.0+ | Recommended; live usage evidence |
| Gemini CLI (`gemini`) | Your host | Written PRDs only | Adapter implemented; unattended end-to-end qualification incomplete |
| OpenCode (`opencode`) | Your host | Written PRDs only | Adapter implemented; unattended end-to-end qualification incomplete |
| Goose (`goose`) | Your host | Written PRDs only | Adapter implemented; unattended end-to-end qualification incomplete |
| OpenAI Agents API (`openai-agents`) | OpenAI-hosted sandbox | Yes, text-only | Hosted adapter implemented; eligible API account, explicit model/environment and live qualification required |
| Codex Cloud (`codex-cloud`) | Codex Cloud | No | New dispatch disabled until the selected environment's repository binding can be verified |

Local Codex, Codex Cloud and the Agents API are distinct integrations. Local
Codex and Claude work independently of the Cloud dispatch restriction.
`openai-agents` supports remote progress, continuation, cancellation and artifact
retrieval; the coordinator verifies returned changes and publishes the PR.
Implemented transport support is not a claim that every account has access or
that the full live lifecycle has passed qualification.

For local harnesses, provider and model selection belongs to that harness's own
configuration. Gallivant has no general per-task local model router and does not
turn a provider API key into a configured harness automatically. Hosted Agents
requires an explicit authorized model; there is no automatic model fallback.
[Hosted setup](docs/install.md#hosted-agents-api-instead-of-a-local-cli) ·
[Detailed capabilities](docs/config.md#execution-providers) ·
[Recorded qualification](https://github.com/uchibeke/gallivant/blob/main/docs/audit/harness-live-validation.md).

## Feature map

| Capability | What you can do | Guide |
| --- | --- | --- |
| Task intake | Prepare a brief from a request, answer clarification questions, inspect revisions and authorize the ready task | [Tasks](docs/tasks.md) |
| Written briefs and context | Define acceptance criteria, verification commands and carried source files | [PRDs](docs/prd.md) |
| Review loop | Watch CI and trusted feedback, continue corrections, recover bounded connection failures and inspect stops | [Commands](docs/commands.md), [recovery](docs/network-recovery.md) |
| Run controls | Message, resume, recheck or cancel from the CLI/dashboard; inspect saved progress and logs | [Dashboard](docs/app.md) |
| Sequential plans | Queue dependent briefs with a merge gate between milestones | [Chains](docs/chains.md) |
| Completion checks | Evaluate acceptance evidence with APort or the explicit local evaluator; choose review handoff or watching for merge | [Guardrails](docs/guardrails.md), [milestones](docs/tasks.md#choose-the-delivery-milestone) |
| Notifications | Configure transition notifications through ntfy | [Configuration](docs/config.md) |
| Embedding and integrations | Use versioned task-delivery operations, Node coordination, MCP and plugin packaging; deployment is separate | [Task delivery](docs/task-delivery.md) |
| Review learning | Collect historical feedback and inspect candidates; rule activation remains unqualified | [Learning](docs/learning.md) |

The [command index](docs/commands.md#command-index) covers every top-level CLI
command and points to the task and learning subcommands. Run `gallivant --help`
for the installed version's flags.

## What to expect

- **Your machine coordinates the work.** Keep it awake, online and running the
  daemon, including when execution is hosted. Gallivant is not a managed service.
- **Your accounts pay for inference.** Subscriptions and API credits differ.
  There is no automatic provider fallback. Review [limits](docs/config.md) before
  unattended work; the default review allowance is 30 rounds.
- **Your permissions apply.** Scope GitHub access to the required repositories.
  Harness permissions, OS sandboxing and optional APort checks are different
  controls. [Security boundaries](docs/guardrails.md).
- **Ready does not mean merged.** Natural-language tasks default to stopping at a
  qualified review handoff. Choose `integrated` to keep watching for your merge.
  Written-PRD runs retain their monitoring behavior. No mode authorizes automatic
  merge, release or deployment. [Delivery milestones](docs/tasks.md#choose-the-delivery-milestone).
- **Learning is experimental.** Review feedback can be collected, but production
  activation of learned rules is not qualified. [Learning](docs/learning.md).

## Documentation

[Getting started](docs/install.md) · [Agent setup](docs/agent-setup.md) ·
[Commands](docs/commands.md) · [Configuration](docs/config.md) ·
[Dashboard](docs/app.md) · [All guides](docs/README.md)

**Asking a coding agent to set this up?** Give it the
[setup-agent instructions](docs/agent-setup.md). They cover inspection, the
`npx` command, the points where your login or decision is required, and what a
setup run may not do on its own.

Embedding the same workflow in another application? See
[task delivery](docs/task-delivery.md). Installing this CLI does not deploy a
hosted service or publish a chat plugin.

[Contributing](CONTRIBUTING.md) · [Security reports](SECURITY.md) ·
[Releasing](docs/releasing.md) · [Apache-2.0 license](LICENSE)
