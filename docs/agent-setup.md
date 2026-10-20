# Let an agent set up Gallivant

Give the prompt below to your coding agent. It can inspect prerequisites, run
the published setup command, read the resulting report and validate a first task.
You handle account login and any required trust prompts. Setup does not need
access to every private repository, and running the setup command does not start
a paid session.

Start with **Codex or Claude and one repository**. Those are the harnesses supported
by `gallivant init`. [Hosted Agents API](openai-agents.md) uses an explicit config
instead; [other harnesses](../README.md#harness-support) have different setup and
capability boundaries. An installed binary alone does not establish working model
access or safe unattended operation.

## Prompt to give your agent

```text
Set up Gallivant on this machine using its current docs:
https://github.com/uchibeke/gallivant/blob/main/docs/agent-setup.md
https://github.com/uchibeke/gallivant/blob/main/docs/install.md

Inspect the installed version, operating system, Node architecture, existing
Gallivant config and target repository before changing anything. Use the actual
CLI --help and the docs matching the installed version. Prefer an already working
Codex or Claude setup. Preserve existing credentials, settings, running jobs,
worktrees and uncommitted changes. Report proposed config changes without secrets.

From inside the target checkout, run the published setup command:
npx --yes @uchibeke/gallivant init --harness codex (or --harness claude), then
read its report. Do not clone the Gallivant repository or install it globally
unless I ask. If the command stops because gh or the harness is signed out, tell
me the exact login command it printed and wait; do not sign in for me. Do not
overwrite an existing config, weaken security settings, install hooks, change
repository protections or elevate privileges without my authorization. Never ask
me to paste API keys or tokens into this conversation. Use the provider's login
flow or a private credential file instead.

Ask only for missing decisions: target repository and checkout, approved base
branch, preferred available harness, first task scope, and allowed spending.
A setup request alone does not authorize inference, pushes or PR creation.
Prepare and validate a written brief without starting it unless I have authorized
the first run. Plain-language task preparation also uses inference.

Finish with a short report: installed version/path, config path, selected harness,
repository/base, doctor results, reviewer and completion evaluator settings,
remaining blockers, and the exact command to start the validated first task.
If I authorized that task, start it once, verify the saved run identity and status,
and give me its dashboard or SSH-tunnel instructions. Do not claim a running or
completed task unless observed. Do not merge, publish, deploy or alter accounts.
```

If the user already provided those decisions and permissions, reuse them. Do not
ask for the same approval again. This guide does not authorize any particular
provider, repository, spend or broader machine change by itself.

## 1. Inspect before installing

Use the user's shell and package manager; no path to a particular person's home
is required. The coordinator supports macOS and Linux with Node 22 or newer.
Linux needs `ps` from `procps`/`procps-ng`. Harnesses and hosted artifact verification
have their own sandbox prerequisites; see [installation](install.md).

```sh
node --version
node -p 'process.platform + " " + process.arch'
npm --version
git --version
gh --version
jq --version
command -v gallivant
gh auth status
```

A missing command is a prerequisite to fix, not a reason to disable a guardrail.
Use the distribution's supported package instructions. Check the chosen harness
version/login using its CLI; `gallivant doctor` performs Gallivant's compatibility
and configuration checks after setup. Do not print credential files or tokens.

Inspect the target checkout separately from the Gallivant installation:

```sh
cd /path/to/target-repository
git status --short
git remote -v
git branch --show-current
git config --get user.name
git config --get user.email
```

Replace the path with the actual authorized checkout. Do not reset, clean,
automatically commit, or switch a dirty checkout. Confirm which GitHub repository
and base branch the task should use; the current branch is not necessarily the
approved PR target. Account login and Git identity belong to the user.

## 2. Run the setup command

Use the [current installation instructions](install.md#2-the-command). After
GitHub and the selected harness are signed in, from inside the target checkout:

```sh
npx --yes @uchibeke/gallivant init --harness codex    # or: --harness claude
```

`npx` runs the published package on demand; it installs nothing globally and
does not clone this repository. `init` is noninteractive. It refuses, writing
nothing, when the directory is not a GitHub checkout, `gh` or the harness is
signed out, or the login cannot push to the repository; report the printed
command to the user instead of working around it. Otherwise it creates
`~/.gallivant/config.json` (mode 600) when none exists, records the current
repository in `repos` once, creates the worktrees directory and prints the
`doctor` report. Exit status `1` means checks remain, not that setup failed.

With an existing config, `init` keeps every key as written and adds only the
current repository. Do not edit unrelated keys. The normal path is
`~/.gallivant/config.json`; use `$GALLIVANT_HOME/config.json` if that variable is
already set. Pass `--worktrees /absolute/path` only on first creation; later
runs refuse a different directory.

If the user prefers a persistent command, `npm install -g @uchibeke/gallivant`
is the documented option; ask before installing globally. Avoid `sudo npm
install`; use a user-owned Node installation or prefix. Do not silently replace
a different installed version while its daemon is running.

Before a real run, finish the [harness guardrail setup](install.md#7-aport-on-claude-code)
for the selected harness. Some steps require human interaction: for example,
Codex's initial `/hooks` trust prompt cannot be automated. Report such a blocker
instead of changing the enforcement level or bypassing it.

`init` records the repository without a base branch; its pull requests target
the default branch unless the user chooses otherwise with `start --base` or a
`{ "repo", "base" }` entry, following [configuration](config.md#the-base-branch).
Review the config diff without printing credentials. Confirm these decisions
before dispatch:

| Decision | What must be established |
|---|---|
| Repository access | The run can read/push the intended repository; use a selected-repository token where appropriate. Public-only work does not require private-repository access. |
| Base protections | Required PR/ruleset protections exist. `doctor` suggests repairs; it does not authorize changing organization policy. |
| Review | The default Codex GitHub reviewer is installed for this repo, another supported reviewer is configured, or the user explicitly chose `reviewer: null` for CI and trusted human feedback. |
| Completion evaluator | Default APort hosted confirmation needs network access. A local evaluator is an explicit user choice, not an automatic workaround for a failure. |
| Cost | Confirm `max_iterations`, provider budget controls and allowed spend. `max_budget_usd` is a native per-run dollar cap for Claude; other local harnesses have no equivalent enforced dollar cap. |

Run `gallivant doctor` (or `npx --yes @uchibeke/gallivant doctor`) again and
report every failure. Do not treat “signed in (API unchecked)” as proof of
inference access. `doctor` without extra flags checks
configuration, credentials and repository access without launching a model run.
`doctor --probe` launches a real Claude sandbox test when Claude is configured;
`doctor --send` sends a real notification. Use those only when authorized.

## 3. Validate a first task without inference

In the target checkout, use a new task name that does not already exist:

```sh
gallivant new first-docs-task
# Edit docs/prds/first-docs-task.md to describe the agreed task.
gallivant ready docs/prds/first-docs-task.md --check
```

With no `--harness` flag, `new` uses the first configured harness. If several are
configured, pass `--harness` with the harness agreed during setup.

Fill every required section with repository-specific facts. Pick a small useful
change, such as documenting existing test commands, with concrete acceptance
criteria and verification. The template deliberately contains placeholders;
validation must fail until they are replaced. [The PRD contract](prd.md) lists the
rules. Expected result: every rule says `ok` and exit status is `0`.

`ready --check` reads and validates locally without loading credentials, starting
a daemon or invoking a model. This is a useful stopping point when setup is
approved but implementation is not. Do not mark a failing brief ready manually.

If paid preparation is authorized, [natural-language task intake](tasks.md) can
write the brief instead. Use `task inspect` and returned revision/question IDs to
continue that same task; do not resubmit it simply because clarification is needed.

## 4. Start once, when authorized

Record readiness, then dispatch the validated brief against the approved branch:

```sh
gallivant ready docs/prds/first-docs-task.md
gallivant start docs/prds/first-docs-task.md --base YOUR_APPROVED_BASE
gallivant status --json
```

Replace `YOUR_APPROVED_BASE` with the actual branch. `ready` can contact the
configured completion evaluator and updates the brief; `start` launches paid work
and permits repository changes, pushes and PR creation within that task.
It also starts/reuses the daemon and dashboard, and attempts to open the browser.
Do not launch a second `up` process.

For a headless machine, use `start ... --no-open`. Reach the loopback dashboard
through SSH instead of exposing it publicly:

```sh
# On your own computer; replace user@host with the coordinator's SSH destination.
ssh -N -L 8791:127.0.0.1:8791 user@host
```

Then open `http://127.0.0.1:8791` locally. Substitute the reported port if configured
differently. `--no-server` skips the dashboard while keeping task monitoring.
Keep the coordinator awake and online; there is no automatic reboot/login service
installer. Startup is not a system service installation.

Save the reported task/run handle, worktree and status. If startup returns an error,
inspect `status` and `why HANDLE` before retrying: work may have started before a
service or browser failed. Diagnose network problems with
[the bounded network check](network-recovery.md). Send corrections with
`say HANDLE --note "..."`; use `resume HANDLE` for a stopped execution and
`recheck HANDLE` for an eligible PR review check. Neither is a blind retry for
unknown provider state.

`cancel HANDLE` fences further dispatch and requests provider cancellation;
confirm its status. `down` stops monitoring/dashboard services but **leaves active
agent processes running**. A ready-for-human result still requires the owner's
review and merge.

## What setup verification proves

The package's `npm run test:install` check packs the tarball and runs the
README's `npx` setup command against it from a disposable repository, with
fixture `gh` and `codex` commands and a throwaway home. It proves which binary
ran, the config and directory permissions, repository registration, repeat
safety and the printed next steps. It does not use a real account, invoke a
model or certify a provider's current availability. A first authorized
end-to-end task is still needed to verify the user's actual repository
permissions, provider entitlement, sandbox, CI and review integration.
