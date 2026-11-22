import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoveryDigest as digest } from "../lib/recovery_digest.mjs";
import { qualificationGate, qualificationInventory, protectedQualification } from "../lib/recovery_qualification.mjs";
import { qualifyAdmitted } from "../lib/recovery_qualification_run.mjs";
import { makeRecoverySchedule, RECOVERY_LANES, STRUCTURAL_SCAN_SECONDS } from "../lib/recovery_schedule.mjs";
import { qualificationArtifact } from "../lib/recovery_qualification_artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modes = new Set(["--fixtures", "--native", "--live", "--overnight", "--check-evidence"]);
const required = [
  "qualification", "observation", "authority", "preflight", "recipes", "git-journal", "scheduling", "resource",
].map(name => `recovery-${name}.test.mjs`);
const contracts = {
  "execution-backends.test.mjs": [
    "local Codex fixture uses existing adapter, journals output and survives launcher exit",
    "openai-agents fixture: lost reply persists intent and reconciles without duplicate paid dispatch",
    "codex-cloud fixture: lost reply persists intent and reconciles without duplicate paid dispatch",
    "unknown acceptance without lookup stays visible through startup and periodic reconciliation",
    "missing results remain retrieving, event gaps are explicit and recovered events deduplicate",
    "local network recovery survives execution-ledger reopening without duplicate sessions",
    "accepted correction recovers workflow ownership after a lost registry acknowledgement",
    "completed local output survives a successor, restart and cursor replay with exact paginated history",
    "interrupted verification blocks replay while lost publication replies reuse verified evidence",
    "a recovery hold arriving after verification fences publication without spending another verification",
    "a held remote result keeps publication owed across restart and publishes once after release",
    "a held remote result preserves merged closeout without publishing late output",
    "uncertain PR creation survives worker restart and only observes the original verified publication",
    "verified PR create can retry a failed lookup before its write",
    "canonical artifact targets survive native commit acknowledgement loss without changing the private manifest",
    "unacknowledged cancellation remains pending and older stopped records recover the same stop intent",
  ],
  "task-delivery-cancellation.test.mjs": [
    "lostSubmit cancellation keeps original provider ownership and retries the same stop key",
    "lostCancel cancellation keeps original provider ownership and retries the same stop key",
  ],
  "runtime-delivery.test.mjs": [
    "pending delivery receipts pin migration before intake and through wake acknowledgement",
    "delayed and repeated coordinator wakes revalidate the pin under ownership before effects",
  ],
  "chains.test.mjs": [
    "ambiguous spawn failure retains its claim across reload and retry cannot duplicate the dispatch",
    "external merge of a stopped predecessor waits for retained cleanup and releases one successor across restart",
    "a maintainer merge retires the owned live author before releasing its chain successor",
  ],
  "live-merge-closeout.test.mjs": [
    "accepted remote cancellation is observed without duplicate cancellation or late publication",
    "a hold arriving during merge proof fences retirement despite a queued correction",
    "a repository disable and enable during merge proof require fresh retirement evidence",
    "settled hosted closeout cannot start cancellation of a live author",
  ],
  "workspace-cleanup.test.mjs": [
    "interrupted deletion retries only its approved directory inode",
    "operator paths, shared task inputs, chain inputs, linked worktrees and symlink ancestors are preserved",
  ],
  "loop.test.mjs": ["a @gallivant fix comment from an untrusted author on a ready entry changes nothing"],
  "control.test.mjs": ["interrupted delivery is not replayed, and closed PRs cannot be resumed"],
  "first-party-review.test.mjs": [
    "structured verdict requires all criteria, exact identities and verifiable findings; injections cannot add policy fields",
    "all local pieces clearing still requires a fresh whole-PR reviewer, including after restart",
    "invalid output repair can recover valid findings and unique citation corrections without replaying passed jobs",
    "explicit retry of a coordinator-cancelled reviewer requires verified cessation and retained ownership",
    "a stopped reviewer reaches current-head clearance from its owned capacity retry without an author turn",
    "review qualification survives OAuth token refresh but not account, subject, provider or API-key changes",
    "a reviewer preparation cannot submit across a scoped disable and enable",
    "a reviewer guard refusal restores preparation while unknown acceptance retains ownership",
    "a new review head preserves uncertain cancellation and waits for exact cessation",
  ],
};

function fixtureEnvironment() {
  const safe = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SystemRoot", "PLAYWRIGHT_BROWSERS_PATH"];
  return { ...Object.fromEntries(safe.filter(key => process.env[key]).map(key => [key, process.env[key]])),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}
const escape = name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function runContracts(suites, names, deadline, observe = () => {}) {
  const timeout = Math.min(120_000, deadline - Date.now());
  if (timeout <= 0) return { suites, selected: names, result: "failed", timeout: true, exit: null, passed: 0 };
  const selection = names.length ? [`--test-name-pattern=^(?:${names.map(escape).join("|")})$`] : [];
  const args = ["--test", "--test-reporter=tap", "--test-concurrency=1", `--test-timeout=${Math.max(1, timeout - 5000)}`,
    ...selection, ...suites.map(suite => `test/${suite}`)];
  const result = spawnSync(process.execPath, args, {
    cwd: root, env: fixtureEnvironment(), encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
  });
  const output = result.stdout ?? "";
  observe(output);
  if (output) process.stdout.write(output);
  if (result.stderr) process.stderr.write(result.stderr);
  const metric = label => Number(output.match(new RegExp(`^# ${label} (\\d+)$`, "m"))?.[1]);
  const missing = names.filter(name => !new RegExp(`^ok \\d+ - ${escape(name)}$`, "m").test(output));
  return { suites, selected: names, exit: result.status, timeout: result.error?.code === "ETIMEDOUT",
    result: !result.error && result.status === 0 && metric("pass") > 0 && metric("fail") === 0 &&
      metric("skipped") === 0 && metric("todo") === 0 && !missing.length ? "passed" : "failed",
    passed: metric("pass") || 0, missing };
}

function fixtureCapacity() {
  const clock = { now: () => at }, cycles = 20, workload = RECOVERY_LANES.host * 2, scanMs = STRUCTURAL_SCAN_SECONDS * 1000;
  let at = STRUCTURAL_SCAN_SECONDS * 1000, firstServiceWithinTwoScans = false;
  const selection = new Set();
  const scheduler = makeRecoverySchedule({ clock });
  const due = new Map(Array.from({ length: workload }, (_, i) => [String(i).padStart(3, "0"), at]));
  const started = Date.now();
  for (let n = 0; n < cycles; n++) {
    const cycle = scheduler.begin(), batch = cycle.batch("host", [...due]);
    for (const id of batch.ids) {
      batch.start(id); selection.add(id);
      due.set(id, cycle.started + scanMs);
      at += 10;
    }
    if (n === 1) firstServiceWithinTwoScans = selection.size === workload;
    cycle.finish();
    at = cycle.started + scanMs;
  }
  return { basis: "synthetic scheduler clock; continuously due host entries", workload, cycles, capacity: RECOVERY_LANES.host,
    firstServiceWithinTwoScans, executionMs: Date.now() - started, percentiles: scheduler.metrics.percentiles };
}

function fixtures(artifact, runtime) {
  const suites = readdirSync(join(root, "test")).filter(name => /^recovery-.+\.test\.mjs$/.test(name)).sort();
  for (const suite of required) if (!suites.includes(suite)) throw qualificationGate(`Required fixture suite missing (${suite}).`);
  const deadline = Date.now() + 240_000, results = [runContracts(suites, [], deadline)];
  for (const [suite, tests] of Object.entries(contracts)) results.push(runContracts([suite], tests, deadline));
  const capacity = fixtureCapacity(), passed = capacity.firstServiceWithinTwoScans && results.every(result => result.result === "passed");
  const proved = passed ? [
    { surface: "github", harness: "claude", owner: "author", status: "fixture-tested" },
    { surface: "github", harness: "codex", owner: "author", status: "fixture-tested" },
    { surface: "github", harness: "codex", owner: "reviewer", status: "fixture-tested" },
  ] : [];
  const report = { version: 1, mode: "fixtures", artifact, runtime, manifest: null, results, capacity,
    inventory: qualificationInventory(proved), result: passed ? "passed" : "failed" };
  return { ...report, digest: digest(report) };
}

export async function qualificationCommand(args, { ctx, task = process.env.GALLIVANT_QUALIFICATION_TASK } = {}) {
  if (args.length !== 1 || !modes.has(args[0])) throw qualificationGate("Choose exactly one of --fixtures, --native, --live, --overnight, or --check-evidence.");
  const mode = args[0].slice(2);
  const runtime = { node: process.version, platform: process.platform, arch: process.arch };
  if (mode === "fixtures") return fixtures(qualificationArtifact(), runtime);
  if (!ctx) {
    if (!task) throw qualificationGate("Set GALLIVANT_QUALIFICATION_TASK to the exact registry task ID with a protected disposable qualification admission.");
    const { makeContext } = await import("../lib/context.mjs");
    ctx = makeContext({ readOnly: true });
  }
  protectedQualification(ctx, task, mode);
  const artifact = ctx.qualificationArtifact ?? qualificationArtifact();
  const report = await qualifyAdmitted(ctx, task, mode, artifact, runtime);
  return { version: 1, mode, artifact, runtime, ...report, result: "passed" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await qualificationCommand(process.argv.slice(2));
    console.log(JSON.stringify(report));
    if (report.result !== "passed") process.exitCode = 1;
  } catch (error) {
    const remedy = error.code === "RECOVERY_QUALIFICATION" ? error.message : "Inspect the protected coordinator or fixture diagnostics before retrying.";
    console.error(JSON.stringify({ result: "gated", remedy, code: error.code ?? "QUALIFICATION_ERROR" }));
    process.exitCode = 1;
  }
}
