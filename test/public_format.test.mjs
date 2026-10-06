import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBlock, parseBlock, upsertBlock, normalizePublicBody } from "../lib/block.mjs";
import { receiptHash, receiptHashes, parseReceipt, normalizeReceipt, publicTaskId, receiptInstructions } from "../lib/deliverable.mjs";
import { branchFor, isOurBranch, prdIdFromBranch } from "../lib/git.mjs";
import { adapters } from "../lib/harness.mjs";
import { makeGh, READY_LABEL, NEEDS_LABEL, ROUND_MARKER, NUDGE_MARKER, RESET_MARKER } from "../lib/gh.mjs";
import { countRounds, hasOwnComment, isOwnComment } from "../lib/events.mjs";
import { attributionIn } from "../lib/attribution.mjs";
import { hasLegacyStatusLabels } from "../lib/public-format.mjs";
import { shortHash } from "../lib/hash.mjs";
import { comment, at, T0 } from "./helpers.mjs";

const identity = { prd: "docs/prds/gallivant-init.md", harness: "goose", session: "gallivant-068021d7-3490-4f2e-a6f1-30e1c00498c9", branch: "gallivant/gallivant-init" };
const legacyBlock = data => `<!-- gallivant\nprd: ${data.prd}\nharness: ${data.harness}\nsession: ${data.session ?? "none"}\nbranch: ${data.branch}\n-->`;
const receipt = { task_id: "uchibeke/gallivant/gallivant-init", output_type: "code", summary: "The change was verified using the focused tests and the resulting output was checked against the approved task requirements.", criteria_attestations: [{ criterion_id: "ac-1", met: true, evidence: "test/start.test.mjs" }] };
const legacyReceipt = value => "```gallivant-attestations\n" + JSON.stringify(value, null, 2) + "\n```";

test("neutral generated formats retain exact legacy recovery identity without renaming anything", () => {
  const body = renderBlock(identity);
  assert.doesNotMatch(body, /gallivant/i);
  assert.deepEqual(parseBlock(body).block, identity);
  assert.deepEqual(parseBlock(legacyBlock(identity)).block, identity);
  assert.equal(branchFor("export"), "work/export");
  for (const branch of ["work/export", "gallivant/export"]) {
    assert.ok(isOurBranch(branch));
    assert.equal(prdIdFromBranch(branch), "export");
  }
  assert.doesNotMatch(adapters.goose.newSession(), /gallivant/i);
  assert.ok(adapters.goose.isSession(identity.session));
  assert.ok(adapters.goose.isSession(adapters.goose.newSession()));
  assert.doesNotMatch(receiptInstructions([{ id: "ac-1", description: "Exports CSV" }], receipt.task_id), /gallivant/i);
});

test("recovery encoding is transport only: decoded schema, fields, duplicate records and canonical encoding are validated", () => {
  const encoded = data => `<!-- work-session\n${Buffer.from(JSON.stringify(data)).toString("base64url")}\n-->`;
  for (const data of [
    { version: 2, ...identity }, { version: 1, ...identity, extra: true },
    { version: 1, ...identity, session: "../escape" }, { version: 1, ...identity, prd: "../escape.md" },
    { version: 1, ...identity, branch: "main" }, { version: 1, ...identity, harness: "bash" },
    { version: 1, ...identity, session: [] }, { version: 1, ...identity, branch: null },
  ]) assert.equal(parseBlock(encoded(data)).block, null);
  assert.equal(parseBlock(renderBlock(identity).replace(/\n-->/, "=\n-->")).block, null);
  assert.match(parseBlock(`${legacyBlock(identity)}\n${renderBlock(identity)}`).reason, /multiple/);
  assert.throws(() => upsertBlock(`${legacyBlock(identity)}\n${renderBlock(identity)}`, identity), /multiple/);
  assert.throws(() => upsertBlock("<!-- gallivant\nprd: x.md", identity), /unterminated/);
  assert.equal(parseBlock("<!-- gallivant round -->").reason, "no block");
});

test("body migration changes only known transport and binds the public task token without touching evidence", () => {
  const evidence = { ...receipt, criteria_attestations: [{ criterion_id: "ac-1", met: true, evidence: "lib/gallivant.mjs actually ran; preserve this until the agent chooses truthful neutral evidence" }] };
  const prose = "Technical text Gallivant: do not silently redact source names.\n";
  const original = `${prose}${legacyReceipt(evidence)}\n\n${legacyBlock(identity)}\n`;
  const changed = normalizePublicBody(original, { identity, taskId: receipt.task_id });
  assert.ok(changed.startsWith(prose));
  assert.deepEqual(parseBlock(changed).block, identity);
  assert.deepEqual(parseReceipt(changed).receipt.criteria_attestations, evidence.criteria_attestations);
  assert.equal(parseReceipt(changed).receipt.task_id, publicTaskId(receipt.task_id));
  assert.equal(receiptHash(changed), receiptHash(original), "format migration alone is not progress");
  assert.equal(normalizePublicBody(changed, { identity, taskId: receipt.task_id }), changed, "idempotent");
  assert.deepEqual(receiptHashes(original), [receiptHash(original), shortHash(JSON.stringify(evidence, null, 2))]);
  assert.deepEqual(parseReceipt(legacyReceipt(receipt).replaceAll("\n", "\r\n")).receipt, receipt, "legacy CRLF receipts remain readable");
  const unknown = normalizeReceipt(legacyReceipt({ ...receipt, task_id: "another-task" }), receipt.task_id);
  assert.equal(parseReceipt(unknown).receipt.task_id, "another-task", "unrecognized task identity is not rewritten");
  const invalid = "```gallivant-attestations\n{invalid JSON}\n```";
  assert.match(parseReceipt(normalizeReceipt(invalid)).reason, /not valid JSON/);
  const duplicate = `${legacyReceipt(receipt)}\n${normalizeReceipt(legacyReceipt(receipt))}`;
  assert.match(parseReceipt(duplicate).reason, /multiple/);
  assert.equal(receiptHash(duplicate), null);
  assert.throws(() => normalizeReceipt(duplicate), /multiple/);
});

test("rounds, resets and retry deduplication span neutral and legacy comments", () => {
  const history = [
    comment({ id: 1, by: "me", at: at(1), body: "<!-- gallivant round -->" }),
    comment({ id: 2, by: "me", at: at(2), body: RESET_MARKER }),
    comment({ id: 3, by: "me", at: at(3), body: "<!-- gallivant round -->" }),
    comment({ id: 4, by: "me", at: at(4), body: ROUND_MARKER }),
    comment({ id: 5, by: "me", at: at(5), body: "<!-- gallivant nudge -->" }),
    comment({ id: 6, by: "stranger", at: at(6), body: ROUND_MARKER }),
  ];
  assert.equal(countRounds(history, "me"), 2);
  assert.ok(hasOwnComment(history, "me", ROUND_MARKER, at(2)));
  assert.ok(hasOwnComment(history, "me", NUDGE_MARKER, T0));
  assert.ok(hasOwnComment(history, "me", "<!-- gallivant reset -->", T0));
  assert.ok(history.slice(0, 5).every(c => isOwnComment(c.body)));
});

test("GitHub metadata migration reads the current body and preserves prose, and mismatched identity writes nothing", async () => {
  const current = { title: "Current title", body: `Operator's newest prose mentioning Gallivant.\n${legacyReceipt(receipt)}\n${legacyBlock(identity)}`, headRefName: identity.branch, isCrossRepository: false };
  const calls = [];
  const gh = makeGh({ exec: async (_cmd, args) => {
    calls.push(args);
    return { stdout: args[0] === "pr" && args[1] === "view" ? JSON.stringify(current) : "" };
  } });
  const updated = await gh.setRecoveryMetadata("uchibeke/gallivant", 1, identity, { taskId: receipt.task_id });
  assert.ok(updated.body.startsWith("Operator's newest prose mentioning Gallivant.\n"));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], "view");
  assert.equal(calls[1].at(-1), updated.body);
  assert.deepEqual(parseBlock(updated.body).block, identity);
  assert.equal(parseReceipt(updated.body).receipt.task_id, publicTaskId(receipt.task_id));
  calls.length = 0;
  await assert.rejects(() => gh.setRecoveryMetadata("uchibeke/gallivant", 1, { ...identity, branch: "work/other" }), /differs/);
  assert.equal(calls.length, 1, "the fresh read happens but no write");
});

test("all ordinary daemon GitHub prose writes reject branding before execution", async () => {
  const calls = [];
  const gh = makeGh({ exec: async (...args) => { calls.push(args); return { stdout: "" }; } });
  for (const method of ["setBody", "setTitle", "comment"]) {
    assert.throws(() => gh[method]("acme/widget", 1, "Contains GALLIVANT"), /Public text rejected/);
  }
  assert.deepEqual(calls, []);
});

test("GitHub writers reject NUL metadata before writes, including recovery-only migration", async () => {
  const calls = [], current = { body: "", headRefName: identity.branch, isCrossRepository: false };
  const gh = makeGh({ exec: async (_cmd, args) => { calls.push(args); return { stdout: args[1] === "view" ? JSON.stringify(current) : "" }; } });
  for (const method of ["setBody", "setTitle", "comment"]) assert.throws(() => gh[method]("acme/widget", 1, "public\0private"), /contains NUL bytes/);
  await assert.rejects(gh.addLabel("acme/widget", 1, "label\0private"), /contains NUL bytes/);
  for (const field of ["title", "body"]) {
    const request = { repo: "acme/widget", branch: "work/result", base: "main", title: "Valid title", body: "Valid body" };
    request[field] += "\0private"; await assert.rejects(gh.publishResultPr(request), /contains NUL bytes/);
  }
  assert.deepEqual(calls, []);
  for (const raw of ["Preserve public prose\0private", "Preserve public prose\n<!-- work-session\nignored\0payload\n-->\n"]) {
    current.body = raw; calls.length = 0;
    await assert.rejects(gh.setRecoveryMetadata("acme/widget", 1, identity), /contains NUL bytes/);
    assert.equal(calls.length, 1); assert.equal(calls[0][1], "view"); assert.equal(current.body, raw);
  }
});

test("status writes clear legacy and opposite labels, and a refused cleanup prevents a false ready status", async () => {
  const calls = [];
  const gh = makeGh({ exec: async (_cmd, args) => { calls.push(args); return { stdout: "" }; } });
  await gh.addLabel("acme/widget", 1, READY_LABEL);
  assert.equal(calls.filter(args => args[0] === "label").length, 2, "upgrade creates both neutral labels lazily");
  assert.deepEqual(calls.filter(args => args[0] === "pr").map(args => args.slice(-2)), [
    ["--remove-label", "gallivant:ready-for-human"], ["--remove-label", NEEDS_LABEL],
    ["--remove-label", "gallivant:needs-human"], ["--add-label", READY_LABEL],
  ]);
  calls.length = 0;
  await gh.removeLabel("acme/widget", 1, READY_LABEL);
  assert.deepEqual(calls.map(args => args.slice(-2)), [["--remove-label", READY_LABEL], ["--remove-label", "gallivant:ready-for-human"]]);
  const failed = [];
  const bad = makeGh({ exec: async (_cmd, args) => { failed.push(args); if (args.at(-1) === "gallivant:ready-for-human") throw new Error("HTTP 403 forbidden"); return { stdout: "" }; } });
  await assert.rejects(() => bad.addLabel("acme/widget", 1, NEEDS_LABEL), /403/);
  assert.ok(failed.every(args => !args.includes("--add-label")));
  const missingAlias = makeGh({ exec: async (_cmd, args) => { throw new Error(`gh pr edit: '${args.at(-1)}' not found`); } });
  await missingAlias.removeLabel("acme/widget", 1, READY_LABEL);
  const missingRepository = makeGh({ exec: async () => { throw new Error("HTTP 404: Repository not found"); } });
  await assert.rejects(() => missingRepository.removeLabel("acme/widget", 1, READY_LABEL), /Repository not found/, "a missing repository is not a missing label");
});

test("new commit messages cannot name the runner in any case", () => {
  assert.equal(attributionIn("fix: correct GaLlIvAnT routing"), "fix: correct GaLlIvAnT routing");
  assert.equal(attributionIn("fix: correct task routing"), null);
});


test("legacy-label migration detects both API shapes without treating unrelated labels as status", () => {
  assert.equal(hasLegacyStatusLabels([{ name: "gallivant:ready-for-human" }]), true);
  assert.equal(hasLegacyStatusLabels(["GALLIVANT:NEEDS-HUMAN"]), true);
  assert.equal(hasLegacyStatusLabels([{ name: READY_LABEL }, { name: "gallivant:unrelated" }, null]), false);
  assert.equal(hasLegacyStatusLabels(), false);
});
