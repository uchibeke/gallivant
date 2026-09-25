# Install

About an hour the first time. `gallivant doctor` checks every step and prints the fix for any that is missing, so you can do them in any order and re-run it.

Requirements: macOS or Linux, Node 22 or newer, `gh` signed in, `jq`, and at least one of Claude Code (2.1.263 or newer) or Codex CLI (0.155.1 or newer) signed in.

## 1. The command

```bash
git clone https://github.com/uchibeke/gallivant && cd gallivant
npm link
gallivant --help          # from any directory, to confirm it is on your PATH
```

There are no dependencies to install; this only puts one executable on your PATH. `npm i -g .` copies instead of
linking, and `npm i -g github:uchibeke/gallivant` skips the clone. If the shell cannot find the command afterwards,
the `bin` directory under `npm prefix -g` is not on your PATH.

Everything below works from any directory, because Gallivant reads `~/.gallivant/config.json` rather than anything
in the current folder.

## 2. Config

```bash
gallivant doctor
```

With no config, the first line prints a complete `~/.gallivant/config.json` built from this machine: your GitHub login as the trusted author, the resolved paths of `claude` and `codex`, and a worktrees directory next to your repos. Write it, `chmod 600` it, and replace the ntfy placeholder with a topic of your own (32 random characters, or a self-hosted server with a token). See [config.md](config.md) for every key.

## 3. GitHub auth

By default Gallivant uses the `gh` login you already have. Nothing to set up beyond `gh auth status` passing.

```bash
cp templates/gitconfig ~/.gallivant/gitconfig
```

The gitconfig routes git's credential lookups through `gh auth git-credential`, so runs use `gh`'s token rather than reading `~/.git-credentials` or the keychain directly.

Optional, and recommended once the loop runs on repos that matter: a fine-grained personal access token limited to the participating repos, so an escaped run cannot reach every repository your login can. Create one at GitHub, Settings, Developer settings, Fine-grained tokens, with Contents, Pull requests and Issues read and write, Checks, Actions and Metadata read, and **no Workflows permission**. Save it and point config at it:

```bash
umask 077; pbpaste > ~/.gallivant/gh-token
# config.json: "github_token_file": "~/.gallivant/gh-token"
```

With the file set, the daemon and every run get `GH_TOKEN` from it and your own login is never used by a session. `doctor` reports which mode is active and, for system auth, the scopes of the token in use.

## 4. A ruleset on each repo

The one control that stops a push to the default branch is GitHub's. `doctor` prints the exact `gh api` call for every repo in `repos`; it creates a ruleset that blocks deletion and force pushes on the default branch and requires a pull request, with no bypass actors. Gallivant never merges, so the ruleset costs nothing in the loop.

## 5. Notifications

Create a topic on [ntfy.sh](https://ntfy.sh) or your own server, install the ntfy app, and put the URL in `notify.ntfy`. Set `notify.email` to also get each message by email through ntfy's `Email` header.

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
cp templates/passport.gallivant.json ~/.gallivant/claude/aport/passport.json
# then edit it: replace {{worktrees}} with your worktrees path and {{home}} with your home directory
```

Merge the sandbox block from `templates/claude-settings.json` into `~/.gallivant/claude/settings.json` next to the hooks block the installer wrote. Every Claude run loads that file with `--settings` and sets `APORT_CLAUDE_CODE_CONFIG_DIR`, so the hook and the sandbox apply only to Gallivant runs.

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

Warn, not enforce, on Codex: APort's Codex hook is beta and fails closed on multi-file `apply_patch`, which would stall every real edit. On Codex the bounds are the `workspace-write` sandbox, the scoped token and the ruleset; APort is the audit trail. See [guardrails.md](guardrails.md).

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

Start from `templates/prd.md`. Every section has rules, listed in [prd.md](prd.md); `gallivant ready` checks them and `start` refuses a PRD that fails any.

```bash
gallivant ready path/to/repo/docs/prds/widget-export.md
gallivant start path/to/repo/docs/prds/widget-export.md
gallivant up
```

Run `up` in a terminal tab you can leave open. On a Mac it starts `caffeinate` for its own lifetime so the machine does not idle-sleep. Put it behind `tmux` if you close terminals often. A service installer for launchd and systemd is planned.

## Verifying the first real PR

Watch `gallivant status` after the start run ends: the entry moves from `implementing` to `waiting on reviewer` once the PR is open. When the reviewer's review lands, the next tick shows `fixing`, then a round comment appears on the PR, and after the re-review either a `ready for a human` notification arrives or `status` shows why not.

## Where things live

| Path | What |
|---|---|
| `~/.gallivant/config.json` | your config, mode 600 |
| `~/.gallivant/state.json` | the registry; deletable, `up` rebuilds it from GitHub |
| `~/.gallivant/runs/<entry>/<run>/` | `job.json`, `job.log` (the harness stream), `cmd.json` |
| `~/.gallivant/daemon.json` | daemon health, read by `status` |
| `~/.gallivant/errors.log` | every warning and error |
| `~/.gallivant/claude/` | Gallivant's Claude settings, APort hook runtime, passport, audit log |
| `<worktrees>/<repo>/<prd>` | one partial clone per PRD; durable until you delete it |

Override the home directory with `GALLIVANT_HOME` to run a second instance.
