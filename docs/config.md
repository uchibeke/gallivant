# Config

`~/.gallivant/config.json`, mode 600. `gallivant doctor` prints a complete one from your machine when the file is missing. Set `GALLIVANT_HOME` to use another directory.

| Key | Default | Meaning |
|---|---|---|
| `poll_seconds` | 120 | Tick interval. Minimum 30. |
| `max_iterations` | 3 | Fix rounds per PR. A round is a fix run that pushed. The next qualifying event after the cap goes to `needs-human`. |
| `checks_grace_minutes` | 5 | A head younger than this with no checks reported is not green yet; GitHub shows an empty check list for the first seconds after a push. A head older than this with no checks at all counts as green. |
| `run_timeout_minutes` | 30 | A run older than this is killed and the PR stops with `timeout`. |
| `max_budget_usd` | 5 | Passed to Claude runs as `--max-budget-usd`. Codex has no equivalent; the timeout bounds it. |
| `rereview_minutes` | 6 | If the reviewer has not reviewed this long after a request, the request is posted once more. |
| `stall_hours` | 6 | If the reviewer still has not reviewed, the PR stops with `reviewer-silent`. |
| `trusted_authors` | required | GitHub logins whose reviews and comments may start a run. Everyone else is ignored. Your own login belongs here. |
| `reviewer` | Codex | `{ login, rereview_comment, blocking_pattern }` or `null`. See below. |
| `deliverable` | policy defaults | Limits for the completion gate, in the shape of APort's `deliverable.task.complete` passport limits: `evaluator` (`aport` confirms with APort's hosted evaluator using a per-task passport, `local` uses only the built-in rules), `api_url`, `on_unreachable` (`wait`, the default: no decision until APort answers, the daemon tries again next tick; `local`: the built-in verdict stands and the log says so), `require_summary`, `min_summary_words`, `require_tests_passing`, `scan_output`, `blocked_patterns`. `null` turns the gate off. See [prd.md](prd.md). |
| `notify` | null | `{ ntfy: "https://ntfy.sh/<topic>", email: null }`. Null means transitions are logged only. |
| `worktrees` | required | Directory for per-PRD checkouts. Must be outside the Gallivant home. |
| `github_token_file` | null | Null means the daemon and runs use your existing `gh` login. Set to the path of a fine-grained PAT to narrow what a run can reach; it is then used as `GH_TOKEN` by the daemon and every run. |
| `context_paths` | [] | Directories a run may READ in addition to its own checkout: a sibling repository, a folder of design notes. Absolute or `~`-prefixed, and each must exist. Writes do not widen. Your home directory, the Gallivant home, `~/.claude`, `~/.codex`, `~/.config/opencode` and `~/.aport` are refused, as is any parent of them. Claude Code renders each as `--add-dir <dir>`; Codex and Gemini CLI refuse the run rather than escalate; opencode and goose have no such flag and ignore it. Read [guardrails.md](guardrails.md#extra-read-directories-are-a-widening-not-a-feature) before setting it: whatever a run reads can leave in a commit or a PR body. |
| `harness` | discovered | Omit it and Gallivant uses whichever harnesses it finds on your PATH, so one installed harness is a complete install. Name one and only that one is used, which is what you want when two versions are installed or a harness is deliberately out of play. |
| `harness.claude` | | `{ bin, settings }`. `bin` is the absolute path to `claude`; `settings` is the Gallivant settings file with the APort hook and sandbox. |
| `harness.codex` | | `{ bin }`. |
| `harness.gemini` | | `{ bin }`. |
| `harness.opencode` | | `{ bin }`. |
| `harness.goose` | | `{ bin }`. |
| `repos` | [] | Appended by `start` and `register`. Used by `up` to recover from GitHub. |

Five harnesses are supported: Claude Code, Codex, Gemini CLI, opencode and goose. A harness can join when it does
three things: start a run non-interactively, resume that specific session by id rather than "the latest", and emit
a machine-readable stream the outcome can be read from. All five do, and each one's resume was checked by
round-trip on 2026-09-25: a number written in one process came back when a second process resumed that session id.

`cursor-agent` is the one that has the flags but is still out. `--print --output-format stream-json`, `--resume
<chatId>` and `create-chat` cover the contract, but it is not signed in on the author's machine, so a headless run
draws the interactive sign-in screen and exits non-zero. Nobody has seen its event stream, and writing an adapter
against an unseen stream would be a guess. The blocker is a login, not a missing capability. The reasoning is kept
next to the adapters in `lib/harness.mjs`.

Sign-in checks are not equal across the five. `claude auth status` and `codex login status` report on credentials
without spending a call, and `opencode auth list` prints the stored ones. Gemini CLI and goose have no such
command, so their probe only proves the binary runs; an unauthenticated run fails at its first model call and
shows up as a failed run rather than a failed probe.

## The reviewer object

```json
"reviewer": {
  "login": "chatgpt-codex-connector[bot]",
  "rereview_comment": "@codex review",
  "blocking_pattern": "\\bP[01]\\b"
}
```

- `login` must be a bot account; it is matched exactly after normalising the `[bot]` suffix. A human with the same name is not the reviewer.
- `rereview_comment` is posted after every push that came from a fix run.
- `blocking_pattern` is a regex tested against each inline comment of the reviewer's newest review since the last request. A match, or a `CHANGES_REQUESTED` state, keeps the PR out of `ready-for-human`.

Any other review bot is a three-field edit. `"reviewer": null` means only humans and CI drive the loop, and a PR is ready as soon as checks are green.

## Harness flags

Flags are not configurable; they live in `lib/harness.mjs` and are the verified working form for each CLI version:

- Claude Code: `-p --permission-mode auto --permission-prompts none --max-budget-usd <n> --settings <file> --output-format stream-json --verbose`, with `--session-id <uuid>` on start and `--resume <uuid>` on resume.
- Codex: `exec --json -c approval_policy="never" -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true --skip-git-repo-check`, with `exec resume <id>` on resume.
- Gemini CLI: `--skip-trust --output-format stream-json -p`, with `--session-id <uuid>` on start and `--resume <uuid>` on resume. `--skip-trust` is mandatory: without it a headless run in an untrusted directory refuses and the run is wasted. The help text says `--resume` takes "latest" or an index; that is incomplete, and a UUID is the only form that resumes one specific session.
- opencode: `run --format json`, with `--session <id>` on resume. Ids are minted by the server and cannot be pre-assigned, so the id is read back off the run's own JSONL, as with Codex.
- goose: `run --output-format stream-json -t`, with `--name <id>` on start and `--resume --name <id>` on resume. `--session-id` looks like the flag to use but is resume-only and refuses without `--resume`, so it cannot name a session the daemon will come back to.

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

## Environment for runs

Every run gets `GH_TOKEN` from the token file, `GIT_CONFIG_GLOBAL=~/.gallivant/gitconfig`, and per harness: `APORT_CLAUDE_CODE_CONFIG_DIR=<dir of the settings file>` for Claude, `GEMINI_CLI_TRUST_WORKSPACE=true` for Gemini CLI, and `GOOSE_MODE=smart_approve` for goose. Runs are spawned with the checkout as the working directory and binaries by absolute path, so shell functions and aliases around `claude` or `codex` are bypassed.
