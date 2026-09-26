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

## Extra read directories are a widening, not a feature

`context_paths` lets you hand a session read access to directories outside its checkout: a sibling repository it has
to call into, a folder of design notes, an API schema it must match. Writes do not move. On Claude Code the paths go
through `--add-dir`, and the sandbox in the Gallivant settings file still bounds every write to the worktree.

What it costs. Reading is an exfiltration path. Anything the agent reads can come back out in a commit, a PR body,
a comment or a run log, and a prompt injection in a review comment is enough to ask for it. A private key in a
directory you added is a private key in a public PR. So the recommendation is a narrow one: name the directory the
brief actually needs, not the parent that happens to contain it. `~/work/schemas` rather than `~/work`.
`~/Projects/design-system` rather than `~/Projects`.

Five paths are refused outright, and each refusal names what it protects:

| Refused | Because |
|---|---|
| The Gallivant home, or any parent of it | It holds the registry, the run logs and `claude/settings.json`, the sandbox definition that bounds the run's writes. A run that can read it can read the rules it is being held to. |
| `~/.claude`, `~/.codex`, `~/.config/opencode` | Harness credentials and config. These are already in the passport's `blocked_paths`; refusing them here means the read never gets as far as the hook. |
| `~/.aport` | The passport itself, and the audit trail. |
| Your home directory | Every credential, token, key and browser profile on the machine. If the answer to "which directory does this brief need" is `$HOME`, the brief needs splitting, not more access. |
| Anything relative, or that does not exist | A relative path means something different depending on where the daemon was started. A missing one is a typo, and silently granting nothing would hide it. |

A parent of a refused directory is refused too, since granting the parent grants the child.

What each harness does with the list:

| Harness | Effect |
|---|---|
| Claude Code | `--add-dir <dir>` per path. Read access widens, the sandbox still bounds writes. |
| Codex | Refused. `--add-dir` makes a directory **writable**, and the only read permission Codex documents is `disk-full-read-access`, the whole disk. Giving a run the entire filesystem to read in order to hand it one directory is worse than the problem; the run fails with that explanation instead. |
| Gemini CLI | Refused, for the same shape of reason. `--include-directories` adds to the *workspace*, and Gemini's own file-system tool reference says every file tool, `write_file` included, operates inside the workspace root. There is no read-only spelling. |
| opencode, goose | No directory flag exists, so the list has no effect. The run proceeds unchanged rather than failing over a setting the CLI cannot honour, and `gallivant doctor` says so per harness when you have a list configured. |

Nothing here escalates quietly. A harness that cannot do what was asked either refuses the run or reports that the
setting did nothing. In the daemon a refusal stops that entry with the reason `context-paths`, since the same
refusal would come back on every poll; `gallivant why <handle>` prints it.

A PRD can add to the list for itself with a `context_paths:` key in its frontmatter, held to exactly the same
refusals. It is the operator's list either way: the daemon's fix rounds read the snapshot of the brief taken when
the run started, not the copy in the checkout, so a session cannot widen its own reads by editing the PRD it was
given.

## Recovery from GitHub is guarded

On boot, `up` registers only PRs authored by the token's login, with same-repo heads, on `gallivant/*` branches, whose block passes strict validation (uuid session, `docs/...md` PRD path, known harness). Iteration is recovered by counting the daemon's own marked comments, never read from the block, so editing a PR body cannot reset the cap.

## The passport

`templates/passport.gallivant.json`: capabilities for file read and write, command execution, web fetch and subagent creation. `allowed_commands` is `["*"]` on purpose: a restrictive list denies any command containing `&&`, `;` or `|`, so the first `git add -A && git commit` of every run would fail. Write `allowed_paths` is the worktrees root.

`blocked_paths` cover `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.gallivant` and `~/.aport` in **both** directions. Blocking writes stops a run editing the rules it is held to. Blocking reads stops it learning them: `~/.claude/settings.json` is the sandbox definition, `~/.aport` holds the passport and the audit trail, and `~/.codex` and `~/.claude` hold harness credentials. An injected run that can Read or Grep those knows where the boundary is and what sits behind it, which is the first move before trying to get around it.

That template is the **local-mode default**, and it is the passport `doctor` checks: it reads `data.file.write` and `data.file.read` on `<aport dir>/passport.json` and fails the check, naming the paths, when either list is short. A **hosted** passport is a different thing. Its limits live in the aport.io dashboard and are whatever the operator set there; `doctor` prints the agent id and what the limits should say, but it cannot read them and cannot change them. If you run hosted, copy the two `blocked_paths` lists out of the template into the dashboard yourself.

## Codex

APort's Codex hook is beta. It fails closed on `apply_patch` payloads that touch more than one file and on `Glob`, `List` and `LS`, and those are pre-evaluation denials. In enforce mode a Codex fix run would stall on its first real edit, so Gallivant documents warn mode for Codex. On Codex the bounds are the seatbelt, the token and the ruleset; APort is an audit trail and a warning. The fix belongs in `aport-agent-guardrails` (evaluate each path of a multi-file patch, allow the listing tools); Codex moves to enforce when it lands.

## Known limits

- The daemon runs as your user on the Mac. The sandbox, the token scope and the ruleset are what stand between an escaped run and your home directory. On a Linux box, run it as a dedicated user.
- Codex `network_access=true` removes the network boundary inside the checkout. Accepted on day one; the token scope and the ruleset bound what a push can do.
- `context_paths` widens what a run can read and therefore what an injected run can leak. The refusals above stop the worst of it; the narrowness of the paths you choose is the rest.
- Run logs hold everything the harness printed, including tool inputs. They are mode 600 under a mode 700 directory and never served. Delete `~/.gallivant/runs` whenever you like.

## Follow-ups filed against APort

Listed at the end of `docs/audit/DECISIONS.md`: multi-file `apply_patch` in the Codex hook, `git push` refspec parsing, control-plane paths blocked by default, a non-interactive local passport install, and a Repository Guard slice that blocks pushes rather than reporting merges.
