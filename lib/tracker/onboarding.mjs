import { shellQuote } from "../runtime-environment.mjs";
import { esc, button } from "./primitives.mjs";
import { at } from "./shell.mjs";

export const cliCommand = (...args) => args.map(shellQuote).join(" ");
const copy = (label, command) => `<div class="setup-command"><code>${esc(command)}</code>${button("Copy command", { "data-copy-command": command, "aria-label": `Copy ${label} command` })}</div>`;
export function onboarding(setup, { base = "", query = {} } = {}) {
  if (!setup || setup.repositories && setup.tasks && setup.configuredProviders) return "";
  return `<section class="onboarding" data-key="onboarding" aria-labelledby="setup-title"><p class="eyebrow">Get started</p><h2 id="setup-title">${!setup.repositories ? "Connect your first repository" : !setup.configuredProviders ? "Configure an execution provider" : "Prepare your first task"}</h2>
<p>${!setup.repositories ? "No repositories are configured. In your approved GitHub checkout, initialize the repository with a supported local harness. Choose Codex or Claude explicitly. Hosted providers and Bitbucket use the operator configuration described by doctor; init does not set them up." : "Use an approved repository checkout. The CLI registers its source checkout; the workspace can then prepare work for that repository."}</p>
${!setup.repositories ? copy("initialize repository", cliCommand("gallivant", "init", "--harness", "codex")) : ""}
<p>Inspect setup and connectivity. This command does not run a model; do not add <code>--probe</code> unless you intend a live qualification.</p>${copy("check setup", cliCommand("gallivant", "doctor"))}
<details><summary>Start from a written brief</summary><p>Create a draft in the current repository, then edit its requirements and Verify commands before recording readiness.</p>${copy("create brief", cliCommand("gallivant", "new", "first-task"))}${copy("validate brief", cliCommand("gallivant", "ready", "docs/prds/first-task.md", "--check"))}<p>After reviewing the brief, record readiness. Starting authorizes execution and may incur provider usage.</p>${copy("record readiness", cliCommand("gallivant", "ready", "docs/prds/first-task.md"))}${copy("start task", cliCommand("gallivant", "start", "docs/prds/first-task.md"))}</details>
<a class="intake-primary-link" href="${esc(at(base, "/task/new", query))}">Open task preparation</a><p class="hint" role="status" data-copy-status></p></section>`;
}
