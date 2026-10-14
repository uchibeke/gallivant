# Install

Start with one harness and one repository. `gallivant init` creates your local
config; `gallivant doctor` checks the prerequisites and prints a fix for each
missing item. Setup time depends on whether your harness and GitHub are already
configured. No model call is needed to install the CLI or validate a hand-written PRD.

Requirements shared by the coordinator: macOS or Linux, Node 22 or newer, Git,
`gh` signed in, and `jq`. For the recommended local path, use signed-in Claude
Code 2.1.263+ or Codex CLI 0.160.0+ (Codex implementation accepts 0.158.0+, but
plain-language preparation needs 0.160.0+). Hosted OpenAI Agents execution has a
separate setup below and needs no local Codex or Claude binary. See the
[capability matrix](../README.md#harness-support) before choosing another harness.

## 1. The command

```bash
git clone https://github.com/uchibeke/gallivant && cd gallivant
npm ci --ignore-scripts
npm link
gallivant --version
gallivant --help          # from any directory, to confirm it is on your PATH
```

The package has locked runtime dependencies; `npm ci` installs them for a source
checkout. `npm i -g .` copies instead of linking. Once the first registry release
is published, `npm install -g gallivant` needs no clone. Until then use the source
path above (the repository needs to be public for anonymous access).
If the shell cannot find the command afterwards,
the `bin` directory under `npm prefix -g` is not on your PATH.

Global configuration lives in `~/.gallivant/config.json`. Task commands still
need a target checkout: run inside it, pass `--dir` for natural-language tasks, or
pass the PRD path for a written brief.

## 2. Sign in and create config

```bash
gh auth login             # skip if gh auth status already passes
codex login               # or sign in with claude, if that is your selected harness
git config --get user.name
git config --get user.email
gallivant init --harness codex    # or --harness claude
gallivant doctor
```

`init` writes `~/.gallivant/config.json` with mode 600, trusts your authenticated
GitHub login, records only the selected installed harness, and creates
`~/.gallivant-worktrees` for separate task checkouts. Use `--worktrees /absolute/path`
to choose another location outside the config home. Notifications start disabled.
Existing configs are never overwritten. Set your Git name/email if the checks
above are empty; commits use your configured identity.

`doctor` can also print a suggested config when none exists. It reports missing
guardrails, credentials and repository protections; `init` does not configure
those for you. See [config.md](config.md) for every key. The default reviewer is
the Codex GitHub integration: enable it on your target repository, configure
another supported bot, or explicitly set `"reviewer": null` to use CI and trusted
human feedback. Without a configured review bot, the default loop waits for a
review that cannot arrive.

### Hosted Agents API instead of a local CLI

`init --harness` currently supports only `codex` and `claude`. For a hosted-only
installation, create the config manually; do not install a local agent just to
satisfy `init`. Create `~/.gallivant` privately, save the following as
`~/.gallivant/config.json` with mode `600`, and replace the example account,
project, model, repository, username and API-key path with your authorized values:

```json
{
  "trusted_authors": ["YOUR_GITHUB_LOGIN"],
  "worktrees": "~/.gallivant-worktrees",
  "repos": ["YOUR_OWNER/YOUR_REPO"],
  "harness": {
    "openai-agents": {
      "account": "my-service-account",
      "organization": "org-selected",
      "project": "proj-selected",
      "api_key_file": "/absolute/path/to/private/agents-key",
      "model": "YOUR_AUTHORIZED_MODEL",
      "environment": "openai_hosted",
      "container_size": "small",
      "network": { "access": "disabled" },
      "allowance": { "remainingUsd": 1, "reservedUsd": 0.2 }
    }
  },
  "notify": null
}
```

Keep existing config keys if you are adding this adapter to an existing install.
The allowance is an illustrative local reservation, not a provider-enforced
spend cap. API inference and hosted compute use API billing, independently of a
ChatGPT subscription. Read the [Agents API guide](openai-agents.md) for scoped
API permissions, packages, restricted networking and cancellation limitations.

Run `gallivant doctor` before starting. Hosted results are verified locally in an
OS sandbox: macOS needs `sandbox-exec` and Command Line Tools; Linux needs
`/usr/bin/bwrap` and the supported namespaces. Missing sandbox support blocks
execution/publication. Read-only account probes do not prove inference entitlement
or a successful full lifecycle. Local APort hooks are not installed into hosted
sessions; mandatory local-only policies cause a refusal.

Use `--harness openai-agents` with `gallivant task`, or `harness: openai-agents`
in your PRD. Keep the coordinator machine awake and online even though the agent
runs remotely. **Codex Cloud is a different adapter:** its new dispatch is
currently disabled because repository ownership of the selected environment
cannot be verified. See [the Cloud gate](codex-cloud.md); local Codex and Claude
remain available.

## 3. GitHub auth

By default Gallivant uses the login you already have, however you set it up. Nothing to configure beyond `gh auth status` passing. There is no file to copy for this: every git setting a run needs, the credential helper included, is passed in the run's environment.

For local CLI runs, the coordinator resolves GitHub credentials before launching
the harness. Supported sandbox settings restrict native credential-store access,
so the run receives `GH_TOKEN` and an environment-carried Git helper. Sandbox
coverage differs by harness; see [guardrails](guardrails.md). The token is not
placed in command arguments or persisted by Gallivant, but the child process
can read it. For hosted Agents execution, GitHub credentials stay with the local
coordinator, which verifies and publishes returned artifacts.

Earlier versions asked you to write `~/.gallivant/gitconfig` and pointed `GIT_CONFIG_GLOBAL` at it. That file is no longer read by anything, so if you have one you can delete it. Two things were wrong with it, and the second is the worse one. Its helper called `gh auth git-credential`, which asks `gh` to read stores a sandbox denies. And the file itself sat outside the worktree, so a sandboxed run could not read it at all: every git command, `git status` included, failed with `unable to access '/Users/you/.gallivant/gitconfig': Operation not permitted`, while git's fallback message blamed `~/.git-credentials` and sent two debugging sessions after the wrong file. `doctor`'s `run git push` line now runs a real `git ls-remote` with the run's own environment and no readable `HOME`, and prints whatever git says.

Where the credential comes from, first answer wins:

1. `github_token_file`, if you set one in config.
2. `GH_TOKEN` or `GITHUB_TOKEN` in the environment the daemon was started in.
3. `gh auth token`. This is why any login works: `gh` answers from whichever store it used, whether that is a keyring, a secret service, or a plain `hosts.yml` on a machine with neither.

If none of the three answers, `gallivant start` refuses and names all three. It does not start a session that would spend money and then fail to push.

Optional, and recommended once the loop runs on repos that matter: a fine-grained personal access token limited to the participating repos, so an escaped run cannot reach every repository your login can. Create one at GitHub, Settings, Developer settings, Fine-grained tokens, with Contents, Pull requests and Issues read and write, Checks, Actions and Metadata read, and **no Workflows permission**. Save it and point config at it:

```bash
umask 077
cat > ~/.gallivant/gh-token
# Paste the token, then press Ctrl-D. Do not paste it into a shell command.
# config.json: "github_token_file": "~/.gallivant/gh-token"
```

With the file set it wins over both of the other two, so a token you deliberately narrowed is never quietly replaced by a wider one. `doctor` reports which source a run would use, whether the token is classic or fine-grained, and repository access and protection checks. Its Git credential-transport check uses
`git ls-remote`; a successful read does not by itself prove push permission.

A `gh` logged in to an enterprise host is the one case this does not resolve for you. Gallivant asks `gh` for the host the remote names, but if `gh` has no login for that host, use `github_token_file`: a github.com token will not authenticate `github.acme.com`, and Gallivant says so rather than sending the wrong one.

## 4. A ruleset on each repo

The one control that stops a push to the default branch is GitHub's. `doctor` prints the exact `gh api` call for every repo in `repos`; it creates a ruleset that blocks deletion and force pushes on the default branch and requires a pull request, with no bypass actors. Gallivant never merges, so the ruleset costs nothing in the loop.

## 5. Notifications

Optional: create a topic on [ntfy.sh](https://ntfy.sh) or your own server, install the ntfy app, and set
`"notify": { "ntfy": "https://ntfy.sh/<unguessable-topic>", "email": null }`.
Set `notify.email` to also get each message by email through ntfy's `Email` header.
With `"notify": null`, use the dashboard or `status`; there are no push notifications.

```bash
gallivant doctor --send      # sends one test message
```

Three kinds of message exist: `ready for a human`, `needs you: <reason>`, and a throttled `gallivant: <error>` when the daemon itself cannot work (gh not authenticated, a harness signed out). Nothing on merge. Nothing per round.

## 6. APort on Claude Code

APort's installer writes a PreToolUse hook with matcher `*` into whichever settings file it is pointed at, and the hook enforces one passport. Gallivant's passport is strict on purpose: writes only under the worktrees directory, control-plane directories blocked. Installed into `~/.claude/settings.json`, that policy would apply to every interactive Claude session you run and block your normal work. So the installer goes into a Gallivant-owned directory, and every run loads it with `--settings` plus `APORT_CLAUDE_CODE_CONFIG_DIR`. Nothing about the sandbox requires this; it is only about keeping Gallivant's policy separate from yours.

If you would rather have one policy everywhere, point `harness.claude.settings` at `~/.claude/settings.json` and install APort there; the sandbox block then applies to your interactive sessions too.

```bash
APORT_CLAUDE_CODE_CONFIG_DIR=~/.gallivant/claude npx @aporthq/aport-agent-guardrails claude-code
# choose "Create local passport file"; no hosted account is needed
# init and doctor print the absolute path to the packaged passport template.
cp /absolute/path/printed/by/init/passport.gallivant.json ~/.gallivant/claude/aport/passport.json
# then edit it: replace {{worktrees}} with your worktrees path and {{home}} with your home directory
```

Merge the sandbox block from the packaged `claude-settings.json` path printed by
`init` into `~/.gallivant/claude/settings.json` next to the hooks the installer wrote.
Those absolute template paths work after either source or npm installation.
Every Claude run loads that file with `--settings` and sets `APORT_CLAUDE_CODE_CONFIG_DIR`, so the hook and the sandbox apply only to Gallivant runs.

On macOS the template enables `sandbox.enableWeakerNetworkIsolation` so `gh` can use Apple's certificate verification service. Without it, a valid GitHub login can fail inside the sandbox with `x509: OSStatus -26276`. This grants access to `com.apple.trustd.agent` and opens a potential exfiltration route through that service; review the [security tradeoff](guardrails.md#claude-on-macos-needs-certificate-verification) before applying it. The setting has no effect on Linux. `doctor` detects the missing setting on macOS and explains the repair; it does not change settings automatically.

Any APort passport option works: a hosted passport created by the installer, an existing hosted `agent_id`, or a local file. With a hosted passport the limits live in the aport.io dashboard, so set `data.file.write` `allowed_paths` there to your worktrees directory and `blocked_paths` to the control-plane directories listed in `templates/passport.gallivant.json`; with a local passport, copy the template. `doctor` reports which mode is in use.

```bash
gallivant doctor --probe     # a real run: a write inside the checkout succeeds, a write outside is denied
```

The probe reads the APort audit log to tell apart a hook that never ran from a passport that allowed the write, and prints the fix for each.

## 7. APort on Codex

```bash
npx @aporthq/aport-agent-guardrails codex --global --enforcement=warn
codex          # once: run /hooks and trust the APort hook. This step cannot be automated.
```

APort's Codex hook is beta. Warn mode may downgrade policy denials, but adapter
failures can still block calls such as unsupported multi-file `apply_patch`;
check the installed guardrails version's support before unattended use. The
other controls are `workspace-write`, Codex's automatic approval reviewer for
Git metadata writes and escalations, the scoped token and the ruleset. Gallivant
sets the approval mode on start and resume. A denial must be diagnosed, not
bypassed. See [guardrails.md](guardrails.md#codex-git-writes-need-automatic-approval).

## 8. First task

You can deliver code, documentation, research or content, provided the outcome
is a repository change with concrete acceptance criteria and checks. You do not
need to write a PRD by hand.

### From plain language

Inside the target repository:

```sh
gallivant task "Document how to run the existing tests in CONTRIBUTING.md. Use the commands already defined in the repository. Change documentation only." \
  --harness codex --verify 'git diff --check'
```

Choose `claude` or `openai-agents` instead when configured. This first command
uses inference to prepare a brief but does not start implementation. Inspect the
returned draft and assumptions. If it needs answers, use its printed question
IDs and `Next` action. Once ready, substitute your returned ID and revision:

```sh
gallivant task start TASK_ID --revision REVISION --run
gallivant start
```

Alternatively, add `--run` to the original `task` request to authorize
implementation as soon as preparation and any clarifications succeed. The task
service starts the daemon; `gallivant start` with no path also opens the dashboard.
Read [task operations](tasks.md) for selected context, revisions, recovery and costs.

### From a written brief

```sh
gallivant new widget-export --harness codex
# Fill in docs/prds/widget-export.md, including every required section.
gallivant ready docs/prds/widget-export.md --check
gallivant ready docs/prds/widget-export.md
gallivant start docs/prds/widget-export.md
gallivant status
```

`new` writes a complete template. Fill in its Problem, User stories, Acceptance
criteria, Verify, Where to look and Out of scope sections. Empty section headings
are not a runnable brief. [The PRD contract](prd.md) explains the rules and
noncoding verification. `ready --check` is a local, read-only validation;
`ready` records readiness and updates the file without committing it.

`start` starts the background daemon and dashboard and opens the browser when
available. Do not run a second `up`. `--no-open` suppresses browser launch;
`--no-server` starts the task and daemon without the dashboard. `gallivant start`
with no path starts/reuses the services without submitting a task. `serve` uses
the same startup; supervisors can use `serve --foreground --no-open --no-daemon`
for a tracker whose daemon is managed separately. `gallivant down` stops both
standalone services, preserving active agent processes.

On macOS the daemon starts `caffeinate` for its lifetime to prevent idle sleep.
Closing a laptop lid, losing network or shutting down still interrupts monitoring.
There is no automatic login/reboot service installer yet.

### Completion verification

APort readiness/completion verification is separate from harness pre-tool hooks.
By default, the built-in contract checks are confirmed by APort's hosted endpoint;
this needs network access and unauthenticated requests have an IP rate limit.
An installed APort Claude API key is used when available. To deliberately use
only the local completion evaluator, set `"deliverable": { "evaluator": "local" }`
in config; the local acceptance criteria and receipt checks still apply. See
[the completion contract](prd.md#the-completion-receipt) for details.

## Verifying the first real PR

Watch `gallivant status` after the start run ends: the entry moves from `implementing` to `waiting on reviewer` once the PR is open. When the reviewer's review lands, the next tick shows `fixing`, then a round comment appears on the PR, and after the re-review either a `ready for a human` notification arrives or `status` shows why not.

## Where things live

| Path | What |
|---|---|
| `~/.gallivant/config.json` | your config, mode 600 |
| `~/.gallivant/state.json` | the registry; preserve it and its snapshots for exact local recovery |
| `~/.gallivant/runs/<entry>/<run>/` | `job.json`, `job.log` (provider output), local `cmd.json` or hosted execution/artifact records |
| `~/.gallivant/daemon.json` | daemon health, read by `status` |
| `~/.gallivant/tracker.json`, `tracker.lock`, `tracker.log` | standalone dashboard ownership, port and output |
| `~/.gallivant/errors.log` | every warning and error |
| `~/.gallivant/claude/` | Gallivant's Claude settings, APort hook runtime, passport, audit log |
| `<worktrees>/<repo>/<prd>` | one partial clone per PRD; durable until you delete it |

Override the home directory with `GALLIVANT_HOME` to run a second instance.
