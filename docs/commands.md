# Commands

Handles: every command that takes one accepts `<repo>#<pr>` (short name or `owner/name`), the registry id `<repo>/<prd id>`, or a PRD path. Bare PR numbers are refused because they are ambiguous across repos.

## `gallivant doctor [--send] [--probe]`

The install checklist and the health probe, one line per check, each failure with the exact command or file that fixes it. With no config it prints a complete config built from this machine. `--send` posts a test notification. `--probe` runs a real Claude session in a temp directory and confirms a write inside is allowed and a write outside is denied. Exit code 1 while anything fails.

## `gallivant new <name> [--harness <name>] [--dir <repo>]`

Writes `docs/prds/<name>.md` into the repository you are standing in, from the template that ships with the package.
Run it from anywhere inside that repository: the root comes from git, not from the current directory, so a
subdirectory writes to the same place as the root. The name is lowercased and dashed to what the contract's `path`
rule accepts, so `gallivant new "Widget Export!"` writes `docs/prds/widget-export.md`.

The `harness:` line names whichever harness your config has, so the brief cannot ask for one you have not installed.
`--dir` is for the case where you are not inside the target repository.

It writes one file and nothing else: no registry entry, no branch, no network. The template deliberately fails the
contract, because a starting point that passed it would be a starting point nobody edits. `gallivant ready <path>
--check` prints what is still missing.

## `gallivant ready <prd.md> [--check]`

The only way a PRD becomes ready. Runs every rule of [the contract](prd.md), prints the checklist, asks APort to decide readiness against a per-PRD passport built from those rules, and flips `status: draft` to `ready` (recording the decision id as `aport_decision`) only on an allow. It does not commit the file. `--check` prints the checklist without writing or deciding. Exit code 1 while anything fails.

## `gallivant start <prd.md>`

1. Reads the PRD into a Request (see [the contract](prd.md)), which names the target repository: the checkout the file itself is in, so the PRD has to live inside the repo it describes. Runs the full contract on it and refuses on the first failing rule. There is no override flag.
2. Requires `status: ready`, which only `gallivant ready` sets.
3. Checks the harness named in the PRD is signed in. If not, the entry is recorded as `needs-human` with reason `not-signed-in` and nothing else happens.
4. Builds the run specification: the prompt, the session id, and the argv the harness will be spawned with, including the read-only `context_paths`. This happens before the clone, because it is the last step that can refuse and the clone is the only one that leaves something behind. A harness that cannot grant those directories as read-only is refused here, with nothing cloned and nothing registered, so rerunning `start` after fixing the config works rather than failing on a leftover worktree.
5. Clones the repo into `<worktrees>/<repo>/<prd id>` (partial clone, blobs on demand) on a new branch `gallivant/<prd id>` from the remote default branch. Your own checkout is never touched.
6. Saves the daemon's own copy of the PRD under `~/.gallivant/prds/`, which fix rounds and the completion gate read instead of the checkout, so a session cannot rewrite its own brief.
7. Copies the PRD into the new checkout at the same path it has in your repo, creating the directories it needs. The PRD is usually only in your own checkout, so the fresh clone off the default branch does not have it; this copy is what lets the session commit the brief with the implementation and lets the PR block point at a path that exists. It is writable by the session and is never read back for a decision.
8. Starts the session detached with the PRD as its prompt, records the session id, and remembers the repo for recovery.

The entry is `running` until the daemon sees the run end. Then either a PR exists on the branch and the entry enters `pr-open`, or it stops with `no-pr`.

## `gallivant register <pr-url> [--harness <name>] [--session <id>] [--worktree <dir>]`

Puts a PR into the loop that Gallivant did not open, or resets one that stopped.

- With `--session` and `--worktree`, later fixes resume that session in that directory. Both harnesses key sessions by the directory they ran in, so the pair is required together. The id has to be one the chosen harness could have minted (a UUID for claude, codex and gemini, `ses_...` for opencode, `gallivant-<uuid>` for goose), the same rule the PR block is held to: the value ends up in the harness's argv, where goose in particular derives its session file from it.
- Without `--session`, the first fix run starts a fresh session whose prompt tells it to read the PR with `gh pr view` and `gh pr diff` before changing anything.
- Without `--worktree`, a checkout is created from the PR branch at the standard path.
- A `--worktree` you pass is resolved to an absolute path first, so `.` means the directory you typed it in and not whatever directory the daemon happens to run in later. It is then checked before it is accepted: its `origin` must be the PR's repository and it must already be on the PR's head branch. A path that fails either check is an error, since the harness edits and pushes from that directory. It is never relocated or re-cloned for you, because a resumed session is keyed to the directory it ran in.
- On an entry that already exists: reason cleared, iteration reset to zero, a marked reset comment posted on the PR (so a count rebuilt from GitHub starts from zero too), cursor set to now, watching again. This is how you restart a `needs-human` PR after you fixed the conflict or answered the question. A fresh registration instead looks at the PR's whole history, so feedback already on it gets addressed.
- That reset comment is the reset boundary, so posting it is a precondition of the reset and not a best-effort extra. A count rebuilt from GitHub finds its marker and counts only the round comments after it; with the comment missing and `state.json` later lost, recovery reconstructs the rounds this command had just zeroed, and an entry restored at `max_iterations` stops with `iterations` on its next event having done no work in the round. If it cannot be posted, `register` refuses and changes nothing: the entry keeps its iteration, its state and its cursor, and running the same command again once GitHub answers does the whole reset in one go.
- A reset with a new `--harness` or `--session` makes two durable writes to GitHub, and they are ordered so a failure between them cannot leave GitHub and the registry disagreeing about which harness or session this PR belongs to. The reset comment goes first because it is safely repeatable: a count rebuilt from GitHub takes the LAST reset marker, so a second one counts as one. The identity block goes last, because that write is what a recovery reads the harness and the session out of. So a failed block write leaves a reset comment on the PR, the registry untouched, and both sides still naming the old identity; the same command run again completes the reset.
- Changing `--harness` without giving a new `--session` drops an inherited session the new harness cannot mean, and says so on the way past. A claude session id is a UUID and an opencode one is `ses_...`, so carrying the old one across would have the next fix round resume an id its harness cannot resolve and write a block that cannot be read back. A session from another harness is meaningless rather than wrong, so it is dropped rather than refused, and the next fix round starts a fresh one. An id you typed yourself is a different case and is still refused, because you meant that id. A harness change between two that agree on the format, claude to codex say, keeps the session.

When the block names a PRD that exists on the PR's branch, the daemon's own snapshot of it is taken, exactly as recovery does, because the completion gate reads that snapshot and nothing else: without it the gate is skipped and the PR can be marked ready with no acceptance criterion evaluated. A snapshot already on disk is kept rather than replaced with the copy the session could have edited, and a PRD the branch does not carry is logged and the PR watched without a gate.

Fork PRs and closed PRs are refused. If the PR body has no Gallivant block, one is added; if it has one that names a different harness or session than the registration chose, it is rewritten to match. Recovery after a lost `state.json` reads that block, so a block left saying the old harness would restore the wrong one.

## `gallivant up [--once]`

The daemon. On boot it writes `daemon.json`, refuses to run if another daemon is alive, and reconciles with GitHub: for every repo in `repos`, every open PR of yours on a `gallivant/*` branch with a valid block that is not in the registry is registered, with the iteration recovered by counting Gallivant's own round comments and the cursor set so old events are not replayed. The PRD snapshot is taken from the PR branch when the daemon has none. Missing checkouts are recreated from the PR branch.

A recovered entry is treated as newly asking, not as mid-conversation, and in two ways that `register` already worked this way:

- The reviewer clock is floored at `rereview_minutes` ago, so a PR whose last round comment is seven hours old is not stopped `reviewer-silent` on the very first tick. The silence accrued while no daemon was running to ask, and stopping for it tells you nothing you can act on while costing you a `register` to resume.
- Failing checks on the recovered head are dispatched rather than treated as already sent. A fix that had been dispatched and had pushed would have moved the head, so red CI on the head that is actually there has not been addressed by anything; the only case a recovery could dispatch twice is a run that was still in flight when the daemon died, and that run's work is lost anyway.

Then it ticks every `poll_seconds`. Before each tick it probes `gh` and every configured harness; while any probe fails nothing is dispatched and one throttled error notification goes out per failing probe. Ticks chain on a timer and never overlap. `--once` runs a single tick and exits, which is useful for cron or for debugging.

On a Mac the daemon runs `caffeinate -i` for its own lifetime.

## `gallivant status [--all] [--json]`

```
gallivant  daemon up since 6h ago  last tick 40s ago  next in 80s  gh ok  claude ok  codex ok

NEEDS YOU
  widget#142        needs-human   conflict                  round 2/3   12m ago   gallivant why widget#142
  api#31            ready         green, no blocking findings, receipt accepted  round 1/3   2h ago    https://github.com/acme/api/pull/31

RUNNING
  guard#88          fixing        review 2201 by chatgpt...  round 1/3   3m ago
  widget#150        waiting       on reviewer, nudged once   round 0/3   4m ago
  api#44            blocked       ready label write failing (3), retrying  round 1/3  6m ago
```

A `ready` row says whether the completion gate accepted the receipt or never ran at all (`RECEIPT NOT CHECKED`, with the reason), because an entry with no PRD snapshot reaches ready on the checks and the reviewer alone and that is a different thing from passing the gate.

A row whose detail names a GitHub write is an entry whose tick is declining one step until that write lands, with the failures counted; see `gallivant why` below for the five writes this can be. `blocked` is the one of those to read twice: every readiness condition has already passed and only the label that says so will not write, so the label is `blocked` rather than `fixing`. The others read `fixing` or `implementing`, which is true for them, because a fix round really does follow.

Sections are in the order needs-you, running; `--all` adds done. The first line is `daemon DOWN` with exit code 1 when no daemon is alive. `--json` prints the same model for scripts and UIs.

## `gallivant serve [--port 8791]`

A local web page showing every entry and every run, with the log of a run tailing live. One place to look instead of `status`, `why` and `tail -f` in three terminals. It is meant to sit in an iframe in a dashboard, so it assumes no viewport size and never navigates the top-level window.

Three views, each with a sidebar listing everything the view holds:

- `/` every registry entry as a row, grouped needs-you, running and done the same way `gallivant status` groups them, from the same `model()`.
- `/run?id=<entry id>` one entry: handle, state, reason, harness, round, PR link, branch, checkout, session id, and the live log below.
- `/runs` every run folder under `~/.gallivant/runs`, newest first, with its entry, start time, exit code and duration, filterable by entry. Picking one in the sidebar opens its log in the pane beside the table. The history is already on disk; this is the index over it.

The sidebar has one filter box that searches everything on the view, including fields the row does not show in full: an entry's id, reason and harness, a run's id and start time. Groups collapse, and which ones you closed is remembered per view. A filter overrides that, so a match inside a closed group still shows. `?by=harness` groups by harness instead of by state, and the choice rides along on every link, so a grouped view is a URL you can bookmark or frame.

JSON for scripts and for a dashboard's own widgets: `/api/status` (the same model `status --json` prints), `/api/runs`, `/api/run/status?id=<entry id>`, and `/api/run/output?id=<entry id>` for the log as server-sent events. `--port` takes anything from 1 to 65535; the default is 8791.

Two things to know about it:

- **It is read-only.** There is no route that starts, kills, resets or edits anything, and no method but GET is routed. Changing state stays the CLI's and the daemon's job, so a page left open in a tab can do nothing.
- **It binds to 127.0.0.1 and has no password.** That is the same boundary as the CLI: anything that can reach it can already read `~/.gallivant`. Do not put it behind a tunnel or a reverse proxy that answers on a public address, because the pages show branch names, local paths and whatever the agent printed.

### Runs from other tools

A host can point the tracker at run folders it does not own, through `runSources` on the context it passes to
`mount`: a list of `{ label, dir }`. Command center writes the same `job.json` and `job.log` under
`<project>/.content-pipeline/runs/`, which is where Gallivant's runner came from, so those runs list and stream in
the same table with no conversion. They are listed and opened by their source label, never by a registry id, since
there is no registry outside Gallivant's own tree; a label that is not in the configured list reaches no directory.

### Running it inside another server

`gallivant serve` is one way to run the tracker, not the only one. The same router can be mounted inside a server you already start, so one process and one port serve both and there is no second thing to supervise:

```js
import { mount } from "gallivant/lib/commands/serve.mjs";
import { makeContext } from "gallivant/lib/context.mjs";

const tracker = mount(makeContext(), { base: "/gallivant" });

createServer((req, res) => {
  if (tracker.owns(req)) return tracker.handle(req, res);
  // ... the host's own routes
}).listen(8790, "127.0.0.1");
```

`owns(req)` is true for the prefix and anything under it; `handle(req, res)` serves it, including its own 404, its assets and the log stream. Every URL the pages emit is built from the mount path, so nothing is hardcoded to the root and the same code serves `/run?id=` standalone and `/gallivant/run?id=` mounted.

Two things become the host's responsibility, because a mounted router cannot enforce them:

- **The bind address.** Standalone, the tracker binds `127.0.0.1` itself and cannot be reached from another machine. Mounted, it answers wherever the host answers, so a host on `0.0.0.0` publishes the tracker too.
- **Auth.** Nothing in the tracker asks who is calling. A host with a sign-in should check it before handing the request over, which also gives the tracker auth it does not have on its own.

Mounting on the same origin is worth preferring for a second reason: the `--gv-*` properties below only work across the same origin, so a same-origin host can restyle the tracker to match itself.

### Embedding it in a page

`?theme=dark` or `?theme=light` on the iframe src forces the palette. Pass it from a parent that knows its own theme, because `prefers-color-scheme` inside an iframe follows the browser rather than the page that framed it, and a dark dashboard otherwise gets a light frame.

Every colour, font and spacing value in `templates/tracker/tracker.css` is a `--gv-*` custom property with a default. A page on the same origin can override them and restyle everything. A page on another origin (a host on another port is another origin) cannot reach into this document at all, whatever the properties are named, which is why the query parameter exists.

The tracker brings its own sidebar, filter and grouping, so it does not need a host's chrome around it. Give it a page or a full-height frame rather than a panel.

The log pane sends the last 400 lines when it opens and says how many earlier ones it is not showing; the whole log is in the run folder. It reconnects on its own and resumes where it left off rather than starting again. It follows the log file rather than the harness process, so it works for a run the daemon started before its last restart, and it auto-scrolls only while you are already at the bottom.

## `gallivant why <handle>`

For a stopped or running PR: state and reason, the PR and checkout paths, the session id and the by-hand command to open it (`claude --resume <id>` or `codex resume <id>` in the checkout), the last dispatched event, the run folder and exit code, cost when the harness reports it, permission denials, the harness's final message, and any APort audit lines from the run's time window.

An entry whose tick is waiting on one GitHub write also gets a line naming that write and how many ticks it has failed, so a PR that looks idle says why it is idle. `status` says the same thing on its row. After five consecutive failures the entry stops with reason `stuck` and `last event` carries the write and GitHub's own message, which is usually a token permission: `Resource not accessible by personal access token` on a body write means the token cannot edit PR descriptions, on a label write that it cannot edit issues, and on a comment that it cannot write to the PR conversation. Fix the token, then `gallivant register <pr-url>` to resume.

The five writes that can put an entry there, and what each one is holding up:

| `retry.op` | What it is holding up |
|---|---|
| `ready label removal` | a fix round for new feedback, or judging a head that just moved, while the PR still says a human may merge |
| `PR #<n> block write` | a start run leaving `running`, so the PR is open but not yet watched |
| `ready label write` | nothing: every readiness condition passed and only the label saying so will not write |
| `round comment` | announcing a round that is already counted. The push landed and the budget was charged for it; the PR has not been told, and until it is, the re-review has not been asked and the entry judges nothing |

`ready label write` is the one worth reading twice. The work is done and the PR is finished; what is missing is the label a person looks for. `why` says so in as many words, and `status` labels that row `blocked` rather than `fixing`, because nothing is being fixed.

`round comment` is the other one. The round it announces is already counted, so the registry is one round ahead of what the PR says, and the count on the PR is what a recovery after a lost `state.json` rebuilds from. `why` prints both numbers: which round is counted, and how many a recovery would find until the comment posts. The gap is at most one round, and it closes the moment the comment lands.

## `gallivant remove <handle>`

Forgets an entry. The PR, its branch, its labels and the checkout are left as they are; `register` puts the PR back into the loop. Use it for an entry that was started against the wrong repo or that you have taken over by hand.

## What the daemon posts on your behalf

- A round comment after every push, `@codex review` by default, with an HTML marker so it can recognise its own comments; a marked "Completion receipt updated" comment after a round that only rewrote the receipt; a marked reset comment when `register` resets an entry.
- One nudge comment if the reviewer has not answered within `rereview_minutes`.
- The labels `gallivant:ready-for-human` and `gallivant:needs-human`, created once per repo the first time it is watched.
- The Gallivant block in the PR body, once.
- Nothing else. The harness posts its own thread replies during a fix run; those are recognised and never treated as events.
