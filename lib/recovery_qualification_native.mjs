import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireProcessLock, daemonRecord, matchesProcess, pidExists, processIdentity } from "./daemon.mjs";
import { readJson } from "./fs.mjs";
import { makeRunner, requestRunCancellation } from "./run.mjs";
import { journalFor } from "./execution_journal.mjs";
import { directoryIdentity, removeOwnedDirectory } from "./owned_artifacts.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { qualificationGate } from "./recovery_qualification.mjs";

const childCode = `
const { acquireProcessLock } = await import(process.argv[1]);
const { journalFor } = await import(process.argv[2]);
const { join } = await import("node:path");
const { writeFileSync } = await import("node:fs");
const dir = process.argv[3];
acquireProcessLock(join(dir, "daemon.lock"));
journalFor(join(dir, "journal"), { taskId: "native", runId: "probe", provider: "synthetic" })
  .append({ eventId: "first", data: "preserve" });
writeFileSync(join(dir, "ready"), "ready", { flush: true });
setTimeout(() => process.exit(1), 8_000);
`;

async function waitFor(check, message) {
  const timeout = Date.now() + 3000;
  do {
    if (check()) return;
    await delay(20);
  } while (Date.now() < timeout);
  throw qualificationGate(message);
}

// Native observations only. An independently configured environment and
// supervisor still have to capture and sign the admitted receipts.
export async function nativeQualificationProbe(root, fence) {
  fence();
  const dir = mkdtempSync(join(root, "native-"));
  const proof = directoryIdentity(root, basename(dir));
  const runner = makeRunner(join(dir, "runs"));
  const leaseFile = join(dir, "daemon.lock");
  let job;
  try {
    job = await runner.start("qualification", realpathSync(process.execPath), [
      "--input-type=module", "-e", childCode, new URL("./daemon.mjs", import.meta.url).href,
      new URL("./execution_journal.mjs", import.meta.url).href, dir,
    ], { cwd: dir, inheritEnv: false, env: { PATH: "/usr/bin:/bin" }, runId: "probe" });
    await waitFor(() => existsSync(join(dir, "ready")), "The native process or journal failed to initialize inside the admitted boundary.");
    fence();
    const lease = daemonRecord(dir);
    const exactIdentity = lease?.pid === job.pid && matchesProcess(lease, processIdentity(job.pid));
    if (!exactIdentity) throw qualificationGate("Native process identity is unavailable or disagrees with the owned launch.");
    let liveLockPreserved = false;
    try { acquireProcessLock(leaseFile).release(); }
    catch (error) { liveLockPreserved = /already running or PID still occupied/.test(error.message); }
    if (!liveLockPreserved || readJson(leaseFile)?.instance !== lease.instance)
      throw qualificationGate("A live lease was not preserved during native process exclusion.");
    requestRunCancellation(runner, job.id);
    await waitFor(() => runner.current()?.id === job.id && !runner.current().running && !pidExists(job.pid),
      "Native cancellation could not prove cessation of the exact owned process.");
    const replacement = acquireProcessLock(leaseFile);
    const deadOwnerRecovered = replacement.owner.instance !== lease.instance;
    replacement.release();
    const journal = journalFor(join(dir, "journal"), { taskId: "native", runId: "probe", provider: "synthetic" });
    const replay = journal.append({ eventId: "first", data: "must not replace" });
    const next = journal.append({ eventId: "second", data: "continue" });
    const events = readFileSync(join(dir, "journal", "events.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    if (!deadOwnerRecovered || replay.sequence !== 1 || next.sequence !== 2 || events.length !== 2 || events[0].data !== "preserve")
      throw qualificationGate("Native journal replay did not preserve the acknowledged event.");
    return { platform: process.platform, arch: process.arch, node: process.version,
      process: digest([lease.identity, lease.instance, liveLockPreserved, deadOwnerRecovered]),
      cancellation: digest([job.id, job.birth, runner.current().exit]), journal: digest(events),
      cleanup: digest(proof) };
  } finally {
    if (job && runner.current()?.running) requestRunCancellation(runner, job.id);
    if (job) await waitFor(() => !pidExists(job.pid) && runner.cleanupSettled(job.id), "Retain the probe directory until native cessation is proved.");
    await removeOwnedDirectory(root, basename(dir), { proof });
  }
}
