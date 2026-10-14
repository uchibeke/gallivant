import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerDelivery, ownerImplementation, validateOwnerDelivery, ownerDeliveryFromPrd, assertDeliveryAnswer } from "../lib/owner_delivery.mjs";
import { completionView } from "../lib/task_completion.mjs";
import { parsePrd, prdFingerprint, contractOf } from "../lib/prd.mjs";
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
