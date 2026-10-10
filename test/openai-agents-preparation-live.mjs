// Explicit live qualification; never imported by the offline test suite.
// Private config, state and the shared campaign ledger must stay outside Git.
import { resolve, relative, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic, ensureDir } from "../lib/fs.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { acquireProcessLock } from "../lib/daemon.mjs";
import { makeAgentsTransport, checkAgentsAccess, agentsCredential } from "../lib/openai_agents.mjs";
const execute = process.argv.includes("--execute");
const required = ["OPENAI_AGENTS_PREPARATION_HOME", "OPENAI_AGENTS_PREPARATION_CONFIG", "OPENAI_AGENTS_CAMPAIGN_LEDGER"];
let execution, campaignLock;
try {
  for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
  const [home, configPath, ledgerPath] = required.map(key => resolve(process.env[key]));
  for (const path of [home, configPath, ledgerPath]) {
    const local = relative(process.cwd(), path);
    if (!local || !local.startsWith("..") && !isAbsolute(local)) throw new Error("Keep live configuration, state and campaign ledger outside the repository");
  }
  const config = readJson(configPath), access = await checkAgentsAccess(config);
  if (!access.ok) throw new Error(`${access.detail}: ${access.fix}`);
  if (!execute) {
    console.log(JSON.stringify({ status: "preflight-only", model: config.model, paidCalls: 0, next: "Review the private campaign allowance, then add --execute; repeating with the same home recovers its saved turn" }));
  } else {
    campaignLock = acquireProcessLock(`${ledgerPath}.lock`, "Agents live campaign");
    const taskId = "intake/preparation-qualification", account = config.account;
    const runner = () => makeExecution({ root: home, taskId, provider: "openai-agents", account,
      transport: makeAgentsTransport({ root: home, taskId, account, config }),
      limits: { deadlineMs: 15000, progressMs: 1000 }, secrets: [agentsCredential(config)()] });
    execution = runner();
    if (!execution.current()) {
      const ledger = readJson(ledgerPath), phase = createHash("sha256").update(home).digest("hex");
      if (!ledger || ledger.version !== 1 || ledger.limitUsd !== 10 || !Array.isArray(ledger.attempts) || !Number.isFinite(ledger.reservationUsd) || ledger.reservationUsd <= 0 || ledger.attempts.some(a => !Number.isFinite(a.reservedUsd) || a.reservedUsd <= 0 || !Number.isFinite(a.observedCostUsd) || a.observedCostUsd < 0 || a.phase === phase)) throw new Error("Ledger requires a new phase, positive reservation and reconciled prior costs within the aggregate USD 10 campaign");
      const committed = ledger.attempts.reduce((n, a) => n + Math.max(a.reservedUsd, a.observedCostUsd), 0);
      if (committed + ledger.reservationUsd > ledger.limitUsd || ledger.reservationUsd > config.allowance.reservedUsd || !ledger.pricing?.url?.startsWith("https://developers.openai.com/") || Math.abs(Date.now() - Date.parse(ledger.pricing.checkedAt)) > 86400000 || !Number.isFinite(Date.parse(ledger.pricing.checkedAt))) throw new Error("Refresh official pricing and keep reservations within the shared campaign allowance");
      const input = { kind: "intake", environment: "none", prompt: 'Return exactly one JSON object, without a code fence: {"feature":"CSV export","requirements":["Export only selected rows","Keep dependencies unchanged"],"questions":[]}. This is a transport qualification; do not run code or invoke tools.', allowance: { remainingUsd: ledger.limitUsd - committed, reservedUsd: ledger.reservationUsd } };
      const prepared = await execution.prepare(input);
      ledger.attempts.push({ phase, reservedUsd: ledger.reservationUsd, observedCostUsd: null, at: new Date().toISOString() });
      writeJsonAtomic(ledgerPath, ledger); // Reserve before the initial-input request.
      try { await execution.submit({ ...input, prepared, preparation: prepared.receipt, operationId: "qualification-1" }); }
      catch (error) { if (!execution.current()) throw error; } // Reconcile the owned intent, never resend.
    }
    const deadline = Date.now() + 120000;
    let result;
    while (Date.now() < deadline) {
      execution = runner(); // Reopen persisted state on every observation.
      await execution.reconcile();
      const job = execution.current();
      if (job.execution.providerState === "retrieving-results" || job.execution.collected) { result = await execution.collect(); break; }
      await new Promise(done => setTimeout(done, 1500));
    }
    if (!result) { await execution.cancel("preparation-qualification-deadline"); throw new Error("Qualification deadline reached; cancellation requested, preserve the reservation until billing is reconciled"); }
    const parsed = JSON.parse(result.outcome.lastMessage);
    if (!result.outcome.ok || parsed.feature !== "CSV export" || JSON.stringify(parsed.requirements) !== JSON.stringify(["Export only selected rows", "Keep dependencies unchanged"]) || parsed.questions?.length !== 0) throw new Error("Owned completed output does not satisfy the qualification");
    const report = { status: "passed", at: new Date().toISOString(), model: config.model, sessionId: result.sessionId, turnId: result.turnId, usage: result.usage, restarted: true, scope: "One native tool-free preparation turn; not implementation/PR, deployed runtime or plugin-host qualification" };
    writeJsonAtomic(join(ensureDir(home), "qualification.json"), report);
    console.log(JSON.stringify(report));
  }
} catch (error) {
  console.error(JSON.stringify({ status: "unverified", code: error.code || "LIVE_PREREQUISITES", message: error.message, savedRun: execution?.current()?.id || null }));
  process.exitCode = 1;
} finally {
  campaignLock?.release();
}
