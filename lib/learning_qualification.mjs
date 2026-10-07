// Disposable OS-denial evidence, never a config boolean or production enrollment.
// The current coding adapters do not launch through this outer profile. A passed
// standalone probe therefore cannot qualify their production apply mode.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationSandboxSpec } from "./verification_sandbox.mjs";
import { execFileAsync } from "./gh.mjs";
import { hash } from "./learning_data.mjs";

const PROBE = `const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
const paths=JSON.parse(process.argv[1]),namespace=process.argv[2]||'';
if(namespace&&fs.readlinkSync('/proc/self/ns/net')===namespace)process.exit(49);
for(const p of paths) {
  for(const action of [()=>fs.readFileSync(p),()=>fs.writeFileSync(p,'changed')]) {
    try {action();process.exit(41);} catch(e){if(!['EPERM','EACCES','ENOENT','EROFS'].includes(e.code))process.exit(42);}
  }
}
try{fs.openSync('/dev/tty','r+');process.exit(43);}catch(e){if(!['EPERM','EACCES','ENXIO','ENOENT','ENODEV'].includes(e.code))process.exit(44);}
try{cp.execFileSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)','/bin/cat',paths[0]],{stdio:'pipe'});process.exit(45);}catch{}
const s=net.connect({host:'127.0.0.1',port:9});s.on('connect',()=>process.exit(46));
s.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code)&&!(namespace&&['ENETUNREACH','EHOSTUNREACH','ECONNREFUSED'].includes(e.code)))process.exit(47);process.stdout.write('denied-key-trust-verifier-checkpoint-terminal-control');});
setTimeout(()=>process.exit(48),2000).unref();`;

export async function probeLearningIsolation({ exec = execFileAsync } = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "learning-isolation-"));
  try {
    const worktree = join(dir, "worker"), home = join(dir, "empty-home"), protectedDir = join(dir, "protected");
    for (const p of [worktree, home, protectedDir]) mkdirSync(p, { mode: 0o700 });
    const canaries = ["private-key", "public-trust", "active-store", "checkpoint", "verifier"].map(name => join(protectedDir, name));
    for (const p of canaries) writeFileSync(p, "disposable-canary", { mode: 0o600 });
    const spec = verificationSandboxSpec({ worktree, home, env: { HOME: home, LANG: "C" } });
    const namespace = spec.driver === "bubblewrap" ? readlinkSync("/proc/self/ns/net") : "";
    const result = await exec(spec.cmd, [...spec.args, spec.node, "-e", PROBE, JSON.stringify(canaries), namespace], { env: spec.env, cwd: worktree, timeout: 5000, maxBuffer: 4096 });
    if (result.stdout !== "denied-key-trust-verifier-checkpoint-terminal-control" || canaries.some(p => readFileSync(p, "utf8") !== "disposable-canary")) throw new Error("denial probes failed");
    return { qualified: false, status: "UNQUALIFIED", standaloneProbe: "passed", platform: process.platform, driver: spec.driver, profileDigest: hash({ cmd: spec.cmd, args: spec.args, node: spec.node }), output: result.stdout, reason: "disposable offline OS profile passed; installed coding adapters are not enclosed by it", remedy: "integrate and qualify the exact installed worker/extractor launch and privileged/control routes before production apply" };
  } catch (e) {
    return { qualified: false, status: "UNQUALIFIED", platform: process.platform, standaloneProbe: "failed", reason: String(e.stderr || e.message).slice(0, 2048), remedy: "macOS must permit sandbox-exec; Linux needs /usr/bin/bwrap and working user/PID/network namespaces; run from the operator terminal" };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The live ceremony owns these disposable directories and launches every probe
// through the very same compiled profile. It is never returned by config or the
// installed coordinator's learningFor factory.
export function disposableLearningProfile(dir, { exec = execFileAsync } = {}) {
  const worktree = join(dir, "worker"), home = join(dir, "empty-home"), protectedDir = join(dir, "protected");
  for (const p of [worktree, home, protectedDir]) mkdirSync(p, { mode: 0o700 });
  const paths = ["private-key", "public-trust", "active-store", "checkpoint", "verifier"].map(name => join(protectedDir, name));
  for (const path of paths) writeFileSync(path, "disposable-canary", { mode: 0o600 });
  const spec = verificationSandboxSpec({ worktree, home, env: { HOME: home, LANG: "C" } });
  const namespace = spec.driver === "bubblewrap" ? readlinkSync("/proc/self/ns/net") : "";
  return {
    worktree, home, protectedDir,
    async qualify() {
      const result = await exec(spec.cmd, [...spec.args, spec.node, "-e", PROBE, JSON.stringify(paths), namespace], { env: spec.env, cwd: worktree, timeout: 5000, maxBuffer: 4096 });
      if (result.stdout !== "denied-key-trust-verifier-checkpoint-terminal-control" || paths.some(p => readFileSync(p, "utf8") !== "disposable-canary")) throw new Error("disposable live authority boundary failed");
      return { qualified: true, disposableOnly: true, status: "disposable offline profile passed", driver: spec.driver, profileDigest: hash({ cmd: spec.cmd, args: spec.args, node: spec.node }), observed: result.stdout };
    },
    async consume(snapshot) {
      const program = `const s=JSON.parse(process.argv[1]),c=require('node:crypto');const digest=c.createHash('sha256').update(s.section).digest('hex');if(digest!==s.contextDigest)process.exit(51);process.stdout.write(JSON.stringify({contextDigest:digest,bundleDigest:s.bundleDigest,rules:s.rules}));`;
      const result = await exec(spec.cmd, [...spec.args, spec.node, "-e", program, JSON.stringify(snapshot)], { env: spec.env, cwd: worktree, timeout: 5000, maxBuffer: 4096 });
      const consumed = JSON.parse(result.stdout);
      if (consumed.contextDigest !== snapshot.contextDigest || consumed.bundleDigest !== snapshot.bundleDigest) throw new Error("live worker consumed different context bytes");
      return { runId: `disposable-live-${hash(result.stdout).slice(0, 24)}`, consumed };
    },
  };
}
