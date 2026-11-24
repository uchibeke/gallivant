// Runs as the worker through the production launcher. Return only observed
// identities. No repository or provider program is executed in this probe.
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const denied = error => ["EACCES", "EPERM"].includes(error.code);
function requireDenied(operation, message) {
  try { operation(); }
  catch (error) { if (denied(error)) return; throw new Error(message); }
  throw new Error(message);
}

async function denySocket(path) {
  await new Promise((resolve, reject) => {
    const socket = connect({ path });
    socket.setTimeout(1000, () => socket.destroy(new Error("socket probe timeout")));
    socket.once("connect", () => socket.destroy(new Error("socket connected")));
    socket.once("error", error => denied(error) ? resolve() : reject(new Error("Worker exclusion from the running approval socket could not be proved.")));
  });
}

async function denyTracker(port) {
  const origin = `http://127.0.0.1:${port}`;
  const routes = ["/api/plan/control", "/api/run/control", "/api/chain/control", "/api/ci-timing", "/api/task/intake/start"];
  await Promise.all(routes.map(async route => {
    const response = await fetch(origin + route, { method: "POST", headers: { origin, "content-type": "application/json" },
      body: "{}", signal: AbortSignal.timeout(1000), redirect: "error" });
    await response.body?.cancel();
    if (response.status !== 403) throw new Error("The standalone tracker did not deny an unauthenticated worker mutation.");
  }));
}

try {
  const { uid, pid, root, worktrees, protectedPaths, routes, socket, checkout, checkoutParent, trackerPort } = JSON.parse(process.argv[2]);
  if (process.getuid() !== uid || process.geteuid() !== uid || !uid || process.getgroups().includes(0)) throw new Error("Unexpected worker identity.");
  const policy = spawnSync("/usr/bin/sudo", ["-n", "-l"], { stdio: "ignore", timeout: 1000, killSignal: "SIGKILL" });
  if (policy.status !== 1) throw new Error("The worker must have no sudo grant.");
  for (const mode of [constants.R_OK, constants.W_OK, constants.X_OK]) requireDenied(() => accessSync(root, mode), "Worker can reach the private coordinator home.");
  for (const name of ["config.json", "state.json", "runs", "plan.sock"]) {
    for (const mode of [constants.R_OK, constants.W_OK]) requireDenied(() => accessSync(join(root, name), mode), "Worker can reach protected coordinator state.");
  }
  requireDenied(() => process.kill(pid, 0), "Worker can signal the coordinator or its identity is unverified.");
  if (socket) await denySocket(socket);

  const ancestors = new Set();
  const parent = checkoutParent ?? (checkout && dirname(checkout));
  for (const path of [...protectedPaths, worktrees, ...(parent ? [parent] : [])]) {
    if (path !== root) requireDenied(() => accessSync(path, constants.W_OK), "Worker can modify installed code or a protected directory.");
    for (let part = dirname(path); !ancestors.has(part); part = dirname(part)) {
      ancestors.add(part);
      const st = statSync(part);
      if (!(st.mode & 0o1000) || st.uid === uid) requireDenied(() => accessSync(part, constants.W_OK), "Worker can replace a protected parent directory.");
      if (part === "/") break;
    }
  }
  for (const route of routes) {
    accessSync(route.bin, constants.R_OK | constants.X_OK);
    if (route.settings) accessSync(route.settings, constants.R_OK);
  }
  accessSync(worktrees, constants.X_OK);
  if (parent) accessSync(parent, constants.X_OK);
  if (checkout) accessSync(checkout, constants.R_OK | constants.W_OK | constants.X_OK);
  if (trackerPort && Number.isInteger(trackerPort) && trackerPort > 0 && trackerPort < 65536) await denyTracker(trackerPort);
  const home = realpathSync(process.env.HOME);
  if (statSync(home).uid !== uid) throw new Error("The worker has no separate login profile.");
  process.stdout.write(JSON.stringify({ uid, home, groups: [...new Set(process.getgroups())].sort((a, b) => a - b) }));
} catch (error) {
  process.stderr.write(`local worker probe: ${error.code ? "A required runtime or checkout path was inaccessible." : error.message}\n`);
  process.exitCode = 1;
}
