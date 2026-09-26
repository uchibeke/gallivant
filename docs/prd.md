# The PRD contract

A PRD is the whole brief a session gets, and the only thing you write by hand. So the rules are strict, there is no override flag, and `gallivant start` refuses a PRD that has not passed `gallivant ready`.

```bash
cp templates/prd.md path/to/repo/docs/prds/widget-export.md
# write it
gallivant ready path/to/repo/docs/prds/widget-export.md --check   # the checklist, nothing written
gallivant ready path/to/repo/docs/prds/widget-export.md           # flips status to ready and commits the file
gallivant start path/to/repo/docs/prds/widget-export.md
```

## The rules

| Rule | Passes when |
|---|---|
| path | The file is `docs/prds/<id>.md` in the target repo, `<id>` lowercase letters, digits and dashes. The id becomes the branch `gallivant/<id>`. |
| frontmatter | A `---` block with `status: draft` or `ready`, and `harness: claude` or `codex`. |
| title | Exactly one H1, 8 to 80 characters. It becomes the PR title. |
| problem | `## Problem` has at least 40 words. Who hurts, when, and what changes when this ships. |
| stories | Every bullet under `## User stories` reads `As a <who>, I want <what>, so that <why>`. At least one. |
| criteria | Every bullet under `## Acceptance criteria` contains Given, When and Then. At least one per user story. A criterion may run over indented continuation lines. |
| verify | `## Verify` lists at least one command, in backticks or a code block, that the session must run green before opening the PR. No `sudo`, no `rm -rf`, no piped installers. |
| look | `## Where to look` names files or directories to start from, or a single bullet `none`. |
| scope | `## Out of scope` has at least one bullet. |
| placeholders | No `TODO`, `TBD`, `FIXME`, `???`, `lorem ipsum` or `<angle-bracket>` text anywhere in the body. The template's placeholders must all be replaced. |
| size | Under 1,500 words. A PRD is one pull request. Split anything bigger. |

`ready --check` prints every rule with ok or FAIL and, for a failure, what to change. `start` runs the same checks again and stops on the first failure, so editing a PRD after marking it ready cannot sneak a bad one through.

## Optional frontmatter

Two keys beyond `status` and `harness` are read if present, and neither is part of the eleven rules:

- `aport_decision` is written by `gallivant ready`, the receipt of the decision that made the PRD ready.
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

The checker does not read files. It takes a Request, which is what a source produces after reading whatever you typed:

```
{ id, repo, title, body, harness, status, source: { kind, url, author }, raw }
```

The only source today is the PRD file, under `lib/sources/prd.mjs`. It parses the frontmatter, takes the id from the filename, and asks git which checkout the file is in, so `repo` arrives as `owner/name` on the Request rather than being worked out later by `start`. Nothing about writing or checking a PRD changes because of this.

What it buys is that the rules are the rules. `path` is the one rule that depends on where a brief lives rather than on what it says, and it declares that in its own data (`kinds: ["prd"]`); every other rule has no scope and applies to any Request. A source that has no path is not reported as failing a rule about filenames, and it is held to all ten of the others. That is the extension point: a brief arriving some other way is an adapter plus somewhere to record its verdict, not a second gate with its own drift.

## Ready is an APort decision

`gallivant ready` records an APort decision as well as flipping the status. The PRD is treated as a deliverable under APort's `deliverable.task.complete.v1` policy: the eleven rules become the acceptance criteria of a per-PRD passport, the checker's verdict per rule becomes an attestation with evidence, the PRD text goes through the policy's output scan for placeholder text, and the summary names the PRD and its score. The built-in rules run first and list every problem; when they pass and `deliverable.evaluator` is `aport`, the same context and passport go to APort's verify endpoint, and its answer is recorded. Only an allow flips the status, and the decision id is written into the PRD's frontmatter as `aport_decision`, so a ready PRD carries the receipt of the decision that made it ready. Without a config, or with `deliverable: null`, the decision is local only. `ready` does not commit; the daemon works from its own snapshot of the PRD taken by `start`, so commit the PRD with the rest of your work whenever you like.

## Why this shape

- **Stories and criteria in fixed forms** give the session something to test against and give you something to review in the PR description. Free-form prose produces free-form PRs.
- **Verify is a command, not a sentence.** The session runs it before opening the PR, and again after every fix round. If you cannot name the command, the PRD is not ready.
- **Where to look** is the cheapest way to cut a session's wandering. Two paths save ten minutes of grep.
- **Out of scope** is what keeps a two-hour PRD from becoming a two-day refactor.
- **The size cap** is the review budget. Three rounds with a reviewer on a 300-line PR works; on a 3,000-line PR it does not.

## What the session receives

The full PRD text, quoted as data, with the branch, the base branch, the Verify commands and the rule that it must open exactly one PR and never touch the default branch. After a fix round it receives the reviewer's findings the same way, plus the Verify commands again.

## The completion receipt

Passing the contract gets a PRD started. Getting the PR to `ready-for-human` needs a second gate at the other end, shaped after APort's `deliverable.task.complete.v1` policy: the agent must attest, with evidence, that every acceptance criterion holds.

Each Acceptance criteria bullet becomes a criterion with a stable id, `ac-1`, `ac-2`, in order. The session is told, at start and on every fix round, to end the PR body with a receipt:

````markdown
```gallivant-attestations
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
| `oap.receipt_missing` | No receipt block, or not valid JSON. |
| `oap.criteria_incomplete` | A criterion has no attestation. |
| `oap.evidence_missing` | An attestation has empty evidence. |
| `oap.criteria_not_met` | An attestation is not `met: true` (the string `"true"` does not count). |
| `oap.criteria_unknown` | An attestation names an id that is not in the PRD. |
| `oap.summary_insufficient` | Summary under `min_summary_words`. |
| `oap.tests_not_passing` | Checks on the head are not all green. |
| `oap.blocked_pattern_detected` | The scanned output contains a blocked pattern. |

A round that only rewrites the receipt counts as a round: the daemon posts a marked "Completion receipt updated" comment instead of a re-review request, since no code moved, so the round count on GitHub still matches the registry. The iteration cap applies. Limits live under `deliverable` in config, in the shape of the policy's passport limits; `"deliverable": null` turns the gate off.

Who decides. The built-in rules run first and list every problem at once. When they pass and `deliverable.evaluator` is `aport` (the default), the daemon builds a per-task passport in OAP shape, with the PRD's criteria as the policy's `acceptance_criteria` limits, and posts it with the context to APort's verify endpoint for `deliverable.task.complete.v1`. APort evaluates the passport as sent and its deny wins. If APort cannot be reached there is no decision: the PR stays where it is, nothing is dispatched, no round is counted, and the daemon asks again next tick. Set `deliverable.on_unreachable` to `local` to let the built-in verdict stand instead; the log then says which verdict was used. `evaluator: "local"` skips the hosted call. The API key recorded by the APort Claude install, if any, is sent so the calls count against your account; the route also works unauthenticated, rate limited per IP.

APort's deny names one problem at a time (evaluation stops at the first failing rule) and does not include the criterion id, which is why the local pass runs first.

## Provenance on a decision

Both gates send a `meta` object inside the context they already send:

```json
"meta": { "framework": "codex", "gallivant_version": "0.1.0" }
```

`framework` is the harness that did the work, or that the brief names for a readiness decision. `gallivant_version` is the release that asked. A machine running Claude Code and Codex against one passport otherwise produces decisions nobody can tell apart afterwards, and the OAP decision object is closed (`additionalProperties: false`), so the request context is where this belongs. No specification change was needed: the policy packs leave `additionalProperties` unset, which in JSON Schema already permits extra properties, and the hosted validator's context schemas are `.unknown(true)`. An older verifier ignores the field.

It is self-reported and it is never an authorization input. Gallivant asserts these two values and nothing verifies them, so a field the caller controls could be forged the moment anything read it back to decide something. It is recorded for audit and analytics, and the local rules ignore it entirely; a test asserts that a forged `meta` changes no verdict in either direction.
