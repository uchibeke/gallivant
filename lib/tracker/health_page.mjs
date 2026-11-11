import { systemHealth } from "./health.mjs";
import { esc, badge, button } from "./primitives.mjs";
import { page, header } from "./shell.mjs";
import { onboarding } from "./onboarding.mjs";

const time = at => at ? `<time datetime="${esc(at)}">${esc(at)}</time>` : "Unknown";
const fact = (label, value) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
const tone = state => state === "up" ? "live" : state === "down" ? "bad" : ["busy", "stale", "pending"].includes(state) ? "attention" : "";
const providerCard = p => `<article class="health-provider" data-key="provider:${esc(p.name)}"><div class="health-provider-heading"><h3>${esc(p.name)}</h3>${badge(p.transport)}</div><p class="health-account">${esc(p.account.label)}</p><dl class="health-facts">${fact("Registry", p.registered ? "Registered" : "Unknown")}${fact("Installation", p.installed)}${fact("Configuration", p.configured ? "Entry present; validity checked at start" : "Not configured")}${fact("Implementation", p.supported ? "Declared support" : "Unavailable")}${fact("Live qualification", p.qualification)}${fact("Dispatch readiness", p.dispatch)}</dl><p class="health-next">${esc(p.nextStep)}</p><div class="health-observations"><p>Last account observation<br>${time(p.account.observedAt)}</p><p>Next readiness check<br>${time(p.nextAt)}</p></div>
<details data-key="support:${esc(p.name)}"><summary>Capabilities &amp; limits</summary><ul>${p.hosts.map(h => `<li>${esc(h.host)}: ${h.available ? "declared repository support" : esc(h.reason)}</li>`).join("")}<li>${p.preparation ? "Tool-free preparation is supported." : "Tool-free preparation is unavailable. Use an explicitly configured bounded model route or the CLI written-brief workflow."}</li><li>${p.interrupt ? "Interrupt is supported when task controls permit it." : "Interrupt is unavailable for this transport. Use only the task controls offered for the current execution."}</li><li>Inference access: ${esc(p.account.inference)}. A saved readiness check is not proof of a model call.</li></ul></details></article>`;

export function healthContent(health, options = {}) {
  const c = health.coordinator;
  return `<div id="health-results" data-key="health-results">
<section class="health-coordinator" aria-labelledby="coordinator-title" data-key="coordinator"><div><p class="eyebrow">Coordinator</p><h2 id="coordinator-title">Workspace observation ${badge(c.state, tone(c.state))}</h2><p>${esc(c.nextStep)}</p></div><dl><div><dt>Last observation</dt><dd>${time(c.observedAt)}</dd></div><div><dt>Next cycle scheduled</dt><dd>${time(c.nextAt)}</dd></div></dl></section>
<section aria-labelledby="providers-title"><div class="health-section-heading"><div><h2 id="providers-title">Providers &amp; harnesses</h2><p>Registry support, setup and current account checks are separate facts.</p></div><span class="tag">${health.providers.filter(p => p.configured).length} configured</span></div>
<div class="health-providers">${health.providers.filter(p => p.configured).map(providerCard).join("") || "<p>No providers are configured. Follow the setup guidance below.</p>"}</div><details class="health-catalogue" data-key="catalogue"><summary>Other registered providers (${health.providers.filter(p => !p.configured).length})</summary><div class="health-providers">${health.providers.filter(p => !p.configured).map(providerCard).join("")}</div></details></section>
<section aria-labelledby="hosts-title"><h2 id="hosts-title">Git hosts</h2><div class="health-hosts">${health.hosts.map(h => `<article data-key="host:${esc(h.host)}"><h3>${esc(h.host)}</h3><p>${esc(h.nextStep)}</p><p class="hint">Account and repository access are checked by the existing readiness workflow.</p></article>`).join("")}</div></section>
${onboarding(health.setup, options)}</div>`;
}
export function healthSnapshot(ctx, options = {}) {
  const health = systemHealth(ctx);
  return { health, observedAt: health.observedAt, content: healthContent(health, options) };
}
export function healthPage(ctx, { base = "", query = {}, theme = null, home = null } = {}) {
  const snapshot = healthSnapshot(ctx, { base, query });
  return page({ title: "System health", base, theme, body: `${header(base, "System health", "health", query, home)}<main class="main health" id="main" tabindex="-1" data-health><div class="health-connection"><p id="health-status" role="status">Snapshot loaded · <time datetime="${snapshot.observedAt}">${snapshot.observedAt}</time></p>${button("Refresh observations", { id: "health-refresh" })}${button("Apply health updates", { id: "health-apply", hidden: true })}</div><p class="health-read-only">Refresh reads saved observations only. The coordinator schedules readiness checks and retries; this page never probes providers or starts model calls. Task activity times do not change when you refresh.</p>${snapshot.content}</main>` });
}
