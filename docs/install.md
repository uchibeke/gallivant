# Install

Start with one harness and one repository. `gallivant init` creates your local
config; `gallivant doctor` checks the prerequisites and prints a fix for each
missing item. Setup time depends on whether your harness and GitHub are already
configured. No model call is needed to install the CLI or validate a hand-written PRD.

Requirements: macOS or Linux, Node 22 or newer, `gh` signed in, `jq`, and at least one of Claude Code (2.1.263 or newer) or Codex CLI (0.158.0 or newer) signed in.

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

Everything below works from any directory, because Gallivant reads `~/.gallivant/config.json` rather than anything
in the current folder.

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

## 3. GitHub auth

By default Gallivant uses the login you already have, however you set it up. Nothing to configure beyond `gh auth status` passing. There is no file to copy for this: every git setting a run needs, the credential helper included, is passed in the run's environment.

A run is sandboxed, so it cannot read your macOS keychain, your Linux secret service, or `~/.git-credentials`. The daemon is not sandboxed, so it does the credential lookup and passes the result to the run as `GH_TOKEN`, where a helper carried in the same environment reads it. The token is never an argument, so `ps` cannot show it, and nothing writes it to a file.

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

With the file set it wins over both of the other two, so a token you deliberately narrowed is never quietly replaced by a wider one. `doctor` reports which source a run would use, whether the token is classic or fine-grained, and whether it can actually push to each repo in `repos`.

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

## 8. First PRD

A PRD is a markdown file in the target repo, by convention under `docs/prds/`, with a flat frontmatter block:

```markdown
---
status: ready
harness: claude
---

# Widget export

## Problem
## User stories
## Acceptance criteria
## Verify
- `npm test`
## Out of scope
```

Run `gallivant new <name>` inside the repository the work belongs to; it writes `docs/prds/<name>.md` from the packaged template. Every section has rules, listed in [prd.md](prd.md); `gallivant ready` checks them and `start` refuses a PRD that fails any.

```bash
gallivant ready path/to/repo/docs/prds/widget-export.md
gallivant start path/to/repo/docs/prds/widget-export.md
gallivant status
```

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
| `~/.gallivant/runs/<entry>/<run>/` | `job.json`, `job.log` (the harness stream), `cmd.json` |
| `~/.gallivant/daemon.json` | daemon health, read by `status` |
| `~/.gallivant/tracker.json`, `tracker.lock`, `tracker.log` | standalone dashboard ownership, port and output |
| `~/.gallivant/errors.log` | every warning and error |
| `~/.gallivant/claude/` | Gallivant's Claude settings, APort hook runtime, passport, audit log |
| `<worktrees>/<repo>/<prd>` | one partial clone per PRD; durable until you delete it |

Override the home directory with `GALLIVANT_HOME` to run a second instance.
