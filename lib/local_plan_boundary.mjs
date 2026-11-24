import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { hostname, release } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileAsync } from "./process.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { planFailure } from "./dependency_plan_anchors.mjs";

const SUDO = "/usr/bin/sudo";
const GIT = "/usr/bin/git";
const POSIX_ACL = "/usr/bin/setfacl";
const ACL = process.platform === "darwin" ? "/bin/chmod" : POSIX_ACL;
const packageRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const probeFile = join(packageRoot, "bin/local-plan-worker-probe.mjs");
const signalFile = join(packageRoot, "bin/local-plan-worker-signal.mjs");
const uid = process.getuid?.();
const within = (child, parent) => { const rel = relative(parent, child); return !rel || (!isAbsolute(rel) && rel.split(sep)[0] !== ".."); };
const sha = /^[a-f0-9]{64}$/;
const username = /^[a-z_][a-z0-9_-]{0,31}$/i;
const privilegedGroups = /^(?:admin|wheel|sudo|root|docker|podman|lxd|libvirt|disk)$/i;
export const PROOF_MS = 30_000;
export const localPlanError = message => planFailure("PLAN_QUALIFICATION", message);
export const planSocketPath = home => join(home, "plan.sock");

export function privatePlanConfig(home) {
  const file = join(home, "config.json");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) || st.size > 1024 * 1024) {
      throw localPlanError("Use an operator-owned, mode-600 config.json of at most 1 MiB.");
    }
    const bytes = Buffer.alloc(st.size + 1);
    if (readSync(fd, bytes) !== st.size) throw localPlanError("Configuration changed during the read. Rerun plan setup --check.");
    return JSON.parse(bytes.subarray(0, st.size).toString("utf8"));
  } finally { closeSync(fd); }
}

export function privatePlanHome(home) {
  const root = realpathSync(home), st = lstatSync(root, { bigint: true });
  if (uid == null || !st.isDirectory() || st.uid !== BigInt(uid) || (st.mode & 0o077n)) {
    throw localPlanError("Use a private mode-700 home owned by the non-root coordinator account.");
  }
  if (Buffer.byteLength(planSocketPath(root)) > 100) throw localPlanError("Use a shorter absolute home path for the local approval socket.");
  return { root, identity: [String(st.dev), String(st.ino), uid] };
}

export function validLocalPlan(record) {
  return record?.version === 1 && username.test(record.worker ?? "") && /^[0-9a-f-]{36}$/.test(record.owner ?? "") &&
    sha.test(record.key ?? "") && sha.test(record.launch ?? "") && record.account &&
    Number.isSafeInteger(record.account.uid) && record.account.uid > 0 && record.account.uid !== uid &&
    typeof record.account.home === "string" && isAbsolute(record.account.home) && Array.isArray(record.account.groups) &&
    Array.isArray(record.repositories) && record.repositories.length > 0 && record.repositories.length <= 64;
}

const fileIdentity = st => [String(st.dev), String(st.ino), String(st.size), String(st.mtimeNs), String(st.ctimeNs), String(st.mode), String(st.uid)];
const binCache = new Map();
function fixedFile(path, remaining, { hash = true } = {}) {
  const fixed = realpathSync(path), st = statSync(fixed, { bigint: true });
  if (!st.isFile() || (st.uid !== 0n && st.uid !== BigInt(uid)) || (st.mode & 0o022n) || st.size > BigInt(remaining)) {
    throw localPlanError(`Install ${path} outside worker writes using an operator- or root-owned installation.`);
  }
  const identity = fileIdentity(st), key = identity.join(":"), prior = binCache.get(fixed);
  let bytes = null;
  if (hash) {
    bytes = prior?.key === key ? prior.bytes : createHash("sha256").update(readFileSync(fixed)).digest("hex");
    if (fileIdentity(statSync(fixed, { bigint: true })).join(":") !== key) throw localPlanError("The installed launcher changed while it was being checked.");
    if (binCache.size >= 2048) binCache.clear();
    binCache.set(fixed, { key, bytes });
  }
  return [path, fixed, identity, bytes];
}

function installedFiles() {
  const files = [join(packageRoot, "package.json"), join(packageRoot, "npm-shrinkwrap.json")];
  const walk = (dir, depth) => {
    if (depth > 4) throw localPlanError("The installed runtime tree exceeds the qualification bounds.");
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= 1024) throw localPlanError("The installed runtime tree exceeds the qualification bounds.");
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path, depth + 1);
      else if (/\.(?:mjs|js|css)$/.test(item.name)) files.push(path);
    }
  };
  walk(join(packageRoot, "lib"), 0);
  walk(join(packageRoot, "bin"), 0);
  walk(join(packageRoot, "templates", "tracker"), 0);
  let remaining = 16 * 1024 * 1024;
  return files.map(path => {
    const item = fixedFile(path, remaining);
    remaining -= Number(item[2][2]);
    return item;
  });
}

export function localWorkerSpec(ctx, worker) {
  if (!uid || !["darwin", "linux"].includes(process.platform)) throw localPlanError("Local plans require a non-root macOS or Linux coordinator account.");
  if (!username.test(worker ?? "")) throw localPlanError("Provision a dedicated unprivileged OS user, then run plan setup --worker USER.");
  const route = ctx.config.harness.codex;
  if (!route?.bin || Object.keys(ctx.config.harness).length !== 1 || !isAbsolute(route.bin)) {
    throw localPlanError("Configure a single local Codex route with an absolute harness.codex.bin path.");
  }
  const { root, identity } = privatePlanHome(ctx.home);
  const worktrees = realpathSync(ctx.config.worktrees), st = statSync(worktrees, { bigint: true });
  if (worktrees !== ctx.config.worktrees || !st.isDirectory() || st.uid !== BigInt(uid) || within(worktrees, root) || within(root, worktrees) || (st.mode & 0o022n)) {
    throw localPlanError("Use an operator-owned worktrees directory outside the private home. Grant the worker traversal only on its parents.");
  }
  const fixed = [fixedFile(process.execPath, 256 * 1024 * 1024), fixedFile(route.bin, 256 * 1024 * 1024), ...installedFiles()];
  const system = [SUDO, GIT, ACL, "/usr/bin/id"].map(path => {
    try { accessSync(path, constants.X_OK); return fixedFile(path, 32 * 1024 * 1024, { hash: false }); }
    catch { throw localPlanError(`Install or repair ${path} for the local worker launcher.`); }
  });
  const path = [...new Set([dirname(process.execPath), dirname(route.bin), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/opt/homebrew/bin"])].join(":");
  const fingerprint = digest([process.platform, process.arch, release(), hostname(), root, identity, worktrees,
    String(st.dev), String(st.ino), route, path, fixed, system]);
  const protectedPaths = new Set([root, ...[...fixed, ...system].flatMap(([path, fixed]) => [path, fixed])]);
  return { root, worktrees, path, worker, bin: route.bin, fingerprint, protectedPaths: [...protectedPaths] };
}

const forwarded = /^(?:PATH|LC_ALL|LANG|GIT_CONFIG_(?:COUNT|GLOBAL|NOSYSTEM|KEY_\d+|VALUE_\d+)|GIT_(?:SSH_COMMAND|OPTIONAL_LOCKS|TERMINAL_PROMPT|CREDENTIAL_HOST|CREDENTIAL_REPOSITORY|HOST_USERNAME|HOST_TOKEN)|GH_(?:HOST|TOKEN|CONFIG_DIR)|HOST_API_(?:HOST|REPOSITORY|TOKEN|EMAIL|BINDING)|NODE_AUTH_TOKEN|GITHUB_PACKAGES_TOKEN|GIT_ATTR_NOSYSTEM)$/;

export function localWorkerCommand(spec, account, cmd, args, { cwd = "/", env = {} } = {}) {
  const isolated = { ...Object.fromEntries(Object.entries(env).filter(([key, value]) => typeof value === "string" && forwarded.test(key))), PATH: spec.path, LC_ALL: "C", LANG: "C" };
  return { cmd: SUDO, args: ["-n", "-H", "-u", `#${account.uid}`, `--preserve-env=${Object.keys(isolated).join(",")}`, "--", cmd, ...args],
    options: { cwd, env: isolated } };
}

export function signalPlanWorker(command, members, signal, exec = execFileSync) {
  // The durable command records the original identity even if the enrollment
  // changes or the launcher has exited. No active grant is needed to stop it.
  const args = command?.args;
  const account = Number(/^#([1-9]\d*)$/.exec(args?.[3] ?? "")?.[1]);
  if (command?.cmd !== SUDO || !Array.isArray(args) || args[0] !== "-n" || args[1] !== "-H" || args[2] !== "-u" || args[5] !== "--" ||
      !Number.isSafeInteger(account) || account === uid || !["SIGTERM", "SIGKILL"].includes(signal)) throw localPlanError("Invalid recorded worker signal route.");
  const launch = localWorkerCommand({ path: "/usr/bin:/bin" }, { uid: account }, process.execPath, [signalFile, String(account), signal]);
  const input = JSON.stringify(members.map(({ pid, started }) => ({ pid, started })));
  const receipt = JSON.parse(exec(launch.cmd, launch.args, { ...launch.options, input, encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"], timeout: 5000, killSignal: "SIGKILL" }));
  const expected = new Set(members.map(member => member.pid));
  if (!Array.isArray(receipt) || receipt.some(pid => !expected.has(pid))) throw localPlanError("Invalid worker signal receipt.");
  return new Set(receipt);
}

export async function probePlanWorker(spec, { pid = process.pid, socket = null, checkout = null, checkoutParent = null, trackerPort = null, exec = execFileAsync } = {}) {
  const options = { cwd: "/", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 4000, maxBuffer: 8192, killSignal: "SIGKILL" };
  try {
    const account = Number((await exec("/usr/bin/id", ["-u", spec.worker], options)).stdout.trim());
    const groups = (await exec("/usr/bin/id", ["-Gn", spec.worker], options)).stdout.trim().split(/\s+/);
    if (!Number.isSafeInteger(account) || account <= 0 || account === uid || groups.some(group => privilegedGroups.test(group))) {
      throw localPlanError("The worker must be a distinct unprivileged OS user without administrative groups or sudo access.");
    }
    const groupIds = [...new Set((await exec("/usr/bin/id", ["-G", spec.worker], options)).stdout.trim().split(/\s+/).map(Number))].sort((a, b) => a - b);
    const launch = localWorkerCommand(spec, { uid: account }, process.execPath, [probeFile, JSON.stringify({ uid: account, pid,
      root: spec.root, worktrees: spec.worktrees, protectedPaths: spec.protectedPaths, bin: spec.bin, socket, checkout, checkoutParent, trackerPort })]);
    if (Buffer.byteLength(launch.args.at(-1)) > 96 * 1024) throw localPlanError("The installation paths exceed the local worker probe size bound.");
    const result = JSON.parse((await exec(launch.cmd, launch.args, { ...options, ...launch.options })).stdout);
    if (result.uid !== account || !isAbsolute(result.home) || within(result.home, spec.root) ||
        within(spec.root, result.home) || within(spec.worktrees, result.home) || within(result.home, spec.worktrees) ||
        JSON.stringify(result.groups) !== JSON.stringify(groupIds)) throw localPlanError("Use a separate worker profile and reset supplementary groups at launch.");
    return { uid: account, home: result.home, groups: result.groups };
  } catch (error) {
    if (error.code === "PLAN_QUALIFICATION") throw error;
    const detail = String(error.stderr ?? "").split("\n").find(line => /^local worker probe: /.test(line))?.slice(20, 180);
    throw localPlanError(`${detail ?? "The worker identity or sudo launch could not be verified."} Check the dedicated account, checkout ACLs and noninteractive sudo policy in the local plan setup guide.`);
  }
}

// The directory entry is protected by its operator-owned parent. Only the new
// checkout has an inheritable dual-user ACL. Clone and subsequent Git commands
// against that tree run under the worker UID, including repository Git helpers.
export async function grantPlanCheckout(spec, account, path, exec = execFileAsync) {
  const parent = dirname(path);
  const info = lstatSync(parent);
  if (!within(parent, spec.worktrees) || !info.isDirectory() || realpathSync(parent) !== parent || info.uid !== uid || (info.mode & 0o022)) {
    throw localPlanError("The checkout parent must stay operator-owned and outside worker writes.");
  }
  mkdirSync(path, { mode: 0o700 });
  const options = { cwd: parent, timeout: 4000, maxBuffer: 4096 };
  if (process.platform === "darwin") {
    const owner = (await exec("/usr/bin/id", ["-un"], options)).stdout.trim();
    const acl = user => ["+a", `user:${user} allow read,write,execute,append,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit`, path];
    await exec(ACL, acl(owner), options);
    await exec(ACL, acl(spec.worker), options);
  } else await exec(ACL, ["-m", `u:${account.uid}:rwx,d:u:${account.uid}:rwx,d:u:${uid}:rwx`, path], options);
}

export function grantPlanOverlayAccess(checkout, account, fd, path) {
  const st = fstatSync(fd);
  if (checkout === path || !within(path, checkout) || realpathSync(`/proc/self/fd/${fd}`) !== path ||
      (!st.isDirectory() && !(st.isFile() && st.uid === uid && st.nlink === 1))) {
    throw localPlanError("Cannot verify the approved checkout overlay. Inspect the checkout paths before retrying.");
  }
  // Existing Git directories created by the worker keep their own permissions.
  if (st.isDirectory() && st.uid === account.uid) return;
  if (st.uid !== uid) throw localPlanError("Use the operator's or dedicated worker's directories for approved checkout overlays.");
  const access = st.isDirectory() || (st.mode & 0o100) ? "rwx" : "rw-";
  try {
    // The POSIX mask applies to named users. Use the opened inode so a replaced
    // pathname cannot redirect the grant outside the approved checkout.
    execFileSync(POSIX_ACL, ["-m", `u:${account.uid}:${access},m::${access}`, "--", "/proc/self/fd/3"], {
      stdio: ["ignore", "ignore", "pipe", fd], timeout: 4000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
  } catch { throw localPlanError("The worker ACL could not be applied. Check Linux ACL support in the managed checkout, then retry."); }
}

export function workerGitCommand(spec, account, args, options) {
  const [org, repo, task] = relative(spec.worktrees, options.cwd).split(sep);
  if (!org || !repo || !task || org === ".." || realpathSync(options.cwd) !== options.cwd) throw localPlanError("Git requires a canonical managed checkout.");
  const env = { ...options.env }, index = Number(env.GIT_CONFIG_COUNT ?? 0);
  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = "safe.directory";
  env[`GIT_CONFIG_VALUE_${index}`] = join(spec.worktrees, org, repo, task);
  return localWorkerCommand(spec, account, GIT, args, { ...options, env });
}

export const isManagedCheckout = (root, path) => Boolean(root && path && within(path, root));
