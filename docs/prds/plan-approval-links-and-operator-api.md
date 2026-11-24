---
status: ready
harness: codex
---

# Review and approve a YAML plan from a link or operator tool

## Problem

A plan preview is tied to the current caller and cannot be reopened as a pending approval from a stable link. An operator has to reconstruct the file, digest and request identity to approve it. Add one durable review request that works from the dashboard or an authorized operator tool, while keeping approval attached to the exact plan and source files reviewed.

## User stories

- As an operator, I want a direct link to a pending plan approval, so that I can open the right review without navigating from the dashboard home.
- As an operator reviewing a chain, I want to read its exact manifest and PRDs before approving, so that I understand the scope, dependencies and resources I authorize.
- As an operator who gives an assistant explicit approval, I want it to submit that exact approval through a trusted tool, so that I can stay in the conversation and receive a receipt.
- As an operator retrying after a timeout or an edit, I want Gallivant to distinguish an accepted approval from a stale one, so that a retry cannot duplicate work or admit a revision I did not review.

## Acceptance criteria

- Given an authorized operator has previewed a valid sequence or nested YAML or JSON plan, when they choose **Create approval request** or use the equivalent CLI command, then Gallivant saves one bounded pending review using its existing approval model. It returns a stable URL such as `/plans?approval=REQUEST_ID` under the active mount. Preview, page loads and link sharing perform zero admission or dispatch.
- Given I open that URL with access, when the review loads, then it goes directly to the saved proposal and shows the exact revision, repos and bases, dependency order and frozen anchors, routes, review and merge gates, resource limits and blockers. The shared file viewer shows the exact reviewed manifest, briefs and approved sources. There is a single **Approve plan** action for an eligible revision and clear states for pending, accepted, stale, expired, denied and unavailable requests.
- Given a signed-in operator uses the button, when they confirm the saved request, then the existing plan service checks current permission and the exact reviewed digest and records a single scoped admission receipt. The next view links to the admitted plan. The scheduler applies the original dependency and merge gates.
- Given I explicitly approve the request at a specific link or ID in an operator tool session, when it resolves to one immutable revision and the assistant calls `gallivant plan approve REQUEST_ID --approve REVISION` or the corresponding protected endpoint, then the operator channel conveys verifiable approval for that exact action and the same service returns the receipt. A trusted host can convey the recorded consent without a second prompt or making me type the digest. If the host cannot convey it, the same link opens direct human approval. Conversation text and worker-controlled assertions are never evidence of consent.
- Given a link, request ID or digest is copied into a worker session, when the worker or an unrelated principal tries to confirm or inspect protected inputs, then the existing authenticated grants and worker isolation reject the operation. A URL is a locator. The server derives actor, scope and inputs from trusted session and saved request data. Scoped tool authority is short-lived and single-action. Credentials never enter links, prompts, model context, logs or rendered documents.
- Given a response is lost or several tabs or clients approve together, when they repeat the same request and revision, then they get the same recorded receipt without another plan or execution. If approval-bound inputs, authority or scope changed, the retained link explains that a new review is required. An expired or ambiguous request never selects another pending plan.
- Given a qualified installed local boundary, when I approve a synthetic plan from a copied URL or via an authorized assistant tool action, then both paths reach the same service and produce the same receipt format. Exercise the standalone and mounted views and a trusted local assistant or tool host that can convey the operator action. The browser handles keyboard focus, submitting and confirmed states, reload and Back without replaying the mutation. Tests cover legacy linear chains, nested and cross-repository dependency gates and permission loss.

## Implementation boundaries

Build after the local YAML plan setup and the shared task and plan file viewer have merged. Reuse the existing review, confirm and reconcile semantics in `planControl` and `queuePlan` and the protected `/api/plan/control` adapter. Preserve the browser's origin, CSRF and size checks. Add a durable pending review within the existing plan state and bounded retention policy. Keep validation and preview read-only and require an explicit protected write to save a review request. Save the identifiers and immutable input references that bind the reviewed bytes. Use the existing atomic admission and receipt reconciliation for approval. Let a permitted client reconcile an already used consent by reading that exact receipt. Avoid a second scheduler, approval engine or storage service.

Use the local operator channel from the setup brief. Reuse the host's verified operator session and current scoped grants when mounted. For an assistant, allow the same action through an existing trusted tool or the local CLI with an explicit operator consent binding. The server checks action, request ID, reviewed revision, principal, scope and expiry at the point of use. Give the assistant a small structured response with the receipt and view URL.

Keep the approval view inside Plans, with the document and scope ahead of the confirmation action. Use existing navigation and shared action states. Preserve preview during recoverable network errors and require a fresh verified revision before confirmation. Update README, commands, plan UI, embedding and agent setup docs with the link, endpoint and CLI examples, and an accurate description of which operator hosts can pass consent.

## Verify

- `node --test test/plan-approval-requests.test.mjs test/dependency-plan-admission.test.mjs test/dependency-plan-controls.test.mjs`
- `node --test --test-concurrency=1 test/ui/plan-approval.test.mjs test/ui/dependency-plans.test.mjs`
- `npm run test:install`
- `npm run lint`
- `git diff --check`

## Where to look

- `lib/dependency_plan_admission.mjs`, `lib/dependency_plan_registry.mjs`, `lib/operator_intent.mjs`, `lib/commands/serve.mjs`, `bin/gallivant.mjs`
- `lib/tracker/chains.mjs`, `lib/tracker/factory_access.mjs`, `templates/tracker/plans.js`, `templates/tracker/lifecycle.js`
- `docs/dependency-plans.md`, `docs/ui-plans.md`, `docs/commands.md`, `docs/agent-setup.md`

## Out of scope

- General delegated administration, a new chat connector or an externally reachable local control API.
- Automatic approval from chat transcripts, GitHub comments, preview, GET requests or URL parameters.
- A new approval requirement for the existing linear CLI or authority to merge, publish or deploy.
