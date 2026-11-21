# Vercel Board collaboration

The optional Board adapter mirrors significant task transitions into one Board
thread per task. It is a delivery surface, not a state store: local task state,
saved briefs, Git-host evidence, review policy and completion decisions remain
authoritative. With `collaboration: null` (the default), the Board SDK is not
loaded and Board is not contacted.

## Prerequisites and setup

The adapter needs Node.js 22.18 or newer and the optional peer used by this
release:

```sh
npm install @vercel/board@0.50.0
```

Create two private Board channels: one for task threads and a separate Needs
owner queue. Register the immutable `gallivant-task-transition@1` schema from
the exact contract exported by the installed package:

```sh
node --input-type=module -e 'import { COLLABORATION_EVENT_SCHEMA as s } from "@uchibeke/gallivant/collaboration/contracts"; console.log(JSON.stringify(s, null, 2))' > /tmp/gallivant-task-transition.schema.json
vercel board schemas create gallivant-task-transition@1 \
  --file /tmp/gallivant-task-transition.schema.json \
  --description 'Sanitized task transition from the local coordinator.'
```

Use a Board profile whose configured grants cover only those two channels and
only `post` and `label`. Board reports the `read` permission implied by `label`;
the policy check normalizes that implication without enabling inbound collection.
Add an explicit `read` grant only if inbound suggestions are separately enabled.
The adapter narrows its handle again and
`gallivant doctor` checks the resulting grants and immutable schema before any
task data is sent. It reports the exact extra channel, permission, missing grant
or schema mismatch it finds.

Board currently stores this data in the United States and does not expose a
task-bounded retention setting. Enabling delivery therefore requires explicit
acceptance of both facts. If either is outside the task's data policy, keep the
adapter disabled; a shorter `max_retention_days` value is rejected rather than
treated as an unenforced promise.

## Private configuration

Add this block to `$GALLIVANT_HOME/config.json` and keep that file mode 600:

```json
{
  "collaboration": {
    "adapter": "board",
    "channel": "engineering/tasks",
    "needs_owner_channel": "engineering/needs-owner",
    "profile": "task-relay",
    "link_base_url": "http://127.0.0.1:8791/gallivant",
    "token_file": null,
    "schema": "gallivant-task-transition@1",
    "significant_events": [
      "accepted", "started", "pr-opened", "needs-owner",
      "stopped", "resumed", "ready", "completed"
    ],
    "owner_decision_hours": 72,
    "retry": {
      "max_attempts": 5,
      "base_seconds": 30,
      "max_seconds": 3600,
      "timeout_seconds": 10
    },
    "inbound": {
      "enabled": false,
      "channel": "engineering/tasks"
    },
    "policy": {
      "allow_us_storage": true,
      "allow_board_managed_retention": true,
      "permissions": ["post", "label"]
    }
  }
}
```

`channel`, `needs_owner_channel`, Board/team selection, credentials and policy
stay in private configuration; none are built into the adapter. With
`token_file: null`, the SDK uses its normal Vercel identity. A non-null path is
read only when Board is first used and supplies a bearer credential without
placing it in logs or task content. `link_base_url` is the locally reachable
dashboard mount used to form canonical task links.

Run `gallivant doctor` after setup and after changing grants or schema. Do not
start the daemon until its collaboration check passes.

## Exported and retained data

Only configured significant state changes are queued. The structured event
contains a version, stable task/run/event idempotency key, transition and bounded
reason, actor/source provenance, and dashboard link. A Needs owner event also
contains a bounded requested decision and expiry and is posted to the dedicated
queue. A `completed` event records a merged or closed pull request and resolves
any outstanding owner item. Pull-request URLs are included when present.

A failed initial remote launch opens an owner request when preparation fails or
dispatch is refused before submission. The item stays open across failed retries
and resolves when the owner repairs the prerequisites and resumes the task.

Prompts, transcripts, credentials, local paths, raw diffs, comments, checks,
session output, logs and private configuration are never event inputs. Board
posts use stable IDs and `noSync`; retries and daemon restarts therefore reuse
one root thread and one transition record. The durable outbox, Board thread IDs,
retry state, cursor and untrusted suggestions live in private
`$GALLIVANT_HOME/collaboration.json`, independently of canonical task state.

Delivery errors do not fail a task or consume an implementation round. Retries
use the configured exponential backoff and stop at `max_attempts`; the dashboard
then shows the retained failure. A denied policy circuit also stops after that
bound. Restarting the daemon performs one fresh policy probe so a repaired grant
can resume pending delivery without recreating a Board thread.

Every policy, delivery, snapshot and live-read operation is capped by
`retry.timeout_seconds`. A deadline aborts supported Board reads and releases the
coordinator even if a destination request never settles.

## Optional inbound suggestions

Inbound collection is a separate opt-in. Set `inbound.enabled` to `true` only
with `policy.allow_inbound_suggestions: true`. The adapter resumes from the
durable Board cursor, reads every paginated reply in the initial thread snapshot
before advancing that cursor, reduces structured or malformed blocks to inert
text, and stores bounded text with its Board provenance as `trust: "untrusted"`,
`authority: "none"` and `control: false`.

No inbound message can approve or replace a brief, change acceptance criteria,
expand scope, alter review policy, merge a pull request, release a chain or
completion gate, or bypass a completion decision. There is deliberately no
parser from suggestions to control actions.

## Rollback

Set `collaboration` to `null` and restart the daemon. Task execution, review,
dashboard and delivery APIs continue on their existing state. Keep
`collaboration.json` while auditing or recovering idempotency history; after the
adapter is disabled and no delivery will be resumed, archive that private file
according to the operator's retention policy. Removing the optional Board peer
is then safe.
