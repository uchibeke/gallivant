# Sources, standards and provenance

Written 2026-09-25.

Status, updated 2026-09-25. Of the six steps in "Order of work" below, three have landed:

- **Step 2, the Request shape**, built. `check()` takes a Request; `lib/sources/` holds the adapter that produces one and the registry that picks it. Only the PRD file source exists.
- **Step 3, the repo as an explicit field**, built. `start` reads `request.repo` and no longer calls `git.toplevel`.
- **Step 6, `context.meta` provenance**, built on Gallivant's side: both gates send `{ framework, gallivant_version }` inside the context. Persisting it is still an API-side question.

Not built, and deliberately held back to a later change so they do not delay the single-operator loop:

- **Step 1, `framework=` in the local audit line.** Lives in the guardrail, not in Gallivant.
- **Step 4, the issue door.** No adapter, no `sources.issue` config, no issue comment or label. Step 2 is the groundwork for it and nothing more: the registry has one adapter and does not pretend otherwise.
- **Step 5, output standards.** No `standards` config, no prompt rendering, no completion-gate check.

Everything below is the design as written, including the parts not yet built.

## The problem

A maintainer's complaint about open source, paraphrased: you are tired of your team throwing slop over the wall,
then you run a public repository and the volume multiplies. The work arriving is not reviewed before it is thrown.
Somebody else pays the cost of reading it.

Gallivant already refuses to start on a PRD that fails its contract, so the brief cannot be slop. Three gaps remain.

1. **The brief is the only door.** A PRD file in `docs/prds/` is the single way in. Most requests do not arrive that
   way. They arrive as issues, and later as Slack messages, PR comments and support tickets. Anything that comes
   through another door today bypasses the contract entirely.
2. **The output is not held to a standard.** The contract governs what goes in. What comes out, the commits and the
   pull request, is governed by two sentences in a prompt: "Commit with clear messages" and "Title it after the PRD".
   That is a suggestion, not a standard, and nothing checks it.
3. **Nothing records which harness did the work.** A decision in APort names the policy, the agent and the verdict,
   but not whether Claude Code or Codex made the call. On a machine running both against one passport, the audit
   trail cannot tell them apart.

## One gate, many doors

The contract must be the narrow waist: one implementation, every door, no bypass. The shape that gets there:

    door (PRD file | issue | later: Slack, PR comment, ticket)
      -> adapter: fetch the raw text, name the target repo, carry provenance
      -> Request: { id, repo, title, body, harness, source: { kind, url, author }, raw }
      -> the contract: check(request)  <- the one gate, unchanged rules
      -> APort deliverable decision, recorded against the source
      -> start a session

`lib/prd.mjs` already holds the rules as data, which is what makes this tractable. The work is to stop the rules
taking a parsed *file* and have them take a Request, then give each door an adapter that produces one.

What each door supplies:

| Door | Repo comes from | Identity | Where "ready" is recorded |
|---|---|---|---|
| PRD file | the file's own git checkout | path under `docs/prds/` | `status:` in frontmatter |
| Issue | the issue's own repository | `<owner>/<repo>#<number>` | a label, plus a posted decision comment |
| Slack, later | a channel-to-repo mapping in config | thread timestamp | a reaction, plus a threaded reply |
| Ticket, later | a project-to-repo mapping | ticket id | a status transition |

Two constraints fall out of this, and both are load-bearing:

- **`start` must stop deriving the repo from the PRD's directory.** Today `git.toplevel(dirname(abs))` means the
  brief must live inside the target checkout. An issue has no local file, so the repo has to become an explicit
  field on the Request. This is the single biggest change in the plan.
- **A door that cannot record a decision is not a door.** The PRD gate is only meaningful if its verdict is durable
  and visible where the request came from. For an issue that means a comment and a label, not just a local state
  file. Otherwise the same issue gets re-gated forever and nobody upstream learns why it was refused.

### What an issue has to contain

The rules do not relax for issues. An issue body must carry the same sections a PRD does, which means the gate will
refuse most issues as written. That is the point, and it is also the mechanism: refusing with the checklist is how a
drive-by request becomes a usable brief. `gallivant ready <issue-url>` posts the failing rules as a comment, so the
requester sees exactly what is missing. An issue template should ship with the tool so the common case starts
compliant.

This is the honest cost of the design: it converts an instant "just do it" into a round trip. For a maintainer
drowning in slop that is a feature. For a solo repo it will feel like friction, so the issue door should be
opt-in per repository rather than on by default.

## Standardising the output

Input standards without output standards just move the slop downstream. The commit and PR conventions should be
data in config, rendered into the prompt and then checked before the PR can be ready for a human, in the same place
the completion receipt is checked.

    standards: {
      commit: { subject_max: 72, body_required: true, trailers: ["Refs"] },
      pr: { title_pattern: "...", require_source_link: true, require_receipt: true }
    }

Checked, not merely requested. The completion gate already reads the PR body and the diff, so it is the natural
place: a PR whose commits or title violate the standard gets a fix round with the specific violation, exactly as a
denied receipt does today. The rules belong next to the PRD rules in `lib/prd.mjs`'s style, as data with one
checker, so `gallivant standards --check <pr>` can print the same checklist `ready` does.

Deliberately not included: a commit message format imposed on every repository. Conventional Commits is a choice, not
a law, and a tool that rewrites a project's history conventions is a worse citizen than one that reads them. Default
to the repository's observed convention where it can be detected, and let config override.

## Provenance: which harness ran

Verified in the code today, 2026-09-25:

- `bin/lib/command-hook-adapter.sh` knows the framework at the hook boundary (`FRAMEWORK`, line 8), for every
  framework it supports.
- It is not sent to the hosted verifier. The API context carries the tool and its arguments, not the harness.
- It is not written to the local audit log. A real line reads:
  `tool=bash decision_id=... allow=true policy=system.command.execute.v1 code=oap.allowed`
- `spec/oap/decision-schema.json` has `additionalProperties: false`, and the spec defines no extension convention.

### Carry it in `context.meta`, and do not touch the standard

The first draft of this design proposed a new top-level `client` object on the request and an echo of it in the
decision. That was wrong, and checking the schemas shows why:

- The policy context schemas (`policies/*/policy.json`) leave `additionalProperties` **unset**, which in JSON Schema
  means additional properties are already allowed.
- The hosted validator's context schemas are `.unknown(true)`. The single `.unknown(false)` in
  `functions/utils/validation/joi-schemas.ts` is on nested `structural_findings` items, not on any context root.

So a `meta` object inside the existing context is accepted today by both the pack schemas and the hosted route, with
no change to the specification, no new required field and no conformance impact. `additionalProperties: false` on the
*decision* schema is a reason to leave the decision object alone, not a reason to amend it.

    context: { ...policy fields..., meta: { framework: "codex", framework_version: "0.155.1", guardrail_version: "1.0.34" } }

What to add, smallest version first:

1. **Local audit log**: add `framework=<name>` to the audit line. Self-contained, no schema or spec implications, and
   it answers "which harness did this" on a multi-harness machine. `APORT_HOOK_FRAMEWORK` is already exported by
   `bin/lib/framework-hook-paths.sh`, so both evaluators can read it with no plumbing.
2. **Verify request**: populate `context.meta` from the same variable. Provenance is an assertion by the caller, not
   a verified fact, so document it as self-reported: useful for audit and analytics, and never an authorization
   input. A field the caller controls, used to gate a decision, is a trivially forged capability. Recording it is
   right; trusting it is not.
3. **Persistence**: the hosted side stores what it needs from `meta` alongside the decision it already records. That
   is a storage and analytics question on the API, not a change to the wire format or the decision object.

Because `meta` is additive and optional, an old verifier ignores it and a new one reads it. Nothing has to move in
lockstep, which is the main argument for this shape over a registered field.

## Order of work

1. `framework=` in the local audit line. Self-contained, no spec change, useful on its own.
2. Extract the Request shape and make the contract take it. Pure refactor, the file door keeps working, tests prove
   the rules did not change.
3. Make the repo an explicit field and stop deriving it from the PRD's directory.
4. The issue door: adapter, decision comment, label, issue template, opt-in per repo.
5. Output standards as data, rendered into prompts and checked in the completion gate.
6. `context.meta` provenance: guardrail populates it, hosted side persists what it needs. No spec change.

Steps 1 to 3 are prerequisites for everything after. Step 4 is where the slop problem actually gets addressed, and it
is worth nothing without 2 and 3 being done properly first. Step 1 and step 6 are independent of all of that and can
land on their own.

## Open questions

- Does an issue-sourced run need a PRD file committed to the repository, so the brief is in version control, or is
  the issue itself the durable record? Committing it makes the branch self-describing and matches what the PRD door
  does, at the cost of a file nobody asked for.
- Who may open a door? `trusted_authors` gates review events today. An issue from a stranger is exactly the slop case,
  so the issue door needs its own allowlist, and probably a maintainer label as the trigger rather than issue
  creation itself.
- Should a refused issue be closed, or labelled and left open? Closing is cleaner for the maintainer and harsher for
  the requester.

## The line: specify the outcome, never the method

Asked while this was being written: does all of this still let the agent reason and pick the smartest solution, or
does it degrade its intelligence? The answer has to stay yes, and it is worth writing down as a constraint on the
design rather than a hope.

What Gallivant constrains today, in full. `lib/prompt.mjs` carries exactly four prohibitions and one instruction:

    Do not merge. Do not touch the default branch. Do not open new PRs. Do not force-push.
    Commit with clear messages and push to this branch when done.

Those are blast-radius limits, not design instructions. Everything else the agent is told is an outcome: "implement
every user story so every acceptance criterion holds, and keep the change focused on what the PRD asks". Architecture,
file layout, libraries, algorithms and order of work are entirely the agent's. Acceptance criteria are Given/When/Then
on purpose, because that form states an observable result and cannot express a method.

The same line governs everything proposed in this document:

- **The PRD contract checks the brief's shape, not its content.** It requires a problem statement of some length,
  stories in a form, criteria in a form, at least one Verify command. It has no opinion on what any of them say.
- **Output standards govern the envelope, not the change.** A commit subject length and a PR that links its source
  constrain how work is presented for review. They say nothing about what the work is. This is why imposing a commit
  format on every repository is listed above as deliberately excluded.
- **Evidence must be checkable, not prescribed.** Requiring that evidence point at something real is a different
  demand from requiring a particular test. The first rules out "see tests" as an answer; the second rules out the
  agent's judgement about how to demonstrate the thing.

The failure mode to watch for is a rule that makes a wrong implementation pass and a right one fail. Any rule that
would reject a better-than-expected solution is a bug in the rule. If an agent solves a criterion in a way nobody
anticipated and the gate refuses it, the gate is wrong, not the agent.

There is one honest tension. Requiring a receipt means the agent spends effort documenting its work, and a receipt
denied on a technicality costs a whole fix round. That is a real tax, and it is why the deny codes are written to be
self-correcting and why a receipt-only round does not require a code push. The tax buys the thing the slop problem
needs: a claim on the record that a person can check.

## Per-task passports: already built, and where determinism stops

Asked while this was being written: does Gallivant mint a passport per task, and can the whole path from PRD to
"what MUST be delivered" be deterministic? Yes to the first, and mostly to the second. Verified 2026-09-25.

`taskPassport` in `lib/deliverable.mjs` mints one passport per task. The id is
`ap_gallivant_<sha1(taskId)[0:24]>`, so the same task always produces the same passport and two tasks never share
one. The PRD's acceptance-criteria bullets become the policy's own `acceptance_criteria` limits, one entry per
criterion, ids assigned by position:

    PRD "## Acceptance criteria" bullets
      -> criteriaFromPrd  -> [{ id: "ac-1", description: "Given ... when ... then ..." }, ...]
      -> taskPassport     -> limits["deliverable.task.complete"].acceptance_criteria
      -> POST /api/verify/policy/deliverable.task.complete.v1 with the passport in the body

The hosted route accepts a passport in the request body and evaluates it as sent, which is what lets one hosted
evaluator gate thousands of tasks with different criteria without registering thousands of passports. That is the
scaling answer: the passport is derived, not stored.

Checked by running it: the same task id and criteria produce byte-identical passports across calls, and a different
task id produces a different passport id.

### The three inputs, and which of them can be trusted

The gate's context is built from three sources, and they are not equally trustworthy. This is the part worth being
precise about, because "deterministic from the PRD" is true of the requirement and false of the evidence.

| Context field | Comes from | Trustworthy |
|---|---|---|
| `acceptance_criteria` (the limits) | the PRD, via `criteriaFromPrd` | Yes. Derived from the brief, and the brief is read from the daemon's own snapshot, not the agent-writable checkout |
| `tests_passing` | the daemon's own reading of the check rollup | Yes. The agent's claim is ignored |
| `output_content` | the PR diff, added lines only | Yes. Observed, not asserted |
| `criteria_attestations[].met` and `.evidence` | the agent's receipt in the PR body | **No.** This is the agent grading its own homework |

So the requirement is fully deterministic and the verdict is not. An agent can write `met: true` with
`evidence: "see tests"` for a criterion it never implemented, and every deterministic check passes: the attestation
exists, the evidence string is non-empty, the ids match, CI is green because the feature is absent rather than
broken. The policy catches an agent that is lazy or forgetful. It does not catch one that is wrong or dishonest.

That gap is not closable by a stricter schema, because the missing step is judging whether a criterion actually
holds, which is a semantic question about the diff. What can be narrowed, in rough order of value:

1. **Make evidence checkable rather than free text.** A criterion's evidence should name something the daemon can
   verify exists: a test name that appears in the run's output, a file path that appears in the diff, a CI run id
   that belongs to this head. Reject evidence that points at nothing. This is deterministic and it kills the
   "see tests" class of receipt outright.
2. **Tie criteria to the Verify commands, by the agent's choice rather than the PRD's.** The PRD already lists
   commands that must pass. The agent can name, in its receipt, which command or test demonstrates each criterion,
   and the daemon then checks that the named thing ran and passed on the head being gated. The naming has to come
   from the implementer, not from the brief: a PRD author who pre-assigns a test name per criterion is dictating the
   test layout, and therefore the design. Ask "what proves this" and let the agent answer.
3. **Let the reviewer judge semantics.** The reviewer bot already reads the diff. A receipt claiming a criterion is
   met, on a PR where the reviewer says the feature is missing, is a contradiction the daemon can act on: treat a
   blocking finding as evidence against the attestation it contradicts.

Point 1 is the one to build first, and it belongs in the policy pack rather than in Gallivant, so every consumer of
`deliverable.task.complete.v1` gets it. Gallivant supplies what a local evaluator cannot: it knows the diff, the
check results and the run log, so it can resolve an evidence pointer that the hosted evaluator can only take on
faith. The honest division is that the hosted policy states the requirement and the daemon corroborates the evidence.

## Personas as the semantic check

Asked next: since the attestation is the agent grading its own homework, should Gallivant run personas, a Staff
Engineer reviewer and the like, to close that gap? Yes, and this project is already evidence the pattern works.
`docs/audit/` holds six persona audits of Gallivant's own PRD (staff engineer, security engineer, designer, tech CEO,
open source user, hacker), and they produced the findings that shaped the thing. What follows is how to make that a
feature rather than a one-off.

### They verify, they do not gate deterministically

The important distinction: a persona's verdict is judgement, and judgement belongs in a different slot than a policy
check. Keep the existing division and the tool stays honest.

| Layer | Question | Nature | On failure |
|---|---|---|---|
| PRD contract | Is the brief well formed? | Deterministic, no override | Refuse to start |
| Completion gate | Are the required attestations present with real evidence? | Deterministic | Fix round |
| **Personas** | **Does the work actually hold up?** | **Judgement** | **Fix round, or escalate to a person** |
| Human | Should this ship? | Judgement | Merge |

A persona must not be able to hard-deny forever on taste, because that is how a tool becomes unusable: an infinite
loop of an LLM disliking something. Bound it the way the reviewer is already bounded, by `max_iterations`. A persona
that still objects after the round budget escalates to `needs-human` with its reasoning, which is the correct
resolution for a disagreement about judgement.

### Where they earn their keep

Two distinct jobs, and it is worth not conflating them:

1. **Reviewing the brief, before any work starts.** This is the slop problem at its source, and it is the higher
   value of the two. A PRD or issue that passes the shape contract can still be a bad idea, ambiguous, or missing a
   security consideration that will be obvious in review. Personas at `ready` time catch that for the price of a few
   model calls, before an agent spends an hour implementing the wrong thing. Gallivant's own PRD went through exactly
   this and it worked.
2. **Corroborating the receipt, before ready-for-human.** This is the gap named above. A Staff Engineer persona reads
   the diff and the receipt together and answers one question per criterion: does the diff actually do this? It has
   what the hosted evaluator lacks, namely the diff, the check results and the PRD, so it can catch
   `met: true, evidence: "see tests"` on a criterion with no implementation behind it.

Job 2 is what the user asked about, and it is the one that closes the homework-grading hole. Job 1 is cheaper and
probably prevents more waste.

### Shape

Personas are config, not code, so an operator can add their own without a pull request:

    personas: {
      prd: ["staff-engineer", "security-engineer"],
      receipt: ["staff-engineer"],
      dir: "~/.gallivant/personas"
    }

Each persona is a prompt file plus a required output shape, and the runner is the harness already configured, so no
new dependency and no new provider. The output must be structured, one verdict per criterion with a reason and a
severity, because free-form prose cannot be acted on and cannot be tested. A persona that returns anything else is
ignored and logged, never allowed to block by accident.

The verdict feeds the existing machinery rather than a new path: a blocking persona finding becomes a fix round with
its reasoning quoted, exactly as a reviewer's inline finding does today. That reuse matters, because the round
counting, the nudge, the escalation and the notification all already work.

### Borrowing the vault benchmark's discipline, without its scale

APort Vault's payment benchmark is the reference for how to do this seriously: 4,371 human-authored attacks sorted
into named categories (`json_injection`, authority claims, direct transfer requests), replayed against a fixed target,
with results reported as what they are rather than as a success rate. Two things transfer to code review, and one
deliberately does not.

Transfers:

- **Named categories beat a general request.** The benchmark's value came from `json_injection` being a distinct
  family with its own rate, not from an undifferentiated pile of attacks. "Review this diff" gets a model's average
  opinion. "Does the diff contain an attestation whose evidence names something that does not exist in it" gets an
  answer. Personas should carry a short list of specific failure families to look for, in the way the benchmark
  labelled attacks.
- **Report what the check proves, not more.** The benchmark states plainly that a denial count is not a count of
  blocked conversations or losses prevented. A persona verdict deserves the same care: it is a second reading, and the
  summary handed to a person should say which criteria were examined and on which commit, never "verified".

Does not transfer: **the scale.** 225,964 evaluations is a research artifact. A review loop that runs anything like
that per PR is unusable and expensive. The instruction here is explicitly not to overdo it, so:

- One persona on the receipt by default. Two at most, and only when an operator asks.
- A fixed, small list of failure families per persona, checked in one pass, not an open-ended exploration.
- Scope the read to the added lines and the receipt, which the gate already computes, rather than the whole
  repository.

The benchmark earns its size because it is measuring models. Gallivant is reviewing one diff, and the useful version
is small and repeatable.

### Closing the loop: feedback, fix, re-check

A persona finding is worthless if nothing makes the agent address it and nothing re-checks afterwards. The loop must
close, and the machinery for it already exists, which is the argument for reusing rather than building.

    receipt accepted by the deterministic gate
      -> persona pass over (added lines + receipt + criteria)
      -> findings? -> fix round, findings quoted as feedback, round counted
                       -> agent pushes
                       -> deterministic gate runs again on the new head
                       -> persona pass runs again on the new head   <- the re-check
      -> no findings -> ready-for-human, with what was examined recorded

Four properties this has to have, each of which follows from a bug already fixed in the tick:

1. **Re-check on the new head, never on the old verdict.** The persona pass is keyed to the head commit it read. A
   push invalidates the previous pass, exactly as `checks_sha` invalidates a previous check dispatch. A stale pass
   must never let a later push through.
2. **Round-counted.** A persona fix round is a round. It consumes `max_iterations` like any other, so the loop cannot
   spin, and the escalation path is the existing `needs-human`.
3. **No repeat of an addressed finding.** The same objection restated on an unchanged line is how a loop becomes
   infinite. Findings need identity (persona, criterion, file, line) so a repeat on unchanged code is recognised and
   escalated rather than dispatched again. This is the same replay problem the event cursor solved, and it wants the
   same answer: remember what was dispatched.
4. **Recorded where a person can see it.** The findings and their resolution belong on the PR, not only in the local
   log, for the same reason the PRD verdict belongs on the issue: the next reader needs to know what was checked.

Property 3 is the one most likely to be got wrong, and it is worth stating as a rule: a persona gets one chance to
raise a given finding. If it raises the same finding on code that did not change, the disagreement is between the
persona and the agent, and a person resolves it.

### The costs, stated plainly

- **Money and time.** Every persona is a model call over a diff. Two personas on a receipt for a large PR is real
  spend, and `max_budget_usd` currently bounds a run, not a review. Default to one persona on the receipt and let the
  operator add more.
- **Disagreement with the human.** Two personas will sometimes contradict each other. Do not try to resolve that in
  software; surface both and escalate.
- **The obvious objection.** A model grading a model is not proof. It is a second opinion from something that did not
  write the code and has no stake in defending it, which catches the lazy receipt but not a subtle wrong answer. It
  narrows the gap rather than closing it, and the honest claim is exactly that.

Worth saying because it constrains the design: a persona can only ever be an input to a person's decision. The tool
stops at ready-for-human on purpose, and no number of personas changes who merges.

## Scope decision, 2026-09-25: what Gallivant is and is not

Asked directly: does Gallivant now require a standard-meeting issue before any PR can pass? **No, and it cannot.**
Worth stating plainly because the design above could be misread as claiming otherwise.

Gallivant gates only the work it starts. `reconcile` calls `gh.prListMine` and skips anything that is not on a
`gallivant/*` branch, so a human's pull request, or any PR the daemon did not open, never meets the contract. The PRD
gate is a gate on **its own runs**, not on a repository's inbound contributions.

That makes the honest claim narrow: Gallivant solves slop for the work you delegate to an agent. It does not solve
slop for a repository, and the issue door above would not change that either. An issue door gates requests that go
*through Gallivant*; a stranger opening a PR directly bypasses it completely.

### Where repository-wide enforcement actually belongs

The enforcement point already exists, and it is not this tool. `integrations/github/actions/policy-verify` in
agent-passport runs on inbound pull requests and already computes `files_changed`, `lines_added` and
`structural_findings`, and it already has a hosted policy decision per PR. Anything that must apply to contributions
from people who never installed Gallivant has to live there, in CI, because that is the only place a repository can
insist on something.

The division that falls out:

| Concern | Where it belongs | Why |
|---|---|---|
| Was the delegated brief good enough to start? | Gallivant's PRD contract | Runs before any work, on a machine the operator controls |
| Did the agent deliver what the brief required? | Gallivant's completion gate | Needs the PRD, the diff and the check results together |
| Is this inbound PR acceptable at all? | the repository guard in CI | The only point every contributor passes through |
| Which harness produced this call? | the guardrail's audit log | The hook is the only place that knows |

So the answer to "what else can spring up from the Gallivant work" is: the parts that generalise belong in the guard,
not here. Two candidates, both of which reuse what Gallivant proved rather than duplicating it:

1. **A deliverable check for inbound PRs.** The completion receipt idea does not depend on Gallivant. A PR that claims
   to close an issue could be required to carry a receipt attesting the issue's acceptance criteria, evaluated by the
   same `deliverable.task.complete.v1` policy in CI. That applies to every contributor, agent or human.
2. **Persona review as a reusable action.** The adversarial read described above is not specific to this daemon
   either. It wants the diff, the criteria and a bounded loop, all of which a CI job has.

Neither is in scope now. Recording them because the question was where this leads, and the answer is "into the guard".

### Order of work, revised

Gallivant's first job is to let its operator stop babysitting runs. That is the requirement it was built for, and it
is not finished until the daily loop is dependable. So:

**Now, in the current pull request:** the Request refactor (step A) and the explicit repo field (step B), because they
are internal cleanups that make the existing door correct rather than new surface, plus `context.meta` provenance
(step E) and the run viewer. Nothing here changes what the operator has to do.

**Later, in its own pull request:** the issue door (step C), output standards (step D) and personas. Each is a
feature with its own review surface, and each earns its own discussion. None of them makes the daily loop more
dependable, which is the current bar.

The risk being avoided is real: a tool that grows three new doors before its first door is trustworthy ends up with
nothing trustworthy. Finish the loop, then widen it.
