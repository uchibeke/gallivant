# Commands

Handles: every command that takes one accepts `<repo>#<pr>` (short name or `owner/name`), the registry id `<repo>/<prd id>`, or a PRD path. Bare PR numbers are refused because they are ambiguous across repos.

## `gallivant doctor [--send] [--probe]`

The install checklist and the health probe, one line per check, each failure with the exact command or file that fixes it. With no config it prints a complete config built from this machine. `--send` posts a test notification. `--probe` runs a real Claude session in a temp directory and confirms a write inside is allowed and a write outside is denied. Exit code 1 while anything fails.

## `gallivant ready <prd.md> [--check]`

The only way a PRD becomes ready. Runs every rule of [the contract](prd.md), prints the checklist, asks APort to decide readiness against a per-PRD passport built from those rules, and flips `status: draft` to `ready` (recording the decision id as `aport_decision`) only on an allow. It does not commit the file. `--check` prints the checklist without writing or deciding. Exit code 1 while anything fails.

## `gallivant start <prd.md>`

1. Runs the full contract again and refuses on the first failing rule. There is no override flag.
2. Requires `status: ready`, which only `gallivant ready` sets.
3. Checks the harness named in the PRD is signed in. If not, the entry is recorded as `needs-human` with reason `not-signed-in` and nothing else happens.
4. Clones the repo into `<worktrees>/<repo>/<prd id>` (partial clone, blobs on demand) on a new branch `gallivant/<prd id>` from the remote default branch. Your own checkout is never touched.
5. Saves the daemon's own copy of the PRD under `~/.gallivant/prds/`, which fix rounds and the completion gate read instead of the checkout, so a session cannot rewrite its own brief.
6. Starts the session detached with the PRD as its prompt, records the session id, and remembers the repo for recovery.

The entry is `running` until the daemon sees the run end. Then either a PR exists on the branch and the entry enters `pr-open`, or it stops with `no-pr`.

## `gallivant register <pr-url> [--harness claude|codex] [--session <id>] [--worktree <dir>]`

Puts a PR into the loop that Gallivant did not open, or resets one that stopped.

- With `--session` and `--worktree`, later fixes resume that session in that directory. Both harnesses key sessions by the directory they ran in, so the pair is required together.
- Without `--session`, the first fix run starts a fresh session whose prompt tells it to read the PR with `gh pr view` and `gh pr diff` before changing anything.
- Without `--worktree`, a checkout is created from the PR branch at the standard path.
- On an entry that already exists: reason cleared, iteration reset to zero, a marked reset comment posted on the PR (so a count rebuilt from GitHub starts from zero too), cursor set to now, watching again. This is how you restart a `needs-human` PR after you fixed the conflict or answered the question. A fresh registration instead looks at the PR's whole history, so feedback already on it gets addressed.

Fork PRs and closed PRs are refused. If the PR body has no Gallivant block, one is added.

## `gallivant up [--once]`

The daemon. On boot it writes `daemon.json`, refuses to run if another daemon is alive, and reconciles with GitHub: for every repo in `repos`, every open PR of yours on a `gallivant/*` branch with a valid block that is not in the registry is registered, with the iteration recovered by counting Gallivant's own round comments and the cursor set so old events are not replayed. Missing checkouts are recreated from the PR branch.

Then it ticks every `poll_seconds`. Before each tick it probes `gh` and every configured harness; while any probe fails nothing is dispatched and one throttled error notification goes out per failing probe. Ticks chain on a timer and never overlap. `--once` runs a single tick and exits, which is useful for cron or for debugging.

On a Mac the daemon runs `caffeinate -i` for its own lifetime.

## `gallivant status [--all] [--json]`

```
gallivant  daemon up since 6h ago  last tick 40s ago  next in 80s  gh ok  claude ok  codex ok

NEEDS YOU
  widget#142        needs-human   conflict                  round 2/3   12m ago   gallivant why widget#142
  api#31            ready         green, no blocking findings round 1/3   2h ago    https://github.com/acme/api/pull/31

RUNNING
  guard#88          fixing        review 2201 by chatgpt...  round 1/3   3m ago
  widget#150        waiting       on reviewer, nudged once   round 0/3   4m ago
```

Sections are in the order needs-you, running; `--all` adds done. The first line is `daemon DOWN` with exit code 1 when no daemon is alive. `--json` prints the same model for scripts and UIs.

## `gallivant why <handle>`

For a stopped or running PR: state and reason, the PR and checkout paths, the session id and the by-hand command to open it (`claude --resume <id>` or `codex resume <id>` in the checkout), the last dispatched event, the run folder and exit code, cost when the harness reports it, permission denials, the harness's final message, and any APort audit lines from the run's time window.

## `gallivant remove <handle>`

Forgets an entry. The PR, its branch, its labels and the checkout are left as they are; `register` puts the PR back into the loop. Use it for an entry that was started against the wrong repo or that you have taken over by hand.

## What the daemon posts on your behalf

- A round comment after every push, `@codex review` by default, with an HTML marker so it can recognise its own comments; a marked "Completion receipt updated" comment after a round that only rewrote the receipt; a marked reset comment when `register` resets an entry.
- One nudge comment if the reviewer has not answered within `rereview_minutes`.
- The labels `gallivant:ready-for-human` and `gallivant:needs-human`, created once per repo the first time it is watched.
- The Gallivant block in the PR body, once.
- Nothing else. The harness posts its own thread replies during a fix run; those are recognised and never treated as events.
