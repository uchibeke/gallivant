# Inspect saved hosted recovery evidence

Call the existing authorized `inspect` operation with
`{ "taskId": "task-…", "diagnostics": true }`. The optional
`progress.diagnostics` object has `version: 1` and `source: "saved-local"`.
The execution API offers the same evidence through
`execution.inspect({ diagnostics: true }).execution.diagnostics`.
Preparation uses its existing intake execution owner; implementation uses its
registered execution owner. Neither path polls providers, subscribes to events,
creates receipts, resets counters, sends input or changes retained state.

| Stage | Saved evidence |
| --- | --- |
| `dispatch-missing` | The exact execution intent has no matching adapter operation. |
| `recovery-circuit-blocked` | The saved launch or observation retry circuit is blocked. |
| `session-before-input` | A session and explicit unsent markers, or the historical pre-input refusal, are saved. |
| `send-intent-unacknowledged` | Input send intent is saved without a positive acknowledgement. |
| `input-acknowledged-root-unowned` | An input acknowledgement is saved without an owned root. |
| `root-owned` | The saved accepted operation identifies its run, session and root. |
| `unknown` | Legacy or incomplete evidence cannot establish a more specific stage. |
| `unavailable` | The execution or adapter cannot supply local diagnostics. |

These codes describe saved evidence, not current provider state. Missing turns,
missing markers and idle sessions never prove no input acceptance or no charge.
A circuit takes precedence over an owned root; identifiers retain any saved
owned root. Intent/ack fields are `true`, `false`, or `null` (unavailable), and
timestamps are recorded epoch milliseconds or `null`. Inspection never invents
timestamps. Identifiers are bounded to 256 characters and errors contain only
allowlisted codes, HTTP status/class and a bounded request ID. Provider error
bodies, arbitrary messages, prompts, source contents and credentials are excluded.
Known secrets are redacted again at the execution and authorized task boundary.

`actions` distinguishes `inspect-local` from `retry-observation`. The latter
means the existing explicitly authorized recovery operation, whose execution
owner revalidates exact identity, stop fences and retry capacity. It performs
remote reconciliation and may check access; inspection itself never invokes it.
Neither action permits another input send. Pre-input refusals offer operator
review of the preserved session and dispatch records, with acceptance/billing
evidence still missing. They retain `needs-human`; reset does not authorize a
new send. Cancellation requests remain separate from confirmed provider stops.

## APort schema intake and rollback

Package compatibility remains the existing 0.3.x window; a 0.2.x runtime
manifest still fails the handshake. The combinations below describe additive
schema fields within an otherwise compatible runtime pin.

| Consumer / stored state | Supported behavior |
| --- | --- |
| Existing client / new runtime | Omit `diagnostics`; the existing response fields and operation version 1 remain unchanged. Clients may ignore additive fields. |
| New client / old runtime | Omit the optional request flag until the advertised inspect schema includes it. Old strict request schemas reject the new flag. Missing diagnostics mean unavailable. |
| New runtime / old task, execution and adapter state v1 | Read without migration or writeback. Missing send markers/timestamps stay `null`; exact ownership is still required. |
| New runtime / new v1 state | Read additive markers and timestamps saved by actual transitions. Diagnostic projection version is independently 1. |
| Old runtime / new v1 state | Added properties are ignorable, but rolling back active work is unsupported. Restore the matching package and state backup through the existing runtime-pin workflow. |

Legacy continuation records without the original session dispatch-key evidence
may require operator repair before remote reconciliation. A local diagnostic
never upgrades such a record or adopts the latest provider turn. Unsupported
task/execution versions still fail the existing compatibility handshake.

Run the existing adapter, delivery, full test, lint and release-package gates.
Build the runtime through the existing package workflow from committed payload
bytes; retain its tarball, `manifest.json` and `runtime.json` together. APort
intake must compare `coreSha256`, `sourceCommit`, `sourceVerified`, payload hashes
and `uncommittedPayload` before changing a pin. Internal package fixtures verify
offline compatibility only; they do not qualify a live deployment or prove the
cause or recoverability of an existing hosted run. Drain active work, back up the
namespace and preserve the prior artifact before an approved migration. Nothing
in this change publishes a package or updates an embedding repository's archive.
