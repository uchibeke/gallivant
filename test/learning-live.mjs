// Explicitly opt-in. No production keys, trust enrollment, provider/model calls.
import { disposableLearningProfile } from "../lib/learning_qualification.mjs";
import { safeDisplay, hash } from "../lib/learning_data.mjs";
import { createLearningService } from "../lib/learning.mjs";
import { learningStore } from "../lib/learning_store.mjs";
import { operatorConfirmation } from "../lib/commands/learn.mjs";
import { makeTrust } from "../lib/events.mjs";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (!process.argv.includes("--qualify")) {
  process.stdout.write("UNQUALIFIED: opt-in requires npm run test:learning:live -- --qualify in the operator terminal. No probe or key creation performed." + "\n");
  process.exitCode = 1;
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stdout.write("UNQUALIFIED: live approval needs an operator terminal; no keys created." + "\n"); process.exitCode = 1;
} else {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "learning-live-"));
  try {
    const profile = disposableLearningProfile(dir), evidence = await profile.qualify();
    const approvalDir = join(dir, "approval"); mkdirSync(approvalDir, { mode: 0o700 });
    const root = join(dir, "learning"), store = learningStore(root), repo = { host: "github.com", id: "1" };
    const service = createLearningService({ root, store, qualify: () => profile.qualify(), trust: makeTrust({ trusted_authors: ["operator"], reviewer: null }, "operator") });
    process.stdout.write("Disposable ceremony only. Choose a unique test passphrase; all generated keys/state are deleted afterward. No provider calls or production enrollment." + "\n");
    await service.setup({ keyPath: join(approvalDir, "disposable-ed25519"), confirm: operatorConfirmation });
    await service.configure(repo, "collect");
    const at = new Date().toISOString();
    await service.observe(repo, { pr: { number: 1, repo: "disposable/qualification" }, inline: [{ id: 1, user: { login: "operator", type: "User" }, path: "src/input.mjs", body: "Validate complete input before persisting.", created_at: at, updated_at: at }] });
    const evidenceDigest = Object.keys(store.load(repo).observations)[0];
    const proposal = { version: 1, id: "lesson-live-validation", repo, paths: [], applicability: "When parsing external input", guidance: "Validate complete input before persistence.", rationale: "Partial persistence makes validation failure unsafe.", example: "Before: save first. After: validate the complete record then save.", evidence: [evidenceDigest], disposition: "unconfirmed", regression: null, provenance: { provider: "operator-live-fixture", inputDigest: hash("disposable live qualification"), at } };
    const pending = await service.revise(repo, proposal.id, proposal);
    const approved = await service.approve(repo, [{ id: proposal.id, digest: pending.digest }], { confirm: operatorConfirmation });
    await service.configure(repo, "apply", "disposable-offline");
    const input = await service.context(repo, { operationId: "live-attempt", profile: "disposable-offline", inputDigest: hash("live input") });
    const worker = await profile.consume(input);
    const delivery = await service.delivered(repo, input.key, worker.runId);
    const retired = await service.approve(repo, [{ id: proposal.id, digest: pending.digest }], { action: "retire", reason: "Disposable qualification complete", confirm: operatorConfirmation });
    const after = await service.context(repo, { operationId: "after-retirement", profile: "disposable-offline", inputDigest: hash("after retirement"), previous: delivery });
    if (after.rules.length || !after.freshSessionRequired) throw new Error("retirement continuity fence failed");
    process.stdout.write(safeDisplay({ evidence, approved, worker, delivery, retired, after, productionStatus: "UNQUALIFIED: installed worker/extractor launch and privileged/control integration are still outstanding" }) + "\n");
    process.exitCode = 1; // Standalone ceremony never qualifies installed coding profiles.
  } catch (e) { process.stdout.write(safeDisplay({ status: "UNQUALIFIED", code: e.code || "LEARNING_LIVE", observed: String(e.stderr || e.message) }) + "\n"); process.exitCode = 1; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
