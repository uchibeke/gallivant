# Plugin launch qualification — 2026-10-08

The plugin is not submission-ready. This change closes native Agents API
preparation, not the remaining APort/runtime/host release gates.

## Delivered and observed

The shared execution service prepares tasks with `environment:none`, `tools:[]`
and disabled delegation. It retains normal receipts, allowance, root-turn
ownership, restart, cancellation and redaction. Implementation keeps its hosted
sandbox and independent coordinator verification.

A real `gpt-6.1-sol` / low-reasoning turn returned the requested CSV-export
requirements through this transport. The execution and transport were reopened
while recovering the saved session. One accepted inference turn was recovered
without creating another session or resending input. Provider usage: 7,829 input
tokens and 25 output tokens. The token-only estimate at checked standard rates is
USD 0.015908, not an invoice or a hard spending cap. The private shared campaign
ledger retains its reservation until billing is reconciled. Credentials and
account configuration remain outside Git.

Live checks caught two defects missed by the original fixtures:

- Conversation-only creation requires initial input; the empty request returned
  HTTP 400 before inference. Bounded input and explicit authority restrictions now
  travel in one creation request, with recovery of its exact initial turn.
- Duplicate `order` query parameters return HTTP 400. Pagination now has one
  owner, and the fixture rejects duplicate parameters too.

Effective configuration is checked before accepting output, not before initial
inference. The initial request explicitly supplies all authority restrictions;
it does not inherit a saved agent or tool configuration.

## Reproduce

Run `node --test test/openai-agents.test.mjs test/execution-preparation.test.mjs
test/preparation-capabilities.test.mjs`. Full regression: 1,440 passed before the
live-contract corrections. Final affected suite: 133 passed. Coverage includes
native HTTP envelopes, shared questions/answers/readiness, changed configuration,
authority escalation, lost creation replies, pagination and restart. Offline
tests are not deployed-runtime or plugin-host evidence.

For an authorized live check, keep explicit Agents config, campaign ledger and
dedicated state outside Git. Set `OPENAI_AGENTS_PREPARATION_CONFIG`,
`OPENAI_AGENTS_CAMPAIGN_LEDGER` and `OPENAI_AGENTS_PREPARATION_HOME`, then run
`npm run test:openai-agents:preparation:live`. Preflight is read-only. Add
`-- --execute` for an authorized reserved turn. Reusing its home recovers the same
turn. Supply credentials through the existing secret store/process environment.
Implementation/correction qualification still uses `test:openai-agents:live`
and the same aggregate campaign allowance.
Both paid qualification scripts hold the same process lock beside that ledger,
so separate state directories cannot race to reserve the same allowance.

## Remaining gates

- Review/merge and rebuild the exact clean runtime artifact for APort.
- Connected APort execution, repository/provider authority, durable storage/wakes
  and region/account isolation.
- Owner-selected Cloudflare Container deployment, with added cost confirmed
  before deployment. Ephemeral disk, R2 FUSE and periodic snapshots do not prove
  safe intent persistence. Test forced eviction and recovery before enabling it.
- Real implementation and forced correction on the same PR. Codex Cloud's
  environment/repository safety gate remains in place.
- Actual ChatGPT install, OAuth/reconnect, sidebar/panel behavior, restricted
  reviewer account, authentic screenshots/demo and directory validation.

No automatic merge, production enablement or directory submission is claimed.

Sources checked 2026-10-08: [Agents configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration),
[session creation](https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/methods/create),
[model pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[Container lifecycle](https://developers.cloudflare.com/containers/faq/),
[R2 FUSE](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/).
