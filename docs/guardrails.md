# Guardrails

Unattended runs act with your GitHub identity on your code. Each guarantee below names the control that provides it. APort is installed on both harnesses from day one, and this page is honest about what it enforces today and what it does not.

| Guarantee | Control | APort's part |
|---|---|---|
| Writes stay in the checkout | Claude: the Bash sandbox in the Gallivant settings file. Codex: the `workspace-write` sandbox. | Denies Write and Edit tool calls outside `allowed_paths`. Does not see `echo x > ~/.zshrc` inside a Bash command. |
| No reads of secrets | Same sandboxes, plus each harness's own denied reads. | Denies Read and Grep calls on `.env*`, `.ssh`, `.aws`, `*.pem`, `*.key` and the passport's `blocked_paths`. Does not see `cat .env` inside Bash. |
| Network limited | Claude: `sandbox.network.allowedDomains`. Codex: none once `network_access=true`, which `git push` needs. | Denies WebFetch and WebSearch outside `allowed_domains`. Does not see `curl` inside Bash. |
| No push to the default branch, no force push | A GitHub ruleset on each repo: no deletion, no force push, pull request required, no bypass actors. `doctor` prints the call. | `blocked_patterns` substring-matches `push --force`, `push origin main` and the like. Best effort; APort does not parse refspecs. |
| Blast radius of a successful injection | Optional but recommended: a fine-grained PAT limited to the participating repos with no Workflows permission (`github_token_file`). By default runs use your `gh` login, which reaches every repo it can. Either way a Gallivant gitconfig keeps `~/.git-credentials` and the keychain out of a run's path. | An audit log of every tool call, for reconstruction. |
| Runaway spend | `--max-budget-usd` on Claude runs, `run_timeout_minutes` on both, `max_iterations` per PR. | none |

## What must be delivered

Before a PR can be ready for a human, the daemon evaluates a completion receipt in the PR body against the PRD's acceptance criteria, following APort's `deliverable.task.complete.v1` policy: one attestation with evidence per criterion, a summary, and tests green as observed by the daemon. See [prd.md](prd.md). It is a gate on what the agent must deliver, not a security boundary; the table above is the boundary.

## What reaches a prompt

Only reviews and comments by `trusted_authors` and the configured reviewer bot. Comments edited after posting, comments created while a run was in progress, the daemon's own comments, and the harness's thread replies are skipped. Failing checks are named with their run id; the harness fetches the log itself, so the daemon never handles log text. Everything quoted into a prompt sits inside a four-backtick fence with internal fences neutralised and a 4,000-character cap. That is hygiene, not a control: assume an injection will sometimes succeed, and rely on the table above to bound what it can do.

## Recovery from GitHub is guarded

On boot, `up` registers only PRs authored by the token's login, with same-repo heads, on `gallivant/*` branches, whose block passes strict validation (uuid session, `docs/...md` PRD path, known harness). Iteration is recovered by counting the daemon's own marked comments, never read from the block, so editing a PR body cannot reset the cap.

## The passport

`templates/passport.gallivant.json`: capabilities for file read and write, command execution, web fetch and subagent creation. `allowed_commands` is `["*"]` on purpose: a restrictive list denies any command containing `&&`, `;` or `|`, so the first `git add -A && git commit` of every run would fail. Write `allowed_paths` is the worktrees root; `blocked_paths` for read and write cover `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.gallivant` and `~/.aport`, so a run cannot edit its own guardrails.

## Codex

APort's Codex hook is beta. It fails closed on `apply_patch` payloads that touch more than one file and on `Glob`, `List` and `LS`, and those are pre-evaluation denials. In enforce mode a Codex fix run would stall on its first real edit, so Gallivant documents warn mode for Codex. On Codex the bounds are the seatbelt, the token and the ruleset; APort is an audit trail and a warning. The fix belongs in `aport-agent-guardrails` (evaluate each path of a multi-file patch, allow the listing tools); Codex moves to enforce when it lands.

## Known limits

- The daemon runs as your user on the Mac. The sandbox, the token scope and the ruleset are what stand between an escaped run and your home directory. On a Linux box, run it as a dedicated user.
- Codex `network_access=true` removes the network boundary inside the checkout. Accepted on day one; the token scope and the ruleset bound what a push can do.
- Run logs hold everything the harness printed, including tool inputs. They are mode 600 under a mode 700 directory and never served. Delete `~/.gallivant/runs` whenever you like.

## Follow-ups filed against APort

Listed at the end of `docs/audit/DECISIONS.md`: multi-file `apply_patch` in the Codex hook, `git push` refspec parsing, control-plane paths blocked by default, a non-interactive local passport install, and a Repository Guard slice that blocks pushes rather than reporting merges.
