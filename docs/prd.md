# The PRD contract

Repository review lessons are advisory shared inputs. They cannot rewrite this
contract, its Verify commands, acceptance criteria or APort completion gates.
Candidate/repository instructions are not learning approval authority. See
[learning](learning.md) for exact revision review, signed activation and the
collection-only qualification status; an incomplete implementation receipt must
keep unmet criteria false.

A PRD is the structured brief for one repository deliverable. Write it yourself,
or let [natural-language intake](tasks.md) prepare it from a request. Both paths
must pass the same rules before implementation; there is no validation override.
The agent also receives the repository and any explicitly selected source files,
permissions and review feedback.

The deliverable need not be code. A research report, documentation update or
content package can use this contract when its outputs live in the repository.
For example, specify a report with cited sources, a fixed comparison table and
no changes to existing code. Verify its required files/schema/link checks using
commands the repository actually provides, plus `git diff --check`. Formatting
checks alone do not prove research accuracy; acceptance evidence and review still
need to establish the requested outcome. Account operations, publishing to an
external service and deployments are not implied by a repository task.

```bash
gallivant new widget-export     # from anywhere inside the repo the work belongs to
# write it
gallivant ready path/to/repo/docs/prds/widget-export.md --check   # the checklist, nothing written
gallivant ready path/to/repo/docs/prds/widget-export.md           # records readiness and updates the file; does not commit
gallivant start path/to/repo/docs/prds/widget-export.md
```

## The rules

| Rule | Passes when |
|---|---|
| path | The file is `docs/prds/<id>.md` in the target repo, `<id>` lowercase letters, digits and dashes. New runs use branch `work/<id>`; existing legacy branches remain readable. |
| frontmatter | A `---` block with `status: draft` or `ready`. If supplied, `harness` must be a registered ID; omission uses `claude`. Set it explicitly to make the runtime choice clear. Registration does not guarantee dispatch availability; see [support](../README.md#harness-support). |
| title | Exactly one H1, 8 to 80 characters. It supplies the PR title, subject to public-output validation. |
| problem | `## Problem` has at least 40 words. Who hurts, when, and what changes when this ships. |
| stories | Every bullet under `## User stories` reads `As a <who>, I want <what>, so that <why>`. At least one. |
| criteria | Every bullet under `## Acceptance criteria` contains Given, When and Then. At least one per user story. A criterion may run over indented continuation lines. |
| verify | `## Verify` lists at least one command, in backticks or a code block, that the session must run green before opening the PR. No `sudo`, no `rm -rf`, no piped installers. |
| look | `## Where to look` names files or directories to start from, or a single bullet `none`. |
| scope | `## Out of scope` has at least one bullet. |
| placeholders | No `TODO`, `TBD`, `FIXME`, `???`, `lorem ipsum` or unfinished `<angle-bracket>` placeholders in the body. Recognized inline HTML tags are allowed. Replace every template placeholder. |
| size | At most 1,500 body words. A PRD is one pull request. Split anything bigger. |
| sources | Every file named in `sources` exists, is readable text, and is inside the repository. Only checked on a brief that names any. |

`ready --check` prints every rule with ok or FAIL and, for a failure, what to change. `start` runs the same checks again and refuses a brief with any failing rule, so editing a PRD after marking it ready cannot sneak a bad one through.

## Optional frontmatter

These keys beyond `status` and `harness` are read if present:

- `aport_decision` is written by `gallivant ready`, the receipt of the decision that made the PRD ready. It is not
  part of the rules.
- `sources` names files beside this brief that travel into the session's checkout, so a brief can cite a requirements
  document or an `AGENTS.md` that only exists in your own tree. Paths are relative to the repository root, named one
  at a time:

  ```
  ---
  status: ready
  harness: codex
  sources:
    - docs/research-notes.md
    - AGENTS.md
  ---
  ```

  Absolute paths, `..` segments, globs, directories, backslashes, `.git` components and symlinks at any path component
  are refused. Files are checked on both reading and copying into the checkout. `gallivant ready` reads every file, so a
  mistyped path is refused at your terminal rather than thirty minutes into a paid run. Each file is snapshotted
  beside the brief and written into the checkout from that snapshot, so a session cannot widen what it was given by
  editing a document it was handed, and the list is part of the contract: adding or removing a file stops the entry
  the way an edited criterion does. See [config.md](config.md#files-a-brief-carries-sources) for how it differs from
  `context_paths`.
- `context_paths` gives this one brief read access to directories outside its checkout, added to whatever
  `config.json` already lists rather than replacing it. Comma-separated, or a `[a, b]` list:

  ```
  ---
  status: ready
  harness: claude
  context_paths: ~/work/schemas, ~/Projects/design-system
  ---
  ```

  Every entry is held to the same refusals as the config key, so a PRD cannot grant itself `$HOME`, the Gallivant
  home or a harness config directory. `start` fails with the offending path named and nothing is recorded. This is
  the operator's list, not the agent's: fix rounds read the snapshot of the brief taken when the run started, so
  editing the PRD in the checkout changes nothing about what later runs can read. See
  [guardrails.md](guardrails.md#extra-read-directories-are-a-widening-not-a-feature) for what it costs.

## One gate, one implementation

The checker takes a Request, which is what a source produces after reading your
input. Its structure rules inspect that request; its `sources` rule also reads
the declared repository files to verify their containment, readability and text
format. No provider call is needed for `ready --check`.

```
{ id, repo, title, body, harness, status, source: { kind, url, author }, raw }
```

The repository-file source lives under `lib/sources/prd.mjs`. It parses
frontmatter, takes the ID from the filename and resolves the repository.
Natural-language intake additionally drafts a PRD with owner requirement mappings,
then uses this same checker/readiness path. Intake is an implemented entry point,
not a second completion system. Other source proposals in `docs/prds` and
`docs/design` are specifications, not necessarily implemented transports.

`path` and `sources` depend on the repository-file source and declare
`kinds: ["prd"]`. The other ten rules apply to every Request. A future non-file
source would use those shared rules and explicitly implement any additional
source-specific checks; it would not need a separate readiness gate.

## Ready is an APort decision

`gallivant ready` records an APort decision as well as flipping the status. The PRD is treated as a deliverable under APort's `deliverable.task.complete.v1` policy: the twelve rules become the acceptance criteria of a per-PRD passport, the checker's verdict per rule becomes an attestation with evidence, the PRD text goes through the policy's output scan for placeholder text, and the summary names the PRD and its score. The built-in rules run first and list every problem; when they pass and `deliverable.evaluator` is `aport`, the same context and passport go to APort's verify endpoint, and its answer is recorded. Only an allow flips the status, and the decision id is written into the PRD's frontmatter as `aport_decision`, so a ready PRD carries the receipt of the decision that made it ready. Without a config, or with `deliverable: null`, the decision is local only. `ready` does not commit; the daemon works from its own snapshot of the PRD taken by `start`, so commit the PRD with the rest of your work whenever you like.

## Editing the brief after the work has started

`start` copies the brief into `~/.gallivant/prds/<id>.md`, and the completion gate reads only that copy. That is what
stops a session rewriting its own acceptance criteria. It is not what stops YOU rewriting them: the snapshot and the
file in your checkout are two files, and until this existed nothing compared them. A brief edited after `start` meant
the run finished against criteria nobody was asking for and the PR arrived satisfying a document that had changed.

So the two are compared, and what happens depends on what you changed. The comparison is in the contract's own terms:
the acceptance criteria, Verify commands, `harness`, `context_paths`, `sources`,
and the **Coordinator delivery contract** when present. The ownership section
keeps a natural-language publication instruction separate from provider work.
It is validated and fingerprinted too; malformed edits cannot be silently ignored.
Physical LF/CRLF formatting changes are equivalent, while the JSON-escaped original
request bytes remain exact.

| What you changed | What happens |
|---|---|
| Anything outside those contract fields: the Problem prose, a reworded story, a new Out of scope bullet | Nothing stops. The snapshot follows your edit so later prompts carry your current wording, the log says it happened, and you are not told. Stopping a run to ask about a typo fix would be worse than useless. |
| A criterion, a Verify command, the harness, `context_paths`, `sources` or coordinator delivery ownership | The entry stops with `prd-changed` before the gate runs, and `gallivant why` names each difference. |
| The ORDER of two criteria, without changing a word of either | Also `prd-changed`. Criteria are numbered by position, and the receipt on the open PR attests `ac-1` and `ac-2` by those numbers, so swapping two of them leaves the receipt attesting each criterion with the other's evidence. |
| The file no longer passes the contract | `prd-illegal`. Fix the file and `gallivant ready` it again; it cannot become the brief the gate judges as it stands. |
| The file is gone from your checkout | `prd-gone`. Restore it, or `gallivant remove` the entry. |
| Only the line endings, CRLF to LF or back | Nothing. It is the same brief, so it compares as the same brief. (`ready` used to refuse a CRLF file outright, reporting a missing frontmatter block that was right there; both halves are fixed.) |

While a `prd-changed` stop is unresolved the gate judges **neither** brief. Judging the snapshot would certify a brief
you have moved on from, which is the silent divergence this exists to end. Judging your new copy would certify criteria
the session was never given and has not attested, so the receipt on the PR would be answering a different question from
the one asked. There is no third brief, so no decision is made until you say which brief is the brief:

```bash
gallivant why widget#142                      # every difference, and what the gate is doing about it
gallivant resume widget#142 --resnapshot       # the edit is the brief; the session is told what moved
# or put the brief back the way it was, and the next tick carries on where it left off
```

`--resnapshot` is the explicit way to adopt a changed contract into an existing snapshot, and it is loud about it: a warning in
`errors.log` naming the file, who asked and every difference, and a resume prompt that tells the session what moved and
to reread the brief rather than trust what it remembers. Work already done against a criterion that has not changed
still stands, which is the whole reason this is a resume and not a restart.

Why a person and not the daemon. A criterion ADDED means the work in flight is valid but incomplete. A criterion
REWRITTEN means what was built is no longer what is wanted. From the text of two files those are the same event, and
guessing wrong is expensive in both directions: finish the old brief and you ship the wrong thing, restart and you throw
away work that may have been exactly right. So the daemon proves what it can (which criterion, which command) and puts
the decision in front of you.

One more signal, reported and never relied on: `gallivant ready` writes `aport_decision` into the frontmatter, so a
brief whose decision id has changed is one you deliberately re-blessed. `why` says so. It cannot be the test, because
`ready` leaves the id alone on a brief that was already ready and a hand-edit can miss the frontmatter entirely.

An entry that never saw your checkout is never stopped for this. `register` and the daemon's recovery from GitHub build
entries with no record of where your copy lives, so there is nothing to compare and they carry on exactly as before.

## Why this shape

- **Stories and criteria in fixed forms** give the session something to test against and give you something to review in the PR description. Free-form prose produces free-form PRs.
- **Verify is a command, not a sentence.** The session runs it before opening the PR, and again after every fix round. If you cannot name the command, the PRD is not ready.
- **Where to look** is the cheapest way to cut a session's wandering. Two paths save ten minutes of grep.
- **Out of scope** is what keeps a two-hour PRD from becoming a two-day refactor.
- **The size cap** is the review budget. Three rounds with a reviewer on a 300-line PR works; on a 3,000-line PR it does not.

## What the session receives

The session receives the full PRD as data, the branch/base, selected sources,
Verify commands and scope constraints. Local execution asks the agent to deliver
one PR without changing the base branch. Hosted execution returns artifacts;
the coordinator verifies and publishes them with its own GitHub credentials.
Review fixes return to the same session with current findings and checks. The
[execution guide](execution.md) describes the ownership boundaries.

## The completion receipt

Passing the contract gets a PRD started. Getting the PR to `ready-for-human` needs a second gate at the other end, shaped after APort's `deliverable.task.complete.v1` policy: the agent must attest, with evidence, that every acceptance criterion holds.

Each Acceptance criteria bullet becomes a criterion with a stable id, `ac-1`, `ac-2`, in order. The session is told, at start and on every fix round, to end the PR body with a receipt:

````markdown
```work-attestations
{
  "task_id": "widget/widget-export",
  "output_type": "code",
  "summary": "What changed and how it was verified, at least 20 words.",
  "criteria_attestations": [
    { "criterion_id": "ac-1", "met": true, "evidence": "src/export/csv.test.ts: 'exports three rows'" },
    { "criterion_id": "ac-2", "met": true, "evidence": "src/export/Button.tsx:41 disabled when empty; test 'empty state hint'" }
  ]
}
```
````

When checks are green and the reviewer has no blocking findings, the daemon builds the policy context and evaluates it. `tests_passing` comes from the checks the daemon observed, never from the receipt. A deny starts a fix round whose prompt carries the policy's deny codes, which are written so the agent can correct itself:

| Code | Meaning |
|---|---|
| `oap.receipt_missing` | No receipt block, not valid JSON, or a shape the rules cannot read: `criteria_attestations` not an array, or an element that is not an object carrying a `criterion_id` string. The reason says which. |
| `oap.criteria_incomplete` | A criterion has no attestation. |
| `oap.evidence_missing` | An attestation has empty evidence. |
| `oap.criteria_not_met` | An attestation is not `met: true` (the string `"true"` does not count). |
| `oap.criteria_unknown` | An attestation names an id that is not in the PRD. |
| `oap.summary_insufficient` | Summary under `min_summary_words`. |
| `oap.tests_not_passing` | Checks on the head are not all green. |
| `oap.blocked_pattern_detected` | The scanned output contains a blocked pattern. |

A brief with no `## Acceptance criteria` section has nothing to attest, and nothing to attest is a deny, not a pass: every criteria rule is vacuously satisfied by an empty list, so the gate would otherwise allow on the summary and the checks alone. This matters because the snapshot the gate reads is taken from the PR branch when the daemon has none, and that copy was writable by the session.

The output scan sees only the lines the diff adds, and it has to see all of them. A diff `gh pr diff` cannot return, or one at or above the 16 MiB scan cap, is no decision rather than a partial scan reported as clean. Hosted requests stay below the API body limit by splitting large output into overlapping pieces, each carrying the complete receipt, criteria and policy limits. Every piece must pass; overlap catches blocked substrings across boundaries, and no output is omitted. The local and hosted scans both match blocked patterns case-insensitively. An unreadable diff or unavailable evaluator retries without dispatching an agent or spending a round; after five consecutive failures the entry stops as `needs-human` with reason `stuck`. `status` and `why` show the completion failure instead of blaming an already-clear reviewer. Correct the cause (split a diff above the scan cap, for example), then `gallivant resume <id>`.

A round that only rewrites the receipt counts as a round: the daemon posts a marked "Completion receipt updated" comment instead of a re-review request, since no code moved, so the round count on GitHub still matches the registry. The iteration cap applies. Limits live under `deliverable` in config, in the shape of the policy's passport limits; `"deliverable": null` turns the gate off.

Who decides. The built-in rules run first and list every problem at once. When they pass and `deliverable.evaluator` is `aport` (the default), the daemon builds a per-task passport in OAP shape, with the PRD's criteria as the policy's `acceptance_criteria` limits, and posts it with the context to APort's verify endpoint for `deliverable.task.complete.v1`. APort evaluates the passport as sent and its deny wins. If APort cannot be reached there is no decision: the PR stays where it is, nothing is dispatched, no round is counted, and the daemon asks again next tick, up to the five-failure bound above. Set `deliverable.on_unreachable` to `local` to let the built-in verdict stand instead; the log then says which verdict was used. `evaluator: "local"` skips the hosted call. The API key recorded by the APort Claude install, if any, is sent so the calls count against your account; the route also works unauthenticated, rate limited per IP.

APort's deny names one problem at a time (evaluation stops at the first failing rule) and does not include the criterion id, which is why the local pass runs first.

## Provenance on a decision

Both gates send a `meta` object inside the context they already send:

```json
"meta": { "framework": "codex", "gallivant_version": "0.2.0" }
```

`framework` is the harness that did the work, or that the brief names for a readiness decision. `gallivant_version` is the release that asked. A machine running Claude Code and Codex against one passport otherwise produces decisions nobody can tell apart afterwards, and the OAP decision object is closed (`additionalProperties: false`), so the request context is where this belongs. No specification change was needed: the policy packs leave `additionalProperties` unset, which in JSON Schema already permits extra properties, and the hosted validator's context schemas are `.unknown(true)`. An older verifier ignores the field.

It is self-reported and it is never an authorization input. Gallivant asserts these two values and nothing verifies them, so a field the caller controls could be forged the moment anything read it back to decide something. It is recorded for audit and analytics, and the local rules ignore it entirely; a test asserts that a forged `meta` changes no verdict in either direction.
