import { redact } from "../execution_io.mjs";
import { ago } from "../time.mjs";
import { attemptPresentation, durationText, instant } from "./presentation_time.mjs";
import { presentationFacts, phaseBadge } from "./presentation_html.mjs";
import { reviewActivity } from "./review.mjs";
import { esc, badge, notice } from "./primitives.mjs";
import { safeLink, externalLink } from "./links.mjs";
import { at } from "./shell.mjs";

const amount = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const fact = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const value = input => esc(input ?? "unknown");

// Only saved, allowlisted fields. Historical attempts never inherit current-run
// provider/session/cost observations. No provider call or transcript read here.
export function workspaceProjection({ id, entry, run, presentation: p, capabilities = {}, now, sanitize = redact }) {
  const text = (value, limit = 256) => typeof value === "string" ? sanitize(value).slice(0, limit) : null;
  const attempt = attemptPresentation(run, { entry, maxIterations: p.rounds.limit, now });
  const ex = run?.execution || {};
  const review = p.review.status === "stale-head" ? { status: "stale", message: "Historical review observation or unbound review; current-head review is unknown." } : reviewActivity(entry);
  const findings = Array.isArray(entry.firstPartyReview?.result?.findings) ? entry.firstPartyReview.result.findings : [];
  return {
    id, presentation: p, attempt, latest: text(entry.last?.run), branch: text(entry.branch),
    state: text(entry.state), taskSession: text(entry.session), harness: text(entry.harness), url: safeLink(entry.url),
    review: { ...review, observedAt: instant(entry.firstPartyReview?.completedAt || entry.firstPartyReview?.startedAt),
      total: findings.length, findings: findings.slice(0, 8).map(f => ({
        severity: ["critical", "high", "medium", "low"].includes(f?.severity) ? f.severity : "unknown",
        description: text(f?.description, 600) || "Finding summary unavailable; inspect the saved review.",
      })) },
    execution: { provider: text(ex.provider), model: text(ex.model), session: text(ex.sessionId),
      state: text(ex.providerState), observedAt: instant(ex.observedAt), reconciledAt: instant(ex.reconciledAt),
      costUsd: amount(ex.costUsd), transport: ["local", "remote"].includes(ex.transport) ? ex.transport : "unknown",
      continuation: text(capabilities.continuation), cancellation: typeof capabilities.controls?.cancel === "boolean" ? capabilities.controls.cancel ? "supported" : "unavailable" : "unknown",
      costSource: text(capabilities.cost?.source), available: capabilities.available === false ? "unavailable" : "unknown; no access probe performed", limitation: text(capabilities.reason),
      usage: { input: amount(ex.usage?.input_tokens), output: amount(ex.usage?.output_tokens), total: amount(ex.usage?.total_tokens) },
      exit: Number.isInteger(run?.exit) ? run.exit : null, running: run?.running === true },
  };
}

export function workspaceSummary(w, { base = "", query = {}, clock = Date } = {}) {
  const p = w.presentation;
  const chains = p.chains?.length ? p.chains : p.chain ? [p.chain] : [];
  return `<div class="workspace-summary">
${query.chain ? `<p><a href="${esc(at(base, "/chains", query))}">Back to chain ${esc(query.chain)}</a></p>` : ""}
<div class="workspace-heading"><div><p class="eyebrow">Task workspace</p><h2>${esc(w.id.split("/").at(-1))}</h2><p class="dim">${esc(redact(w.id))}</p></div>${phaseBadge(p)}</div>
<dl class="workspace-facts">${fact("Repository / approved base", `${value(p.delivery.repository)} / <code>${value(p.delivery.base)}</code>`)}${fact("Delivery target", value(p.delivery.target))}
${fact("Selected attempt", `<code>${value(w.attempt.id)}</code>`)}${fact("selected attempt duration", value(durationText(w.attempt.duration)))}
${fact("Activity age", p.activity.at ? `<time datetime="${esc(p.activity.at)}" data-relative-time>${esc(ago(p.activity.at, clock))}</time>` : "unknown")}
${fact("Task rounds", `round ${p.rounds.used ?? "unknown"}/${p.rounds.limit ?? "unknown"}`)}
${fact("Chain", chains.length ? chains.map(c => `<a href="${esc(at(base, "/chains", query, { chain: c.name, milestone: c.predecessor ? "" : w.id }))}">${esc(`${c.name || "Chain"} · ${c.predecessor ? "Predecessor" : `${c.position ?? "?"}/${c.total ?? "?"}`} · ${c.status || "unknown"}`)}</a>`).join("<br>") : "No chain recorded")}
${fact("Task delivery", w.url ? externalLink(w.url, `Open PR ${p.delivery.pr ? `#${p.delivery.pr}` : "evidence"}`) : p.delivery.pr ? `PR #${p.delivery.pr} · safe link unavailable` : "No PR recorded")}</dl>
${notice(`${p.attention.title} · ${p.attention.actor}. ${p.nextAction}`, p.attention.group === "attention" ? "warning" : "info")}
${w.latest && w.attempt.id !== w.latest ? `<p class="attempt-notice">Historical attempt selected. Task evidence below describes the current task. <a href="${esc(at(base, "/run", query, { id: w.id, run: w.latest }))}">Open latest attempt</a></p>` : ""}
<details class="workspace-technical"><summary>Task facts &amp; provenance</summary><dl class="facts">${presentationFacts(p)}<dt>task session</dt><dd>${value(w.taskSession)}</dd><dt>state code</dt><dd>${value(w.state)}</dd><dt>branch</dt><dd><code>${value(w.branch)}</code></dd><dt>harness</dt><dd>${value(w.harness)}</dd><dt>phase source</dt><dd>${value(p.phase.source)}</dd><dt>activity source</dt><dd>${value(p.activity.source)}</dd><dt>retry scheduled</dt><dd>${value(p.retryAt)}</dd></dl></details>
</div>`;
}

export function workspaceEvidence(w) {
  const p = w.presentation;
  const cards = [
    ["CI checks", p.checks.status, p.checks.source, p.checks.observedAt, p.checks.head],
    ["Independent review", p.review.verdict !== "unknown" ? p.review.verdict : p.review.status, p.review.source, p.review.observedAt, p.review.head],
    ["External review", p.review.external || "unknown", "entry.reviewObservation.external", p.checks.observedAt, p.checks.head],
    ["Acceptance receipt", p.acceptance.status, p.acceptance.source, p.acceptance.observedAt, p.acceptance.head],
    ["Delivery readiness", p.readiness.status, p.readiness.source, p.freshness.observedAt, null],
    ["Owner publication", p.ownerDelivery?.obligations.length ? p.ownerDelivery.obligations.map(o => `${o.kind}: ${o.status}`).join("; ") : "No owner obligation recorded", p.ownerDelivery?.source, p.ownerDelivery?.obligations[0]?.observedAt, p.ownerDelivery?.obligations[0]?.head],
  ];
  return `<div class="evidence-grid">${cards.map(([label, status, source, observed, head]) => `<article class="evidence-card"><h3>${esc(label)}</h3>${badge(status, ["passed", "clear", "accepted", "fulfilled"].includes(status) ? "success" : ["stale-head", "skipped", "blocking", "findings"].includes(status) ? "attention" : "")}<p>${label === "CI checks" && status === "pending" ? "Checks are not settled; inspect pending or failing checks on the PR." : label === "Acceptance receipt" && status === "skipped" ? "The acceptance gate was skipped. This is not a pass." : label === "Delivery readiness" ? "Delivery readiness, worker exit and integration are separate facts." : "Recorded evidence; missing observations remain unknown."}</p><details><summary>Provenance</summary><dl>${fact("Source", value(source))}${fact("Observed", value(observed))}${fact("Head", value(head))}</dl></details>${label === "Independent review" ? '<a href="#review-activity">Inspect reviewer findings</a>' : w.url ? externalLink(w.url, "Inspect PR evidence") : '<span class="dim">Evidence link unavailable</span>'}</article>`).join("")}</div>`;
}

export function workspaceReview(w) {
  return `<p>${esc(w.review.message)}</p><p class="note">Source: reviewActivity / firstPartyReview.result · observed ${value(w.review.observedAt)}. Reviewer findings are separate from operator messages and do not certify acceptance.</p>
${w.review.findings.length ? `<ol class="review-findings">${w.review.findings.map(f => `<li><strong>${esc(f.severity)}</strong> ${esc(f.description)}</li>`).join("")}</ol><p class="note">Showing ${w.review.findings.length} of ${w.review.total} recorded findings${w.review.status === "stale" ? " · historical evidence" : ""}.</p>` : '<p class="dim">No actionable finding summaries recorded.</p>'}`;
}

export function workspaceExecution(w) {
  const e = w.execution;
  return `<dl class="workspace-facts">${fact("Provider / model", `${value(e.provider)} / ${value(e.model)}`)}${fact("Transport / provider state", `${value(e.transport)} / ${value(e.state)}`)}${fact("Selected attempt session", `<code>${value(e.session)}</code>`)}${fact("Selected attempt rounds", `${w.attempt.rounds.used ?? "unknown"}/${w.attempt.rounds.limit ?? "unknown"}`)}${fact("Recorded cost (USD)", e.costUsd == null ? "unknown" : value(e.costUsd))}${fact("Cost source", `${value(e.costSource)} · run.execution.costUsd; task total unknown`)}${fact("Recorded tokens (input / output / total)", `${value(e.usage.input)} / ${value(e.usage.output)} / ${value(e.usage.total)} · run.execution.usage`)}${fact("Dispatch capability", `${value(e.available)}${e.limitation ? ` · ${value(e.limitation)}` : ""}`)}${fact("Continuation capability", value(e.continuation))}${fact("Cancellation capability", value(e.cancellation))}${fact("Provider observed / reconciled", `${value(e.observedAt)} / ${value(e.reconciledAt)}`)}${fact("Worker exit", e.running ? "running" : value(e.exit))}</dl><p class="note">Source: selected run execution record and configured capabilities. Missing session metadata does not establish continuity. Provider readiness: ${esc(w.presentation.provider.label)}.</p>`;
}

export function workspaceSnapshot(w, options) {
  return { version: 1, id: w.id, run: w.attempt.id, observedAt: w.presentation.freshness.observedAt, snapshotAt: w.presentation.freshness.snapshotAt,
    summary: workspaceSummary(w, options), evidence: workspaceEvidence(w), review: workspaceReview(w), execution: workspaceExecution(w) };
}
