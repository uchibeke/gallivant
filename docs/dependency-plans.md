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

`plan inspect NAME` shows the immutable approval and separate runtime and
control generations. Future anchors require current read, observe and link
grants for both sides. Cross-company links require an additional scoped grant.
An anchor freezes the producer's instance and terminal or exact task nodes
before any PR exists. Later production activity fills in observed identities.
Appending work beyond the frozen nodes leaves their scope unchanged. Changes
to their approved contracts require review.

Admitted graphs reserve tasks in observation-only mode. A graph task remains
ineligible for dispatch even after all its dependencies integrate. Existing
linear chains and `--after` keep their current execution owner. Their saved
descriptions compile with `compileLinearChain` from the `dependency-plans`
package export. [PRD chains](chains.md)

The standalone CLI can validate manifests and resolve previews without saved
producer links. The supplied local author launch does not qualify an operator
ingress for graph queue, inspection, migration or future links. A deployment
must enclose the exact worker launch outside protected state and controls and
bind its authenticated operator through the coordinator's authority port.
[Configuration and feature gates](config.md#dependency-plan-admission)
