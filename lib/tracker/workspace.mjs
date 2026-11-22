import { redact } from "../execution_io.mjs";
import { attemptPresentation, durationText, instant } from "./presentation_time.mjs";
import { presentationFacts, phaseBadge, fact, relativeTime, cooldown } from "./presentation_html.mjs";
import { outcomeLabel, readinessLabel } from "./presentation.mjs";
import { factoryNote } from "./factory_projection.mjs";
import { planHref } from "./factory_links.mjs";
import { shellQuote } from "../runtime-environment.mjs";
import { reviewActivity } from "./review.mjs";
import { esc, badge, emptyState, icon } from "./primitives.mjs";
import { safeLink, externalLink } from "./links.mjs";
import { at } from "./shell.mjs";
import { executionCapabilities } from "../capabilities.mjs";
import { validVerificationSandbox } from "../verification_sandbox.mjs";

const catalogue = new Map(executionCapabilities().map(cap => [cap.name, cap]));

const amount = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const value = input => esc(input ?? "unknown");
const tag = value => badge(value, ["passed", "clear", "accepted", "fulfilled", "Integrated"].includes(value) ? "success"
  : ["stale-head", "skipped", "blocking", "findings", "failed", "denied", "incomplete"].includes(value) ? "attention" : "");
const times = at => at ? `<time datetime="${esc(at)}">${esc(at)}</time>` : "Unknown";
const human = value => typeof value === "string" ? value.replaceAll(/[-_]/g, " ") : null;

// Only saved, allowlisted fields. Historical attempts never inherit current-run
// provider/session/cost observations. No provider call or transcript read here.
export function workspaceProjection({ id, entry, run, presentation, factory = null, divergence = null, capabilities = {}, now, sanitize = redact }) {
  const p = factory?.presentation ?? presentation;
  const text = (value, limit = 256) => typeof value === "string" ? sanitize(value).slice(0, limit) : null;
  const attempt = attemptPresentation(run, { entry, maxIterations: p.rounds.limit, now });
  const ex = run?.execution || {};
  const historical = run?.id && run.id !== entry.last?.run;
  const selectedCapabilities = historical ? catalogue.get(run.harness || ex.provider) ?? {} : capabilities;
  const review = p.review.status === "stale-head" ? { status: "stale", message: "Historical review observation or unbound review; current-head review is unknown." } : reviewActivity(entry);
  const reviewRecord = entry.firstPartyReview;
  const pieces = Array.isArray(reviewRecord?.pieces) ? reviewRecord.pieces : [];
  const findings = Array.isArray(reviewRecord?.result?.findings) ? reviewRecord.result.findings : [];
  const approved = factory?.capability;
  const saved = entry.execution || {};
  const pinnedRoute = approved?.source === "plan.approval.bindings.tasks.route";
  const declared = catalogue.get(approved?.harness ?? entry.harness);
  const route = { harness: text(approved?.harness ?? entry.harness),
    provider: text(pinnedRoute ? approved.provider : saved.provider), model: text(pinnedRoute ? approved.model : saved.model),
    transport: text(pinnedRoute ? approved.transport : saved.transport ?? capabilities.transport), approval: pinnedRoute,
    continuation: text(capabilities.continuation ?? declared?.continuation), cancellation: p.controls.cancellation,
    limitation: (capabilities.available ?? declared?.available) === false ? text(capabilities.reason ?? declared?.reason) : null,
    qualification: approved?.qualification ?? "unknown",
    cap: approved?.providerPerRunCap ?? capabilities.cost?.hardCap ?? null,
    allowance: factory?.budget.implementationAllowanceUsd ?? null, runtimeAllowance: factory?.budget.runtimeAllowanceMs ?? null,
    runAllowance: factory?.budget.perRunAllowanceUsd ?? null };
  const brief = { path: factoryNote(text(entry.prd)), revision: p.recovery.revision, source: p.recovery.sourceDigest,
    contract: p.recovery.contractDigest, reason: text(divergence?.reason), verdict: text(divergence?.verdict), why: factoryNote(text(divergence?.why)),
    changes: Array.isArray(divergence?.diff) ? divergence.diff.slice(0, 6).map(change => factoryNote(text(change))) : [],
    totalChanges: Array.isArray(divergence?.diff) ? divergence.diff.length : 0, handle: text(divergence?.handle) };
  return {
    id, presentation: p, attempt, latest: text(entry.last?.run), branch: text(entry.branch),
    plan: factory?.plan ?? (entry.plan ? { id: text(entry.plan.instanceId), node: text(entry.plan.node) } : null),
    approvedBase: factory?.base ?? p.delivery.base, deliveryTarget: factory?.delivery.target ?? p.delivery.target,
    dependencies: (factory?.dependencies ?? []).slice().sort((a, b) => (a.status === "integrated") - (b.status === "integrated")).slice(0, 5)
      .map(({ id, status }) => ({ id, status })),
    prerequisiteCount: factory?.prerequisiteCount ?? null, blockerCount: factory?.blockerCount ?? null,
    freshness: factory?.times.freshness ?? "unknown", meaningfulAt: factory?.times.meaningful.at ?? p.activity.at,
    nextAt: factory?.recovery.retryAt ?? p.recovery.nextAt ?? p.retryAt, recoverySettings: factory?.recoverySettings ?? null,
    integration: factory?.evidence.integration ?? null, planFailure: factory?.recovery.original ?? null, route, brief,
    state: text(entry.state), taskSession: text(entry.session), harness: text(entry.harness), url: safeLink(entry.url),
    review: { ...review, observedAt: p.review.observedAt, retryAt: instant(reviewRecord?.retryAt),
      route: text(entry.reviewPolicy?.route?.name), qualification: text(entry.reviewPolicy?.route?.qualification),
      pieceCount: pieces.length, pieces: pieces.slice(0, 8).map(piece =>
        ["running", "completed", "failed", "waiting", "incomplete"].includes(piece?.status) ? piece.status : "unknown"),
      total: findings.length, findings: findings.slice(0, 8).map(f => ({
        severity: ["critical", "high", "medium", "low"].includes(f?.severity) ? f.severity : "unknown",
        description: text(f?.description, 600) || "Finding summary unavailable",
        path: factoryNote(text(f?.evidence?.path)),
        line: Number.isSafeInteger(f?.evidence?.line) && f.evidence.line > 0 ? f.evidence.line : null,
      })) },
    execution: { harness: text(run?.harness), provider: text(ex.provider), model: text(ex.model),
      session: text(ex.sessionId ?? run?.session),
      state: text(ex.providerState), observedAt: instant(ex.observedAt), reconciledAt: instant(ex.reconciledAt),
      costUsd: amount(ex.costUsd), transport: ["cli", "local", "remote"].includes(ex.transport) ? ex.transport : "unknown",
      continuation: text(selectedCapabilities.continuation), cancellation: typeof selectedCapabilities.controls?.cancel === "boolean" ? selectedCapabilities.controls.cancel ? "supported" : "unavailable" : "unknown",
      costSource: historical ? null : text(selectedCapabilities.cost?.source), available: selectedCapabilities.available === false ? "unavailable" : "unknown; no access probe performed", limitation: text(selectedCapabilities.reason),
      usage: { input: amount(ex.usage?.input_tokens), output: amount(ex.usage?.output_tokens), total: amount(ex.usage?.total_tokens) },
      exit: Number.isInteger(run?.exit) ? run.exit : null, running: run?.running === true },
  };
}

export function workspaceSummary(w, { base = "", query = {}, clock = Date } = {}) {
  const p = w.presentation;
  const decision = p.attention;
  const chains = p.chains?.length ? p.chains : p.chain ? [p.chain] : [];
  const chain = !query.plan && chains.find(c => !c.predecessor && c.name === query.chain);
  const chainReturn = chain && `<a href="${esc(at(base, "/chains", query, { milestone: w.id }))}">Back to chain ${esc(chain.name)}</a>`;
  const plan = w.plan && (!chain || w.plan.name !== chain.name) &&
    `<a href="${esc(query.plan === w.plan.id && query.node === w.plan.node ? at(base, "/plans", query) : planHref(base, query, w.plan))}">Back to plan</a>${w.plan.name ? ` · ${esc(w.plan.name)}` : ""}`;
  const otherChains = chains.filter(c => c.name !== w.plan?.name && c.name !== chain?.name).map(c =>
    `<a href="${esc(at(base, "/chains", query, { chain: c.name, milestone: c.predecessor ? "" : w.id, plan: "", node: "" }))}">${esc(`${c.name || "Chain"} · ${c.predecessor ? "Predecessor" : `${c.position ?? "?"}/${c.total ?? "?"}`}`)}</a>`);
  const dependencies = [chainReturn, plan, ...otherChains].filter(Boolean).join("<br>");
  const brief = w.brief;
  const next = brief.reason ? ["#workspace-brief-change", "Review brief changes"]
    : decision.source === "entry.control" ? ["#run-controls", "Check task request"]
    : decision.source === "entry.hold" ? ["#workspace-recovery", "Inspect recovery hold"]
    : decision.source?.includes("firstPartyReview") || ["failed", "incomplete", "findings"].includes(p.review.status) ? ["#review-activity", "Inspect reviewer evidence"]
    : p.phase.id === "execution_failed" ? ["#workspace-recovery", "Inspect recovery"]
    : p.checks.status === "failed" || p.phase.id === "delivery_ready" ? ["#workspace-evidence", "Inspect delivery evidence"] : null;
  return `<div class="workspace-summary" data-key="task-summary">
<div class="workspace-heading"><p class="dim">${esc(redact(w.id))}</p><div class="workspace-tags">${phaseBadge(p)}${p.phase.label === outcomeLabel(p.outcome) ? "" : tag(outcomeLabel(p.outcome))}</div></div>
<section class="workspace-decision ${decision.group === "attention" ? "needs-attention" : ""}" aria-labelledby="workspace-decision-heading">
<div class="decision-body">${icon(decision.group === "attention" ? "attention" : "info")}<div><h2 id="workspace-decision-heading">${esc(decision.title)}</h2><p>${esc(decision.nextAction)}</p></div></div>
${next ? `<a href="${next[0]}">${next[1]}</a>` : ""}</section>
<details id="workspace-brief" class="workspace-technical" data-key="brief"${brief.reason ? " open" : ""}><summary>Approved brief and sources ${brief.reason ? tag("Review needed") : ""}</summary>
${brief.reason ? `<div class="brief-warning" id="workspace-brief-change" tabindex="-1"><p>${value(brief.why)}</p>${brief.changes.length ? `<ul>${brief.changes.map(change => `<li>${value(change)}</li>`).join("")}</ul>` : ""}
${brief.totalChanges > brief.changes.length ? `<p>${brief.totalChanges - brief.changes.length} more changes. Inspect the full difference with <code>gallivant why ${esc(shellQuote(brief.handle || w.id))}</code>.</p>` : ""}
${brief.verdict === "changed" ? w.plan?.kind === "graph" ? "<p>Restore the plan-approved inputs. Review changes to future work in Plans.</p>"
    : `<p>Restore the approved copy or review and approve a new snapshot explicitly with <code>gallivant resume ${esc(shellQuote(brief.handle || w.id))} --resnapshot</code>.</p>` : ""}</div>` : ""}
<dl class="workspace-facts">${fact("Saved brief", value(brief.path))}${fact("Revision", value(brief.revision))}${fact("Brief fingerprint", value(brief.contract))}${fact("Carried source digest", value(brief.source))}</dl></details>
<dl class="workspace-facts">${fact("Repository / approved base", `${value(p.delivery.repository)} / <code>${value(w.approvedBase)}</code>`)}${fact("Delivery target", value(w.deliveryTarget))}
${fact("Responsible actor", value(human(decision.actor)))}${fact("Last meaningful activity", relativeTime(w.meaningfulAt, clock))}
${fact("Selected attempt", w.attempt.id ? `<code>${value(w.attempt.id)}</code> · ${value(durationText(w.attempt.duration))}` : "No attempt recorded")}
${fact("Task rounds", `round ${p.rounds.used ?? "unknown"}/${p.rounds.limit ?? "unknown"}`)}
${fact("Plan", dependencies || "No plan recorded")}
${fact("Task delivery", w.url ? externalLink(w.url, `Open PR ${p.delivery.pr ? `#${p.delivery.pr}` : "evidence"}`) : p.delivery.pr ? `PR #${p.delivery.pr} · safe link unavailable` : "No PR recorded")}</dl>
${w.prerequisiteCount ? `<div class="workspace-prerequisites"><strong>${w.blockerCount} waiting · ${w.prerequisiteCount} prerequisite${w.prerequisiteCount === 1 ? "" : "s"}</strong><ul>${w.dependencies.map(d => `<li>${esc(d.id)} ${tag(d.status)}</li>`).join("")}</ul></div>` : ""}
${w.latest && w.attempt.id && w.attempt.id !== w.latest ? `<p class="attempt-notice" data-key="historical-attempt">Historical attempt selected. Task evidence below describes the current task. <a href="${esc(at(base, "/run", query, { id: w.id, run: w.latest }))}">Open latest attempt</a></p>` : ""}
<details class="workspace-technical" data-key="task-facts"><summary>Task facts &amp; provenance</summary><dl class="facts">${presentationFacts(p)}<dt>task session</dt><dd>${value(w.taskSession)}</dd><dt>state code</dt><dd>${value(w.state)}</dd><dt>branch</dt><dd><code>${value(w.branch)}</code></dd><dt>phase source</dt><dd>${value(p.phase.source)}</dd><dt>activity source</dt><dd>${value(p.activity.source)}</dd></dl></details>
</div>`;
}

export function workspaceEvidence(w) {
  const p = w.presentation;
  const checks = p.checks;
  const review = p.review;
  const delivery = { ...p.readiness, status: readinessLabel(p) };
  const checkDetails = checks.count == null ? "" : `<p>${checks.count} observed${checks.failed == null ? "" : ` · ${checks.failed} failed`}.</p>${checks.jobs.length ? `<ul class="check-jobs">${checks.jobs.map(job => `<li>${value(job.name)} ${tag(job.status)}${job.runId ? ` <small>Run ${job.runId}</small>` : ""}</li>`).join("")}</ul>${checks.count > checks.jobs.length ? `<small>Showing ${checks.jobs.length} of ${checks.count} checks.</small>` : ""}` : ""}`;
  const cards = [
    ["CI checks", checks, checks.status === "stale-head" ? "<p>Saved checks belong to another revision.</p>" : checkDetails],
    ["Independent review", { ...review, status: review.verdict === "unknown" ? review.status : review.verdict }, "", '<a href="#review-activity">Inspect reviewer findings</a>'],
    ["External review", { ...checks, status: review.external || "unknown", source: "entry.reviewObservation.external" }, ""],
    ["Acceptance receipt", p.acceptance, p.acceptance.status === "skipped" ? "<p>The acceptance gate was skipped.</p>"
      : ["denied", "accepted"].includes(p.acceptance.status) ? `<p>Evaluator · ${value(p.acceptance.source)}</p>` : ""],
    ["Delivery readiness", delivery, delivery.reason ? `<p>${value(delivery.reason)}</p>` : "", w.url ? externalLink(w.url, "Inspect PR evidence") : ""],
    ["Owner publication", { status: p.ownerDelivery.obligations.length ? p.ownerDelivery.obligations.some(o => o.status === "pending") ? "pending" : "fulfilled" : "No owner obligation recorded", source: p.ownerDelivery.source },
      p.ownerDelivery.obligations.length ? `<ul>${p.ownerDelivery.obligations.map(o => `<li>${esc(human(o.kind))} ${tag(o.status)}${o.head ? ` · <code>${value(o.head)}</code>` : ""}</li>`).join("")}</ul>` : ""],
  ];
  return `<p class="evidence-head" data-key="current-head">Task evidence for ${p.currentHead ? `<code>${value(p.currentHead)}</code>` : "an unknown head"} · review policy ${value(human(review.policy))}.</p>
<div class="evidence-grid" data-key="evidence-grid">${cards.map(([label, evidence, context, link = ""]) => `<article class="evidence-card" data-key="${label}"><h3>${label}</h3>${tag(evidence.status)}${context}
<details data-key="provenance"><summary>Provenance <span class="sr-only">for ${label}</span></summary><dl>${fact("Source", value(evidence.source))}${fact("Observed", times(evidence.observedAt))}${fact("Head", value(evidence.head))}</dl></details>${link}</article>`).join("")}</div>`;
}

export function workspaceReview(w) {
  const r = w.review;
  return `<p>${esc(r.message)}</p>${r.retryAt && r.status !== "stale" ? `<p>Reviewer retry ${times(r.retryAt)}</p>` : ""}
${r.findings.length ? `<ol class="review-findings">${r.findings.map(f => `<li>${tag(f.severity)} ${esc(f.description)}${f.path ? `<br><code>${esc(f.path)}${f.line ? `:${f.line}` : ""}</code>` : ""}</li>`).join("")}</ol><p class="note">Showing ${r.findings.length} of ${r.total} recorded findings${r.status === "stale" ? " · historical evidence" : ""}.</p>` : '<p class="dim">No actionable finding summaries recorded.</p>'}
<details data-key="review-pieces"><summary>Reviewer pieces and qualification</summary><dl class="workspace-facts">${fact("Route", value(r.route))}${fact("Qualification", value(r.qualification))}${fact("Observed", times(r.observedAt))}${fact("Head", value(w.presentation.review.head))}</dl>
${r.pieces.length ? `<ol class="review-pieces">${r.pieces.map(status => `<li>${tag(status)}</li>`).join("")}</ol><p class="note">Showing ${r.pieces.length} of ${r.pieceCount} pieces.</p>` : ""}</details>`;
}

export function workspaceRecovery(w) {
  const r = w.presentation.recovery, route = w.route;
  const settings = w.recoverySettings;
  const incident = r.incidents[0] ?? r.original;
  const repair = r.repair;
  const cancellation = route.cancellation?.startsWith("stop-future")
    ? "Stops future dispatch. Remote execution may continue." : ["local", "cli"].includes(route.transport)
      ? "Process cessation must be verified" : "Provider confirmation required";
  return `<dl class="workspace-facts" data-key="recovery-state">
${fact("Current step", value(human(r.step)))}${fact("Next retry", cooldown(w.nextAt))}
${fact("Recovery profile", settings?.profileMode ? value(settings.profileMode) : r.profileDigest ? "Pinned profile unavailable" : "No approved profile recorded")}
${fact("Hold", r.control.held ? `Held · generation ${value(r.control.generation)}` : r.control.disabled ? "Repository disabled" : settings?.held ? "Held by recovery scope" : "No task hold recorded")}
${fact("Incident", incident ? `${value(human(incident.cause))} · <code title="${value(incident.id)}">${value(incident.id.slice(0, 12))}</code>` : "No incident recorded")}
${fact("Incident attempts", incident ? value(incident.attempts) : "Unknown")}
${fact("Recovery attempts across task", value(r.attempts))}${fact("Provider retries", value(r.retryAttempts))}
${fact("Cancellation", value(r.control.cancellation ? human(r.control.cancellation) : r.control.stopped ? "Dispatch stopped · confirmation unknown" : "No stop recorded"))}
${fact("Workspace cleanup", value(human(r.obligations.cleanup)))}</dl>
${repair ? `<details data-key="repair"><summary>Pinned repair evidence</summary><dl class="workspace-facts">
${fact("Pinned base", `<code>${value(repair.pinnedBase)}</code>`)}${fact("Repair phase", value(human(repair.phase)))}
${fact("Repair operation", `<code>${value(repair.operation)}</code>`)}${fact("Repair head", `<code>${value(repair.taskHead)}</code>`)}
${fact("Verify candidate", `<code>${value(repair.verify.head)}</code>`)}${fact("Verify results",
    repair.verify.head ? `${repair.verify.passed} passed${repair.verify.failed ? " · failures recorded" : ""}` : "No candidate verification recorded")}
${repair.failedJob ? fact("Failed CI job", value(repair.failedJob)) : ""}</dl></details>` : ""}
<details data-key="approved-route"><summary>Task route and limits</summary><p class="note">${route.approval ? "Route pinned in the plan approval." : "Task harness and recorded execution route."} ${value(w.presentation.provider.label)}.</p><dl class="workspace-facts">
${fact("Harness", value(route.harness))}${fact("Provider / model", `${value(route.provider)} / ${value(route.model)}`)}
${fact("Transport", value(route.transport))}${fact("Live qualification", value(route.qualification))}
${r.profileDigest ? fact("Profile digest", `<code>${value(r.profileDigest)}</code>`) : ""}
${fact("Continuation", value(human(route.continuation)))}${fact("Cancellation capability", value(cancellation))}
${fact("Implementation allowance (USD)", value(route.allowance))}${fact("Configured per-run allowance (USD)", value(route.runAllowance))}
${fact("Enforcement", route.cap === false ? "Provider hard cap unavailable" : route.cap === true ? "Adapter declares per-run support · task-wide enforcement unknown" : "Unknown")}
${fact("Runtime allowance", route.runtimeAllowance == null ? "Unknown" : `${value(route.runtimeAllowance / 1000)}s`)}
</dl>${route.limitation ? `<p>${value(route.limitation)}</p>` : ""}</details>
${incident ? `<details data-key="incident-provenance"><summary>Incident provenance</summary><dl class="workspace-facts">
${fact("Incident ID", `<code>${value(incident.id)}</code>`)}${fact("First recorded", times(incident.at))}
${fact("Source", value(incident.evidence))}${fact("Head", `<code>${value(incident.head)}</code>`)}</dl></details>` : ""}`;
}

export function workspaceActivity(w, { base = "", query = {}, clock = Date } = {}) {
  const p = w.presentation, r = p.recovery;
  const first = r.original ?? w.planFailure;
  const attemptLink = first?.run && /^[a-zA-Z0-9_-]+$/.test(first.run)
    ? at(base, "/run", query, { id: w.id, run: first.run }) : null;
  const reviewStatus = p.review.verdict === "unknown" ? p.review.status : p.review.verdict;
  const entries = [
    first && { kind: "failure", label: "Original failure", detail: human(first.cause ?? first.detail), at: first.at,
      anchor: "#workspace-recovery", head: first.head, attemptLink },
    w.review.observedAt && { kind: "review", label: "Independent review", detail: reviewStatus,
      at: w.review.observedAt, anchor: "#review-activity", head: p.review.head },
    !w.review.observedAt && p.checks.observedAt && !["unknown", "none"].includes(p.review.external) && {
      kind: "review", label: "External review", detail: p.review.external, at: p.checks.observedAt,
      anchor: "#workspace-evidence", head: p.checks.head },
    r.recoveryAt && (first || r.repair || r.control.id || r.retryAttempts != null) && { kind: "recovery", label: "Recovery activity",
      detail: human(r.step), at: r.recoveryAt, anchor: "#workspace-recovery", head: r.repair?.pinnedBase },
    p.acceptance.observedAt && { kind: "receipt", label: "Acceptance recorded", detail: p.acceptance.status,
      at: p.acceptance.observedAt, anchor: "#workspace-evidence", head: p.acceptance.head },
    (w.integration || p.closeout.state !== "unknown" || p.readiness.observedAt) && {
      kind: "delivery", label: "Delivery", detail: outcomeLabel(p.outcome),
      at: w.integration?.at ?? p.closeout.at ?? p.readiness.observedAt, anchor: "#workspace-evidence",
      head: w.integration?.head ?? p.closeout.head ?? p.readiness.head },
  ].filter(Boolean).sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  return entries.length ? `<ol class="provenance-timeline" data-key="timeline">${entries.map(event => `<li data-key="${event.kind}">
<div><a href="${event.anchor}">${event.label}</a> <span>${value(event.detail)}</span></div>
<div class="timeline-meta">${relativeTime(event.at, clock)}${event.head ? ` · <code title="${value(event.head)}">${value(event.head.slice(0, 12))}</code>` : ""}
${event.attemptLink ? `<a href="${esc(event.attemptLink)}">Open failure attempt</a>` : ""}</div></li>`).join("")}</ol>`
    : emptyState("No task evidence has been recorded for the timeline.");
}

export function workspaceExecution(w) {
  const e = w.execution;
  if (!w.attempt.id) return emptyState("No attempt has been recorded for this task.");
  return `<dl class="workspace-facts">${fact("Harness", value(e.harness))}${fact("Provider / model", `${value(e.provider)} / ${value(e.model)}`)}
${fact("Transport / provider state", `${value(e.transport)} / ${value(e.state)}`)}${fact("Selected attempt session", `<code>${value(e.session)}</code>`)}
${fact("Started", times(w.attempt.startedAt))}${fact("Ended", times(w.attempt.endedAt))}${fact("Duration", value(durationText(w.attempt.duration)))}
${fact("Worker exit", e.running ? "running" : value(e.exit))}${fact("Recorded cost (USD)", value(e.costUsd))}
${fact("Recorded tokens (input / output / total)", `${value(e.usage.input)} / ${value(e.usage.output)} / ${value(e.usage.total)}`)}
${fact("Provider observed", times(e.observedAt))}${fact("Provider reconciled", times(e.reconciledAt))}</dl>
<p class="note">Usage is from the selected attempt record. Task-wide spend is unknown.</p>${e.limitation ? `<p>${value(e.limitation)}</p>` : ""}`;
}

// On-demand selected-attempt evidence. The publication checkpoint establishes
// whether verification finished. Observed passes alone can be a partial run.
export function workspaceVerification(record, checkpoint) {
  if (record?.version !== 1 || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(record.head) || !Array.isArray(record.evidence)) return null;
  const valid = record.evidence.filter(row => row?.head === record.head && row.source === "coordinator-executed" && validVerificationSandbox(row.sandbox));
  const passed = valid.filter(row => row.exit === 0).length;
  const failed = valid.length - passed;
  const finished = checkpoint?.appliedHead === record.head && ["verified", "pushed", "publishing", "published"].includes(checkpoint.phase);
  return { head: record.head, passed, failed, status: failed ? "failed"
    : finished && passed > 0 && passed === record.evidence.length ? "passed" : passed > 0 ? "partial" : "unavailable" };
}

export function workspaceSnapshot(w, options) {
  return { version: 1, id: w.id, run: w.attempt.id, latest: w.latest, freshness: w.freshness, briefChanged: Boolean(w.brief.reason),
    observedAt: w.presentation.freshness.observedAt, snapshotAt: w.presentation.freshness.snapshotAt,
    summary: workspaceSummary(w, options), evidence: workspaceEvidence(w), review: workspaceReview(w),
    recovery: workspaceRecovery(w), activity: workspaceActivity(w, options), execution: workspaceExecution(w) };
}
