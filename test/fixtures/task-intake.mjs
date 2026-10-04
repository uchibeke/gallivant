// Deterministic planning envelopes, never live-provider evidence.
export function draftFor(task, { question = false, conflict = false } = {}) {
  const unanswered = question && !Object.keys(task.answers).length;
  const q = { id: "q-r-1", text: conflict ? "Should export use CSV or JSON?" : "Which file format should export use?", requirements: ["r-1"] };
  return {
    version: 1, title: "Export widgets from the table",
    problem: "Finance admins reconcile widget spending in spreadsheets every month. Today the widget table has no export action, so admins copy each visible row by hand and make transcription errors. A scoped export will preserve the selected records and their values while making the monthly reconciliation repeatable and reducing manual work for these users.",
    stories: ["As a finance admin, I want to export widgets, so that I can reconcile spending."],
    criteria: task.requirements.map((r, i) => ({ id: `ac-${i + 1}`, text: /dependencies/.test(r.text) ? "Given the current package manifest, when CSV export is installed, then dependency declarations remain unchanged." : "Given a table with three widgets, when Export is selected, then the requested file contains exactly three widget rows." })),
    mapping: task.requirements.map((r, i) => ({ requirementId: r.id, ...(unanswered && i === 0 ? { questionId: q.id } : { criteria: [`ac-${i + 1}`], ...(task.answers[q.id] && r.id === "r-1" ? { resolvedBy: q.id } : {}) }) })),
    questions: unanswered ? [q] : [], assumptions: ["Export includes the currently visible rows."],
    verify: task.commandCandidates.includes("npm test") ? ["npm test", "npm run lint"].filter(c => task.commandCandidates.includes(c)) : task.commandCandidates.slice(0, 1),
    sources: task.context.filter(c => c.path.startsWith("docs/")).map(c => c.path),
    where: ["src/export/"], exclusions: ["PDF export and unrelated table changes."],
  };
}
