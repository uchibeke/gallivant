import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent } from "../lib/hosts/github.mjs";
import { reviewerVerdict, exactReviewerVerdict, makeTrust, isGreen } from "../lib/events.mjs";
import { selectReviewPolicy, reviewVerdict } from "../lib/review_policy.mjs";
import { CONFIG, T0, at, comment, review } from "./helpers.mjs";

const head = "a".repeat(40), bot = "chatgpt-codex-connector[bot]";
const trust = makeTrust(CONFIG, "me");
const base = { reviews: [], inline: [], config: CONFIG, trust, sinceIso: T0, headSha: head };
function summary({ code = {}, time = at(3), created = at(1), updated = at(4), by = bot, isBot = true, transform = body => body } = {}) {
  const state = { code_review: { commit_sha: head, status: "completed", has_any_findings: false, has_unresolved_findings: false, ...code },
    security_review: { commit_sha: head, status: "failed", has_any_findings: true, has_unresolved_findings: true } };
  const body = `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify(state)} -->\n\n## Codex Review Summary\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${time}">${time}</relative-time> | \`${state.code_review.commit_sha.slice(0, 7)}\` | PR opened |\n| 🔒 **Security Review** | ⚠️ **Failed** <relative-time datetime="${updated}">${updated}</relative-time> | \`${head.slice(0, 7)}\` | PR opened |`;
  return normalizeEvent({ ...comment({ id: 91, by, bot: isBot, at: created, body: transform(body) }), updated_at: updated }, "comment");
}
const verdict = (record, extra = {}) => reviewerVerdict({ ...base, comments: [record], ...extra });

test("current-head Codex structured code review clears despite an optional security usage failure", async () => {
  const result = await exactReviewerVerdict({ ...base, comments: [summary()] }, () => { throw new Error("full identity needs no lookup"); });
  assert.equal(result.verdict, "clear");
  assert.equal(result.reviewedHead, head);
});

test("structured summaries require the genuine configured Codex bot", () => {
  for (const options of [{ by: "chatgpt-codex-connector", isBot: false }, { by: "other[bot]" }, { by: "me" }]) {
    assert.equal(verdict(summary(options)).verdict, "waiting");
  }
  const config = { ...CONFIG, reviewer: { ...CONFIG.reviewer, login: "other-bot" } };
  assert.equal(verdict(summary(), { config, trust: makeTrust(config, "me") }).verdict, "waiting");
});

test("only explicit completed code review with false finding flags clears", () => {
  for (const code of [{ status: "failed" }, { status: "in_progress" }, { has_any_findings: true },
    { has_unresolved_findings: true }, { has_any_findings: null }, { has_unresolved_findings: "false" },
    { has_any_findings: undefined }, { commit_sha: "a".repeat(7) }]) {
    assert.equal(verdict(summary({ code })).verdict, "waiting", JSON.stringify(code));
  }
});

test("a structured summary requires the exact full current commit", () => {
  assert.equal(verdict(summary({ code: { commit_sha: "b".repeat(40) } })).verdict, "waiting");
  assert.equal(verdict(summary(), { headSha: head.slice(0, 7) }).verdict, "waiting");
  assert.equal(verdict(summary({ transform: b => b.replace(/`aaaaaaa`/, "`bbbbbbb`") })).verdict, "waiting");
});

test("in-place code review completion uses its own time, not comment creation or later security edits", () => {
  assert.equal(verdict(summary({ created: at(-10), time: at(3), updated: at(4) })).verdict, "clear");
  assert.equal(verdict(summary({ created: at(-10), time: at(-2), updated: at(4) })).verdict, "waiting");
  assert.equal(verdict(summary({ time: at(5), updated: at(4) })).verdict, "waiting");
  assert.equal(verdict(summary({ time: at(0), created: at(1) })).verdict, "waiting");
  assert.equal(verdict(summary({ time: "not-a-date" })).verdict, "waiting");
  assert.equal(verdict(summary({ time: "2026-09-24T02:04:00.900Z", updated: at(4) })).verdict, "clear", "REST truncates fractional seconds");
});

test("malformed, duplicate or unbound structured metadata is not a clean review", () => {
  for (const transform of [
    b => b.replace('"code_review":', '"other_review":'),
    b => b.replace('"code_review":{', '"code_review":oops{'),
    b => b.replace('"has_any_findings":false', '"has_any_findings":true,"has_any_findings":false'),
    b => b.replace('"code_review":', '"code_review":null,"code_review":'),
    b => `${b}\n${b.match(/<!-- codex-review-state:v1 .* -->/)[0]}`,
    b => b.replace(/\| 📝 \*\*Code Review\*\*[^\n]+/, ""),
    b => `${b}\n${b.match(/\| 📝 \*\*Code Review\*\*[^\n]+/)[0]}`,
    b => b.replace('<!-- codex-pull-request-review-summary -->', ''),
    b => b.replace('✅ **Completed**', '⚠️ **Failed**'),
  ]) assert.equal(verdict(summary({ transform })).verdict, "waiting");
  const malformedWithLegacy = summary({ code: { status: "failed" }, transform: b => `${b}\n**Reviewed commit:** \`${head}\`` });
  assert.equal(verdict(malformedWithLegacy).verdict, "waiting", "invalid structured state cannot fall back to legacy prose");
});

test("a newer changes request still blocks an earlier clean structured summary", () => {
  const newer = { ...review({ id: 93, by: bot, bot: true, state: "CHANGES_REQUESTED", at: at(5) }), commit_id: head };
  assert.equal(verdict(summary(), { reviews: [newer] }).verdict, "blocking");
});

test("structured code clearance never bypasses required security review or CI gates", () => {
  const external = verdict(summary());
  const config = { ...CONFIG, review: { mode: "both-required", route: "codex", specialist: "security" } };
  const policy = selectReviewPolicy(config, "acme/widget", { route: "codex", fingerprint: "f".repeat(64), run: "test", qualified: true });
  assert.equal(reviewVerdict(policy, external, { status: "failed", error: "security usage limit" }, "binding").verdict, "failed");
  assert.equal(reviewVerdict(policy, external, null, "binding").verdict, "waiting");
  assert.equal(isGreen([{ name: "required-security", outcome: "failed" }], ["required-security"]), false);
});
