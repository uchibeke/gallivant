import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerDelivery, ownerImplementation, validateOwnerDelivery, ownerDeliveryFromPrd, assertDeliveryAnswer } from "../lib/owner_delivery.mjs";
import { completionView } from "../lib/task_completion.mjs";
import { parsePrd, prdFingerprint, contractOf, contractDiff, check } from "../lib/prd.mjs";
import { GOOD_PRD } from "./helpers.mjs";

test("ownership partitions exact Unicode source and removes only affirmative publication", () => {
  for (const source of [
    "Improve the café greeting, test it, and open one pull request for review; do not merge or add dependencies.",
    "Implement CSV and JSON export. Test both. Open a PR for review. Do not release.",
  ]) {
    const contract = ownerDelivery(source);
    assert.equal(contract.source, source); assert.equal(contract.offsets, "utf16");
    assert.equal(contract.spans.map(s => source.slice(s.start, s.end)).join(""), source);
    assert.equal(contract.spans[0].start, 0); assert.equal(contract.spans.at(-1).end, source.length);
    for (let i = 1; i < contract.spans.length; i++) assert.equal(contract.spans[i - 1].end, contract.spans[i].start);
    assert.doesNotMatch(ownerImplementation(contract).join(""), /open (?:one pull request|a PR)/i);
    assert.match(ownerImplementation(contract).join(""), /do not (?:merge|release)/i);
    const forged = structuredClone(contract); forged.spans[0].end--;
    assert.throws(() => validateOwnerDelivery(forged), { code: "TASK_DELIVERY_SCOPE" });
  }
});

test("quoted/code examples never create publication authority", () => {
  for (const source of ['Render "Open one pull request for review" in help.', "Render `Open a PR` in help.", "Show 'Open a PR' in the example.", "Document this example:\n```\nOpen a PR\n```"])
    assert.equal(ownerDelivery(source), null);
});

test("initial requests cannot contradict the default publication workflow", () => {
  for (const instruction of ["Keep the change local", "Do not push", "Don't commit", "Return a patch only", "Show diff only", "Wait for my review", "Pause the task", "Withhold the changes"]) {
    for (const source of ["Implement export. " + instruction + ".", "Implement export, " + instruction + ", and open a PR for review."])
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  assert.equal(ownerDelivery('Render the literal labels "local", "patch" and "review".'), null);
  assert.ok(ownerDelivery('Render "Keep the change local". Open a PR for review.'));
});

test("implementation nouns are not lifecycle instructions in initial requests or answers", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const source of ["Add local storage.", "Keep local storage working.", "Add a review dashboard.", "Display commit SHA in diagnostics.", "Fix the diff viewer.", "Add branch selection.", "Implement export. Scope: aporthq/task-delivery-onboarding-qualification only."]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, source), source);
    assert.ok(ownerDelivery(source.replace(/ Scope:.*$/, "") + " Open a PR for review."), source);
  }
});

test("publication subjects and technical conditions remain implementation scope", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const source of ["Add a PR status badge.", "Build a pull-request dashboard.", "Update the pull request template to require changelog entries.", "Fix parsing of PR titles.", "Add a list of published articles.", "Use local time for display.", "Preserve branch sorting order.", "Commit the database transaction after validation."]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, source), source);
  }
  const text = "If name is empty, return friend. Open a PR for review.";
  assert.equal(ownerImplementation(ownerDelivery(text)).join("").trim(), "If name is empty, return friend.");
  for (const source of ["Wait for my approval. Open a PR for review.", "Implement export. Do not proceed until I approve.", "Implement export. My approval is required.", "Implement export. My approval is required. Open a PR.", "Implement export. Publish the changes.", "Implement export. Send a PR for review.", "Implement export. Open a pull-request.", "Implement export. Only if tests pass open a PR."]) assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
  for (const answer of ["Wait for my approval.", "Do not proceed until I approve.", "My confirmation is required.", "Skip publication.", "No PR should be created.", "Send it for review."]) assert.throws(() => assertDeliveryAnswer(task, answer), { code: "TASK_DELIVERY_SCOPE" }, answer);
});

test("publication-subject conditions and standalone gates remain owner controls", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const clause of ["Publication only after tests pass.", "PR only after approval.", "Publishing requires approval.", "Only after tests pass.", "Keep changes only local."]) {
    assert.throws(() => ownerDelivery("Implement export. " + clause), { code: "TASK_DELIVERY_SCOPE" }, clause);
    assert.throws(() => ownerDelivery("Implement export. Open a PR. " + clause), { code: "TASK_DELIVERY_SCOPE" }, clause);
    assert.throws(() => assertDeliveryAnswer(task, clause), { code: "TASK_DELIVERY_SCOPE" }, clause);
  }
});

test("ambiguous, conditional, qualified and delivery-only requests refuse before planning", () => {
  for (const source of [
    "Please open one pull request for review.", "Open a PR.", "Open a PR; do not merge or release.",
    "Implement export. Do not: open a PR.", "Implement export. Do not merge; open a PR.",
    "Implement export. No PR should be created.", "Implement export. Do not publish anything.",
    "Implement export. Only if tests pass open a PR.",
    "Wait for my explicit confirmation before proceeding. Open a PR for review.",
    "Implement export. Open a PR for review. Wait for my permission first.",
    "Implement export. Open a PR against release.", "Implement export. Open a PR in other/repo.",
    "Implement export. Open a PR and release it.", "Implement export. Explain how to open a PR.",
    "Implement export. Open a PR. Open another PR.",
    "Implement export. Publish the changes for review.", "Implement export. Send a PR for review.", "Implement export. Open a pull-request.",
  ]) assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
});

test("unsupported positive publication forms require clarification instead of provider criteria", () => {
  for (const clause of ["Publish the changes for review", "Send a PR for review", "Open a pull-request", "Publish the changes", "Prepare the PR", "Open pull-requests"])
    assert.throws(() => ownerDelivery(`Implement export. ${clause}.`), { code: "TASK_DELIVERY_SCOPE" }, clause);
  assert.equal(ownerDelivery('Render "Publish the changes for review" and `Open a pull-request` in help.'), null);
  assert.throws(() => assertDeliveryAnswer({}, "Open a pull-request"), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, "Do not publish publicly."), { code: "TASK_DELIVERY_SCOPE" });
});

test("initial delivery restrictions cannot become implementation criteria under the default review target", () => {
  for (const restriction of ["Keep the change local", "Keep this local", "Keep changes local-only", "Leave these edits uncommitted", "Do not push", "Don't run git push", "Never commit",
    "Return a patch only", "Show only a diff", "Only return a patch", "Just return a diff", "Do not send it for review", "Pause delivery", "Hold the change for my approval", "Wait for my approval"]) {
    for (const text of [`Implement CSV export. ${restriction}.`, `Implement CSV export. Open a PR for review. ${restriction}.`])
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({ completion: { version: 1, target: "delivery_ready" } }, restriction), { code: "TASK_DELIVERY_SCOPE" });
  }
  for (const text of ['Document "Keep the change local", "Do not push" and `Return a patch only`.',
    "Implement branch sorting. Update the patch renderer. Cache local timezone offsets."])
    assert.equal(ownerDelivery(text), null);
  assert.ok(ownerDelivery("Implement branch sorting. Update the patch renderer. Open a PR for review."));
});

test("new-request delivery restrictions do not reinterpret exact saved ownership versions", () => {
  const source = "Implement CSV export. Open a PR for review. Keep the change local.";
  const start = source.indexOf("Open"), end = source.indexOf(" Keep");
  for (const version of [1, 2]) {
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end, owner: "coordinator", kind: "pull_request" },
      { start: end, end: source.length, owner: "implementation" },
    ] };
    const before = structuredClone(saved);
    assert.equal(validateOwnerDelivery(saved), saved);
    assert.deepEqual(saved, before);
  }
  assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" });
});

test("new answers cannot silently override existing publication ownership", () => {
  const task = { ownerDelivery: ownerDelivery("Implement export. Open a PR for review.") };
  for (const answer of ["Do not open a PR until I approve the change", "Wait for my confirmation first.", "Only publish after permission.", "Do not publish anything", "Skip publication", "Keep the change local", "Do not send it for review", "Show diff only", "Do not push", "Return a patch without publishing", "Hold the change for my approval"])
    assert.throws(() => assertDeliveryAnswer(task, answer), { code: "TASK_DELIVERY_SCOPE" });
  assert.doesNotThrow(() => assertDeliveryAnswer(task, "Use CSV and preserve the existing dependency declarations."));
  assert.doesNotThrow(() => assertDeliveryAnswer(task, 'The label is "Open a PR".'));
  assert.throws(() => assertDeliveryAnswer({ completion: { version: 1, target: "delivery_ready" } }, "Keep the change local"), { code: "TASK_DELIVERY_SCOPE" });
  assert.doesNotThrow(() => assertDeliveryAnswer({}, "Keep the change local"), "legacy tasks without a completion contract retain their answer behavior");
});

test("publication owns its terminator and courtesy prefix, never a punctuation-only provider requirement", () => {
  for (const source of ["Implement export. Open a PR for review.", "Implement export. Open a PR; do not merge.", "Implement export.\nPlease open a PR for review.\nDo not merge."]) {
    const contract = ownerDelivery(source), implementation = ownerImplementation(contract);
    assert.equal(contract.spans.map(s => source.slice(s.start, s.end)).join(""), source);
    assert.ok(implementation.every(s => !s.trim() || /[\p{L}\p{N}]/u.test(s)), JSON.stringify(implementation));
    assert.ok(implementation.every(s => !/^[.;]/.test(s.trim())), JSON.stringify(implementation));
    assert.ok(implementation.every(s => !/\bPlease\s*$/i.test(s.trim())), JSON.stringify(implementation));
  }
});

test("publication owns recognized connectors without changing implementation text or exact source coverage", () => {
  for (const connector of [", and ", ", and then ", ", then ", ", ", " and ", " and then ", " then ", ", AND THEN "]) {
    const implementation = 'Implement CSV and JSON export for the café label "and then"';
    const source = `${implementation}${connector}open a PR for review; do not merge or add dependencies.`;
    const contract = ownerDelivery(source);
    assert.deepEqual(ownerImplementation(contract), [implementation, " do not merge or add dependencies."], connector);
    assert.equal(contract.version, 2);
    assert.equal(contract.spans.map(span => source.slice(span.start, span.end)).join(""), source);
    assert.equal(contract.spans.find(span => span.owner === "coordinator").start, implementation.length);
    assert.equal(validateOwnerDelivery(contract), contract);
  }
  for (const source of ["Implement export only if approved, and open a PR.", "Do not merge, and then open a PR.", "Implement export, and open a PR after approval.",
    'Implement export, "preserve CSV headers" open a PR for review.', 'Implement export and "literal" open a PR for review.',
    "Implement export,\nand open a PR for review.", "Implement export, and\nopen a PR for review.", "Implement export, and then\nPlease open a PR for review."])
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" });
});

test("saved version-one ownership remains exact and cannot authorize forged connector ranges", () => {
  const source = "Implement CSV export, and open a PR for review.";
  const split = source.indexOf("open");
  const legacy = { version: 1, offsets: "utf16", source, spans: [
    { start: 0, end: split, owner: "implementation" },
    { start: split, end: source.length, owner: "coordinator", kind: "pull_request" },
  ] };
  const before = structuredClone(legacy);
  assert.equal(validateOwnerDelivery(legacy), legacy);
  assert.deepEqual(ownerImplementation(legacy), ["Implement CSV export, and "]);
  assert.deepEqual(legacy, before);
  const corrected = ownerDelivery(source);
  assert.deepEqual(ownerImplementation(corrected), ["Implement CSV export"]);
  for (const value of [{ ...corrected, version: 1 }, { ...legacy, version: 2 }, { ...corrected, version: 3 }])
    assert.throws(() => validateOwnerDelivery(value), { code: "TASK_DELIVERY_SCOPE" });
  for (const original of [legacy, corrected]) {
    const forged = structuredClone(original); forged.spans[0].end--; forged.spans[1].start--;
    assert.throws(() => validateOwnerDelivery(forged), { code: "TASK_DELIVERY_SCOPE" });
  }
  for (const source of ['Implement export, "preserve CSV headers" open a PR for review.', "Implement export,\nand open a PR for review.", "Implement export, and\nopen a PR for review."]) {
    const split = source.indexOf("open");
    const prior = { version: 1, offsets: "utf16", source, spans: [
      { start: 0, end: split, owner: "implementation" },
      { start: split, end: source.length, owner: "coordinator", kind: "pull_request" },
    ] };
    assert.equal(validateOwnerDelivery(prior), prior);
    assert.deepEqual(ownerImplementation(prior), [source.slice(0, split)]);
  }
});

test("publication owns only its recognized coordinating connector and delimiter", () => {
  for (const connector of [", and ", ", and then ", " and ", " and then ", ", then ", " then ", ", "]) {
    const source = "Implement CSV export and test both formats" + connector + "open a PR for review.";
    const contract = ownerDelivery(source);
    assert.equal(ownerImplementation(contract).join(""), "Implement CSV export and test both formats", connector);
    assert.equal(contract.spans.map(s => source.slice(s.start, s.end)).join(""), source);
    assert.equal(source.slice(contract.spans.at(-1).start), connector + "open a PR for review.", connector);
  }
});

test("typed ownership is validated and included in the ongoing PRD fingerprint; legacy contract is unchanged", () => {
  const contract = ownerDelivery("Implement export. Open a PR for review.");
  const section = `\n## Coordinator delivery contract\n\n\`\`\`json\n${JSON.stringify(contract)}\n\`\`\`\n`;
  const legacy = parsePrd(GOOD_PRD, "docs/prds/example.md"), current = parsePrd(GOOD_PRD + section, "docs/prds/example.md");
  assert.equal(Object.hasOwn(contractOf(legacy), "ownerDelivery"), false);
  assert.deepEqual(ownerDeliveryFromPrd(current), contract);
  assert.deepEqual(ownerDeliveryFromPrd(parsePrd((GOOD_PRD + section).replace(/\n/g, "\r\n"), "docs/prds/example.md")), contract);
  assert.notEqual(prdFingerprint(current), prdFingerprint(legacy));
  assert.notEqual(prdFingerprint(current), prdFingerprint(parsePrd(GOOD_PRD + section.replace('"pull_request"', '"merge"'), 'docs/prds/example.md')));
  assert.throws(() => ownerDeliveryFromPrd(parsePrd(GOOD_PRD + section + section, "docs/prds/example.md")), { code: "TASK_DELIVERY_SCOPE" });
});

test("CRLF preserves ownership validation and fingerprint without weakening malformed-contract checks", () => {
  const contract = ownerDelivery('Preserve the café greeting.\r\nOpen a PR for review.');
  const section = `\n## Coordinator delivery contract\n\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n`;
  const lf = GOOD_PRD + section, crlf = lf.replaceAll("\n", "\r\n");
  const parsed = parsePrd(crlf, "docs/prds/example.md"), original = parsePrd(lf, parsed.path);
  assert.deepEqual(ownerDeliveryFromPrd(parsed), contract);
  assert.equal(check(parsed).ok, true);
  assert.equal(prdFingerprint(parsed), prdFingerprint(original));
  assert.deepEqual(contractDiff(original, parsed), []);
  // Formatting normalization must not change the original request's escaped bytes.
  const changedSource = parsePrd(lf.replace('\\r\\n', '\\n'), parsed.path);
  assert.notEqual(prdFingerprint(changedSource), prdFingerprint(original));
  for (const malformed of [crlf + section.replaceAll("\n", "\r\n"), crlf + "Unexpected trailing text", crlf.replace('"pull_request"', '"merge"')])
    assert.throws(() => ownerDeliveryFromPrd(parsePrd(malformed, parsed.path)), { code: "TASK_DELIVERY_SCOPE" });
});

test("publication is fulfilled only by matching canonical delivery proof, never provider output", () => {
  const owner = ownerDelivery("Implement export. Open a PR for review.");
  const entry = { repo: "owner/repo", pr: 4, base: "main", state: "ready-for-human", cursor: { fixed_sha: "abc" },
    task: { completion: { version: 1, target: "delivery_ready" }, ownerDelivery: owner },
    completionEvidence: { delivery: { repository: "owner/repo", pr: 4, base: "main", head: "abc", gate: { allow: true }, observedAt: "2026-10-14T12:00:00Z" } } };
  assert.equal(completionView(null, entry).obligations[0].status, "fulfilled");
  for (const patch of [{ repository: "other/repo" }, { pr: 5 }, { head: "stale" }, { base: "release" }, { gate: { allow: false } }, { invalidatedAt: "2026-10-14T12:01:00Z" }]) {
    const changed = structuredClone(entry); Object.assign(changed.completionEvidence.delivery, patch);
    assert.notEqual(completionView(null, changed).status, "fulfilled");
    assert.equal(completionView(null, changed).obligations[0].status, "pending");
  }
  assert.equal(completionView({ target: "delivery_ready" }, { ...entry, state: "pr-open", completionEvidence: {}, result: { acceptance_criteria: [{ met: true, evidence: "I opened a PR" }] } }).obligations[0].status, "pending");
});
