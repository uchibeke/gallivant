---
status: draft
harness: claude
---

# Set up Gallivant inside a repo in one command

## Problem

Nothing in the docs answers the question an operator actually has. They are sitting in a repo directory and they want
Gallivant watching a pull request for that repo. The README and `docs/install.md` both open with
`git clone https://github.com/uchibeke/gallivant && cd gallivant`, so the first instruction moves them out of the repo
they came to work on, and neither file says how to get back. Every step after that is implied: create the worktrees
directory, decide where briefs live, copy a template whose path only resolves inside the clone, work out whether the
checkout directory needs a gitignore entry, get the repo into `repos` so `up` can recover it. An operator doing this
by hand reads a config error instead of a checklist. An agent told "set up Gallivant here" invents a sequence. And
there is no way to prove an install works short of a real brief against a real repo, so a signed-out harness or a
denied write is found on work that matters.

## User stories

- As an operator in a repo directory, I want one command that sets this repo up and ends in a doctor report, so that I
  do not reconstruct the sequence from four documents.
- As an operator who tells a coding agent to do setup, I want one command line with the install source as an argument,
  so that the agent does not guess at nine steps.
- As an operator installing from a clone I am editing, I want that same command to link the working tree, so that my
  edits take effect without a reinstall.
- As a newly installed operator, I want one command that runs a throwaway brief through the loop, so that I find a
  signed-out harness or a denied write before real work.
- As an operator running that throwaway brief, I want it to clean up the branch, pull request and entry it made, so
  that my repo collects no test artifacts.

## Acceptance criteria

- Given a git checkout with a GitHub remote, when `gallivant init` runs with no arguments, then it resolves the repo as
  owner and name from `gh`, creates the Gallivant home at mode 700, creates the `worktrees` directory named in config,
  adds the repo to `repos` through `rememberRepo`, creates `docs/prds/` in the checkout if it is absent, and ends by
  printing the report `gallivant doctor` prints.
- Given a directory that is not a git checkout, when `gallivant init` runs, then it refuses, saying the command runs
  inside the repo it sets up, and writes nothing.
- Given no config file, when `gallivant init` runs, then it writes the config `suggestedConfig` builds from this machine
  at mode 600 rather than printing it to paste, and doctor's config check passes on the file it wrote.
- Given a config file that already exists, when `gallivant init` runs, then it changes only `repos`, overwrites no key
  the operator wrote, and names the keys it left alone.
- Given `gallivant init` run twice in one repo, when the second run finishes, then `repos` holds one entry for the repo,
  no directory was recreated, and the two reports differ only in timing.
- Given `--from` with a GitHub owner and repo reference, when `gallivant init` runs, then it installs the command with
  `npm i -g` from that reference before any other step, and a failed install stops the run with npm's own message.
- Given `--from` with a path to a local clone, when `gallivant init` runs, then it runs `npm link` from that path so the
  command resolves to that working tree, and reports which path is now on PATH.
- Given the command already on PATH and no `--from`, when `gallivant init` runs, then it installs nothing and reports
  the resolved path and version in use.
- Given `--prd` with a brief name, when the setup steps finish, then it copies the packaged `templates/prd.md` into
  `docs/prds/` under that name with `status: draft`, resolving the template from the installed package rather than the
  current directory, and prints the path to edit.
- Given any doctor check that fails, when `gallivant init` finishes, then the exit code is 1 and each failing line
  carries doctor's own fix text, so the operator reads one report rather than two.
- Given a repo that has been through init, when `gallivant try` runs, then it writes `docs/prds/gallivant-try.md` whose
  acceptance criteria describe one file the session must create, marks it ready, starts a session, and reports the
  entry id and the checkout path.
- Given the daemon is not running, when `gallivant try` runs, then it ticks once itself rather than requiring
  `gallivant up` in another tab, and reports each state the entry passes through.
- Given a try session that opened a pull request, when the entry reaches `pr-open`, then the command reports the pull
  request URL and stops without waiting for a reviewer, because a reviewer round is not what it proves.
- Given `gallivant try --clean`, or a try run that finished, when cleanup runs, then it closes the pull request, deletes
  the remote branch, removes the registry entry, deletes the worktree under the worktrees root, deletes the brief from
  the operator's checkout, and reports each deletion by path.
- Given a repo whose default branch carries a ruleset, when the try session pushes, then it pushes only to
  `gallivant/gallivant-try`, so the run proves the guardrails hold rather than working around them.
- Given a harness that is signed out, when `gallivant try` runs, then it stops before cloning with the sign-in message
  `start` produces, and leaves nothing behind.

## Verify

```sh
npm test
```

- `node --test test/*.test.mjs`

## Where to look

- `lib/commands/doctor.mjs`, whose `suggestedConfig` builds a config from this machine and whose `renderDoctor` is the
  report `init` ends with. Nothing here needs a second checklist.
- `lib/config.mjs` for `rememberRepo`, which appends to `repos` without disturbing other keys, and `validate`, which a
  written config has to satisfy. `repos` entries are `"owner/name"` or `{ "repo", "base" }`, and `rememberRepo` writes the
  string form when no base is named, which is what `init` should do: `init` is not where a base branch is chosen, and
  writing an object entry with no base would change the shape of the operator's config for nothing. An operator whose
  pull requests target something other than the default branch sets it with `gallivant start --base <branch>` once, or by
  hand. See [the base branch](../config.md#the-base-branch).
- `lib/commands/start.mjs`, which already remembers the repo, writes the snapshot, clones and copies the brief in.
- `lib/git.mjs` for `worktreePath` and branch naming; `lib/commands/up.mjs` for the single-tick path `try` needs.
- `bin/gallivant.mjs`, for how a command is wired and where the help text lives.
- `docs/audit/open-source-user.md` line 113, where the position on keeping worktrees out of the repo was recorded.

## The gitignore decision

The work directories do not need a gitignore entry, and `init` should not add one.

Checkouts live at the path `worktreePath` builds: the configured `worktrees` root joined with owner, repo and brief
id. `validate` refuses a `worktrees` value inside the Gallivant home, and `suggestedConfig` defaults it to a sibling
of the current repo rather than a child. Snapshots live under the Gallivant home. Neither is ever inside the
operator's checkout, so git never sees them. The audit reached the same conclusion for a second reason: an operator
with sixty repos would otherwise be editing sixty gitignore files.

The one thing `init` writes into the repo is `docs/prds/`, and that is the opposite case. Briefs are the operator's own
work, they belong in review, and the pull request body links the path, so an uncommitted brief leaves a link to
nothing. `init` should say that in its report, because the question is reasonable and a directory listing does not
answer it.

## Worked example

Remote install, from any repo directory:

```sh
cd ~/work/widget
gallivant init --from github:uchibeke/gallivant --prd widget-export
```

Local clone, when the operator is editing Gallivant itself:

```sh
cd ~/work/widget
gallivant init --from ~/projects/gallivant --prd widget-export
```

Either form is the whole instruction an agent needs: run `gallivant init --from` with that reference in the repo I am
in, fix what doctor reports, then run `gallivant try`. `init` ends in the report and `try` ends in a pull request URL
or a named failure.

Already installed, setting up a second repo:

```sh
cd ~/work/api
gallivant init
gallivant try
```

## Out of scope

- A wizard that prompts. The SPEC cut an init wizard on purpose and the audit's reasoning holds: the APort installers
  open their own prompts and the Codex hook needs trust from inside the Codex interface, so a wrapper that hides them
  stalls on a question the operator did not expect. `init` automates what it can and prints doctor's fix line for the
  rest.
- Installing APort, creating the ntfy topic or the branch ruleset, minting a token. Those parts of `docs/install.md`
  need a decision or a third party; doctor reports them and `init` stops.
- Writing the brief. `--prd` copies the template and names the file; the text is the operator's.
- A scratch GitHub repo for `try`. The try run goes against the repo the operator is in, because a scratch repo proves
  nothing about that repo's ruleset, token scope or labels.
- Uninstall, which is npm's job, and a launchd or systemd service installer, which is its own milestone.
