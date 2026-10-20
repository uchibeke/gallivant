# Typed delivery profiles

New natural-language tasks take delivery permission from one typed profile
that the owner selects when the task is prepared. Request text, answers,
selected documents and model output can describe the implementation and can
raise clarification questions. None of them can add, widen or remove an
external action. This replaces the free-text publication grammar for new
tasks; saved tasks keep the contract they were created with (see
[historical tasks](#historical-tasks)).

```sh
gallivant task "Add CSV export for the widget table. Open one PR for review." \
  --harness claude --delivery pull_request --completion-target delivery_ready --json
```

The profile is saved with the task as:

```json
{"version":1,"action":"pull_request","target":{"kind":"github-pull-request","repository":"acme/widget","base":"main"},"completion":{"condition":"delivery_ready"}}
```

| Field | Values | Meaning |
| --- | --- | --- |
| `action` | `pull_request` | The only supported action: implement on a task branch and open exactly one pull request for human review. `merge` and `deploy` are recognised so a request for them fails closed with a remedy; they need an explicit supported control and authorization that this release does not have. |
| `target` | resolved repository and base | Bound from the checkout and the usual base precedence when the task is created. Never taken from text. |
| `completion.condition` | `delivery_ready`, `integrated` | The same milestone as `--completion-target`. `integrated` keeps watching until someone else merges; it grants no merge authority. |

Omitting `--delivery` selects `pull_request`. The profile is immutable for a
saved request identity; changed retry input returns `TASK_CONFLICT`. The
structured `prepare` operation accepts `delivery: { action, completion }` and
the MCP `task_prepare` schema carries the same field. Capability discovery lists
the supported actions, so clients render those instead of their own list.

## Clauses, mappings and the delivery screen

Every nonblank request line and answer line is an immutable fragment with a
stable identifier and its exact UTF-16 span in the source text. The planner must
map each fragment to generated criteria, to one explicit assumption listed in
the brief, or to a clarification question. Unmapped fragments trigger bounded
repair and can never validate or start.

When a clause asks for, forbids or conditions an external action, the planner
adds a literal reading as a typed `delivery` tag (`pull_request`, `merge`,
`deploy`, `release`, `publish`, `local_only`, `wait_for_approval`, or `restrict`
with the effects it forbids). The service compares that reading with the
profile:

- A covered reading (the profile already does exactly that, or the clause only
  forbids effects the profile never performs) is recorded in the mapping. The
  clause still keeps its implementation content in the criteria. A tag speaks
  only for the terms it names, and only in the right sense: a requested action
  speaks for terms outside a control word or under an affirmative one ("a
  pull request is required"), a prohibition for terms under a negative one
  ("do not", "except", "is not required"); control words bind within a
  statement, across additive conjunctions. Contrast words such as "but" and
  "however" start a new control scope. Both senses are retained when an action
  occurs more than once: "Do not deploy; deploy to production" cannot be covered
  by a prohibition tag. So "do not open
  a pull request" tagged as a `pull_request` action, "merge the PR" tagged with
  a `merge` prohibition, an escalating term the tag leaves out ("open a PR and
  deploy it") and an effect term it leaves out under a control word ("open a
  PR; do not push to main") all keep the screen's own clarification.
- An uncovered reading becomes the deterministic question `q-delivery-<clause>`.
  Preparation pauses with `needs-input`; no readiness decision or implementation
  starts until the owner answers.

New delivery question IDs are at most 64 characters. Longer clause identifiers
use a stable portable digest suffix instead of embedding their full answer
ancestry. Exact source spans and saved question ownership retain that ancestry.
Saved IDs within the 128-character public answer limit remain unchanged. If an
older pending delivery question exceeds that limit, explicitly resume the task
at its current revision: intake creates a bounded replacement and a fresh draft
revision without inference or implementation, preserving the old history and
accepted answers. Answer the replacement ID from the resumed result; readiness
and execution authorization remain unset. Conflicting saved ownership refuses
recovery and requires inspection before retrying.

Explicit PR destinations are also compared with the selected repository and
case-sensitive base, even if the planner supplies only a `pull_request` tag.
Planner tags retain named destinations as `target: { repository, base }`, with
either field optional; malformed targets are rejected and mismatches clarify.
"Open a PR against staging" under a `main` profile, or a PR in another
repository, pauses with a question naming the selected target. Ambiguous
destinations require clarification. Text cannot change the saved target; the
owner must resolve the scope or prepare a new task with the intended selection.

Independently of the planner, a deterministic screen looks for delivery
vocabulary in each clause (pull request, merge, deploy, release, publish, push,
commit, branch, approval, review, wait, local-only). Paired quotes and code
spans are masked, so literal examples do not count, except a span whose
statement carries a control phrase before or after it (`Please do not ever
"open a pull request"`, `"Open a pull request" is forbidden`), which is read as
the control's target; a control word inside another example never counts. Restriction forms such
as "leave the changes uncommitted", "unstaged", "keep all edits in the working
tree" or "unpublished" count as local-only. Control words bind within a statement: sentence and clause
punctuation ends one, but additive conjunctions and an introductory colon after the
control ("Do not: open a pull request") do not.

Terminal directions such as "stop after committing the changes", "stop once
committed" and "once committed, stop" also count as local-only: they withhold
the push and PR required by the profile. They require clarification even when
the planner omits a tag. Feature infinitives and database transaction commits
retain their product interpretation.

The screen grants nothing:

- Escalating terms (merge, deploy including shipping, rollout, go-live and
  "to production" wording, release, wait, local-only, a write aimed
  at the base branch or at skipping the pull request such as "push directly
  to main", "push to <the selected base>" with the profile's actual base name
  or any explicitly direct branch write such as "commit straight to staging",
  publish whenever it appears as a bare verb such as "Publish this package to
  npm", "and publish the package" or "could you publish it", or as a package
  or build submission to a registry or store such as "submit the package to
  npm", "upload the build to the App Store" or "run gem push", rather than as a
  noun modifier such as "a publish button" or a feature infinitive such as
  "a command to publish docs", and approval whenever the statement waits on
  someone's decision such as "wait for my approval", "get sign-off", "once
  approved", "get my consent" or "get my authorization" (also "authorisation"
  and "permission"), rather than a product feature such as "an approval
  workflow", "a consent banner", "authorization middleware", "the approval
  status column" or "a button to approve comments") or a
  control word such as "do not", "until", "unless", "out of scope",
  "exclude", "except", "other than", "but not", "disallowed", "isn't
  allowed", "not permitted", "stop before", "pause before" or an owner
  reservation such
  as "I will open the PR myself", "let me open the PR" or "leave the PR to me"
  next to any delivery
  term
  raise the same `q-delivery-<clause>` question when the planner left the
  clause untagged.
- Dots inside registry and repository names stay in the statement, so
  "Upload the package to hex.pm" and "Submit the package to crates.io" keep
  their publication meaning. Quoted examples and feature infinitives retain
  their product interpretation.
- A review prohibited outright ("do not send this for review", "no code
  review", "reviews are forbidden") conflicts with pull-request delivery, which
  exists to request review, so it keeps its clarification whatever the planner
  tags. A review named as a condition ("do not merge until reviewed") or as
  optional ("a review is not required") does not.
- Ordinary vocabulary ("Add a PR status badge") becomes a visible assumption in
  the brief and in the review: the clause is treated as product behaviour and
  the profile is unchanged.

The owner's reply to a delivery question is screened like any other clause,
and it closes the original conflict only when every fragment of the reply
carries a typed reading the profile covers; an anaphoric reply such as "do it
anyway" gets its own question instead.
That reading must be grounded in the reply's own explicit action or prohibited
effects. Empty `restrict` tags and invented actions or prohibitions cannot close
a delivery question. Restate the intended action (for example, "Open a pull
request for review; do not merge") or explicitly name the prohibited effects.
A reply that the planner reads as asking for an uncovered action, or that
carries escalating vocabulary the planner leaves untagged, raises the same
question for the reply itself. A reply that restates a prohibition the profile
already honours ("no deployment by this task") maps to criteria once the planner
tags it as a covered `restrict` reading; insisting on an uncovered action
cannot expand the profile. Prepare a new task with a different typed profile
instead.

## The review

Every prepared revision returns one `review` object, pinned by `revision` and a
`digest` over the immutable request, fragments, answers, profile, harness,
route, draft hash, selected sources, repository snapshot and allowance:

- `request`: the original text, its hash and `immutable: true`.
- `requirementMap`: for each fragment, its source span, target (criteria,
  assumption or question), any clarification, delivery tag, coverage, screen
  result and conflict reason.
- `questions`, `assumptions` (planner assumptions plus screen assumptions) and
  `draft` (path, hash, revision, text).
- `deliveryProfile`, `harness`, `allowance`, `modelRoute` and `cost`.
- `repositoryContext`, `readiness` and `approval`.

`task start --run` on the current revision records `approval` with that digest.
Answers clear readiness and approval, so a changed material input requires a
new review before the existing run path is callable. For typed tasks this also
revokes a `--run` given at preparation: that consent covered the revision the
owner saw, so an answered intake returns `ready` and needs its own
`task start --run`. Tasks saved before typed profiles keep their documented
persisted authorization. A saved approval whose
digest no longer matches returns `TASK_CONFLICT` instead of dispatching. The
approved profile and approval travel into the implementation entry and are
checked again on reconciliation, so retries resume the same dispatch rather than
creating another.

The CLI prints the profile, planner route, cost status, repository snapshot
status and review summary; `--json` returns the complete object. The delivery
dispatcher and MCP views expose the same fields, and the bounded model summary
carries the profile action, completion, review revision and approval state.

## Planner routes

| Route | When | Boundary |
| --- | --- | --- |
| `harness` | The selected harness declares a preparation boundary (Claude, Codex, OpenAI Agents) | Existing dispatch, session controls and usage recording. Cost is provider-reported or labelled unknown, never zero. |
| `model` | `intake_model` is configured and its credential is exported | One bounded text request per planning turn against the configured endpoint, with no tools, shell, web or repository access. |

Without `--route`, a harness with a preparation boundary is used; otherwise the
model route when it is enabled; otherwise the existing
`TASK_PREPARATION_BOUNDARY` refusal. `--route model` on a disabled route returns
`TASK_MODEL_ROUTE` with the configuration remedy before any effect. The task's
`harness` still names the implementation adapter in the brief's frontmatter.

### Configuring the model route

```json
"intake_model": {
  "adapter": "openai-chat",
  "model": "gpt-5-mini",
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "credential_env": "OPENAI_API_KEY",
  "budget": { "max_calls": 3, "max_input_tokens": 50000, "max_output_tokens": 6000,
              "allowance_usd": 0.10, "input_usd_per_million": 0.25, "output_usd_per_million": 2 },
  "timeout_ms": 60000
}
```

`adapter` is `openai-chat` or `anthropic-messages`. The endpoint must be a
public HTTPS URL without credentials. The API key is read from the named
environment variable at call time and is never written to disk or returned by
any view. Ceilings are absolute: at most three calls per task, 50,000 input and
6,000 output tokens per call, and a $0.10 allowance. Configuration can lower
them and cannot raise them. The task's runtime allowance bounds each call too:
the deadline is capped to the remaining runtime, and less than one second
remaining refuses before the request. Before each call the route bounds input tokens at
one token per UTF-8 byte of the complete serialized request (system message,
prompt and framing fields, plus a fixed margin for protocol tokens), the
byte-level fallback worst case, so emoji and rare scripts cannot slip under the
ceiling. It prices that bound plus
the output limit at the configured list prices, and refuses to start the call
when the result does not fit the remaining allowance. Reported usage above
either ceiling rejects the draft after the call, and usage that is negative,
fractional or non-numeric is treated as a malformed response rather than a
spend record. The response body is read under the same deadline as the request
and cancelled at one megabyte, so a stalled or oversized provider reply cannot
hang the task lock or buffer without bound. Cancelling a body, including an
error response's body, is awaited only until that deadline.

A task pins the complete route selection (adapter, model, endpoint, budget,
timeout and the credential variable name) when it is created. Later turns,
including answers and repairs, run against that pinned selection and the
review digest covers it, so changing or removing `intake_model` affects new
tasks only. The credential itself is still read from the environment on every
call; if the named variable is missing the turn stops with the export remedy. Reported usage replaces and releases the reservation, so the
implementation allowance that follows subtracts the reported spend rather than
the ceiling held during the call; missing usage leaves the reservation as the
spend bound with `spend.status: "unknown"`. These are
estimates from list prices, not provider invoices. Truncated, over-limit,
malformed or empty responses are rejected with a bounded error and count as a
call.

## Repository context

Preparation collects a read-only snapshot of the selected checkout: the HEAD
revision and the path listing of that commit's tree, with ignored and private
paths removed (`.env`, credential, key and agent-configuration locations). The
checkout's in-tree `.gitignore` files decide ignores (local and global exclude
files do not), and they must match the recorded revision: an edited or
untracked `.gitignore` makes the snapshot unavailable with the files named,
instead of evaluating rules the recorded tree does not contain. A tree path the
index no longer holds (a staged deletion) is excluded as unverified and a
staged addition is never listed; the listing therefore always describes the
recorded revision. It is bounded to 400 paths and 16 KiB in the prompt; its
digest covers the complete approved listing at that revision. The revision,
the index and the ignore files are rechecked after the listings are read, so a concurrent
edit between the reads makes the snapshot unavailable instead of pairing the
recorded revision with another state. File contents reach the planner only through
explicitly selected `--context` documents, which are screened for credential
material. If the snapshot cannot be collected safely, the task records
`repositoryContext.status: "unavailable"` with the reason, and nothing is
guessed.

## Historical tasks

Tasks saved before typed profiles existed keep their original interpretation.
Those with a Coordinator delivery contract keep its versioned validation; those
without one keep the workflow default. Inspection labels them `legacy` and they
can still be validated, started, resumed and controlled. A saved profile with an
unsupported version, or whose target repository, base or completion does not
match the task it is saved on, is readable through `inspect` and `list` and can
be exported, but every mutation returns `TASK_PROFILE_UNSUPPORTED` with the
remedy "prepare a new task". A record created with a typed profile (it carries
a planner route, a repository snapshot or a pinned model route) whose profile
is missing is treated the same way, never as a historical task. Such a record does not pin an idle namespace, so runtime migration
proceeds. New tasks always use the current typed profile; there is no fallback
to the free-text contract.

## Agent Passport packaging

`lib/task_profile.mjs` is self-contained (no imports at all, so the vendored copy
loads alone and its hash covers every rule it applies) and is the file Agent
Passport vendors. Its copy of the completion conditions is checked against the
coordinator schema by the focused suite. `templates/plugin/task-intake-contract.json` pins its exact
bytes, the fixture corpus at `templates/plugin/task-profile-requests.mjs` and the
profile schema version. Both pinned files ship in the published package, so a
consumer can run the exact promised corpus. `npm run lint` fails when the pin is
stale; `npm run contract:intake -- --write` refreshes it after a reviewed change.
The plugin builder refuses to package when either packed file differs from the
pin and records `intakeContract` in `runtime.json`. The
downstream `task-intake-vendor-sync` work in `aporthq/agent-passport` must pin
the published package, regenerate its bundled validator from these bytes and
run the same corpus before either repository's change is approved.

## Verification

```sh
npm test
npm run lint
npm run test:task-intake
git diff --check
```

The focused suite covers the request corpus (direct, indirect, quoted,
contradictory, adversarial and ordinary feature wording), per-clause
traceability, typed-profile authorization, review invalidation, retry and
idempotency, historical fixtures, model-route call, token and allowance
boundaries, repository snapshots and a bounded-input timing check. It makes no
provider calls. No live qualification of generated-PRD quality or actual cost is
recorded here.
