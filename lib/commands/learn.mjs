import { createInterface } from "node:readline/promises";
import { createLearningService } from "../learning.mjs";
import { gallivantHome } from "../fs.mjs";
import { join } from "node:path";
import { candidateId, digestField, learningError, canonical } from "../learning_data.mjs";

const allowed = {
  collect: ["repo", "since", "until", "dry-run", "json"], doctor: ["repo", "json"], setup: ["key-path", "ssh-keygen", "json"],
  configure: ["repo", "mode", "json"], list: ["repo", "status", "json"], show: ["repo", "revision", "json"],
  revise: ["repo", "from", "json"], approve: ["repo", "revision", "reason", "json"], reject: ["repo", "revision", "reason", "json"],
  retire: ["repo", "revision", "reason", "json"], explain: ["repo", "run", "json"], report: ["repo", "json"],
  recover: ["repo", "json"], prune: ["repo", "json"], extract: ["repo", "learning-budget", "json"],
};
export async function operatorConfirmation(preview) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw learningError("TERMINAL", "review requires an interactive operator terminal");
  process.stdout.write(preview + "\n"); // Complete frozen JSON. No pager, links, editor, ANSI or truncation.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question("Review every displayed field. Type APPROVE to request fresh passphrase signing: ")).trim() === "APPROVE"; }
  finally { rl.close(); }
}
export async function learnCommand(ctx, { args = [], values = {}, confirm = operatorConfirmation } = {}) {
  const operation = args[0] || "collect", id = args[1];
  if (!allowed[operation] || args.length > (["show", "revise", "approve", "reject", "retire"].includes(operation) ? 2 : 1)) throw learningError("INPUT", "unknown learning command or extra arguments");
  for (const key of Object.keys(values)) if (!allowed[operation].includes(key)) throw learningError("INPUT", `--${key} is not allowed for learn ${operation}`);
  let service = ctx.learning || ctx.learningFor?.(operation === "collect" ? await ctx.gh.user() : undefined, { signerExecutable: values["ssh-keygen"] });
  if (!service) service = createLearningService({ root: join(ctx.home || gallivantHome(), "learning"), signerExecutable: values["ssh-keygen"] });
  if (operation === "setup") return service.setup({ keyPath: values["key-path"], confirm });
  if (operation === "doctor" && !values.repo) return service.doctor();
  if (!values.repo) throw learningError("INPUT", "--repo owner/repository is required");
  // Local inspection and emergency disable must work during credential/repository outages.
  const disabling = operation === "configure" && values.mode === "off";
  const repo = disabling || ["list", "show", "report", "explain", "recover", "prune", "extract"].includes(operation) ? service.identityFor(values.repo) : await service.resolveRepo(values.repo);
  if (!repo) throw learningError("REPOSITORY", "repository has no learning state; configure collect first");
  if (operation === "configure" && !disabling) {
    const remembered = service.identityFor(values.repo);
    if (remembered && canonical(remembered) !== canonical(repo)) throw learningError("REPOSITORY", "repository identity changed; remembered identity retained for local disable");
  }
  if (["show", "revise", "approve", "reject", "retire"].includes(operation)) candidateId(id);
  switch (operation) {
    case "doctor": return service.doctor(repo);
    case "configure": { const result = await service.configure(repo, values.mode); if (!disabling) service.rememberRepo(values.repo, repo); return result; }
    case "collect": return service.collect(repo, values.repo, { since: values.since, until: values.until, dryRun: values["dry-run"] || false });
    case "list": return service.list(repo, values.status);
    case "show": return service.show(repo, id, values.revision);
    case "revise": if (!values.from) throw learningError("INPUT", "revise requires --from reviewed-rule.json"); return service.reviseFromFile(repo, id, values.from);
    case "reject": return service.reject(repo, id, values.revision, values.reason);
    case "approve": case "retire": return service.approve(repo, [{ id, digest: digestField(values.revision) }], { action: operation === "retire" ? "retire" : "approve", reason: values.reason || null, confirm });
    case "recover": return service.recover(repo);
    case "prune": return service.prune(repo);
    case "extract": return service.extract(repo, { allowanceUsd: Number(values["learning-budget"] || 0) });
    case "explain": if (!values.run) throw learningError("INPUT", "explain requires --run RUN_ID"); return service.explain(repo, values.run);
    case "report": return service.report(repo);
  }
}
