# Config

`~/.gallivant/config.json`, mode 600. `gallivant doctor` prints a complete one from your machine when the file is missing. Set `GALLIVANT_HOME` to use another directory.

| Key | Default | Meaning |
|---|---|---|
| `poll_seconds` | 120 | Tick interval. Minimum 30. |
| `max_iterations` | 20 | Automatic fix-round allowance per PR. A pushed fix or changed completion receipt consumes a round. At the cap, further automatic work stops with `needs-human`. Explicit operator resumes can exceed the cap; their progress still counts. |
| `checks_grace_minutes` | 5 | A head younger than this with no checks reported is not green yet; GitHub shows an empty check list for the first seconds after a push. A head older than this with no checks at all counts as green. |
| `run_timeout_minutes` | 720 | A run older than this is killed (SIGKILL) and the PR stops with `timeout`. It is a catch for a wedged session, not a spend limit; see below. Overridable per repository. |
| `max_budget_usd` | 5 | Passed to Claude runs as `--max-budget-usd`. Codex has no equivalent; the timeout bounds it. |
| `rereview_minutes` | 6 | If the reviewer has not reviewed this long after a request, the request is posted once more. |
| `stall_hours` | 6 | If the reviewer still has not reviewed, the PR stops with `reviewer-silent`. |
| `trusted_authors` | required | GitHub logins whose reviews and comments may start a run. Everyone else is ignored. Your own login belongs here. |
| `reviewer` | Codex | `{ login, rereview_comment, blocking_pattern }` or `null`. See below. |
| `deliverable` | policy defaults | Limits for the completion gate, in the shape of APort's `deliverable.task.complete` passport limits: `evaluator` (`aport` confirms with APort's hosted evaluator using a per-task passport, `local` uses only the built-in rules), `api_url`, `on_unreachable` (`wait`, the default: no decision until APort answers, the daemon retries next tick and stops as `needs-human` after five consecutive failures; `local`: the built-in verdict stands and the log says so), `require_summary`, `min_summary_words`, `require_tests_passing`, `scan_output`, `blocked_patterns`. `null` turns the gate off. See [prd.md](prd.md). |
| `notify` | null | `{ ntfy: "https://ntfy.sh/<topic>", email: null }`. Null means transitions are logged only. |
| `worktrees` | required | Directory for per-PRD checkouts. Must be outside the Gallivant home. |
| `github_token_file` | null | Null means the credential is resolved from the environment or from `gh`, so whichever way you are logged in already works. Set it to the path of a fine-grained PAT to narrow what a run can reach; it then wins over both of the others. See [GitHub credentials](#github-credentials). |
| `context_paths` | [] | Directories a run may READ in addition to its own checkout: a sibling repository, a folder of design notes. Absolute or `~`-prefixed, and each must exist. Writes do not widen. Your home directory, the Gallivant home, `~/.claude`, `~/.codex`, `~/.config/opencode` and `~/.aport` are refused, as is any parent of them. Claude Code renders each as `--add-dir <dir>`; Codex and Gemini CLI refuse the run rather than escalate; opencode and goose have no such flag and ignore it. Read [guardrails.md](guardrails.md#extra-read-directories-are-a-widening-not-a-feature) before setting it: whatever a run reads can leave in a commit or a PR body. |
| `harness` | discovered | Omit it and Gallivant uses whichever harnesses it finds on your PATH, so one installed harness is a complete install. Name one and only that one is used, which is what you want when two versions are installed or a harness is deliberately out of play. |
| `harness.claude` | | `{ bin, settings }`. `bin` is the absolute path to `claude`; `settings` is the Gallivant settings file with the APort hook and sandbox. |
| `harness.codex` | | `{ bin }`. |
| `harness.gemini` | | `{ bin }`. |
| `harness.opencode` | | `{ bin }`. |
| `harness.goose` | | `{ bin }`. |
| `repos` | [] | The repositories Gallivant watches, appended by `start` and `register` and read by `up` to recover from GitHub. Each entry is either `"owner/name"` or an object: `{ "repo": "owner/name", "base": "staging", "run_timeout_minutes": 90 }`. Both object keys are optional. See below. |

The default allows 20 rounds because multi-part tasks can still receive distinct, actionable review findings after
fifteen rounds. It remains a fixed allowance: reaching it requires an operator decision, and it never increases itself.
Existing explicit `max_iterations` settings keep their value. More rounds allow more time and model spend; they do
not resolve missing credentials, permission denials or unavailable providers. Recheck a stopped PR after changing
the setting and restarting the daemon; its session, worktree and consumed rounds are preserved.

Five harnesses are supported: Claude Code, Codex, Gemini CLI, opencode and goose. A harness can join when it does
three things: start a run non-interactively, resume that specific session by id rather than "the latest", and emit
a machine-readable stream the outcome can be read from. All five do, and each one's resume was checked by
round-trip on 2026-09-25: a number written in one process came back when a second process resumed that session id.

`cursor-agent` is the one that has the flags but is still out. `--print --output-format stream-json`, `--resume
<chatId>` and `create-chat` cover the contract, but it is not signed in on the author's machine, so a headless run
draws the interactive sign-in screen and exits non-zero. Nobody has seen its event stream, and writing an adapter
against an unseen stream would be a guess. The blocker is a login, not a missing capability. The reasoning is kept
next to the adapters in `lib/harness.mjs`.

## The base branch

The branch a pull request targets. It decides three things, and all three read one value:

- the branch the fresh checkout is cut from, in `git.create`
- the `gh pr create --base <branch>` the session is told to run
- the branch the daemon merges into the branch before every round of work

Gallivant used to read the repository's default branch from `gh repo view --json defaultBranchRef` and use that for all
three. That is wrong for a repository whose pull requests go somewhere else. On one real project `gh repo view`
reported `main` while every merged pull request had `baseRefName: staging`, so a branch was cut from `main` and the
session was told to open against `main`, both wrong, and nobody found out until the pull request existed.

Three ways to set it, highest first:

1. `gallivant start <prd.md> --base staging`. Used for that start, and written into `repos` for that repository, so it
   is typed once rather than every time.
2. `{ "repo": "acme/widget", "base": "staging" }` in `repos`, written by hand or by the flag above.
3. The repository's default branch, as reported by GitHub. This is the fallback and it has not changed: an operator
   who configures nothing gets what they get today.

It is a property of the repository, not of the operator and not of one brief. A single global key would be wrong for
anyone with two repositories, and a `base:` key in a brief's frontmatter would let two briefs in one repository
disagree about where their work lands, which is a contradiction with no good way to resolve it. So it lives per
repository in `repos`, and `SPEC.md` still says `base` is not a frontmatter field.

Nothing is derived. Gallivant could guess the base from the most common `baseRefName` among recent pull requests, or
from a `CONTRIBUTING.md`, or from a branch protection rule. All three can be wrong, and a wrong base that nobody typed
is the hardest kind to find: it produces a pull request aimed at the wrong branch with no line anywhere saying why. One
value typed once, printed by `doctor`, `status` and `why`, is worth more than a clever guess.

`gallivant doctor` prints the resolved base for every repository in `repos` and says where it came from:

```
ok    base branch acme/widget       staging (configured in repos; acme/widget's default branch is main)
ok    base branch acme/other        main (acme/other's default branch; nothing configured). Pull requests will target it.
```

A base that is not on the remote fails at `gallivant start`, before anything is cloned and before a session is
spawned. Left to `gh pr create --base`, it fails after a run has implemented the brief, run the tests and spent the
budget, with the work stranded on a branch nobody asked for. `doctor` checks a configured base too, so a branch that
was deleted after it was configured is reported before the next start rather than during it.

## How long a run may take

`run_timeout_minutes` bounds one run. Past it the run is SIGKILLed and the entry stops with `timeout`. It resolves the
same way `base` does, and for the same reason:

1. `run_timeout_minutes` on the repository's `repos` entry: `{ "repo": "acme/big", "run_timeout_minutes": 120 }`.
2. The global `run_timeout_minutes`.

How long verification takes is a property of the codebase. A repository whose `Verify` commands are `pnpm type-check`
and `pnpm build`, at about 2m30s each, cannot do the same work in the same budget as one whose whole suite is `npm test`
in nine seconds, and an operator with both has no single number that is right for either.

**This is not a spend limit.** It catches a session that is genuinely wedged: spinning on a command that never returns,
waiting on a prompt that will never come, looping. What bounds spend is `max_iterations` and `max_budget_usd`, and they
are the right tools because they can tell an expensive round from a stuck one. A clock cannot.

The default was 30 and is now 720, twelve hours. Two runs are the argument. One review round was killed at 31.2 minutes
against the 30-minute limit with its work finished: it had verified four review findings against the code, created a
shared route inventory with a test pinning it, fixed a referrer bug, extracted an emitter and mutation-tested it, fixed
six contradictions on a page with a test pinning them, and run the full baseline green (846 tests, 611 type errors
matching the recorded baseline). Its last tool call wrote the commit message, and it was killed between writing that
message and running `git commit`, so none of it was committed and the entry reported `reason: timeout` as though the
session had failed. The healthy run before it took 7.3 hours and exited 0.

So any default under about eight hours can cut a run like the second one, which makes 30, 45 and 180 the same error at
different scales: a limit set near the cost of real work. Twelve hours is "longer than any legitimate run", which is what
this knob is supposed to be.

The tradeoff is real and is deliberate: a wedged session now burns up to twelve hours before the daemon stops it. That is
a spend question and `max_budget_usd` is its control. There is no second clock.

The validation floor is 1, so an operator who deliberately wants a short timeout can set one, per repository or globally.

A kill reports what it interrupted. `gallivant why` names the limit that was exceeded and which of the two set it, so
the right number gets raised, and it names any work the kill left behind:

```
killed: ran 31m and exceeded its 30m timeout (the global run_timeout_minutes). SIGKILL, so the session had no
chance to finish what it was doing; the run log below is the last thing it did.
  UNCOMMITTED WORK IN THE WORKTREE: 6 modified, 4 untracked, held by no commit and in no PR.
  Do NOT delete or recreate the checkout: `gallivant resume` rebuilds a missing worktree without asking, which
  would discard this.
```

The uncommitted count is the half worth reading. A run killed before its `git commit` has nothing committed, so a
commit count says zero about the worst case there is, and `resume` recreates a missing worktree without asking. An entry
killed with a clean tree says so too, which is what makes the warning mean something when it appears.

## Keeping a branch on its base

The daemon merges the base branch into the work branch before every round of work: before each fix round the tick
dispatches, and before a `gallivant resume`. At `start` there is nothing to do, because a branch just cut from the tip
of its base is already on it; what matters there is the fetch, so the cut is from the current base rather than a stale
local ref.

It is a merge, not a rebase, and the reason is not tidiness. A rebase rewrites history, so a pushed branch could only
move with a force-push, and the rules every session is given say "Do not force-push" for good reasons that apply just
as much to the daemon. A rebase would also strand the reviewer: Gallivant clears a head only when the commit the
reviewer named is that head, so every rewrite makes every prior clearance describe a commit that no longer exists, and
the reviewer's inline comments are anchored to those same commits. And the tick reads a head it did not put there as a
person's push, resetting the reviewer clock, so a daemon force-push would look to the daemon itself like a stranger
pushing.

A merge avoids all of that. It moves the head forward, so the remote takes it without `--force`; every reviewed commit
stays an ancestor, so a clearance keeps describing something real; and the commit it adds is the daemon's own, which
is the honest record. The price is a merge commit in the history, which is the cheaper of the two.

An outstanding review does not hold it up, which is a consequence of that choice rather than a separate decision. A
rebase would have had to wait for the review to land, and waiting is a deadlock: the reviewer is waiting for a fix and
the fix is waiting for the reviewer.

The merge commit stays local until the session pushes, so nothing on GitHub moves when it happens. The head the loop
is watching is unchanged, the reviewer clock is not reset, and the round is still counted from the session's own push,
which carries the merge with it as one head move rather than two.

A merge that conflicts is aborted, so a session is never handed a checkout with conflict markers in it. The entry then
stops with reason `base-conflict`, naming the base it could not merge, and `gallivant why` prints the conflict git
reported. A `gallivant resume` refuses instead of stopping, because there is an operator reading the output: it prints
the conflict and the `git merge` command that resolves it, and resumes nothing.

Every merge is recorded the moment it happens, not when the round finally starts, because several things after it can
decline the round. The log says what was merged into what and when, and `gallivant why` prints the same thing with the
commit, so an operator reading a diff they did not expect can see where the extra commit came from.

## What is deliberately not a key

Two bounds the daemon enforces have no setting, and both are fixed numbers with their reasoning written at the
constant.

- **How many consecutive failures of one GitHub write stop an entry.** Five, in `lib/tick.mjs`. Five steps in the
  tick wait rather than proceed when a write will not land, and each of them stops the entry with reason `stuck` once
  that write has failed five ticks in a row. The only question the number answers is "transient or permanent": at the
  default `poll_seconds: 120` it is ten minutes, which outlasts a GitHub rate-limit window and falls far short of a
  revoked token or a missing permission. `max_iterations` is not reused for it because that counts fix rounds, which
  cost a harness run each, where these cost one API call.
- **How many entries the tick works on at once.** Four, also in `lib/tick.mjs`. Entries never block each other, and
  `gh` is the shared resource.

Sign-in checks are not equal across the five. `claude auth status` and `codex login status` report on credentials
without spending a call, and `opencode auth list` prints the stored ones. Gemini CLI and goose have no such
command, so their probe only proves the binary runs; an unauthenticated run fails at its first model call and
shows up as a failed run rather than a failed probe.

## The reviewer object

Gallivant does not know or care which tool reviews the pull request. Three fields say who the reviewer is, how to
ask it for another look, and what counts as a finding it is blocking on. The default is Codex because that is what
Gallivant was first driven against, and it is only a default:

```json
"reviewer": {
  "login": "chatgpt-codex-connector[bot]",
  "rereview_comment": "@codex review",
  "blocking_pattern": "\\bP[01]\\b"
}
```

- `login` must be a bot account; it is matched exactly after normalising the `[bot]` suffix. A human with the same name is not the reviewer. This is the only thing that decides whether a review or an inline comment came from the reviewer.
- `rereview_comment` is the entire text Gallivant posts to ask for another look. It is posted after every push that came from a fix run, and again as a nudge if the reviewer says nothing for `rereview_minutes`. Gallivant never inspects the string, so a bot mention, a slash command or a plain sentence all work.
- `blocking_pattern` is a regex tested against each inline comment of the reviewer's newest review since the last request. A match, or a `CHANGES_REQUESTED` state, keeps the PR out of `ready-for-human`.

### Pointing it at a different reviewer

Nothing beyond these three fields needs to change. Two worked examples.

A different review bot, here one that labels its findings by severity instead of Codex's `P0`/`P1`:

```json
"reviewer": {
  "login": "coderabbitai[bot]",
  "rereview_comment": "@coderabbitai full review",
  "blocking_pattern": "(?:^|\\s)(?:Critical|Major):"
}
```

A human reviewer, which needs no knowledge of any vendor at all. `login` is their GitHub login and `rereview_comment`
is whatever you would have typed yourself:

```json
"reviewer": {
  "login": "alice",
  "rereview_comment": "@alice pushed a fix, ready for another look",
  "blocking_pattern": "\\bblocking\\b"
}
```

One caveat on the human case, and it is a real one: `login` is required to be a bot account, because a `[bot]`
account is what distinguishes a review tool from the trusted humans in `trusted_authors`, whose comments Gallivant
dispatches a fix run against rather than waiting on. So a human login in `reviewer.login` never matches, the verdict
stays `waiting`, and the PR waits out `stall_hours` and then stops with `reviewer-silent` for a person to look at.
That is a reasonable way to run a repo where a human gates every merge, but it is a wait, not a verdict. If you want
the human's findings to drive fix rounds instead, put them in `trusted_authors` and set `reviewer` to null.

### No automated reviewer

`"reviewer": null` means there is no review tool: only humans and CI drive the loop, and a PR is ready as soon as
checks are green. Gallivant asks nobody for a re-review, so there is no nudge and no `reviewer-silent` stop. It still
comments after a push, because the round comment is also how a recovery rebuilds the round count off the PR, but the
comment says `Pushed a fix.` and mentions no one.

## Harness flags

Flags are not configurable; they live in `lib/harness.mjs` and are the verified working form for each CLI version:

- Claude Code: `-p --permission-mode auto --permission-prompts none --max-budget-usd <n> --settings <file> --output-format stream-json --verbose`, with `--session-id <uuid>` on start and `--resume <uuid>` on resume.
- Codex: `exec --json -c approval_policy="on-request" -c approvals_reviewer="auto_review" -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true --skip-git-repo-check`, with the same overrides on `exec resume <id>`. The automatic reviewer handles Git metadata writes without an operator click; a denied escalation still stops. These are adapter defaults, not operator settings.
- Gemini CLI: `--skip-trust --output-format stream-json -p`, with `--session-id <uuid>` on start and `--resume <uuid>` on resume. `--skip-trust` is mandatory: without it a headless run in an untrusted directory refuses and the run is wasted. The help text says `--resume` takes "latest" or an index; that is incomplete, and a UUID is the only form that resumes one specific session.
- opencode: `run --format json`, with `--session <id>` on resume. Ids are minted by the server and cannot be pre-assigned, so the id is read back off the run's own JSONL, as with Codex.
- goose: `run --output-format stream-json -t`, with `--name <id>` on start and `--resume --name <id>` on resume. `--session-id` looks like the flag to use but is resume-only and refuses without `--resume`, so it cannot name a session the daemon will come back to.

## Files a brief carries: `sources`

A brief often cites documents beside it. Name them in its frontmatter and they travel into the session's checkout:

```yaml
---
status: ready
harness: codex
sources:
  - docs/research-notes.md
  - AGENTS.md
---
```

Paths are relative to the repository root, named one at a time with forward slashes. Absolute paths, `..` segments,
globs, directories, `.git` components and symlinks at any path component are refused. `gallivant ready` reads every file and refuses the brief if one is missing, unreadable or
not text, so a mistyped path costs a second at your terminal rather than thirty minutes inside a paid run.

Each file is snapshotted beside the brief's own snapshot and written into the checkout from that snapshot, not from your
tree. That is the same rule the brief follows: the daemon judges what it recorded, so a session cannot widen what it was
given by editing a document it was handed. Editing one in your own tree afterwards is reported by `gallivant why` the
same way an edited brief is, and the list itself is part of the contract, so adding or removing a file is a contract
change even though no criterion moved. Changes to either the manifest or file bytes block readiness and resume until
accepted with `resume --resnapshot`; accepted snapshots are also restored when a checkout is recreated.

`sources` and `context_paths` answer different questions and neither replaces the other. `sources` puts named files
INSIDE the checkout, so it works on every harness because it needs no flag at all. `context_paths` grants a session read
access to directories OUTSIDE its checkout, which only some harnesses can express:

`context_paths` renders per harness, and only Claude Code has a flag that grants read without also granting write:

- Claude Code: `--add-dir <dir>` once per path, placed before the prompt. Writes stay bounded by the sandbox in the file `--settings` points at.
- Codex: refused. `--add-dir` is documented by Codex itself as making directories *writable*, and `sandbox_permissions=["disk-full-read-access"]` is the whole disk. Checked against 0.157.0: a per-path spelling and `sandbox_workspace_write.readable_roots` are both reported as ignored settings, so the read would silently not happen.
- Gemini CLI: refused. `--include-directories` adds to the workspace, which is Gemini's write boundary as well as its read boundary.
- opencode and goose: no directory flag exists. The list is ignored and `doctor` reports that it has no effect on those runs, rather than failing a run over a setting the CLI cannot honour.

An empty list renders nothing at all, so a run without extras has the argv it had before the setting existed.

Any `--dangerously-*` flag is refused by the adapter, and so is each harness's own equivalent: `-y`/`--yolo` and
`--approval-mode yolo` for Gemini CLI, `--auto` for opencode, and a `sandbox_mode` override whose value contains
`danger` for Codex. goose has no such flag at all; it is bounded by the `GOOSE_MODE` environment variable, which
the adapter pins to `smart_approve` and the same check refuses to loosen. Gallivant never edits
`~/.claude/settings.json`, `~/.codex/config.toml` or `~/.config/goose/config.yaml`.

## GitHub credentials

A run is sandboxed. It cannot read your keychain, your Linux secret service, `~/.git-credentials`, or `~/.config/gh`. The daemon is not sandboxed, so it resolves a credential and passes it to the run in the environment as `GH_TOKEN`, where a git credential helper carried in the same environment reads it.

Resolution order, first answer wins:

| Order | Source | When it applies |
|---|---|---|
| 1 | `github_token_file` | You set one. Explicit and scoped, so it is never overridden by anything below. |
| 2 | `GH_TOKEN` or `GITHUB_TOKEN` in the daemon's environment | CI, and anyone who exports a token in a shell profile. `GH_TOKEN` is read first. |
| 3 | `gh auth token` | Everything else. `gh` answers for whichever store it used, so a keyring, a secret service and a plain `hosts.yml` all work without extra setup. |

Gallivant asks `gh` rather than reading `~/.config/gh/hosts.yml` itself. Parsing that file would reimplement `gh`'s own resolution and drift from it as `gh` changes.

If nothing answers, `gallivant start` refuses and names all three, and the daemon stops the entry with reason `no-credential`. Neither spends a run that could not push.

Resolution happens once per run, at spawn, not once per daemon boot. It costs one subprocess, and only when neither the file nor the environment answered. The reason is that a daemon runs for days: a token cached at boot expires under it, and an operator who re-authenticates mid-session would otherwise have to restart the daemon for the new one to be used.

The token reaches the child through the environment only. It is never in argv, which `ps` exposes to every process on the machine; never in `job.log`, which is the child's own stdout and is rendered in the tracker; and never in `cmd.json`, which records the command and its arguments but no environment. Anything that prints a credential prints its source and length instead.

Enterprise hosts. `gh` can be logged in to more than one host, and a github.com token does not authenticate `github.acme.com`, so the host is taken from the checkout's `origin` remote and passed to `gh auth token --hostname`. The host is not a secret, so it is safe in argv; the token comes back on stdout. If `gh` has no login for that host, set `github_token_file`. Gallivant says so by name rather than sending a token that cannot work.

## Environment for runs

Every run gets the resolved credential as `GH_TOKEN`, the git settings below, and per harness: `APORT_CLAUDE_CODE_CONFIG_DIR=<dir of the settings file>` for Claude, `GEMINI_CLI_TRUST_WORKSPACE=true` for Gemini CLI, and `GOOSE_MODE=smart_approve` for goose. Runs are spawned with the checkout as the working directory and binaries by absolute path, so shell functions and aliases around `claude` or `codex` are bypassed.

### Git settings for a run

No file. Git's own `GIT_CONFIG_COUNT` with numbered `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs carries four settings:

| Key | Value |
|---|---|
| `user.name` | `gallivant` |
| `user.email` | `gallivant@users.noreply.github.com` |
| `push.default` | `current` |
| `credential.helper` | a shell snippet that prints `GH_TOKEN` as the password, and prints nothing when there is no `GH_TOKEN` |

Plus `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`.

Nothing in that list is a path outside the worktree, and that is the point. Until v0.1 the helper lived in `~/.gallivant/gitconfig` with `GIT_CONFIG_GLOBAL` pointing at it. A sandboxed run cannot read outside its worktree, so every git command failed with `unable to access '/Users/you/.gallivant/gitconfig': Operation not permitted`, including `git status`. The token was in the environment the whole time and unusable, because the file that would have read it could not itself be read. A test asserts that no value `runEnv` returns is an absolute path other than `/dev/null`, so adding a config file back fails the suite.

Both isolating variables are load-bearing, and `GIT_CONFIG_NOSYSTEM` is not decoration. `GIT_CONFIG_GLOBAL` replaces only git's global file; the system one still applies, and on a Mac with the Xcode command line tools `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig` sets `credential.helper = osxkeychain`. Without `GIT_CONFIG_NOSYSTEM` a run had a path to your keychain whatever else was set. With it, `git config --get-all credential.helper` in a run's environment returns nothing but the snippet above.

What this does not bound, said plainly because it is easy to mistake for new: a run's own `.git/config` is still read, `credential.helper` is multi-valued, and a repo-local helper is consulted before this one. That was equally true when the helper lived in a global file, since local config always won there too. A run owns its worktree, so it can always add a helper. What bounds a run is the token's scope and the branch ruleset, not how the config travels.
