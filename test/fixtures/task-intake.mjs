// Deterministic planning envelopes, never live-provider evidence.
import { collectCommands } from "../../lib/task_contract.mjs";
// `delivery` maps requirement IDs to planner delivery tags, standing in for a
// model's literal reading of a delivery clause; `assumptions` maps requirement
// IDs to an explicit assumption target instead of criteria.
export function draftFor(task, { question = false, conflict = false, delivery = {}, assumptions = {} } = {}) {
  const unanswered = question && !Object.keys(task.answers).length;
  const q = { id: "q-r-1", text: conflict ? "Should export use CSV or JSON?" : "Which file format should export use?", requirements: ["r-1"] };
  const verify = task.commandCandidates.includes("npm test") ? ["npm test", "npm run lint"].filter(c => task.commandCandidates.includes(c)) : task.commandCandidates.slice(0, 1);
  const commandSources = collectCommands(task.context, task.commandCandidates).sources;
  const resolved = task.requirements.filter((_, i) => !unanswered || i !== 0);
  const assumed = Object.values(assumptions);
  const output = {
    version: 1, title: "Export widgets from the table",
    problem: "Finance admins reconcile widget spending in spreadsheets every month. Today the widget table has no export action, so admins copy each visible row by hand and make transcription errors. A scoped export will preserve the selected records and their values while making the monthly reconciliation repeatable and reducing manual work for these users.",
    stories: [{ id: "us-1", text: "As a finance admin, I want to export widgets, so that I can reconcile spending.", requirements: [task.requirements[0].id] }],
    criteria: resolved.map((r, i) => ({ id: `ac-${i + 1}`, text: /dependencies/.test(r.text) ? "Given the current package manifest, when CSV export is installed, then dependency declarations remain unchanged." : "Given a table with three widgets, when Export is selected, then the requested file contains exactly three widget rows." })),
    mapping: task.requirements.map((r, i) => ({ requirementId: r.id, ...(unanswered && i === 0 ? { questionId: q.id } : assumptions[r.id] ? { assumption: assumptions[r.id] } : { criteria: [`ac-${resolved.indexOf(r) + 1}`], ...(task.answers[q.id] && r.id === "r-1" ? { resolvedBy: q.id } : {}) }), ...(delivery[r.id] ? { delivery: delivery[r.id] } : {}) })),
    questions: unanswered ? [q] : [], assumptions: ["Export includes the currently visible rows.", ...assumed],
    verify,
    sources: [...new Set([...task.context.filter(c => c.path.startsWith("docs/")).map(c => c.path), ...verify.flatMap(command => commandSources[command] || [])])],
    where: ["src/export/"], exclusions: ["PDF export and unrelated table changes."],
  };
  // Assumption-mapped clauses own no criterion; renumber so ac-N stays sequential.
  if (assumed.length) {
    const mapped = output.mapping.filter(m => m.criteria);
    output.criteria = mapped.map((_, i) => ({ id: `ac-${i + 1}`, text: output.criteria[0]?.text || "Given a table with three widgets, when Export is selected, then the requested file contains exactly three widget rows." }));
    mapped.forEach((m, i) => { m.criteria = [`ac-${i + 1}`]; });
  }
  return output;
}
