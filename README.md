# Gallivant

**Give an agent a task. Let the review loop run. Go outside.**

Gallivant takes repository work from a request to a pull request ready for your
review. It prepares a brief, starts an agent in an isolated checkout or hosted
sandbox, watches reviews and CI, and sends feedback back to the same session.
You can check progress or send a correction from a local dashboard. You decide
what gets merged.

Use it for features and bug fixes, but also research reports, documentation,
content and other files your team reviews in GitHub. Every task needs a concrete
repository deliverable and verification commands. Start with plain language or
bring your own PRD; both use the same acceptance and review gates.

- **Finish the review loop.** Implementation, reviewer feedback, fixes, CI and
  acceptance evidence stay attached to the same task, branch and PR.
- **Choose where the agent runs.** Use local Claude Code or Codex, or explicitly
  configured OpenAI Agents API sessions in a hosted sandbox. Provider access,
  permissions and costs differ; see the support table below.
- **Correct work as it happens.** Message the agent, recheck a PR or resume a
  stopped run from the dashboard, with its saved context.
- **Plan longer work.** Chain briefs; each successor starts after you merge its
  predecessor into the planned base.
- **Know when to step in.** Runs stop at unmet permissions, missing evidence,
  repeated non-progress or configured limits, with a reason you can inspect.

## Get started

The recommended first path uses **macOS or Linux, Node 22+, Git, GitHub CLI, jq**,
and signed-in **Codex CLI 0.160.0+** or **Claude Code 2.1.263+**. Model usage is
billed by your harness/provider; Gallivant does not include inference credits.
For API execution without a local agent CLI, follow the
[hosted setup](docs/install.md#hosted-agents-api-instead-of-a-local-cli).

Until the first npm release is published, install from source:

```sh
git clone https://github.com/uchibeke/gallivant.git
cd gallivant
npm ci --ignore-scripts
npm link
gallivant --version
```

Anonymous installation requires a public repository. After the first registry
release, use `npm install -g gallivant`. See [release readiness](docs/releasing.md).

Temporary network failures have bounded, same-session recovery. Status separates
local sign-in from API connectivity, and `gallivant doctor --network <https-origin>`
diagnoses DNS/HTTPS on Linux and macOS. See [network recovery](docs/network-recovery.md)
for retry limits and troubleshooting.

Create your local configuration:

```sh
gh auth status
codex login status
gallivant init --harness codex       # or --harness claude
gallivant doctor
```

`init` records your GitHub login, selected local harness and a separate checkouts
directory. It never overwrites an existing config or changes global agent
settings. Follow the [installation guide](docs/install.md) to resolve `doctor`
findings, configure harness guardrails and protect your repository. Enable your
review bot on the target repository; otherwise explicitly configure a different
reviewer or `"reviewer": null` for CI and trusted human feedback.

### Start with a request

Inside a repository you can push to, try a small documentation task:

```sh
cd /path/to/your/repository
gallivant task "Document how to run the existing tests in CONTRIBUTING.md. Use the commands already defined in the repository. Change documentation only." \
  --harness codex --verify 'git diff --check' --run
gallivant start
```

`task` prepares the brief and asks for missing information. `--run` authorizes
implementation as soon as that brief passes validation, including after you
answer questions. Omit `--run` to inspect the draft first; follow the printed
`Next` action with your task ID and current revision. Preparation itself uses
inference. [Task operations](docs/tasks.md) covers answers, context files and
explicit approval of a prepared brief.

The final `gallivant start` opens the dashboard and ensures monitoring is running;
it does not submit another task. The dashboard is at **http://127.0.0.1:8791**.

### Or start with a written brief

```sh
gallivant new add-csv-export
# Fill in docs/prds/add-csv-export.md: scope, acceptance criteria and checks.
gallivant ready docs/prds/add-csv-export.md --check
gallivant ready docs/prds/add-csv-export.md
gallivant start docs/prds/add-csv-export.md
```

`start` with a PRD launches the task, ensures the daemon and dashboard are running,
and opens a browser when available. It returns to your shell. Closing the browser
does not stop the work. See the [PRD contract](docs/prd.md).

```sh
gallivant start                     # reopen dashboard; ensure services are up
gallivant start docs/prds/add-csv-export.md --no-open    # dashboard runs; do not open a browser
gallivant start docs/prds/add-csv-export.md --no-server  # task + daemon only
gallivant serve --port 8792          # same services, without a new task
gallivant status
gallivant down                      # stop monitoring/dashboard; active runs continue
```

If service startup fails after a task starts, retry `gallivant start` without a
PRD path. The task stays recorded; there is no need to submit it again.

## Harness support

Preparation means turning plain language into a validated brief. Execution means
performing the task and continuing its review fixes. An implemented adapter does
not establish that every account, model or permission configuration works.

| Harness ID | Runs where | Request preparation | Execution and evidence |
| --- | --- | --- | --- |
| `claude` | Local Claude Code | Available | Recommended starting point; live usage evidence |
| `codex` | Local Codex CLI | Available with 0.160.0+ | Recommended starting point; live usage evidence |
| `openai-agents` | OpenAI-hosted sandbox | Available, text-only session | Implemented; explicit API access, model and sandbox setup required. Full live lifecycle qualification remains separate. |
| `gemini` | Local Gemini CLI | Unavailable; use a written PRD | Adapter and automated coverage; unattended end-to-end qualification incomplete |
| `opencode` | Local OpenCode | Unavailable; use a written PRD | Adapter and automated coverage; unattended end-to-end qualification incomplete |
| `goose` | Local Goose | Unavailable; use a written PRD | Adapter and automated coverage; unattended end-to-end qualification incomplete |
| `codex-cloud` | Codex Cloud | Unavailable | **New dispatch disabled:** selected environment-to-repository ownership cannot yet be verified by the supported CLI interface |

Local Codex, Codex Cloud and the Agents API are different integrations. Disabling
Codex Cloud does **not** disable local Codex or Claude. Read the
[Agents API guide](docs/openai-agents.md), [Cloud blocker](docs/codex-cloud.md),
[preparation boundaries](docs/preparation.md) and
[recorded harness evidence](https://github.com/uchibeke/gallivant/blob/main/docs/audit/harness-live-validation.md).

Hosted execution moves the agent's compute, not Gallivant's coordinator. Your
coordinator machine must remain awake, online and running the daemon to publish,
watch CI and handle reviews. This package is not a managed always-on service.
Subscriptions and API credits are separate, and a CLI connection does not prove
permission for unattended use. There is no automatic provider or model fallback.

## What completion means

```text
request → prepared brief ─┐
                         ├→ approved task → isolated work → pull request
written brief ───────────┘                                     ↓
                              same session ← review / CI feedback
                                   ↓
                              verify + update → ready for your review
```

Acceptance evidence, verification, CI and reviewer findings determine readiness.
Gallivant never merges PRs. The default review allowance is 30 rounds; limits,
repeated non-progress and unrecoverable failures stop for you. Optional ntfy
notifications report readiness and blockers. Natural-language tasks default to `delivery_ready`: automatic observation and
fixes stop once that handoff is qualified. Recheck, resume or message the run to
explicitly reopen work. Choose `integrated` to keep watching for a human merge.
Existing written-PRD runs retain their monitoring behavior. Neither target
authorizes merging, releasing or deploying.

For a longer plan:

```sh
gallivant chain launch docs/prds/foundation.md docs/prds/integration.md docs/prds/launch.md
gallivant chain launch
```

The daemon starts the first ready brief and waits for your merge before starting
the next. [Chains](docs/chains.md) explains gates and recovery. The structured
[task-delivery package](docs/task-delivery.md) lets another trusted application
use these same operations; installing the CLI alone does not publish a chat app.
[Review learning](docs/learning.md) is experimental and collection only in
production; automatic application of learned rules is not qualified.

## Security and operating limits

Runs use your GitHub identity. Prefer a fine-grained token restricted to selected
repositories and protect base branches with GitHub rulesets. Local permission
controls differ by harness; hosted agents do not inherit local APort hooks or
OS sandbox guarantees. APort pre-tool authorization and task-completion
verification are separate controls. See [guardrails](docs/guardrails.md) before
unattended work. Never treat automatic approval as an OS sandbox.

## Documentation

| Need | Guide |
| --- | --- |
| Install and run your first task | [Getting started](docs/install.md) |
| Start from a request, answer questions, inspect results | [Natural-language tasks](docs/tasks.md) |
| Write a brief or define noncoding acceptance checks | [PRD contract](docs/prd.md) |
| Use API-backed hosted execution | [OpenAI Agents](docs/openai-agents.md) |
| Dashboard messages, controls and recovery | [Dashboard](docs/app.md) · [Commands](docs/commands.md) |
| Models, credentials, limits and notifications | [Configuration](docs/config.md) |
| Plan sequential work | [Chains](docs/chains.md) |
| Embed task delivery in another application | [Task-delivery package](docs/task-delivery.md) |
| Understand internals or recorded qualification | [Documentation index](docs/README.md) |
| Release, contribute or report a vulnerability | [Releasing](docs/releasing.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) |

Apache-2.0. [License](LICENSE).
