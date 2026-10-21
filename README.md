# Gallivant

**Give an agent a task. Let the review loop run. Go outside.**

Gallivant turns repository tasks into reviewed pull requests. It starts an agent,
watches CI and reviewer feedback, and continues the same session to fix issues.
You can follow progress and send corrections from a local dashboard. **You decide
what gets merged.**

Use it for code, documentation, research or content that belongs in a GitHub
repository. Start with a plain-language request or a written brief.

```text
Your task → agent works → PR → review + CI → fixes → ready for you
                                 ↑___________|
```

## Install

You need **macOS or Linux, Node 22+, Git, GitHub CLI and jq**. For your first run,
use signed-in **Codex CLI 0.160.0+** or **Claude Code 2.1.263+**. Provider usage is
billed to your own account. [Full prerequisites](docs/install.md).

Check the [registry version](https://www.npmjs.com/package/@uchibeke/gallivant). Once a
version is available, install it with `npm install -g @uchibeke/gallivant`. If the package
is not published yet, install from source:

```sh
git clone https://github.com/uchibeke/gallivant.git
cd gallivant
npm ci --ignore-scripts
npm link
gallivant --version
```

[Release status and checks](docs/releasing.md).

## Set up

```sh
gh auth status
codex login status                    # use Claude sign-in if you choose Claude
gallivant init --harness codex         # or --harness claude
gallivant doctor
```

`init` creates local configuration and a separate task-checkout directory. It
preserves existing config, credentials and global agent settings. Follow the
fixes from `doctor`; [setup instructions](docs/install.md) cover authentication,
harness permissions and repository protection.

Enable the Codex GitHub review integration on the target repository, or choose
another reviewer. If you want CI and trusted human feedback without a review bot,
explicitly configure `"reviewer": null`. The default waits for Codex review.

**Prefer an agent to handle setup?** Give it the
[setup-agent instructions](docs/agent-setup.md). They cover inspection, installation,
configuration, verification and the points where your input is required.

## Run your first task

Inside a repository you can push to. This example uses Codex; if you configured
Claude, replace `--harness codex` with `--harness claude` before running it:

```sh
cd /path/to/your/repository
gallivant task "Document how to run the existing tests in CONTRIBUTING.md. Use the commands already defined in the repository. Change documentation only." \
  --harness codex --verify 'git diff --check'
# Review the draft, then substitute its returned task ID and revision:
gallivant task start TASK_ID --revision REVISION --run
gallivant start
```

`task` prepares a brief and asks for missing information. Review the draft and
answer any questions, then use the printed `Next` action to approve that revision
with `task start --run`. Preparation always returns for review, even if its
command includes `--run`. Preparation also uses inference.

`gallivant start` opens **http://127.0.0.1:8791** and ensures the daemon is running.
Without a PRD path, it does not submit another task. Closing the browser does not
stop the work.

With the default configuration, **ready** means the configured checks, reviewer
and acceptance gate passed. Inspect status for skipped-gate warnings, review the
PR and merge when you choose. Missing access, evidence or exhausted limits produce
an inspectable stop instead.

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

| Need | Guide |
| --- | --- |
| Install and run your first task | [Getting started](docs/install.md) |
| Start from a request, answer questions, inspect results | [Natural-language tasks](docs/tasks.md) |
| Select the typed delivery profile and planner route for a request | [Typed delivery profiles](docs/task-profiles.md) |
| Write a brief or define noncoding acceptance checks | [PRD contract](docs/prd.md) |
| Use API-backed hosted execution | [OpenAI Agents](docs/openai-agents.md) |
| Dashboard messages, controls and recovery | [Dashboard](docs/app.md) · [Commands](docs/commands.md) |
| Models, credentials, limits and notifications | [Configuration](docs/config.md) |
| Plan sequential work | [Chains](docs/chains.md) |
| Embed task delivery in another application | [Task-delivery package](docs/task-delivery.md) |
| Understand internals or recorded qualification | [Documentation index](docs/README.md) |
| Set up from an agent | [Agent setup](docs/agent-setup.md) |
| Release, contribute or report a vulnerability | [Releasing](docs/releasing.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) |

Embedding the same workflow in another application? See
[task delivery](docs/task-delivery.md). Installing this CLI does not deploy a
hosted service or publish a chat plugin.

[Contributing](CONTRIBUTING.md) · [Security reports](SECURITY.md) ·
[Releasing](docs/releasing.md) · [Apache-2.0 license](LICENSE)
