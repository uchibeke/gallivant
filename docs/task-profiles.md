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
  speaks for terms outside a control word, a prohibition for terms under one
  (control words bind within a statement, across conjunctions). So "do not open
  a pull request" tagged as a `pull_request` action, "merge the PR" tagged with
  a `merge` prohibition, an escalating term the tag leaves out ("open a PR and
  deploy it") and an effect term it leaves out under a control word ("open a
  PR; do not push to main") all keep the screen's own clarification.
- An uncovered reading becomes the deterministic question `q-delivery-<clause>`.
  Preparation pauses with `needs-input`; no readiness decision or implementation
  starts until the owner answers.

Independently of the planner, a deterministic screen looks for delivery
vocabulary in each clause (pull request, merge, deploy, release, publish, push,
commit, branch, approval, review, wait, local-only). Paired quotes and code
spans are masked, so literal examples do not count, except a span that directly
follows a control phrase (`Do not "open a pull request"`), which is the
control's target. Control words bind within a statement: sentence and clause
punctuation ends one, but conjunctions and an introductory colon after the
control ("Do not: open a pull request") do not. The screen grants nothing:

- Escalating terms (merge, deploy, release, approval, wait, local-only) or a
  control word such as "do not", "until" or "unless" next to any delivery term
  raise the same `q-delivery-<clause>` question when the planner left the
  clause untagged.
- Ordinary vocabulary ("Add a PR status badge") becomes a visible assumption in
  the brief and in the review: the clause is treated as product behaviour and
  the profile is unchanged.

The owner's reply to a delivery question is screened like any other clause.
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
them and cannot raise them. Before each call the route bounds input tokens at
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
hang the task lock or buffer without bound.

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
digest covers the complete approved listing at that revision. File contents reach the planner only through
explicitly selected `--context` documents, which are screened for credential
material. If the snapshot cannot be collected safely, the task records
`repositoryContext.status: "unavailable"` with the reason, and nothing is
guessed.

## Historical tasks

Tasks saved before typed profiles existed keep their original interpretation.
Those with a Coordinator delivery contract keep its versioned validation; those
without one keep the workflow default. Inspection labels them `legacy` and they
can still be validated, started, resumed and controlled. A saved profile with an
unsupported version is readable through `inspect` and `list` and can be exported,
but every mutation returns `TASK_PROFILE_UNSUPPORTED` with the remedy "prepare a
new task". Such a record does not pin an idle namespace, so runtime migration
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
