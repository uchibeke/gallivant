# Commands

Handles: every command that takes one accepts `<repo>#<pr>` (short name or `owner/name`), the registry id `<repo>/<prd id>`, or a PRD path. Bare PR numbers are refused because they are ambiguous across repos.

## `gallivant init [--harness codex|claude] [--worktrees <directory>]`

Create a private config from your authenticated GitHub login and the selected
installed harness (Codex by default). Creates a separate checkouts directory,
disables optional notifications initially, and prints the packaged template paths.
Existing configs are refused, never replaced. Does not change credentials, global
harness settings, reviewer installation or repository rules. Follow `doctor` and
[installation](install.md) next. `--version` prints the installed package version.

## `gallivant doctor [--send] [--probe]`

The install checklist and the health probe, one line per check, each failure with the exact command or file that fixes it. With no config it prints a complete config built from this machine. `--send` posts a test notification. `--probe` runs a real Claude session in a temp directory and confirms a write inside is allowed and a write outside is denied. Exit code 1 while anything fails.

## `gallivant task [prepare] "request" [--stdin] [--run] [--json]`

Prepares an isolated canonical PRD through the shared task service. Accepts
`--dir`, `--repo`, `--base`, `--harness`, repeated `--context` files and a retry-safe
`--request-id`. Material unknowns return saved questions; `task answer` resumes
their identity using `--revision`, `--request-id` and repeated `--answer id=text`.
`task inspect`, `list`, `resume`, `validate` and `start` expose the same versioned
operations to CLI and in-process clients. Preparation uses inference but starts
implementation only with explicit `--run` authorization and exact readiness.
Configured Claude uses tool-free preparation; Codex 0.160.0+ uses its isolated
preparation profile. Hosted providers require their own registered preparation
capability and access checks. Unsupported adapters return
`TASK_PREPARATION_BOUNDARY` without an automatic fallback.
See [task operations](tasks.md) for examples, source delivery and stopping rules.

One line per repository in `repos` names the base branch its pull requests will target and where that answer came from,
so a repository whose work should go to `staging` while nothing is configured is visible before a session opens a pull
request against `main`. A configured base that GitHub does not have is a failure here, with the fix. See [the base
branch](config.md#the-base-branch).

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

The only way a PRD becomes ready. Runs every rule of [the contract](prd.md), prints the checklist, asks APort to decide readiness against a per-PRD passport built from those rules when configured, and flips `status: draft` to `ready` (recording the decision id as `aport_decision`) only on an allow. It does not commit the file. `--check` reads only the brief and its sources: it skips runtime config, credentials and hosted recording, and writes nothing. Hosted recording prints a progress message and has a 15-second request timeout. Exit code 1 while anything fails.

## `gallivant start [prd.md] [--no-daemon] [--no-server] [--no-open] [--port 8791] [--base <branch>]`

With no PRD, ensure the daemon and dashboard are running and open the dashboard.
With a PRD, submit that task first, then use exactly the same service startup:

1. Reads the PRD into a Request (see [the contract](prd.md)), which names the target repository: the checkout the file itself is in, so the PRD has to live inside the repo it describes. Runs the full contract on it and refuses on the first failing rule. There is no override flag.
2. Requires `status: ready`, which only `gallivant ready` sets.
3. Checks the harness named in the PRD is signed in. If not, the entry is recorded as `needs-human` with reason `not-signed-in` and nothing else happens.
4. Builds the run specification: the prompt, the session id, and the argv the harness will be spawned with, including the read-only `context_paths`. This happens before the clone, because it is the last step that can refuse and the clone is the only one that leaves something behind. A harness that cannot grant those directories as read-only is refused here, with nothing cloned and nothing registered, so rerunning `start` after fixing the config works rather than failing on a leftover worktree.
5. Works out the base branch: the pull request this will open targets it, and the new branch is cut from it. `--base` wins, then the base configured for this repository in `repos`, then the repository's default branch, which is the fallback and what an operator who configures nothing gets. A `--base` is written into `repos` so it is typed once per repository. A base that GitHub does not have fails here, before anything is cloned: left to `gh pr create --base` it would fail after the run had implemented the brief and spent the budget. See [the base branch](config.md#the-base-branch).
6. Clones the repo into `<worktrees>/<repo>/<prd id>` (partial clone, blobs on demand) on a new branch `work/<prd id>` cut from that base, fetched first so the cut is from the current base rather than a stale local ref. Your own checkout is never touched.
7. Saves the daemon's own copy of the PRD and each carried `sources` file under `~/.gallivant/prds/`. Fix rounds and the completion gate read these snapshots, so a session cannot rewrite its own brief. Records where your copy lives, plus a fingerprint of the contract, for later comparison: see [editing the brief after the work has started](prd.md#editing-the-brief-after-the-work-has-started).
8. Copies those snapshots into the checkout at their original repository paths, creating directories as needed. The PRD is usually only in your own checkout; this copy lets the session commit it with the implementation. Copies in the session's checkout are writable and are never read back for a decision.
9. Starts the session detached with the PRD as its prompt, records the session id, and remembers the repo for recovery.

The entry is `running` until the daemon sees the run end. Then either a PR exists on the branch and the entry enters `pr-open`, or it stops with `no-pr`.

It also brings the daemon up in the background if one is not already running, and waits until the daemon reports
itself before returning. That is not a convenience: `start` opens a session that will open a pull request, and the
daemon is the only thing that then reads reviews, dispatches fixes and reaches ready-for-human. Without it the PR sits
untouched and nothing says so, which is the one failure this tool exists to prevent. `--no-daemon` skips it, for the
case where you are about to run `gallivant up` in the foreground yourself.

A daemon started this way is detached, so it outlives the terminal that ran `start`, and its output goes to
`~/.gallivant/daemon.log`. A second `start` does not add a second daemon.

The dashboard also runs detached, writes `tracker.log`, and opens in the default
browser. `--no-open` leaves it running without opening a tab; `--no-server` skips
dashboard startup and opening. These flags do not stop services already running.
A headless machine prints the URL. Process identity, instance, code and port are
checked before reusing a tracker; a port owned by another app/home is refused.
To change a running tracker's port, `gallivant down`, then `gallivant start --port N`.
If service startup fails after dispatch, the command reports the partial failure
with exit code 1. Retry `gallivant start` without a PRD, not the original submission.

`gallivant down` stops the verified daemon and standalone tracker. Existing agent
processes continue; restart monitoring with `gallivant start`. Embedded trackers
are owned by their host and are not stopped by this command.

## `gallivant chain [<name> [<first.md> <next.md> ...]] [--base <branch>]`

Queue at least two ready PRDs in order. All must be new tasks in one checkout of the same repository and on the same
resolved base. `--base` selects the base for a new chain; otherwise the repository config or default branch applies.
The daemon starts the first task and starts each successor only after GitHub confirms the preceding PR was merged
into that base. The final merge completes the chain. `ready-for-human`, a completed agent process and a local `done`
entry never satisfy the dependency; closing without merging stops the chain. Gallivant never merges for you.

With no arguments, lists chains. With only a name, shows that chain's milestones and current wait or stop. Queueing
brings the existing daemon up if needed. Independent runs continue alongside it.

| Command | Effect |
|---|---|
| `gallivant chain launch first.md next.md` | Approve the order and current brief/source fingerprints, then queue dispatch. |
| `gallivant chain launch --retry` | Recheck a stopped chain after its cause is resolved. |
| `gallivant chain launch --retry --resnapshot` | Explicitly accept updated briefs and carried sources for unstarted tasks. |
| `gallivant chain launch --cancel` | Stop future dispatch; preserve already started work and its review loop. |

Changed queued inputs require explicit reapproval. An ambiguous pending start is never cleared by retry because a
session may already have started. Recover an ordinary stopped milestone with its existing run controls; that does
not require a separate chain retry. See [PRD chains](chains.md) for the workflow, source preservation and recovery.

## `gallivant register <pr-url> [--harness <name>] [--session <id>] [--worktree <dir>]`

Puts a PR into the loop that Gallivant did not open, or resets one that stopped.

- With `--session` and `--worktree`, later fixes resume that session in that directory. Both harnesses key sessions by the directory they ran in, so the pair is required together. The id has to be one the chosen harness could have minted (a UUID for claude, codex and gemini, `ses_...` for opencode, `work-<uuid>` or legacy `gallivant-<uuid>` for goose), the same rule the PR block is held to: the value ends up in the harness's argv, where goose in particular derives its session file from it.
- Without `--session`, the first fix run starts a fresh session whose prompt tells it to read the PR with `gh pr view` and `gh pr diff` before changing anything.
- Without `--worktree`, a checkout is created from the PR branch at the standard path.
- A `--worktree` you pass is resolved to an absolute path first, so `.` means the directory you typed it in and not whatever directory the daemon happens to run in later. It is then checked before it is accepted: its `origin` must be the PR's repository and it must already be on the PR's head branch. A path that fails either check is an error, since the harness edits and pushes from that directory. It is never relocated or re-cloned for you, because a resumed session is keyed to the directory it ran in.
- On an entry that already exists: reason cleared, iteration reset to zero, a marked reset comment posted on the PR (so a count rebuilt from GitHub starts from zero too), cursor set to now, watching again. This is how you restart a `needs-human` PR after you fixed the conflict or answered the question. A fresh registration instead looks at the PR's whole history, so feedback already on it gets addressed.
- That reset comment is the reset boundary, so posting it is a precondition of the reset and not a best-effort extra. A count rebuilt from GitHub finds its marker and counts only the round comments after it; with the comment missing and `state.json` later lost, recovery reconstructs the rounds this command had just zeroed, and an entry restored at `max_iterations` stops with `iterations` on its next event having done no work in the round. If it cannot be posted, `register` refuses and changes nothing: the entry keeps its iteration, its state and its cursor, and running the same command again once GitHub answers does the whole reset in one go.
- A reset with a new `--harness` or `--session` makes two durable writes to GitHub, and they are ordered so a failure between them cannot leave GitHub and the registry disagreeing about which harness or session this PR belongs to. The reset comment goes first because it is safely repeatable: a count rebuilt from GitHub takes the LAST reset marker, so a second one counts as one. The identity block goes last, because that write is what a recovery reads the harness and the session out of. So a failed block write leaves a reset comment on the PR, the registry untouched, and both sides still naming the old identity; the same command run again completes the reset.
- Changing `--harness` without giving a new `--session` drops the inherited session and starts a fresh one on the next fix round. This also applies when both harnesses use UUIDs: a Claude session does not belong to Codex. An explicit `--session` must have the chosen harness's format and is used as supplied.

When the block names a PRD that exists on the PR's branch, the daemon's own snapshot of it is taken, exactly as recovery does, because the completion gate reads that snapshot and nothing else: without it the gate is skipped and the PR can be marked ready with no acceptance criterion evaluated. A snapshot already on disk is kept rather than replaced with the copy the session could have edited, and a PRD the branch does not carry is logged and the PR watched without a gate.

Fork PRs and closed PRs are refused. On managed `work/*` or legacy `gallivant/*` branches, the neutral recovery record is added or migrated to match the selected harness/session and PRD. Recovery after a lost `state.json` reads that record, so it must agree with the registry. A hand-made branch outside those conventions remains explicitly registered in local state; it receives no invalid recovery record and is still excluded from automatic recovery.

## `gallivant up [--once]`

The daemon. On boot it acquires `daemon.lock` before contacting GitHub and refuses to run if another daemon owns it. The lock records the PID, process start time and command; `ps` must be available to verify that identity. Its output uses a fixed locale and UTC, so a different terminal cannot mistake formatting differences for a replacement process. `daemon.json` reports health separately, so a failed health write cannot allow a second daemon. Background startup returns once ownership is published, while GitHub initialization may still be running. `down` verifies the recorded identity before sending SIGTERM, so a reused PID is not enough to stop a process. A live older daemon with a missing or unversioned identity is reported as `UNVERIFIED` and must be verified and stopped manually before restarting; its lock is never silently replaced.

It then reconciles with GitHub: for every repo in `repos`, every open PR of yours on a `work/*` (or legacy `gallivant/*`) branch with a valid block that is not in the registry is registered, with the iteration recovered by counting Gallivant's own round comments and the cursor set so old events are not replayed. The PRD snapshot is taken from the PR branch when the daemon has none. Missing checkouts are recreated from the PR branch.

A recovered entry is treated as newly asking, not as mid-conversation, and in two ways that `register` already worked this way:

- The reviewer clock is floored at `rereview_minutes` ago, so a PR whose last round comment is seven hours old is not stopped `reviewer-silent` on the very first tick. The silence accrued while no daemon was running to ask, and stopping for it tells you nothing you can act on while costing you a `register` to resume.
- Failing checks on the recovered head are dispatched rather than treated as already sent. A fix that had been dispatched and had pushed would have moved the head, so red CI on the head that is actually there has not been addressed by anything; the only case a recovery could dispatch twice is a run that was still in flight when the daemon died, and that run's work is lost anyway.

Then it ticks every `poll_seconds`. Before each tick it probes `gh` and every configured harness; while any probe fails nothing is dispatched and one throttled error notification goes out per failing probe. Ticks chain on a timer and never overlap. `--once` runs a single tick and exits, which is useful for cron or for debugging.

On a Mac the daemon runs `caffeinate -i` for its own lifetime.

## `gallivant status [--all] [--json]`

```
gallivant  daemon up since 6h ago  last tick 40s ago  next in 80s  gh ok  claude ok  codex ok

NEEDS YOU
  widget#142        needs-human   base-conflict             round 2/3   -> staging   12m ago   gallivant why widget#142
  api#31            ready         green, no blocking findings, receipt accepted  round 1/3   -> main   2h ago    https://github.com/acme/api/pull/31

RUNNING
  guard#88          fixing        review 2201 by chatgpt...  round 1/3   -> staging   3m ago
  widget#150        waiting       on reviewer, nudged once   round 0/3   -> main      4m ago
  api#44            blocked       ready label write failing (3), retrying  round 1/3  -> main   6m ago
```

The `-> <branch>` is the base: the branch this pull request targets, or will target once it is opened. It is on every
row because the question has a wrong answer that costs a whole run, and before the PR exists there is nowhere else to
read it.

A `ready` row says whether the completion gate accepted the receipt or never ran at all (`RECEIPT NOT CHECKED`, with the reason), because an entry with no PRD snapshot reaches ready on the checks and the reviewer alone and that is a different thing from passing the gate.

A `brief-moved` row is an entry whose brief you have edited since it started, in a way that changes what the work is or what will be checked. It sits under NEEDS YOU whatever the entry is otherwise doing, and it outranks every other label on the row, because it is the only one that says the work itself may be aimed at the wrong target: a red check or a waiting reviewer are questions about work whose brief nobody disputes. The detail names the first difference and `gallivant why` has the rest. `status` runs the comparison itself rather than reading what the last tick found, so a brief you edited thirty seconds ago shows up now rather than after the next poll. A `done` entry is never compared: there is nothing left to certify, and tidying up your briefs afterwards is not something to be warned about.

A row whose detail names a GitHub write is an entry whose tick is declining one step until that write lands, with the failures counted; see `gallivant why` below for the five writes this can be. `blocked` is the one of those to read twice: every readiness condition has already passed and only the label that says so will not write, so the label is `blocked` rather than `fixing`. The others read `fixing` or `implementing`, which is true for them, because a fix round really does follow.

Sections are in the order needs-you, running; `--all` adds done. The first line is `daemon DOWN` with exit code 1 when no daemon is alive. `--json` prints the same model for scripts and UIs.

Chain progress is shown alongside runs. `gallivant chain <name>` shows the full ordered plan and explains which
milestone or merge it is waiting for. Unstarted milestones have no agent run yet.

## `gallivant serve [--port 8791] [--no-open] [--no-daemon] [--foreground]`

Uses the same service startup as `start` without a PRD: daemon, dashboard, browser.
Use `--foreground` to keep the tracker attached to this terminal; Ctrl-C stops
that tracker, while the daemon and active agent sessions continue. For an existing
supervisor that manages the daemon separately, use
`gallivant serve --foreground --no-open --no-daemon`. The exported `serve()` and
`mount()` APIs retain their server-only behavior for embedding.

A local web page showing every entry and every run, with the log of a run tailing live. One place to look instead of `status`, `why` and `tail -f` in three terminals. It is meant to sit in an iframe in a dashboard, so it assumes no viewport size and never navigates the top-level window.

Three views, each with a sidebar listing everything the view holds:

- `/` every registry entry as a row, grouped needs-you, running and done the same way `gallivant status` groups them, from the same `model()`.
- `/run?id=<entry id>` one entry: handle, state, reason, harness, round, PR link, branch, checkout, session id, and the live log below. When the brief has changed since the run started, every difference is listed above the facts, with what to do about it: the page has room for the whole list where a `status` row has one line.
- `/runs` every run folder under `~/.gallivant/runs`, newest first, with its entry, start time, exit code and duration, filterable by entry. Picking one in the sidebar opens its log in the pane beside the table. The history is already on disk; this is the index over it.

The sidebar has one filter box that searches everything on the view, including fields the row does not show in full: an entry's id, reason and harness, a run's id and start time. Groups collapse, and which ones you closed is remembered per view. A filter overrides that, so a match inside a closed group still shows. `?by=harness` groups by harness instead of by state, and the choice rides along on every link, so a grouped view is a URL you can bookmark or frame.

JSON for scripts and for a dashboard's own widgets: `/api/status` (the same model `status --json` prints), `/api/runs`, `/api/run/status?id=<entry id>`, and `/api/run/output?id=<entry id>` for the log as server-sent events. `/api/run/history?id=<entry id>` serves one 400-line window of a run's log as JSON rather than as a stream, older than what the pane is showing: `?before=<line number>` asks for the window ending just before that line, and the answer says `from`, `to`, `total` and how many lines are older still. Both log routes address a run the same way and validate it the same way, so a run id that is refused by one is refused by the other. `--port` takes anything from 1 to 65535; the default is 8791.

Two things to know about it:

- **GET is read-only; run controls require a local POST.** The run page groups Recheck PR and Resume agent separately from the message composer and its Send message button. These enqueue one request in the existing registry; the daemon applies it after any active run settles. The write requires a loopback peer, a loopback Host matching the serving port, an exact same-origin request and a per-server CSRF token. Mounted trackers keep the host's authentication, and remote readers do not receive controls.
- **It binds to 127.0.0.1 and has no password.** That is the same boundary as the CLI: anything that can reach it can already read `~/.gallivant`. Do not put it behind a tunnel or a reverse proxy that answers on a public address, because the pages show branch names, local paths and whatever the agent printed.

### Rechecking and updating a run

`needs-human` stops normal review and check processing. GitHub labels may trigger a repository's workflows, but they do not restart Gallivant. After resolving the cause, use **Recheck PR** on `/run?id=...`, or:

```sh
gallivant recheck agent-passport#396
gallivant say agent-passport#396 --note "The external blocker is resolved; continue within the approved brief."
```

Recheck returns the entry to watching without resetting its iteration count or check dispatch markers. The existing loop reads checks, review and the completion gate again. It does not rerun GitHub Actions or override a failed check. Unchanged failures stop again without spending another fixer round. To deliberately reset a spent round budget, use `register`.

**Resume agent** continues the same session on its current instructions. **Send message** and `say` deliver your correction to that session, including after an agent has finished and its PR is ready for human review. A closed or merged PR requires a follow-up PRD. Both use the existing resume path and preserve the approved brief, permissions and review budget. Uncommitted files and the index stay intact; only the automatic base merge is deferred when the tree is dirty. The agent must inspect partial work, commit only its task changes, then fetch and merge the intended base into its task branch before rerunning verification and pushing. It must preserve unrelated edits and carried instructions, stopping if they prevent that merge. This never authorizes merging the PR or writing to its base. Replacing a changed brief or carried files still requires an explicit `resume --resnapshot`. Every existing replacement file, including ignored files absent from Git status, must match either the previous snapshot or the newly accepted bytes; conflicting session edits stop the resnapshot before any file or snapshot is replaced.

During a run, messages queue until it finishes by default. Select **Interrupt the active run to apply this message**, or use:

```sh
gallivant say agent-passport#396 --interrupt --note "Preserve the existing article's useful sections; improve them without turning it into a summary."
```

At the next daemon check, Gallivant records the active run's descendants, including tool helpers in separate process groups. It stops the tools and their owner, waits for the recorded live processes to exit, then resumes the same session with the message and existing files. Zombie processes cannot write and do not block delivery. Surviving process identities allow cancellation to finish after a daemon restart; if ownership cannot be verified, the request fails visibly with the message preserved and no replacement run. A descendant in a shared outside group never grants permission to stop that whole group. Partial edits may need repair. This is stop-and-resume, not live stdin streaming. A first run must emit its resumable session ID before it can be interrupted; until then the request waits safely. It never stops another entry's run.

The fixed buttons never send or discard the composer's draft. Messages are limited to 4,000 characters and one outstanding request per entry. Requests survive restarts and show queued, applying, applied or failed on the page and in `gallivant why`. The registry retains the previous 20 requests; **Last submitted message → Edit and resend** recovers a message even after another fixed action. Failed delivery restores it into an empty composer without overwriting a newer draft. A request interrupted while applying is not automatically replayed, because it might already have started a run.

A live daemon running older code is refused before a request is saved, by both the CLI and the UI. Restart it with `gallivant down && gallivant up`, then submit again; active agent runs survive that restart. The daemon must be running and its health probes must pass. CLI requests start it unless `--no-daemon` is used; the UI saves the request and waits. With the default poll interval, pickup takes up to about two minutes plus probe/GitHub response time; queued delivery also waits for the active run. After upgrading, restart the daemon and the process serving the tracker, including Command Center if mounted there, to load the new controls. No Telegram transport is implemented by these controls.

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

The log pane sends the last 400 lines when it opens and says how many earlier ones it is not showing. It reconnects on its own and resumes where it left off rather than starting again. It follows the log file rather than the harness process, so it works for a run the daemon started before its last restart, and it auto-scrolls only while you are already at the bottom.

**Reaching back.** A **load earlier lines** button above the pane fetches the previous 400 and prepends them, and keeps going back on each press until the run's first line. That is the whole run, not only what happened since you opened the page: `job.log` is written once per run and never rotated, so the file on disk holds every line between the run's start and its stop, and the button walks all of it. Your scroll position does not move when lines are inserted above it.

Why a button and not simply a bigger tail: delivering thousands of lines as individual server-sent events on open stalls the browser badly enough that it drops the connection and retries, forever. So reaching back is a plain read (`/api/run/history`) rather than a mode of the stream, one bounded window per request.

The pane keeps 2000 live rows and drops the oldest beyond that, because an unbounded stream would otherwise grow the DOM forever. Lines you loaded with the button are exempt: the budget grows by exactly what you loaded, and the rows that get dropped are the oldest **live** ones rather than the top of the pane, so a burst of new output cannot undo a press of the button. The whole log is still in the run folder either way.

### What the log pane shows

A run's `job.log` is the harness's own stream-json, one event per line, so printing it raw gave you `{"type":"assistant","message":{"content":[{"type":"tool_use",...` down the page. The pane reads each event and draws it the way command-center's runner panel draws its logs, using the same CSS class names, so the two panels look like one system:

- A tool call is the tool's name in a fixed-width column on the left and one argument beside it: whichever of `command`, `file_path`, `pattern`, `url`, `description` or `prompt` the call carried. Searches, fetches, writes, shell and subagent calls are coloured apart.
- Prose the model wrote reads as prose, with its markdown rendered. Inline: bold, italic, inline code and links. Blocks: a run of bullets or numbers becomes one list, a fenced block becomes one `<pre>` with its contents left exactly as typed, a GitHub-style pipe table becomes a table that scrolls sideways inside its own box rather than widening the pane, a run of `>` lines becomes one blockquote, and `---` on a line of its own becomes a rule. A heading is already its own row, so it renders as the row's text in bold rather than keeping its hashes. This matters most on the final summary, which in practice is a report with a table of what passed and fenced blocks of commands to run.
  - Nothing inside a fence is markdown, which is the point of a fence: the inline pass reads a `*` as emphasis and would delete the asterisks from a glob or a pointer. A language tag on the fence is kept as a label and nothing else, and only when it is a plain word; no highlighter is loaded, because the CSP is `script-src 'self'`.
  - A block the model left half-written degrades to what it holds. An unclosed fence shows the code that did arrive, marked as still open, rather than swallowing the rest of the report. A row of pipes with no `|---|` separator under it is not a table and is shown as the line it is.
  - Tool arguments are left alone, where a `*` is a glob and an `_` is part of a filename. No markdown library: the part of CommonMark it would add is the part that never appears here, and HTML passthrough is the one thing this must not have on agent output. Nesting inside a list is an indent rather than a list inside a list, which is the deliberate limit: a tree built out of agent output fails by swallowing siblings.
- A tool call your guardrails blocked gets the loudest row the stylesheet has, in the failure colour, labelled `BLOCKED`, with the policy reason on it. APort's `PreToolUse` hook denies and Claude Code returns the denial as the tool's result, so this is the row that tells you a passport stopped the run from doing something, and it is not supposed to be easy to scroll past.
- A tool result that failed is a row in the failure colour. One that succeeded is not shown: it is what the run read, not what it did, and the whole output is in the run folder.
- The run's last event closes the pane with the verdict, the cost the harness reported, and the reason when it failed.
- A call that has not returned counts up on its own row. Claude Code sends a heartbeat every 30 seconds for a tool still running, and one `npm ci` in the run tree this was built against collected fourteen of them. They are not fourteen rows: the `Bash` row you are already looking at gains `running 4m 30s` and keeps it current, so a build sitting for six minutes says so instead of showing nothing.
- Anything the reader cannot place is shown as itself, verbatim. A truncated write from a killed run, a harness spilling to stderr, a runner line: they stay on screen, escaped, in monospace and marked apart from the model's prose, because an unreadable line is still evidence. They deliberately skip the markdown pass. A `*` or an `_` pair in `Error: --add-dir *cannot* be used with __proto__` is not emphasis, and reading it as emphasis deleted the characters that mattered.

Reading events is per-harness, since each CLI's stream is its own shape, and it lives in `lib/harness_log.mjs` next to the adapters in `lib/harness.mjs` that already have to know these streams to read a run's outcome.

Claude Code and Codex were read off real captured runs, so their tool calls, prose and closing lines all render. Gemini, opencode and goose read only the events their adapter's `outcome` already proves exist (the session line, assistant prose, the closing event) and fall through to raw lines for everything else, which today means their tool calls still show as JSON. Guessing at field names nobody here has captured would put a confident row on screen with an invented argument in it and nothing to mark it as invented; a raw line at least says what the harness wrote. Capture one run each and extend `lib/harness_log.mjs`.

A run from a foreign tree (`runSources`) has no harness name, so its lines go through the prose rules, which is right for command-center's own logs.

## `gallivant why <handle>`

For a stopped or running PR: state and reason, the PR and checkout paths, the base branch, the session id and the by-hand command to open it (`claude --resume <id>` or `codex resume <id>` in the checkout), the last dispatched event, the run folder and exit code, cost when the harness reports it, permission denials, the harness's final message, and any APort audit lines from the run's time window.

It also reports every merge the daemon made into this branch, with the commit and the time, because an operator reading
a diff they did not expect needs to know where the extra commit came from. A merge that failed is reported too, with
the conflict git gave and the fact that it was aborted, so the checkout is known to be clean. History is only ever
added to: no rebase, no force-push. See [keeping a branch on its base](config.md#keeping-a-branch-on-its-base).

When the brief has changed since the run started it prints every difference, one line each, what the completion gate is doing about it (nothing: neither brief is judged while it is in dispute) and the command that resolves it. This is where the whole difference goes, because a `status` row has space for one line of it and five changed criteria do not fit. It prints for a running entry as well as a stopped one, since you will ask `why` before the daemon's next tick has had a chance to stop anything. It also reports whether the brief was re-readied, by comparing the `aport_decision` in the frontmatter with the one recorded at `start`: a changed id means you put the edit through `gallivant ready`, which is worth knowing and is never what decides the verdict. See [editing the brief after the work has started](prd.md#editing-the-brief-after-the-work-has-started).

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

## `gallivant resume <handle> [--note "..."] [--resnapshot]`

Puts a stopped entry back to work in the session that was doing it. The handle is the id, a PRD path, or `<repo>#<pr>`,
the same forms `why` takes.

This exists because of a real run. A start run spent its budget and stopped before opening a pull request, so the entry
went to `needs-human` with reason `no-pr`. The session id, the worktree and the brief were all recorded, but `register`
needs a pull request to attach to, so the one case where a run dies before its PR exists had no way back.

It resumes rather than restarts: the session holds what the last run learned, so a fresh one would pay for that work
twice and could undo half-finished edits it knows nothing about. The prompt says why the last run stopped, because the
agent's memory ends mid-task and that is the one thing it cannot know. `--note` adds a line of your own, which is where
"the budget is now higher" belongs.

An entry with no session is refused, because there is nothing to resume and `start` is the honest answer. So is one
with a run already in flight or still awaiting daemon settlement, since replacing its record would lose its outcome. A missing checkout is
recreated from the branch first; the session's memory lives in the harness, not the directory.

When the checkout is clean, the base branch is merged in before the session carries on, which is the case that needs it most: an entry stopped
hours or days ago and the base has moved since. The session is told about the merge commit so it does not try to undo a
commit that is not its own. A merge that conflicts is aborted and the resume is refused, printing the conflict and the
`git merge` command that resolves it, so nothing is resumed into a checkout with conflict markers in it. See [keeping a
branch on its base](config.md#keeping-a-branch-on-its-base).

A dirty checkout is preserved: the resumed session is explicitly told to commit only its task changes, fetch and merge the intended base into the task branch, resolve conflicts within scope, then verify and push. Unrelated edits that prevent the merge must be reported rather than discarded or committed. This exception does not authorize merging a PR, writing to the base, rebasing or force-pushing.

So is an entry whose brief has changed, and that refusal is the opposite of what a resume usually does. The session
holds what the last run learned, and what it learned is the OLD brief: resuming into a changed contract would put a
session that believes one thing back to work while the gate judges another, and nobody would be told. The refusal names
every difference. `--resnapshot` is the deliberate answer to it: the edited brief becomes the one the gate judges, the
replacement is logged as a warning naming the file and what moved, the brief is copied into the session's checkout, and
the prompt tells the session what changed and to reread it rather than trust its memory. A brief that no longer passes
the contract, or one that has been deleted, is refused even with the flag, because neither can become the copy the gate
judges. An edit outside the contract needs no flag at all and says nothing to the session. See [editing the brief after
the work has started](prd.md#editing-the-brief-after-the-work-has-started).

The same rule covers the bytes of every carried `sources` file and changes to the manifest. `--resnapshot` records
the accepted files, copies them into the checkout and tells the session what moved. Remove a deleted file from the
manifest before accepting that deletion. A harness change is refused even with `--resnapshot`; an existing session
cannot move between harnesses. When resuming a ready PR, removing its ready label is a precondition of spawning work.

If timeout or interruption cannot verify the owned process tree, the task becomes `needs-human` with reason `run-stop-unverified`. Its PR labels and notification identify the stop; failed label writes retry even while the process may still be running. Inspect `gallivant why` and the daemon log, restore process inspection, and resolve any surviving owned processes before resuming. No replacement starts over an unverified writer.

The daemon comes up if it is not already running, for the same reason `start` brings it up.

## `gallivant remove <handle>`

Forgets an entry. The PR, its branch, its labels and the checkout are left as they are; `register` puts the PR back into the loop. Use it for an entry that was started against the wrong repo or that you have taken over by hand.

## What the daemon posts on your behalf

- A round comment after every push: the text of `reviewer.rereview_comment`, `@codex review` by default, with an HTML marker so it can recognise its own comments; a marked "Completion receipt updated" comment after a round that only rewrote the receipt; a marked reset comment when `register` resets an entry.
- One nudge comment if the reviewer has not answered within `rereview_minutes`. It is the same text as the round comment, told apart only by its marker, so it never goes out on the tick that already posted a round: one push earns one asking of the reviewer.
- With `reviewer` set to null nothing asks anyone for anything: the round comment says `Pushed a fix.` and there is no nudge.
- The labels `status:ready-for-review` and `status:needs-attention`, created once per repo the first time it is watched. Ready means checks, reviewer and receipt gates passed; it does not mean merged or complete. Label writes remove legacy spellings and the opposite status before signalling the new state.
- A neutral `work-session` recovery record in the PR body. It contains a versioned base64url JSON identity, with strict decoded validation. This is transport encoding, not encryption or authorization.
- Nothing else. The harness posts its own thread replies during a fix run; those are recognised and never treated as events.


### Public formatting and compatibility

New branches use `work/<prd-id>`, receipts use a `work-attestations` JSON fence, and daemon comments use
neutral `work-round`, `work-nudge` and `work-reset` markers. Human follow-up can use `/fix`.
Legacy branches, recovery blocks, receipt fences, commands and comment markers remain readable; existing
branches and sessions are not renamed. Round/reset history still counts across formats, and changing only
a receipt's transport format or informational task ID does not constitute progress.

Recovery metadata preserves exact PRD paths, branch names and session IDs in its encoded record, including
old identifiers; decoding does not grant trust. Recovery still checks the actual same-repository head and
validated harness/session. Receipt task IDs are stable neutral tokens; the completion gate binds evaluation
to its own trusted task ID. Prose and evidence are not redacted or altered by format migration, and ambiguous
duplicate metadata or receipts must be repaired rather than silently choosing one.

Existing branch names and historical commits/comments can still expose earlier naming. Upgrading does not
rewrite history or rename live branches. Existing integrations that select the old status labels should move
to the new labels; no branded alias is written merely to keep an external label filter matching.


Managed pull requests use GitHub's regular review workflow. Start prompts require an ordinary PR; if a harness
nevertheless creates a draft, the daemon converts it to ready for review and gives the reviewer a fresh window.
Registering an existing PR explicitly adopts the same regular-PR policy. This presentation change does not mark
work complete, satisfy acceptance criteria, waive checks or review, merge the PR, or clear an unrelated stop.
Incomplete work remains accurately described with unmet attestations.

Daemon-authored title, body and comment writes reject the runner name case-insensitively. The daemon checks the
actual published PR title/body and new own-account replies before marking work ready; violations request a bounded
wording correction in the existing session. New commits are checked by the installed commit-message hook. Technical
source files, PRD basenames, local commands and existing history keep their actual names; they are not renamed or
rewritten to satisfy a public-text rule. Choose a truthful neutral description or another concrete evidence pointer
when a literal path would name the runner in PR prose.

Harnesses still invoke their own GitHub tools directly. A prompt and a later daemon check cannot promise that an
incorrect draft or branded phrase never appears briefly before correction. This implementation enforces daemon
writes and readiness, not an exclusive network publication boundary. The encoded recovery record is also not secret:
it can be decoded to inspect the precise existing branch/session identity.
