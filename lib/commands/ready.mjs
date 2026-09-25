// `gallivant ready <prd.md> [--check]`: the only way a PRD becomes `ready`. Runs every rule in the contract,
// prints the checklist, asks APort to record the decision, and flips the status only on an allow. `--check`
// prints without writing. The decision id is written into the PRD's frontmatter as `aport_decision`.
//
// It does not commit: the daemon reads its own snapshot of the PRD taken by `start`, so the file's git state does
// not affect the loop, and committing on the operator's behalf from an unknown cwd was a guess.
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { parsePrd, check, renderCheck, withStatus, withFrontmatterKey, RULES } from "../prd.mjs";
import { decidePrdReady, PRD_LIMITS } from "../deliverable.mjs";
import { readText } from "../fs.mjs";

export async function ready({ path, checkOnly = false, config = null, apiKey = null, fetch = globalThis.fetch, log = null }) {
  const abs = resolve(path);
  const text = readText(abs);
  if (text === null) throw new Error(`cannot read ${abs}`);
  const prd = parsePrd(text, abs);
  const verdict = check(prd);
  let report = renderCheck(prd, verdict);
  if (!verdict.ok || checkOnly) return { ok: verdict.ok, report, changed: false, decisionId: null };

  // The contract passed locally. With a config whose gate is on, APort records the decision and its deny wins.
  // Without a config, or with the gate off, the decision is local only.
  const d = config?.deliverable ?? null;
  const limits = { ...PRD_LIMITS, ...(d ? { evaluator: d.evaluator, api_url: d.api_url } : { evaluator: "local" }) };
  const decision = await decidePrdReady({ prd, verdict, rules: RULES, limits, apiKey, fetch, log });
  if (!decision.allow) {
    report += `\n\nAPort (${decision.source}) denied readiness:\n${decision.denials.map(x => `  - ${x.code}: ${x.message}`).join("\n")}`;
    return { ok: false, report, changed: false, decisionId: null };
  }
  report += `\nAPort decision (${decision.source}): allow${decision.decisionId ? ` ${decision.decisionId}` : ""}`;
  if (prd.status === "ready") return { ok: true, report: report + "\n(already ready)", changed: false, decisionId: decision.decisionId };

  let next = withStatus(text, "ready");
  if (decision.decisionId) next = withFrontmatterKey(next, "aport_decision", decision.decisionId);
  writeFileSync(abs, next);
  return { ok: true, report: report + "\nstatus set to ready. Commit the PRD when you commit the rest of your work.", changed: true, decisionId: decision.decisionId };
}
