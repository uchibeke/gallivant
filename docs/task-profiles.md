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
Canonical `gh pr create` commands retain `--base`/`-B` and `--repo`/`-R`
arguments under the same comparison, including equals, attached short flags,
quoted values and repeated flags. Title/body values and later commands cannot
supply a target flag. Missing, dynamic or ambiguous target arguments clarify;
matching explicit targets retain the normal PR reading. These arguments never
select or expand the saved target.
Quoted target values stay visible only when attached to a PR target qualifier,
including paired repository/base values and leading qualifiers. Matching quoted
values keep the ordinary PR reading; mismatches retain the exact named target.
Other quoted examples and unrelated prepositional phrases remain product text.
Draft and dry-run PR creation modes (`--draft`/`-d`, `--dry-run`) remain
`pull_request_mode` conflicts: this profile creates a regular review PR. Explicit false boolean flags, title/body argument values,
read-only help for registry commands, product features and literal examples
retain their own meaning. Natural-language requests to create a draft PR also
require clarification; no planner tag can select a different creation mode.
The profile opens exactly one PR. Requests for two or more PRs, separate PRs,
a PR per component, repeated PR creation commands or another PR retain a
`pull_request_count` conflict even if the planner supplies a `pull_request` tag.
Target qualifiers must be attached to the PR instruction, including leading
targets and adjacent repository/base pairs. Separate actions such as "run the
tests on Linux" or "document it in docs/README.md" do not select a PR target.

Independently of the planner, a deterministic screen looks for delivery
vocabulary in each clause (pull request, merge, deploy, release, publish, push,
commit, branch, approval, review, wait, local-only). Paired straight or curly
single/double quotes and code spans are masked as literal examples. Apostrophes
in contractions and possessives do not open quotes. Imperative command spans
such as ``Run `npm publish` `` remain visible, including linked command lists;
product wording such as ``Document how to run `npm publish` `` stays literal.
A span whose
statement carries a control phrase before or after it (`Please do not ever
"open a pull request"`, `"Open a pull request" is forbidden`) is read as
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

Wrapped request and answer lines are screened in the complete source statements
that touch their immutable spans. Source IDs, text and offsets remain unchanged;
context never crosses between the original request and an answer or between
separate answers. Sentence punctuation, blank lines and list-item boundaries
separate controls; paired literal spans retain their context across wrapped
lines. Shared statement windows are cached within each source.

The screen grants nothing:

- Workflow dispatch, enable/disable and existing Actions run rerun/cancel/delete
  are unsupported external mutations, including canonical CLI commands and
  imperative workflow wording. Read-only list/view/watch commands, features and
  literal examples retain their implementation meaning. Command coverage follows
  [workflow commands](https://cli.github.com/manual/gh_workflow) and
  [run commands](https://cli.github.com/manual/gh_run).
- Issue creation, editing, commenting, closing and reopening are unsupported
  external mutations, including passive instructions, quoted issue references,
  GitHub issue URLs and canonical `gh issue` write commands. Related writes
  (deleting, assigning, locking, pinning and transferring issues, or creating
  linked development branches) follow the same rule. They require clarification
  even with an omitted or `pull_request` planner tag; no new profile action or
  prohibition tag is granted. Read-only issue commands, issue templates,
  product features and literal examples retain their implementation meaning.
  Command coverage follows the [GitHub CLI issue commands](https://cli.github.com/manual/gh_issue).
- Package registry administration is also a publication restriction. Write
  subcommands of `npm access` (set/grant/revoke and legacy access/MFA setters),
  `npm owner` (add/remove), and `npm dist-tag` (add/remove) require clarification.
  List/get forms and help remain read-only. The quote-aware command argument
  reader keeps option values and later commands from supplying a write verb.
- Outbound messages (email, Slack, chat and webhook instructions) are unsupported
  external communications. Mutating `curl` calls, including explicit methods,
  data/form/JSON bodies and file uploads, require clarification. Read-only
  GET/HEAD/OPTIONS/TRACE requests and GET query options retain their meaning;
  explicit methods and `--next` transfer boundaries are respected. Configuration
  files or unresolved methods cannot silently choose a write. Header/body option
  values, read-only help, local logging, product features and literal examples
  do not become separate communication instructions. These screens never send
  a message or issue a network request. Authenticated `gh api` writes use the
  same HTTP conflict: explicit mutating methods and implicit POST from
  field/input flags cannot use PR authority. Explicit GET overrides retain query
  semantics, including field values; method, header, payload and output option
  values stay atomic. Unknown modes require clarification. See the
  [GitHub CLI API reference](https://cli.github.com/manual/gh_api).
- Hosted registry names and host destinations use the same publication
  restriction: GitHub Packages/GHCR, GitLab registries, cloud artifact registries
  and explicit registry hosts, including schemes, ports and artifact paths.
  Detection, escalation and registry-removal checks share one destination
  vocabulary. Quoted destinations of mutation instructions remain visible;
  read-only pulls/downloads, feature infinitives and literal examples retain
  their implementation meaning. Host formats follow [GitHub Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
  [Google Artifact Registry](https://docs.cloud.google.com/artifact-registry/docs/docker/names),
  [Amazon ECR](https://docs.aws.amazon.com/AmazonECR/latest/userguide/Registries.html)
  and [Azure Container Registry](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-get-started-portal).
- Removing, deprecating or yanking registry packages retains the existing
  publication conflict. This includes npm unpublish/deprecate, Cargo/RubyGems
  yank and prose such as "remove the package from npm". No registry mutation
  is authorized by PR delivery. Local dependency removal, feature descriptions
  and literal examples keep their implementation meaning. Command semantics
  follow [npm unpublish](https://docs.npmjs.com/cli/v11/commands/npm-unpublish/),
  [npm deprecate](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/) and
  [Cargo yank](https://doc.rust-lang.org/cargo/commands/cargo-yank.html).
- Conversational owner decisions such as "check with me", "ask me" and "get
  my go-ahead" are approval gates, including quoted decision objects. A plain
  "go ahead and open a PR" retains its affirmative reading. Confirmation
  dialogs, product features and literal examples keep their product meaning.
- Object-storage uploads and remote copies using AWS S3 cp/sync or gsutil
  cp/rsync require clarification, as do moves that delete a remote source.
  Prose uploads to S3 and other named object stores use the same restriction.
  Operand direction, quoted option values and separate command boundaries are
  preserved; download-only transfers, listing and unambiguous simulations retain
  their read-only reading. Dynamic operands or unresolved option arity cannot
  prove a download or dry run. See [AWS S3 transfer commands](https://docs.aws.amazon.com/cli/latest/userguide/cli-services-s3-commands.html).
- Imperative infrastructure writes, including Terraform/OpenTofu apply/destroy,
  Helm install/upgrade/rollback/uninstall, kubectl resource mutations and Pulumi
  up/destroy/refresh/import/cancel, retain
  the existing deployment conflict. Plan/template/get commands and unambiguous
  simulation flags (including Pulumi refresh --preview-only) keep their read-only
  reading. Pulumi preview/history/stack output do not request an update.
  Simulation flags cannot be
  borrowed from another command or override a later mutating mode; quoted or
  ambiguous option values keep a clarification. See [Terraform CLI](https://developer.hashicorp.com/terraform/cli/commands),
  [Helm upgrade](https://docs.helm.sh/docs/helm/helm_upgrade/) and
  [kubectl apply](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/)
  and [Pulumi up](https://www.pulumi.com/docs/iac/cli/commands/pulumi_up/).
- Pushing tags, Git notes, all/mirrored refs, deleting remote refs or naming
  another destination ref is a `direct_push` conflict. A base named before
  the remote ("push main to origin", "push the main branch to origin") has the
  same restriction, including literal selected-base names and reversed named
  branch wording. Descriptive task/feature branches retain their ordinary
  reading. A task-branch push such
  as `git push -u origin HEAD` keeps the profile's normal reading. Product
  commands and literal examples retain their feature meaning.
- Closing, reopening, editing, locking or changing the state of an existing
  PR is a `pull_request_lifecycle` conflict, including imperative CLI commands
  and quoted PR objects. The profile creates one new review PR; a planner's
  `pull_request` tag cannot cover an existing-PR mutation or grant it authority.
  Prose reviews, comments, feedback and replies use the same conflict as their
  CLI equivalents; asking to open a new PR "for review" stays creation scope.
- Escalating terms (merge, including landing a PR, patch or change; deploy
  including shipping, rollout, go-live and
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

A missing pinned credential blocks before any model attempt or reservation is
created. Restore the named environment variable and explicitly resume the saved
task; known credential preflight recovery preserves accepted answers, the
original validation feedback and repair count. Only this known model pre-call failure
can rearm: submitted, unsettled or failed provider calls retain their ownership
and spend evidence and cannot purchase a replacement call through resume. Older markerless pre-call failures recover only when all saved calls are successful, settled and consumed with matching text-only receipts.

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
provider calls. Maximum-size timing fixtures use the UTF-8 byte counts of their
complete repeated units and command prefixes/suffixes, with assertions that
inputs fill but never exceed the accepted request allowance. The 50 CPU ms
screening budget is unchanged. Repeated statements share checks only within one
screen; every target-conflict occurrence and whole-request PR count is retained.
No live qualification of generated-PRD quality or actual cost is
recorded here.
