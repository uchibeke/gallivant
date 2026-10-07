# APort task-delivery integration: delivery and release correction

Owner direction: Uchi, 2026-10-04. This carried addendum supersedes conflicting
public endpoint, UI ownership and downstream-dispatch instructions in
`plugin-ready-gallivant.md` and `plugin-hosting-and-live-tests.md` for M5/M6 only.
It does not change the running M1 contract or the queued M2–M4 requirements.
Both requested remote harnesses, durable coordination and actual live release
qualification remain required. No model defaults change.

## One implementation per responsibility

- Public endpoint: `https://aport.io/api/task-delivery/mcp`, subject to actual
  deployment verification. Retire the proposed `/api/gallivant/mcp` name; no alias
  unless there is evidence of a deployed client that needs it.
- APort implements MCP/HTTP transport, existing-account OAuth integration,
  tenant/region authorization and persistence adapters, public product/support
  pages and the shared Next UI under its existing `/web`. Its static export serves
  presentation; Pages Functions handle dynamic data/auth. The MCP resource and web
  page share components. No competing Gallivant-hosted public React app.
- Gallivant owns requirement/ready/task/review semantics, versioned portable
  exports, operation schemas, durable coordinator and provider adapters. Its CLI
  and APort consume those same services. M5 supplies reusable MCP dispatch helpers
  and view models when useful; they accept scoped context supplied by APort and
  never bypass its authorization or invent another tool registry.
- Existing Cloudflare Pages, regional D1/KV/R2 and identity records are preferred.
  Use namespaced tenant/environment entities and authoritative regional routing.
  Shared physical stores are not permission boundaries. Never put job state into
  the existing shared counter DO or weaken existing verification endpoints.
- No mandatory dedicated Worker, new database or new account system. A transient
  Pages request cannot coordinate a whole job. M5 must demonstrate an existing
  compatible durable runtime adapter, or document a measured Node/scheduling
  limitation with the smallest supported deployment option. Do not claim native
  Codex Cloud can dispatch over an invented HTTP API or omit its runtime needs.

## Dependency order without a cycle

The already-authored canonical APort PRD is
`aporthq/agent-passport:docs/prds/aport-task-delivery-mcp.md`, carrying
`_plans/task-delivery-contract.md` sections T0–T9. The existing Gallivant job identity
is `aporthq/agent-passport/aport-task-delivery-mcp`; discover its current status/PR
using existing operator controls. Do not generate or start a replacement brief.
These named repo files and job identity are references, not assumptions that a
developer's local sibling checkout exists in the execution environment.

APort starts independent auth/storage/transport/UI work while M1–M5 progress.
It cannot certify real integration before M5's actual merged exports are pinned.
If it reaches that dependency, preserve its branch and completed work, leave the
dependent acceptance criteria unmet and record the existing resume command.

M5 can finish after its real artifact-installed consumer and runtime compatibility
tests pass and its exports/configuration are documented. It does not wait for the
APort endpoint deployment or claim that offline fixtures are an installed-host test.
Deliver a compact compatibility/ownership handoff with version/digest, supported
runtime, operation/schema versions, storage/coordinator interfaces and exact build,
configure, migrate and rollback commands. Missing exports are fixed here.

M6 consumes merged M5, reconciles/resumes the same APort job through available
existing controls, waits for its human merge and authorized deployment, and then
qualifies real integration. If operator controls are unavailable, identify the
exact resume/merge/deploy action and preserve this dependency as unmet. No second
runner, silent contract rewrite, auto-merge or fixture-based release completion.

## Final release gates

Use the one Gallivant packager with the actual APort endpoint, UI resource and
origin configuration. The initial submission must be a combined skills/MCP plugin;
current OpenAI rules do not support adding MCP to a published skills-only listing.
APort is publisher with owner-selected license/privacy/terms URLs.

M6 must demonstrate both remote providers producing a real tested PR and correction,
persisted restart/reconnect, actual ChatGPT sidebar/panel use, account isolation,
usable restricted reviewer access, valid product/support/legal URLs, exact hashes,
auth discovery/tool scans, authentic screenshots/demo and G9's bounded release kit.
Use an eligible OpenAI publisher project: current MCP review docs exclude projects
with EU data residency. This is separate from APort customer storage region policy.
Verify business/org permissions and domain ownership. Never include credentials
or private reviewer instructions in the public ZIP; use secure portal fields.

Keep the shared initial USD 10 campaign ledger from the hosting addendum; this is
not another per-repo allowance. No purchases, production release outside existing
authority, directory submission or automatic merges. Code merged, deployed,
live-qualified, submission-ready and published are distinct states. M6 cannot
finish by only documenting missing prerequisites.

Research checked 2026-10-04: [submission](https://developers.openai.com/plugins/deploy/submission),
[app review](https://developers.openai.com/plugins/deploy/app-review),
[auth](https://developers.openai.com/plugins/build/auth),
[UI](https://developers.openai.com/plugins/build/chatgpt-ui) and
[Extensions](https://developers.openai.com/plugins/build/extensions).
Reverify current platform details during implementation.
