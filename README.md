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

The first npm release is pending. Install from source for now; anonymous cloning
will work once this repository is public:

```sh
git clone https://github.com/uchibeke/gallivant.git
cd gallivant
npm ci --ignore-scripts
npm link
gallivant --version
```

After registry publication, the install command will be `npm install -g gallivant`.
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

Inside a repository you can push to:

```sh
cd /path/to/your/repository
gallivant task "Document how to run the existing tests in CONTRIBUTING.md. Use the commands already defined in the repository. Change documentation only." \
  --harness codex --verify 'git diff --check' --run
gallivant start
```

`task` prepares a brief and asks for missing information. `--run` authorizes
implementation when that brief is ready, including after clarification. Omit it
to inspect the draft first. Follow the printed `Next` action using your task's ID
and revision. Preparation also uses inference.

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

| Harness | Prepare requests | Implement and fix review feedback |
| --- | --- | --- |
| Local Claude Code | Yes | Recommended; live usage evidence |
| Local Codex CLI | Yes, 0.160.0+ | Recommended; live usage evidence |
| OpenAI Agents API | Yes, text-only | Implemented hosted adapter; explicit API access, model and sandbox configuration required; full live qualification remains separate |
| Gemini CLI, OpenCode, Goose | Use a written PRD | Implemented adapters with automated coverage; unattended end-to-end qualification incomplete |
| Codex Cloud | No | New dispatch disabled until the selected environment's repository binding can be verified |

Local Codex, Codex Cloud and the Agents API are distinct integrations. Local
Codex and Claude work independently of the Cloud dispatch restriction.
[Hosted setup](docs/install.md#hosted-agents-api-instead-of-a-local-cli) ·
[Detailed capabilities](docs/config.md#execution-providers) ·
[Recorded qualification](https://github.com/uchibeke/gallivant/blob/main/docs/audit/harness-live-validation.md).

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

Embedding the same workflow in another application? See
[task delivery](docs/task-delivery.md). Installing this CLI does not deploy a
hosted service or publish a chat plugin.

[Contributing](CONTRIBUTING.md) · [Security reports](SECURITY.md) ·
[Releasing](docs/releasing.md) · [Apache-2.0 license](LICENSE)
