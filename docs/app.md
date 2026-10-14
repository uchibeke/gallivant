# The app and the orchestration boundary

Gallivant has a local browser dashboard, a CLI, and a shared task-delivery API.
They use the same task state and review coordinator. The dashboard shows what is
running, what needs attention and why; you can send a correction or resume an
existing run without finding its terminal session.

For a first run, use [installation](install.md) and [natural-language tasks](tasks.md).
The work can be code, documentation, research or another verifiable repository
artifact. GitHub pull requests remain the delivery surface; arbitrary browser
chores, email delivery and deployments are not separate supported task targets.

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

The current dashboard controls existing registered runs. Prepare new work through
`gallivant task` or `new` → `ready` → `start`. The exported
[task-delivery package](task-delivery.md) lets an authenticated host provide its own
intake UI/MCP surface without implementing another runner. That package is not
evidence that a hosted service or plugin integration is deployed.

## The browser boundary

GET routes read saved state. One `POST /api/run/control` route queues a bounded
operator request under the shared mutation lock; the daemon performs the action.
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
