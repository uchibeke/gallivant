// Run under the original worker account with the coordinator's verified stop
// members. Check birth and UID again after sudo starts before signaling a PID.
import { readFileSync } from "node:fs";
import { processBirth } from "../lib/daemon.mjs";

const uid = Number(process.argv[2]), signal = process.argv[3];
if (!uid || process.getuid() !== uid || process.geteuid() !== uid || !["SIGTERM", "SIGKILL"].includes(signal)) {
  throw new Error("Unexpected worker identity or signal.");
}
const members = JSON.parse(readFileSync(0, "utf8"));
if (!Array.isArray(members) || members.some(member => !Number.isSafeInteger(member?.pid) || member.pid <= 0 ||
    typeof member.started !== "string" || !member.started || member.started.length > 64)) throw new Error("Invalid worker stop members.");
const sent = [];
for (const { pid, started } of members) {
  // sudo's own monitor can be in the tree. Only this UID's processes are
  // delegated, and a replaced PID is never included in the receipt.
  if (processBirth(pid, { uid }) !== started) continue;
  try { process.kill(pid, signal); sent.push(pid); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
process.stdout.write(JSON.stringify(sent));
