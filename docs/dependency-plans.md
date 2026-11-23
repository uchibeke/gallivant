# Declarative dependency plans

`plan validate` compiles a local JSON or restricted YAML manifest into a finite
graph. It works before configuring a host, an execution route or a state
directory. The CLI prints counts and digests by default. Pass `--json` for the
graph and its source manifest.

From the source checkout, compile either synthetic example.

```sh
gallivant plan validate synthetic.json --dir templates/dependency-plan --json
gallivant plan validate synthetic.yaml --dir templates/dependency-plan --json
```

Both examples are also in the installed package's `templates/dependency-plan`
directory. Use that directory as `--dir` when running from an installation.
The examples use a terminal anchor, a parallel group loaded from a local
fragment, and a qualification task with two prerequisites.
[JSON example](../templates/dependency-plan/synthetic.json) ·
[YAML example](../templates/dependency-plan/synthetic.yaml) ·
[Group fragment](../templates/dependency-plan/fragments/console.yaml)

## Version 1 grammar

A manifest has four fields.

| Field | Value |
| --- | --- |
| `version` | The number `1` |
| `name` | An ID |
| `repositories` | A map from alias IDs to objects with `repository`, `checkout` and `base`. `repository` uses `owner/name` for GitHub or `host/owner/name` for an explicit host. `base` is a Git branch name. |
| `nodes` | A nonempty list of nodes. Place ordered work in a sequence group or declare dependencies with `needs`. |

| Node type | Fields beyond `id` and `type` |
| --- | --- |
| `task` | `repository` names an alias. `prd` is the path to a brief declaring `status: ready`. Optional `needs` lists prerequisites. |
| `group` | `mode` is `sequence` or `parallel`. Supply exactly one of nonempty `children` or `file`. A fragment file has only `version: 1` and a nonempty `children` list using the same node grammar. Optional `needs` lists prerequisites. |
| `anchor` | `target` is either `{ plan: producer-id, boundary: terminal }` or `{ plan: producer-id, node: group/task }`. Validation returns the requested target with `resolution: unresolved`. |

IDs use 1 to 80 lowercase ASCII letters, digits and single separating dashes.
Sibling IDs must be unique. A nested node has a qualified ID such as
`checks/unit`. A bare `needs` ID selects a sibling. A qualified ID selects a node
from the root, with an optional leading slash. Use `/setup` to select a top-level
node from inside a group.

Each group computes entries and exits from edges within the group. Referencing
a group uses every exit, and a dependency on a group applies to every entry.
Sequence adds edges from each child's exits to the next child's entries.
Parallel leaves those edges to explicit dependencies. All incoming edges are
required. The graph shows task and anchor leaves, the normalized edges, root
entries and exits, and the authored display hierarchy. The dependency condition
is `integrated`.

The schema rejects unknown fields and versions, empty lists of nodes or children,
plans with only anchors, unresolved local references, duplicate canonical task
identities and cycles. A task's identity uses the canonical repository and the
PRD filename stem, matching existing task IDs. The same task in two groups, on
different bases or through two aliases still has one identity.

## Local input and limits

`--dir` selects the approved local root and defaults to the current directory.
A relative manifest path starts there. A fragment path starts in the directory
of the file that names it. Repository checkout `.` uses the approved root.
For a checkout below that root, pass an explicit `--checkout` with its relative
directory. Repeat the flag for each approved subdirectory. Briefs and their
`sources` paths start at the corresponding checkout. Every path must stay
within the approved root, use regular files and avoid links. Path operands in
the manifest are literal relative paths. Traversal segments, globs, remote
paths and environment or shell interpolation are rejected.

JSON uses strict JSON syntax. YAML accepts a single document with ordinary
mappings, sequences and scalars. Both reject duplicate keys, prototype keys and
merge keys. YAML also rejects explicit tags, anchors, aliases, directives and
explicit mapping keys.

| Limit | Maximum |
| --- | --- |
| Exact input per file | 1 MiB |
| Total exact input | 8 MiB across the manifest, fragments, briefs and carried sources |
| Source closure | 32 distinct files |
| Nesting | 32 node levels and 32 files on an include path |
| Expanded nodes | 1,000, including groups and anchors |
| Distinct edges | 10,000 |
| Work | 200,000 syntax tokens, 10,000 declared needs references and 100,000 expanded edge attempts |
| Paths and output | 512 bytes per path and 4 MiB for the compact JSON preview |

An over-limit input fails with a diagnostic. Source bodies stay out of the
preview.

## Comparison data and authority

`graphDigest` identifies the normalized graph and display hierarchy. Equivalent
JSON and YAML yield the same digest. `approvalDigest` also covers the exact
source bytes and relative paths. A formatting edit can preserve the first
digest and change the second. The exported compiler returns `admission: unbound`.
The digest function can also bind the hash of a later admission record, including
verified repository identities, base pins and resolved targets.

Structural validation checks local inputs and reports declared repository
identities, bases and anchor targets.

## Resolved preview and admission

`plan preview FILE --json` verifies the Git checkout against the host's repository
identity and reads the intended branch and base-file bytes. It runs the normal
ready-brief checks against the captured source closure and reports file hashes,
configured routes, review requirements, policy limits and applicable controls.
The report omits source contents, absolute checkout paths and credentials. A
configured route can still report unverified model access. The preview performs
bounded reads and leaves the registry and host unchanged.

Use the same file and checkout options for `plan queue FILE --approve DIGEST`.
Without `--approve`, queue returns the preview. A qualified operator ingress
checks the exact proposal and saves the approval, snapshots, ownership and
request receipt together. Supply `--request-id ID` to name the request. When
omitted, the approved digest is the request ID. Repeat the same digest and
request ID after a lost response to retrieve the saved result.

## Review and confirm plan controls

Review a plan or group action with a new request ID and repeat the command
with `--approve` set to the returned `revision`. After a lost confirmation
response, repeat the same confirmation to retrieve its stored result. A stale
review requires a new review against the current plan.

```sh
gallivant plan hold console-follow-through --group console --request-id hold-console
gallivant plan hold console-follow-through --group console --request-id hold-console --approve REVISION
gallivant plan retry console-follow-through --node console/plan-view --request-id retry-plan-view
gallivant plan edit console-follow-through revised.yml --request-id revise-console
gallivant plan attach console-follow-through linked.yml --request-id attach-producer
```

| Action | Scope and review gate |
| --- | --- |
| Queue | Approves the exact manifest, sources, repository bindings and policy. Use a new name and separately approved task identities for a new plan instance. |
| Attach | Reviews a replacement manifest that adds a producer link to an existing plan. Both scopes require current read, observe and link grants. Cross-tenant links also require a scoped cross-company grant. |
| Hold / unhold | Sets or clears the selected plan or group's dispatch hold. Enclosing holds and task, repository and recovery holds continue to apply. Releasing a hold makes eligible future work available for scheduling. |
| Cancel | Permanently fences future dispatch in the selected plan or group, including starts that have yet to be submitted. Existing accepted tasks retain their task controls and can still close out. Dependent work waits for qualified integration. |
| Retry | Rearms a blocked node under its approved inputs. Retrying a provably unsubmitted start requires the original clone and execution identity. Use task Resume or Recheck for admitted work. Reconcile ambiguous acceptance and inspect partial or replaced clones through their original owners. |
| Edit | Reviews changed inputs or dependencies for undispatched, unreserved work. The response includes old and new hashes for the graph, source files and affected dependency closure. Existing links, frozen producer contracts, active work and policy limits constrain the proposed changes. |

Use a qualified operator ingress for these commands. The protected service is
`planControl`. Its HTTP adapter uses `POST /api/plan/control` with the same
loopback, Host, Origin, CSRF, JSON size and mutation checks as existing controls.
Send `action`, `stage` (`review` or `confirm`), `requestId` and `plan` for
actions on an existing instance. Supply `group` or `node` for a scoped action,
`file` for queue, attach or edit, and `approve` for confirmation. Manifest
paths are relative to the deployment's `planInputs.directory` and its approved
checkouts. An authenticated tracker host supplies `planOperatorForRequest(req)`
with the bound current operator for that request. The legacy tracker pages
remain within the host's operator-only boundary. A request for an admitted
graph task uses its existing run control endpoint and a scoped
`task/message`, `task/resume`, `task/recheck` or `task/cancel` grant.
In an authenticated mount, legacy mutations use the local operator's
corresponding `task/*` or `chain/*` grant.

The browser adapter uses a `manifest` object with `format` (`json` or `yaml`)
and exact UTF-8 `text` in place of `file`. The server resolves references
through `planInputs.bindings`. This transport uses an allowlisted review view.
Send `stage: "reconcile"` with the original command identity and `approve`
to read the saved receipt after an uncertain response. This stage never
recompiles or applies a control. [Plan workspace and bindings](ui-plans.md)

`GET /api/plan` lists authorized plans or inspects one with `?plan=NAME`.
It reads the saved registry. Queue, edit and attach reviews read local inputs
and host bindings through explicit requests. Unknown provider acceptance,
unqualified routes, unresolved Git ownership and upstream approval changes
remain inspect-only until their existing owners resolve the gate. The
standalone installation can compile manifests and resolve previews. Graph
mutations require the protected ingress described in [configuration](config.md#dependency-plan-admission).

`plan inspect NAME` shows the immutable approval and separate runtime and
control generations. Future anchors require current read, observe and link
grants for both sides. Cross-company links require an additional scoped grant.
An anchor freezes the producer's instance and terminal or exact task nodes
before any PR exists. Later production activity fills in observed identities.
Appending work beyond the frozen nodes leaves their scope unchanged. Changes
to their approved contracts require review.

## Dispatch and integration

A parallel group requests eligibility for its independent branches. The
coordinator admits each ready leaf against the current author, preparation,
per-plan and per-repository limits. It also applies the graph ceilings recorded
in the approval to initial starts and author continuations, including fix
rounds. A diamond with one available author slot can run its second
branch while the first awaits review or merge. The join waits for both exact
integration receipts. The reviewer and result-collection lanes remain
available while author capacity is full.

The task's ordinary review, checks, completion and closeout supply the
receipt. It identifies the producer's original start, host repository, PR,
approved base and merge commit. A retained workspace counts as settled
cleanup. A closed-unmerged PR, a missing required verification decision or
an author still running keeps the dependency gated. Integration remains a
maintainer action.

Concurrent branches in one repository use distinct clones and branches.
Overlapping changes can still conflict. The normal base repair and current-head
review apply after an earlier branch lands. A descendant clone must contain
the required same-repository merges. For a dependency across repositories, the
coordinator verifies the producer's receipt on its own host and approved base.
That edge grants ordering only. The consumer receives its own snapshots and
scoped credentials.

Each dispatch rechecks the producer PR and current base ancestry. If a base
moves but still contains the merge, the receipt can still qualify. A force-push
that drops the merge fences undispatched consumers. New dispatch needs a
supported adapter with immutable repository identity and merge proof. Hosted
routes also need their existing repository, execution and result bindings.
Native and live combinations require independent qualification for the exact
runtime, host, launch and owner routes. [Dependency delivery qualification](dependency-plan-qualification.md)

An author slot covers preparation and remains reserved through any ambiguous
submission. Confirmed process cessation and result collection release it
while merge, review, publication or cost reconciliation can still be pending.
An admitted graph task keeps its approved round limit, per-run budget and
repository timeout across fixes, resumes and coordinator restarts. Hosted
continuations use the approved execution route and its provider allowance.
Hosted reservations remain in the execution ledger and unknown usage remains
charged against the allowance. Native currency enforcement depends on the
provider. An estimate or an author slot does not impose a dollar cap across
parallel tasks.

The default graph ceilings are zero. A protected deployment can approve
positive limits for new plans. Earlier observation-only approvals stay
observation-only. Linear chains and `--after` keep their command behavior.
Their saved descriptions compile to the same dependency graph for selection
and use the shared start and completion owners. [PRD chains](chains.md)

The standalone CLI can validate manifests and resolve previews without saved
producer links. The supplied local author launch does not qualify an operator
ingress for graph queue, inspection, migration or future links. A deployment
must enclose the exact worker launch outside protected state and controls and
bind its authenticated operator through the coordinator's authority port.
[Configuration and feature gates](config.md#dependency-plan-admission)

## References and rollback

The registry keeps approved source bytes while a plan needs them, with exact
approval hashes and integration receipts retained after settlement. Cleanup
protects eligible dispatch inputs, unresolved starts and active task
references. A downstream anchor retains the original producer contract and
receipt. It can verify that receipt after the producer's workspace is removed.
A retained workspace satisfies cleanup settlement when its merge and delivery
evidence qualify. Historical review archives remain available for explicit
inspection and verified backups.

### Rollout and rollback

1. Compile local examples and intended manifests with `plan validate`.
2. Resolve read-only previews and verify saved Plans and Tasks projections with
   graph limits at zero. The protected `plan migration` checkpoint preserves
   legacy approvals, pending starts and evidence under their original owners.
3. After verifying the exact host, route and isolation evidence, admit the
   protected deployment and set positive graph ceilings for explicitly reviewed
   plans. Older observation-only approvals keep their original limits.
4. Enable authoring and reviewed UI controls through the authenticated mount's
   operator and input bindings. Withdraw those bindings to remove UI authoring.

Set both graph ceilings to zero to disable new graph reservations. The existing
coordinator continues collecting accepted runs, settling task cancellations and
closing merged work. Use `recovery drain` to inspect outstanding graph plans,
claims, reservations and task obligations. Complete or cancel future dispatch
and reconcile unresolved starts under the compatible runtime before switching
artifacts. Back up the full private namespace and its matching runtime manifest.
Registry format 6 preserves scoped controls and compact references. For an
incompatible rollback, keep that namespace and restore a coherent backup with
its matching artifact in a separate location. Linear chains retain their
existing execution owner and deep links.
