# Gallivant

**Write a PRD, mark it ready, go outside.**

Gallivant keeps coding-agent pull requests moving while you do something else.
It starts work in a separate checkout, watches reviews and CI, and resumes the
same agent session to address feedback. You come back to a PR ready for your
review, or a specific reason it needs your help. You decide what gets merged.

- **Keep the context.** Fix rounds resume the session that did the work.
- **Know what is happening.** A local dashboard shows runs, logs and blockers;
  send a correction, resume a stopped run or recheck a PR from there.
- **Plan beyond one task.** Chain PRDs; each successor starts after you merge
  the preceding PR into its planned base.
- **Check the outcome.** The PRD's acceptance criteria, verification commands,
  reviewer findings and CI determine readiness.
- **Use your tools.** Claude Code and Codex are the recommended starting points.
  GitHub access uses `gh`; no GitHub App, database or webhook server is required.

## Get started

You need **macOS or Linux, Node 22+, Git, GitHub CLI, jq**, and a signed-in
**Codex CLI or Claude Code**. Model usage is billed by your harness/provider;
Gallivant does not include inference credits. See the [installation guide](docs/install.md)
for supported versions, guardrails and repository permissions.

Until the first npm release is published, install from source:

```sh
git clone https://github.com/uchibeke/gallivant.git
cd gallivant
npm ci --ignore-scripts
npm link
gallivant --version
```

The repository must be public for this to work without repository access.
After the first registry release, the same CLI installs with `npm install -g gallivant`.
The [release guide](docs/releasing.md) tracks that publication step.

Create your local configuration, then complete the checks in the installation guide:

```sh
gh auth status
codex login status
gallivant init --harness codex       # or --harness claude
gallivant doctor
```

`init` records the selected harness, your GitHub login and a separate checkouts
directory. It never overwrites an existing config, signs you in or changes
global agent settings. `doctor` explains missing prerequisites. Set up the
[harness guardrails and repository rules](docs/install.md) before unattended work.

Then, inside the repository you want to change:

```sh
cd /path/to/your/repository
gallivant new add-csv-export
# Edit docs/prds/add-csv-export.md: describe the work and its acceptance tests.
gallivant ready docs/prds/add-csv-export.md --check
gallivant ready docs/prds/add-csv-export.md
gallivant start docs/prds/add-csv-export.md
```

`start` launches the task, ensures the background daemon and local dashboard are
running, and opens the dashboard at **http://127.0.0.1:8791** when a browser is
available. It returns to your shell. Closing the browser does not stop the work.

```sh
gallivant start                     # reopen the dashboard and ensure services are up
gallivant start task.md --no-open    # dashboard runs; do not open a browser
gallivant start task.md --no-server  # task + daemon only
gallivant serve --port 8792          # same service startup, without starting a new task
gallivant status
gallivant down                      # stop monitoring/dashboard; active agent runs continue
```

If a service fails after the task starts, retry `gallivant start` **without the
PRD path**. The existing task stays recorded; there is no need to submit it again.

## How it works

```text
ready PRD → isolated checkout → agent implements → pull request
                                                   ↓
               resume same session ← review or CI feedback
                       ↓
                   verify + push → review again
                                       ↓
                          ready for your review / needs help
```

Gallivant never merges PRs. The default review allowance is 30 rounds; limits,
repeated non-progress and unrecoverable failures stop for you. The daemon must
remain running, and the machine must remain awake and online. Optional ntfy
notifications tell you when a run is ready or needs attention.

For longer plans:

```sh
gallivant chain launch docs/prds/foundation.md docs/prds/integration.md docs/prds/launch.md
gallivant chain launch
```

The daemon starts the first ready brief and waits for your merge before starting
the next. [Chains](docs/chains.md) explains gates, cancellation and recovery.

## Support and boundaries

With Claude configured, you can also prepare a brief from a request:
`gallivant task "Add CSV export without new dependencies" --harness claude`.
Review its questions and validated brief before authorizing implementation with
`--run`. See [task preparation](docs/tasks.md) for Codex and hosted support.

Claude Code and Codex have live usage evidence. Gemini CLI, OpenCode and Goose
have adapters and automated coverage, but are **not yet qualified end to end for
unattended coding**. See the [harness evidence](https://github.com/uchibeke/gallivant/blob/main/docs/audit/harness-live-validation.md).

Natural-language [task preparation](docs/tasks.md), explicit
[hosted Agents API](docs/openai-agents.md) execution and [Codex Cloud](docs/codex-cloud.md)
have separate capability and access requirements. Hosted adapters are not a
promise that a particular subscription can run unattended jobs. Repository
[review learning](docs/learning.md) is experimental and collection only in production;
automatic application of learned rules is not qualified.

Runs use your GitHub identity. Prefer a fine-grained token restricted to selected
repositories, protect base branches with GitHub rulesets, and review the
[security boundaries](docs/guardrails.md). APort pre-tool hooks and task-completion
verification are separate controls. Automatic approval is not equivalent to an
operating-system sandbox; review the permissions you give a run.

## Documentation

| Need | Guide |
| --- | --- |
| Install and run your first task | [Getting started](docs/install.md) |
| Write a useful brief | [PRD contract](docs/prd.md) |
| Commands, messages and recovery | [Commands](docs/commands.md) |
| Models, credentials, limits and notifications | [Configuration](docs/config.md) |
| Sandbox and permission boundaries | [Guardrails](docs/guardrails.md) |
| Package and publish a release | [Releasing](docs/releasing.md) |
| Contribute or report a vulnerability | [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) |

Apache-2.0. [License](LICENSE).
