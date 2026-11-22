import { systemHealth } from "./health.mjs";
import { esc, badge, button } from "./primitives.mjs";
import { page, header } from "./shell.mjs";
import { onboarding } from "./onboarding.mjs";
import { capacityProjection } from "./factory_projection.mjs";
import { cooldown, fact } from "./presentation_html.mjs";

const time = at => at ? `<time datetime="${esc(at)}">${esc(at)}</time>` : "Unknown";
const textFact = (label, value) => fact(label, esc(value));
const tone = state => state === "up" ? "live" : state === "down" ? "bad" : ["busy", "stale", "pending"].includes(state) ? "attention" : "";
const providerCard = p => `<article class="health-provider" data-key="provider:${esc(p.name)}"><div class="health-provider-heading"><h3>${esc(p.name)}</h3>${badge(p.transport)}</div><p class="health-account">${esc(p.account.label)}</p><dl class="health-facts">${textFact("Registry", p.registered ? "Registered" : "Unknown")}${textFact("Installation", p.installed)}${textFact("Configuration", p.configured == null ? "Outside this view’s scope" : p.configured ? "Entry present; validity checked at start" : "Not configured")}${textFact("Implementation", p.supported ? "Declared support" : "Unavailable")}${textFact("Live qualification", p.qualification)}${textFact("Dispatch readiness", p.dispatch)}</dl><p class="health-next">${esc(p.nextStep)}</p><div class="health-observations"><p>Last account observation<br>${time(p.account.observedAt)}</p><p>Next readiness check<br>${cooldown(p.nextAt)}</p></div>
<details data-key="support:${esc(p.name)}"><summary>Capabilities &amp; limits</summary><ul>${p.hosts.map(h => `<li>${esc(h.host)}: ${h.available ? "declared repository support" : esc(h.reason)}</li>`).join("")}<li>${p.preparation ? "Tool-free preparation is supported." : "Tool-free preparation is unavailable. Use an explicitly configured bounded model route or the CLI written-brief workflow."}</li><li>${p.interrupt ? "Interrupt is supported when task controls permit it." : "Interrupt is unavailable for this transport. Use only the task controls offered for the current execution."}</li><li>Inference access: ${esc(p.account.inference)}. A saved readiness check is not proof of a model call.</li></ul></details></article>`;

export function healthContent(health, options = {}) {
  const c = health.coordinator, scoped = options.access?.protectedReads;
  return `<div id="health-results" data-key="health-results">
<section class="health-coordinator" aria-labelledby="coordinator-title" data-key="coordinator"><div><p class="eyebrow">Coordinator</p><h2 id="coordinator-title">Workspace observation ${badge(c.state, tone(c.state))}</h2><p>${esc(c.nextStep)}</p></div><dl><div><dt>Last observation</dt><dd>${time(c.observedAt)}</dd></div><div><dt>Next cycle scheduled</dt><dd>${time(c.nextAt)}</dd></div></dl></section>
${health.capacity ? `<section data-key="capacity" aria-labelledby="capacity-title"><h2 id="capacity-title">Capacity</h2><dl class="health-facts">${textFact("Active authors", `${health.capacity.activeAuthors ?? "Unknown"} · ${health.capacity.scope}`)}${textFact("Author limit", health.capacity.authorLimit ?? "Unknown")}${textFact("Preparation reservations", health.capacity.preparations ?? "Unknown")}</dl></section>` : ""}
<section aria-labelledby="providers-title"><div class="health-section-heading"><div><h2 id="providers-title">Providers &amp; harnesses</h2><p>${scoped ? "Showing declared capabilities. Installation-level account observations are outside this workspace scope." : "Registry support, setup and current account checks are separate facts."}</p></div>${scoped ? "" : badge(`${health.providers.filter(p => p.configured).length} configured`)}</div>
<div class="health-providers">${health.providers.filter(p => p.configured).map(providerCard).join("") || (scoped ? "" : "<p>No providers are configured. Follow the setup guidance below.</p>")}</div><details class="health-catalogue" data-key="catalogue"><summary>${scoped ? "Registered providers" : "Other registered providers"} (${health.providers.filter(p => !p.configured).length})</summary><div class="health-providers">${health.providers.filter(p => !p.configured).map(providerCard).join("")}</div></details></section>
${health.collaboration ? `<section aria-labelledby="collaboration-title" data-key="collaboration"><h2 id="collaboration-title">Collaboration delivery ${badge(health.collaboration.state, tone(health.collaboration.state))}</h2><p>${esc(health.collaboration.nextStep)}</p><dl class="health-facts">${textFact("Policy", health.collaboration.policy)}${textFact("Pending transitions", String(health.collaboration.pending))}${textFact("Failed transitions", String(health.collaboration.failed))}${textFact("Last delivery", health.collaboration.lastSuccessAt || "Unknown")}${fact("Next retry", cooldown(health.collaboration.nextAttemptAt))}${textFact("Last error code", health.collaboration.lastError || "None")}</dl></section>` : ""}
<section aria-labelledby="hosts-title"><h2 id="hosts-title">Git hosts</h2><div class="health-hosts">${health.hosts.map(h => `<article data-key="host:${esc(h.host)}"><h3>${esc(h.host)}</h3><p>${esc(h.nextStep)}</p><p class="hint">Account and repository access are checked by the existing readiness workflow.</p></article>`).join("")}</div></section>
${options.access?.protectedReads ? "" : onboarding(health.setup, options)}</div>`;
}
export function healthSnapshot(ctx, options = {}) {
  const health = systemHealth(ctx);
  if (options.access) health.capacity = capacityProjection(options.access, ctx.config);
  if (options.access?.protectedReads) {
    health.setup.configuredProviders = null;
    health.providers = health.providers.map(p => ({ ...p, configured: null, dispatch: p.supported ? "unknown" : p.dispatch,
      nextStep: p.supported ? "Use the operator’s local setup to inspect current account readiness." : p.hosts.find(h => h.reason)?.reason }));
  }
  return { health, observedAt: health.observedAt, content: healthContent(health, options) };
}
export function healthPage(ctx, { base = "", query = {}, theme = null, home = null, access } = {}) {
  const snapshot = healthSnapshot(ctx, { base, query, access });
  return page({ title: "System health", base, theme, body: `${header(base, "System health", "health", query, home)}<main class="main health" id="main" tabindex="-1" data-health data-snapshot="health"><div class="health-connection"><p id="health-status" role="status">Snapshot loaded · <time datetime="${snapshot.observedAt}">${snapshot.observedAt}</time></p>${button("Refresh observations", { id: "health-refresh" })}${button("Apply health updates", { id: "health-apply", hidden: true })}</div><p class="health-read-only">Refresh reads saved observations. The coordinator schedules readiness checks and retries.</p>${snapshot.content}</main>` });
}
