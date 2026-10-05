# Execution foundation checklist

This checklist qualifies the offline foundation and preserves the release gates.
See [the contract](../../execution.md) and [per-case evidence](execution-foundation.json).

- [x] Reuse the merged intake task service and existing lifecycle; fail missing prerequisites.
- [x] Keep existing CLI identities, adapters and policy defaults compatible.
- [x] Export a versioned execution/result boundary and one capability registry.
- [x] Persist owned intent, idempotency and recovery metadata before dispatch.
- [x] Scope health by provider/account and separate progress/result work from review.
- [x] Reconcile startup, stale observations, missed events and uncertain acceptance.
- [x] Redact normalized journals/projections; preserve replay IDs and explicit gaps.
- [x] Bound indexed history, SSE responses/buffers, browser DOM and disconnect cleanup.
- [x] Fence cancellation, unsupported interruption, unknown usage and exhausted allowances.
- [x] Validate shared results and retain actual approved verification before PR publication.
- [x] Preserve supported legacy local state and document compatible-package rollback.
- [x] Supply deterministic API-shaped, Cloud-shaped and local Codex-shaped fixtures.
- [ ] Implement either remote production transport (later milestones).
- [ ] Qualify provider/model access, repository/environment setup and remote controls live.
- [ ] Qualify an installed plugin, public endpoint, screenshots or capture surface.
- [ ] Merge, deploy, submit or publish a release (human/later milestone boundaries).

The PRD explicitly requires offline verification and excludes paid calls for this
foundation. No unavailable live capability is marked passed. Future live runs need
implemented transports, operator credentials and demonstrated model access,
authorized disposable repository/environment, and a reservation in the aggregate
campaign ledger. Installed-host qualification additionally needs the actual host,
plugin, deployed endpoint and capture surface. Version/sign-in output and these
fixtures cannot substitute for that evidence. Preserve the existing intake
qualification blockers recorded in its evidence instead of rewriting them.
