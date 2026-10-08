// Provider-controlled Verify commands run behind an OS boundary, including their
// descendants. An empty HOME is useful isolation, but is not that boundary.
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, realpathSync, statSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { execFileAsync, MAX_DIFF_BYTES } from "./gh.mjs";
import { executionError } from "./execution_io.mjs";

const unavailable = () => executionError("EXECUTION_VERIFICATION_SANDBOX", "OS verification sandbox unavailable or enforcement probe failed; use macOS sandbox-exec with its installed dyld-support.sb and Command Line Tools, or Linux /usr/bin/bwrap with working user/PID/network namespaces; /usr/bin/git and a dedicated Node installation with npm are required. Preserve saved results and repair host isolation before explicitly resuming; verification never falls back to an unsandboxed shell");
export { unavailable as verificationSandboxUnavailable };
const inside = (path, root) => path === root || path.startsWith(root + "/");

export function validVerificationSandbox(value) {
  return value?.version === 1 && ["sandbox-exec", "bubblewrap"].includes(value.driver) && value.filesystem === "checkout-and-runtime" && value.network === "disabled" && value.probe === "passed";
}

// Bind the CLI module and create its normal entry point without exposing the
// entire Node bin directory. Binding a symlink as a file would lose npm's module
// location and break its relative imports. System bin mounts already own theirs.
export function verificationRuntimeMounts({ runtime, extra, npmLauncher, npmCli }) {
  const roots = [...new Set([...runtime, ...extra])], args = [];
  for (const path of roots) args.push("--ro-bind", path, path);
  if (npmCli && !roots.some(root => inside(npmLauncher, root))) args.push("--symlink", npmCli, npmLauncher);
  return args;
}

// Runtime grants are fixed system tool/library directories, the running Node
// binary and its npm modules, never the operator's PATH, HOME or config roots.
export function verificationSandboxSpec({ worktree, home, env, gitView = null, platform = process.platform, node = process.execPath }) {
  worktree = realpathSync(worktree); home = realpathSync(home); node = realpathSync(node);
  if (inside(home, worktree) || inside(worktree, home)) throw unavailable();
  const nodeBin = dirname(node), npm = join(dirname(nodeBin), "lib/node_modules/npm");
  const npmCli = existsSync(npm) ? realpathSync(join(npm, "bin/npm-cli.js")) : null;
  env.PATH = [...new Set([nodeBin, "/usr/bin", "/bin"])].join(":");
  const runtime = ["/bin", "/usr/bin", "/usr/lib", ...(platform === "darwin"
    ? ["/System/Library", "/Library/Apple/usr/lib", "/Library/Developer/CommandLineTools", "/usr/share/zoneinfo", "/usr/share/nls"]
    : ["/lib", "/lib64", "/usr/share/zoneinfo"])].filter(existsSync);
  // A Node installed directly in /bin needs no extra installation-wide grant.
  const extra = [node, ...(existsSync(npm) ? [realpathSync(npm)] : [])];
  if ([...runtime, ...extra].some(root => inside(worktree, root) || inside(home, root) || inside(realpathSync(homedir()), root))) throw unavailable();
  const git = join(worktree, ".git");
  if (platform === "darwin") {
    const loader = "/System/Library/Sandbox/Profiles/dyld-support.sb";
    if (!existsSync("/usr/bin/sandbox-exec") || !existsSync(loader)) throw unavailable();
    const quote = value => JSON.stringify(value);
    const read = [...runtime.map(path => `(subpath ${quote(realpathSync(path))})`), ...extra.map(path => `(${statSync(path).isDirectory() ? "subpath" : "literal"} ${quote(path)})`)];
    const profile = `(version 1)
(deny default)
(import ${quote(loader)})
(allow syscall* system-fcntl mach-bootstrap)
(allow process-exec process-fork)
(allow signal (target self))
(allow file-read-metadata file-test-existence)
; libc page-size queries also use the compatibility name. Blocking it can
; make Node's allocator receive -1 and abort before the verification probe.
(allow sysctl-read (sysctl-name "hw.ncpu" "hw.logicalcpu" "hw.logicalcpu_max" "hw.physicalcpu" "hw.physicalcpu_max" "hw.memsize" "hw.pagesize" "hw.pagesize_compat" "hw.cachelinesize" "hw.machine" "hw.optional.arm64" "kern.ostype" "kern.hostname" "kern.osrelease" "kern.osversion" "kern.osproductversion" "kern.version" "kern.argmax" "kern.maxfiles" "kern.maxfilesperproc"))
(allow file-read* file-map-executable ${read.join(" ")})
(allow file-read* file-write* file-map-executable (subpath ${quote(worktree)}) (subpath ${quote(home)}))
(deny file-read* file-write* file-map-executable (subpath ${quote(git)}))
${gitView ? `(deny file-write* (subpath ${quote(gitView)}))` : ""}
(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))
(allow file-read* file-write-data (literal "/dev/null") (literal "/dev/zero") (subpath "/dev/fd"))
`;
    // Compile immutable coordinator-owned bytes for each launch. A policy file
    // in the writable profile could be replaced by an earlier Verify command.
    return { cmd: "/usr/bin/sandbox-exec", args: ["-p", profile], driver: "sandbox-exec", node, env };
  }
  if (platform === "linux") {
    if (!existsSync("/usr/bin/bwrap")) throw unavailable();
    const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev"];
    args.push(...verificationRuntimeMounts({ runtime, extra, npmLauncher: join(nodeBin, "npm"), npmCli }));
    args.push("--bind", worktree, worktree, "--bind", home, home);
    if (gitView) args.push("--ro-bind", gitView, gitView);
    if (existsSync(git)) {
      const empty = join(home, "hidden-git");
      if (statSync(git).isDirectory()) { mkdirSync(empty, { recursive: true }); args.push("--ro-bind", empty, git); }
      else args.push("--ro-bind", "/dev/null", git);
    }
    args.push("--chdir", worktree, "--");
    return { cmd: "/usr/bin/bwrap", args, driver: "bubblewrap", node, env };
  }
  throw unavailable();
}

// A disposable read-only repository contains only the current commit and its
// tree/blob objects, plus an index reconstructed from that tree. Never copy the
// coordinator's config, hooks, remotes, reflogs, alternate stores or history.
async function verificationGitView({ worktree, home, env, signal }, exec) {
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
  const options = { cwd: worktree, env: { ...env, GIT_NO_REPLACE_OBJECTS: "1" }, signal, timeout: 20_000, maxBuffer: MAX_DIFF_BYTES };
  const git = args => exec("/usr/bin/git", args, options);
  // Readiness precedes cloning. Use a trusted empty commit so that the same
  // native Git read/denied-write probe runs even before a real checkout exists.
  const empty = new Map(), object = (type, data) => { const oid = createHash("sha1").update(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data])).digest("hex"); empty.set(oid, { type, data }); return oid; };
  let head;
  if (existsSync(join(worktree, ".git"))) head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  else { const tree = object("tree", Buffer.alloc(0)); head = object("commit", Buffer.from(`tree ${tree}\nauthor Readiness <readiness@localhost> 0 +0000\ncommitter Readiness <readiness@localhost> 0 +0000\n\nReadiness\n`)); }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw unavailable();
  const objects = empty.size ? [...empty.keys()] : (await git(["rev-list", "--objects", "--no-object-names", "--no-walk", head])).stdout.trim().split("\n");
  if (objects.length > 10_000) throw unavailable();
  const view = join(realpathSync(home), "verification-git");
  mkdirSync(join(view, "objects"), { recursive: true }); mkdirSync(join(view, "refs"));
  writeFileSync(join(view, "HEAD"), head + "\n"); writeFileSync(join(view, "shallow"), head + "\n");
  writeFileSync(join(view, "config"), `[core]\nrepositoryformatversion = ${head.length === 64 ? 1 : 0}\nbare = false\nfilemode = true\n${head.length === 64 ? "[extensions]\nobjectformat = sha256\n" : ""}`);
  let size = 0;
  for (const oid of new Set(objects)) {
    if (oid.length !== head.length || !/^[a-f0-9]+$/.test(oid)) throw unavailable();
    const type = empty.get(oid)?.type ?? (await git(["cat-file", "-t", oid])).stdout.trim();
    if (!["commit", "tree", "blob"].includes(type)) throw unavailable();
    const stdout = empty.get(oid)?.data ?? (await exec("/usr/bin/git", ["cat-file", type, oid], { ...options, encoding: "buffer" })).stdout;
    size += stdout.length; if (size > MAX_DIFF_BYTES) throw unavailable();
    const raw = Buffer.concat([Buffer.from(`${type} ${stdout.length}\0`), stdout]);
    if (createHash(head.length === 64 ? "sha256" : "sha1").update(raw).digest("hex") !== oid) throw unavailable();
    mkdirSync(join(view, "objects", oid.slice(0, 2)), { recursive: true });
    writeFileSync(join(view, "objects", oid.slice(0, 2), oid.slice(2)), deflateSync(raw));
  }
  const isolated = { ...env, GIT_DIR: view, GIT_WORK_TREE: realpathSync(worktree), GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" };
  await exec("/usr/bin/git", ["read-tree", "HEAD"], { ...options, env: isolated });
  Object.assign(env, isolated);
  return view;
}

// Probe the exact boundary before any repository code runs. The marker remains
// outside both grants. macOS must deny the TCP syscall; Linux must demonstrate a
// different network namespace as well as failure to reach the host loopback.
const PROBE = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
require('node:os').type();
const [outside,home,namespace]=process.argv.slice(1); const denied=e=>['EACCES','EPERM'].includes(e.code)||(namespace&&e.code==='ENOENT');
for(const action of [()=>fs.readFileSync(outside),()=>fs.writeFileSync(outside,'changed')]) {
  try { action(); process.exit(41); } catch(e) { if(!denied(e)) process.exit(42); }
}
fs.writeFileSync(home+'/probe-ok','ok'); fs.unlinkSync(home+'/probe-ok');
cp.execFileSync('/usr/bin/git',['diff','--check']); cp.execFileSync('/usr/bin/git',['rev-parse','--verify','HEAD']);
const npm=require('node:path').join(require('node:path').dirname(process.execPath),'npm');
fs.accessSync(npm,fs.constants.R_OK|fs.constants.X_OK); fs.readFileSync(npm);
try { fs.writeFileSync(process.env.GIT_DIR+'/index','changed'); process.exit(47); } catch(e) { if(!denied(e)&&e.code!=='EROFS') process.exit(48); }
if(namespace&&fs.readlinkSync('/proc/self/ns/net')===namespace) process.exit(46);
const socket=net.connect({host:'127.0.0.1',port:9}); socket.on('connect',()=>process.exit(43));
socket.on('error',e=>{if(!denied(e)&&!(namespace&&['ENETUNREACH','EHOSTUNREACH','ECONNREFUSED'].includes(e.code))) process.exit(44); process.stdout.write('sandbox-enforced');});
setTimeout(()=>process.exit(45),2000).unref();`;

export async function prepareVerificationSandbox(options, exec = execFileAsync) {
  let probeRoot;
  try {
    // Validate containment, fixed runtime grants and the OS driver before
    // constructing any temporary repository metadata.
    verificationSandboxSpec(options);
    const gitView = await verificationGitView(options, exec);
    const spec = verificationSandboxSpec({ ...options, gitView });
    probeRoot = mkdtempSync(join(dirname(realpathSync(options.home)), "verification-probe-"));
    const outside = join(probeRoot, "private-marker"); writeFileSync(outside, "private-sandbox-probe", { mode: 0o600 });
    const namespace = spec.driver === "bubblewrap" ? readlinkSync("/proc/self/ns/net") : "";
    const observed = await exec(spec.cmd, [...spec.args, spec.node, "-e", PROBE, outside, realpathSync(options.home), namespace],
      { cwd: options.worktree, env: spec.env, signal: options.signal, timeout: 5000, maxBuffer: 4096 });
    if (observed.stdout !== "sandbox-enforced") throw unavailable();
    return { ...spec, evidence: { version: 1, driver: spec.driver, filesystem: "checkout-and-runtime", network: "disabled", probe: "passed" } };
  } catch { throw unavailable(); }
  finally { if (probeRoot) rmSync(probeRoot, { recursive: true, force: true }); }
}
