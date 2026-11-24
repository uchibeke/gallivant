# The app and the orchestration boundary

Gallivant has a local browser dashboard, a CLI, and a shared task-delivery API.
They use the same task state and review coordinator. The dashboard shows what is
running, what needs attention and why; you can send a correction or resume an
existing run without finding its terminal session.

For a first run, use [installation](install.md) and [natural-language tasks](tasks.md).
The work can be code, documentation, research or another verifiable repository
artifact. GitHub and Bitbucket Cloud pull requests are the delivery surface,
subject to the selected host and route gates. Integration stays with the
authorized maintainer.

## Start the dashboard

```sh
gallivant start
```

This ensures the daemon and dashboard are running, then opens the browser at
`http://127.0.0.1:8791`. `gallivant serve` uses the same startup path. Pass
`--no-open` to keep it in the background, `--no-server` to omit the dashboard,
or `--no-daemon` when you manage the coordinator separately. See
[commands](commands.md) for port selection, foreground mode and service ownership.
The dashboard is a local control surface, not a publicly exposed server.

## Work with an existing run

The dashboard and run sidebar share the CLI's status model. A run page shows
its current state, stop reason, PR link, session history and streamed logs.
History can be loaded without redispatching work. Provider capabilities, saved
execution state and artifact summaries are exposed through the same tracker;
reading a page does not poll a provider or incur inference.

Run actions have different effects:

| Action | Effect |
| --- | --- |
| Recheck PR | Ask the coordinator to refresh GitHub checks/review state and apply its normal readiness rules. |
| Resume agent | Continue the existing task on its current approved instructions. |
| Message agent | Send an operator correction to the existing session, including after a PR is ready for review. |
| Cancel task | Request cancellation through the shared provider-aware control path. |

The message composer is separate from the fixed actions. Normally a message waits
for active work to settle. Local providers with interrupt support offer an explicit
interrupt option; hosted providers expose only the controls they implement.
Requests are queued, and the daemon must be running to apply them. Messages keep
the brief, permissions and consumed budget; they do not authorize a new scope,
merge or deployment. Changing the delivery contract requires the explicit
resnapshot flow. Closed or merged PRs require a new task.

Use **New task** on the overview for [guided preparation](task-intake-ui.md),
or use `gallivant task` or `new` → `ready` → `start`. Preparation may incur
inference charges; the review screen requires an explicit Start of the saved
revision. Coding, documentation and research share the same repository delivery
and readiness gates. The exported
[task-delivery package](task-delivery.md) lets an authenticated host provide its own
intake UI/MCP surface without implementing another runner. That package is not
evidence that a hosted service or plugin integration is deployed.

## The browser boundary

GET routes read saved state. `POST /api/run/control` queues a bounded
operator request under the shared mutation lock; the daemon performs the action.
Intake and chain recovery use their own thin protected adapters to the existing
task and chain services, with revision and operation identity checks.
The POST requires a loopback peer, a loopback Host with the actual serving port,
an exact same-origin header and the server's CSRF token. Remote readers receive
no control token. There is no arbitrary shell command route.

These checks resist cross-origin requests and DNS rebinding; they are not
multi-user authentication or isolation from another process running as the same
OS user. Keep the standalone tracker on loopback. A server mounting the tracker
owns its authentication and bind address. Do not expose it through an unauthenticated
proxy. CSP, HTML escaping and text-only log insertion protect rendering of
repository, reviewer and agent-controlled text.

`mount(ctx, {base})` lets an existing dashboard, including Command Center, delegate
a path prefix. The tracker provides SSE logs with a bounded initial tail,
`Last-Event-ID` continuation and explicit history gaps. The CLI, standalone UI and
mounted UI retain one coordinator and one set of run identities.

**Overview** (`/`) starts with decisions and upcoming work. **Plans** (`/plans`)
shows admitted graphs and linear chains with exact saved prerequisites. It
includes a bounded dependency diagram, guided authoring and scoped plan reviews
through the protected service. [Plan workspace](ui-plans.md)

**Tasks**
(`/tasks`) filters registered delivery, intake and future work by outcome.
Future nodes link to their plan until task registration. **System** (`/system`)
shows coordinator and supervisor observations, service cooldown deadlines,
capacity, bytes and inodes of storage headroom, and retained cleanup. The
active author count includes slots reserved before task registration. Protected
views show authorized task counts and approved route cooldowns. Local operator
views show installation-wide observations.
See the [console feature matrix](ui-feature-matrix.md) for current controls and
the operator paths for qualified or CLI-only features.

Task workspace links (`/run?id=…`), pinned attempts (`&run=…`), run history
(`/runs`), linear chain links (`/chains`), intake (`/task/new`) and health
(`/health`) retain their URLs. Command Center keeps its back link.
A host mounting at `/gallivant` serves the same paths, assets and APIs under
that prefix. Theme, filters, plan and node selection and history links remain
shareable. Ctrl/⌘ K opens navigation, `/` focuses the current search and Escape
closes dialogs.

In a mounted task, for example `/gallivant/run?id=acme%2Fatlas%2Fsearch-index`,
**View PRD** uses the same packaged viewer and read service as standalone.
The copy link carries the selected task or plan, file revision and view.
The tracker rechecks current access on every file read. Keep the existing
host authorization in front of the entire mount prefix, including
`/gallivant/api/artifact`. The host continues serving its own file views.

The loopback console shows local legacy work. Graph work needs authenticated
`planOperatorForRequest` ingress and current protected read scope. An anchor
needs both scopes and the original read, observe and link grants. Cross-company
anchors also require the scoped cross-company grant. When a mount configures
this ingress, local intake and flat external histories remain on their original
local or authorized service surfaces.

### Plan approval links and tool hosts

The standalone and mounted Plans views open `/plans?approval=REQUEST_ID` using
the current authenticated operator. A copied URL contains the request locator.
Keep host authentication in front of the full mount, including
`GET /api/plan/approval`, `GET /api/artifact` and `POST /api/plan/control`.

A trusted operator tool host can resolve one request with
`GET /api/plan/approval?approval=REQUEST_ID`, show the revision and scope, and
record explicit operator confirmation for `approve-plan` and that exact
request and revision. In the process that owns the authenticated ingress,
call `recordPlanApprovalConsent(scopedContext, requestId, revision)` from
`lib/dependency_plan_admission.mjs` after verifying the host's confirmation
event. The scoped context uses the request's current bound `planAuthority`.
Keep the returned capability in the host process. It expires within two
minutes, sooner if the operator proof or request expires.

The host can submit this JSON to the existing loopback control endpoint using
the standard session, Origin and CSRF checks. Bind
`planApprovalConsentForRequest(req, intent)` in the server context so it can
return the opaque capability for a verified host action. The intent contains
`action: "approve-plan"`, `requestId` and `revision`. An in-process tool
adapter can call `planControl(scopedContext, command, { consent, base })` with
the same command and the mount prefix it serves.

```json
{
  "action": "queue",
  "stage": "approve-tool",
  "requestId": "REQUEST_ID",
  "approve": "REVISION"
}
```

The host returns the receipt and view URL to the assistant. The HTTP payload,
CLI arguments and conversation can identify the requested action. The host's
authenticated confirmation event supplies consent. Generic shell, MCP and
chat sessions need that host integration to submit approval. Without it, send
the operator to the browser approval link.

### Workspace connection

Connection failures retain the last snapshot with stale/disconnected feedback.
Observation age is separate from the page refresh time and saved productive
activity. Refresh successfully after a disconnection before confirming a plan or chain
control.
Use the shown refresh action after repairing access. Keep an uncertain request's
saved identity and check its status; submitting a new task is not a retry.
Applied controls confirm coordinator application, not model acknowledgement or
completion. See [task controls](ui-task-controls.md) and
[qualification and real captures](ui-qualification.md). The dependency aggregate
includes both the served plan and task workspace suites. Its native and live
matrix tracks the separate proofs needed for operational routes.
[Dependency delivery qualification](dependency-plan-qualification.md)

## Local and hosted harnesses

Five local CLI adapters and OpenAI Agents API are implemented. Claude, Codex and
Agents API also have bounded natural-language preparation. Codex Cloud has a
transport but new dispatch is unavailable until the chosen environment can be
verified against the intended repository. [Configuration](config.md#execution-providers)
and the provider guides distinguish implemented capability, account access and
live qualification.

A hosted harness moves implementation compute off the device; it does not move
Gallivant's coordinator, GitHub publication or local verification. If this machine
sleeps, orchestration waits for it to return. Running the coordinator on a Node
host you operate requires its durable state and appropriate verification isolation.
Gallivant does not currently sell or provision that host for you.

Provider credentials and models belong to the selected harness/provider setup.
A subscription, API key or dashboard connection is not automatically usable by a
different transport. Costs depend on provider pricing, caching, task duration and
review rounds; Gallivant does not promise that API use is cheaper than a subscription.
See [execution](execution.md) for cost visibility and limits.

## Product decisions and future work

Gallivant owns the delivery contract, session ownership, retry bounds, review
feedback and completion evidence. Harnesses own tool execution and context
management. Adding a provider extends that boundary; it does not add a second
agent loop. Thin CLI adapters and durable hosted transports share the same review
state machine even though their execution details differ.

Earlier product exploration proposed a native desktop wrapper, managed hosting,
per-round harness routing and bundled provider plans. These remain possible
future directions, not capabilities enabled by this release. A desktop shell
would add conveniences such as an application icon; the browser dashboard already
provides run controls. Any future routing must preserve explicit provider consent,
authority, continuity and budget ownership rather than silently switching a run.
