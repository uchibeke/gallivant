# Architecture

One actor, one file of rules, everything else is plumbing. About 1,500 lines of plain ESM with no dependencies.

```
bin/gallivant.mjs        CLI: parse args, build the context, call one command
lib/context.mjs          wires the real dependencies once (config, state, gh, git, notify, log, runner)

lib/tick.mjs             the state machine. Settle runs, fetch, terminal states, events, dispatch, ready, silence.
lib/events.mjs           pure rules: what counts as an event, trust, reviewer verdict, green checks, round counting
lib/prompt.mjs           start, register and fix prompts; quoting and caps
lib/harness.mjs          adapters: argv per harness and mode, session id extraction, outcome parsing, sign-in probe
lib/block.mjs            the PR body block: render, strict parse
lib/prd.mjs              the PRD contract: frontmatter, sections, rules, Verify commands
lib/deliverable.mjs      the completion gate: criteria from the PRD, the receipt, the policy's rules and deny codes

lib/gh.mjs               the only GitHub access, through the gh CLI; login normalisation; markers and labels
lib/git.mjs              per-PRD checkouts (partial clones), run environment
lib/run.mjs              detached runs; liveness checks that the pid still runs the harness, adapted from command-center
lib/state.mjs            the registry: atomic writes under a lock file, pure ids, handle resolution
lib/config.mjs           defaults, validation, path expansion
lib/notify.mjs           ntfy messages and the throttled error class
lib/probe.mjs            health checks shared by doctor, start and the daemon
lib/aport.mjs            what APort's installer leaves on disk: the mode file and the audit log, one parser each
lib/log.mjs, fs.mjs, time.mjs

lib/commands/            start, register, up (daemon + reconcile), status, why, doctor
test/                    node --test; helpers.mjs holds the fakes
templates/               passport, Claude sandbox settings, gitconfig
```

## Design rules

- **The tick is the only writer.** Nothing changes state in exit handlers, timers or callbacks. A finished run is noticed on the next tick by asking the OS whether the pid is alive and reading the log. That is what makes a daemon restart mid-run safe.
- **Rules are pure.** `events.mjs` takes the raw shapes `gh` returns and produces events. Every rule in the PRD has a unit test with no network.
- **Dependencies are injected.** `makeTick` receives `gh`, `git`, `runnerFor`, `notify`, `clock`. The test suite builds fakes in `test/helpers.mjs`; the CLI builds real ones in `context.mjs`.
- **GitHub is the source of truth for identity; the registry for counters.** Both can be rebuilt: identity from the PR block, counters from the daemon's own marked comments (every round posts one, a reset posts one).
- **Four cursors, one meaning each.** `since`: events at or after it are new. `fixed_sha`: the head when the last run started, so a push is the head moving. `checks_sha`: the head whose failing checks were already dispatched. `receipt_hash`: the completion receipt when the last run started. `since` is inclusive because GitHub stamps events to the second, so two that arrive in the same second share a timestamp; `dispatched` rides alongside it with the ids already handled at exactly that instant, and is cleared the moment the cursor moves to another second.
- **One run per entry is the lock.** A run root per entry means a second dispatch for the same PR is refused by the runner while the first is alive, and entries never block each other.
- **Adapters own the flags.** Config holds binaries and paths only. A CLI upgrade changes `harness.mjs`, and `assertSafeArgv` refuses any `--dangerously-*` flag no matter who adds it.
- **Reuse over build.** `gh` for the API, the harness's own resume and no-prompt flags, APort's own installers, ntfy's email header, command-center's runner layout so its log viewer can read a Gallivant run.

## The tick, step by step

For each registry entry that is not `done`:

1. **Settle.** If a run is alive and past `run_timeout_minutes`, kill it and stop with `timeout`. If a run ended and is not yet recorded: for a `running` entry, find the PR on the branch, write the block, enter `pr-open` with the event cursor and the reviewer clock at the PR's creation time, so a review that landed during the start run is seen; or stop with `no-pr`. For a `pr-open` entry, if the head moved, post the round comment and reset the reviewer clock; if only the receipt changed, post the receipt-round comment; either way bump the iteration. Otherwise stop with `no-push` or `harness-error`.
2. **Fetch.** `gh pr view --json` for state, head, checks, issue comments, labels and body; REST for reviews and inline comments since the cursor, asked for from a second before it so the boundary second comes back whatever GitHub's filter does with it.
3. **Terminal.** Merged or closed is `done`. Conflicting is `needs-human`. A `needs-human` entry is checked for nothing else.
4. **Events.** The rules in `events.mjs`. Failing checks count against `checks_sha`, so red CI on a head the loop itself pushed is dispatched once; if it stays red on that head after the fix, the entry stops with `checks-red`.
5. **Dispatch.** Past the cap, stop with `iterations`. Otherwise build the fix prompt, resume the session (or start one for a registered PR), move the cursor to the newest event and record the ids dispatched at that instant, record the run.
6. **Ready.** No events, no run, not a draft, every check green (none counts as green), reviewer clear or absent. Then the completion gate (`deliverable.mjs`): the PR body's receipt must attest every acceptance criterion of the PRD with evidence; a deny starts a receipt round. Only then label and notify once.
7. **Silence.** Reviewer configured and quiet since the last request: nudge once after `rereview_minutes`, stop with `reviewer-silent` after `stall_hours`.

## Adding a harness

Add an adapter to `lib/harness.mjs` with `start`, `resume`, `env`, `sessionFrom`, `outcome`, `signIn`, `version` and `attach`, add its name to `HARNESSES` in `config.mjs`, and add its minimum version. OpenCode is next: `opencode run --format json --auto`, resume with `-s <id>`.

## Adding a reviewer

No code. Set `reviewer.login`, `reviewer.rereview_comment` and `reviewer.blocking_pattern` in config.
