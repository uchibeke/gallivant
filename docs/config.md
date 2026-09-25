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
| `harness` | discovered | Omit it and Gallivant uses whichever harnesses it finds on your PATH, so one installed harness is a complete install. Name one and only that one is used, which is what you want when two versions are installed or a harness is deliberately out of play. |
| `harness.claude` | | `{ bin, settings }`. `bin` is the absolute path to `claude`; `settings` is the Gallivant settings file with the APort hook and sandbox. |
| `harness.codex` | | `{ bin }`. |

Claude Code and Codex are the two supported harnesses. Others are not rejected on principle; the loop needs a
harness that can start a run non-interactively, resume that specific session by id, and emit a machine-readable
stream. `cursor-agent` meets all three (`--print --output-format stream-json`, `--resume <chatId>`) and is the next
one to add. `gemini` can name a session with `--session-id` but resumes by index or file rather than by that id.
`goose` resumes interactive sessions only, so there is nowhere for the loop to stand. `opencode` has `run -s <id>`
and is gated on an APort target. The reasoning is kept next to the adapters in `lib/harness.mjs`.
| `repos` | [] | Appended by `start` and `register`. Used by `up` to recover from GitHub. |

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

Any `--dangerously-*` flag is refused by the adapter. Gallivant never edits `~/.claude/settings.json` or `~/.codex/config.toml`.

## Environment for runs

Every run gets `GH_TOKEN` from the token file, `GIT_CONFIG_GLOBAL=~/.gallivant/gitconfig`, and for Claude `APORT_CLAUDE_CODE_CONFIG_DIR=<dir of the settings file>`. Runs are spawned with the checkout as the working directory and binaries by absolute path, so shell functions and aliases around `claude` or `codex` are bypassed.
