import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const sourceExec = promisify(execFile);
import { readRepositoryText, assertRepositoryTargets } from "./repository_files.mjs";
import { parseTaskSources } from "./task_contract.mjs";
import { executionError } from "./execution_io.mjs";
import { AGENTS_LIMITS } from "./openai_agents_http.mjs";
export const contentHash = value => value === null ? null : createHash("sha256").update(value).digest("hex");
export function portablePath(path) {
  const parsed = parseTaskSources([path]);
  if (parsed.problems.length || parsed.paths[0] !== path || path.split("/").some(p => !p || p === ".") || /[\x00-\x1f\x7f]/.test(path)) throw executionError("AGENTS_SOURCE", "unsafe or private portable source/result path");
  return path;
}
// Only approved brief/source overlays may differ from HEAD. An explicit resume
// must never describe preserved local edits while dispatching stale Git blobs.
export async function assertAgentsCheckout({ worktree, overlays = [], signal }, exec = sourceExec) {
  const allowed = new Set(overlays.map(item => portablePath(typeof item === "string" ? item : item.path)));
  const { stdout } = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktree, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, signal, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 20_000 });
  for (const entry of stdout.split("\0").filter(Boolean)) {
    if (entry.length < 4 || entry[2] !== " " || /[RCU]/.test(entry.slice(0, 2)) || !allowed.has(entry.slice(3))) {
      throw executionError("AGENTS_DIRTY_SOURCE", "hosted execution requires unfinished repository edits to be committed before resume; preserve the index/worktree, commit the intended changes on the owned branch, then resume the existing session; only approved brief/source overlays may remain uncommitted");
    }
  }
}
// Immutable Git blobs, plus the foundation's explicitly snapshotted brief and
// carried sources. Never upload the checkout's environment or Git history.
export async function prepareAgentsSources({ worktree, inputHead, repo, branch, base, overlays = [], signal }, exec = sourceExec) {
  if (!/^[a-f0-9]{40}$/.test(inputHead || "") || !/^[\w.-]+\/[\w.-]+$/.test(repo || "") || typeof branch !== "string" || branch === base) throw executionError("AGENTS_SOURCE", "exact source head and owned repository/branch/base are required");
  const options = { cwd: worktree, signal, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 20_000 };
  const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], options);
  if (head.trim() !== inputHead) throw executionError("AGENTS_SOURCE", "source head changed during preparation");
  await assertAgentsCheckout({ worktree, overlays, signal }, exec);
  const { stdout: listing } = await exec("git", ["ls-tree", "-r", "-z", inputHead], options);
  const files = new Map(); let size = 0;
  for (const entry of listing.split("\0").filter(Boolean)) {
    const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s);
    if (!match) throw executionError("AGENTS_SOURCE", "portable source includes a symlink, submodule or unsupported mode");
    const [, mode, blob, rawPath] = match, path = portablePath(rawPath);
    const { stdout: data } = await exec("git", ["cat-file", "blob", blob], { ...options, encoding: "buffer" });
    size += data.length;
    if (size > 10 * 1024 * 1024) throw executionError("AGENTS_SIZE", "portable source exceeds the 10 MiB expanded limit");
    files.set(path, { path, mode: Number.parseInt(mode.slice(-3), 8), data: data.toString("base64"), hash: contentHash(data) });
  }
  for (const item of overlays) {
    const path = portablePath(item.path);
    if (typeof item.text !== "string" || readRepositoryText(worktree, path) !== item.text) throw executionError("AGENTS_SOURCE", "portable brief/source differs from its saved snapshot");
    const bytes = Buffer.from(item.text); size += bytes.length;
    if (size > 10 * 1024 * 1024) throw executionError("AGENTS_SIZE", "portable source exceeds the expanded limit");
    files.set(path, { path, mode: files.get(path)?.mode ?? 0o644, data: bytes.toString("base64"), hash: contentHash(bytes) });
  }
  assertRepositoryTargets([...files.keys()], [...files.keys()]);
  await assertAgentsCheckout({ worktree, overlays, signal }, exec);
  if ((await exec("git", ["rev-parse", "HEAD"], options)).stdout.trim() !== inputHead) throw executionError("AGENTS_SOURCE", "source head changed during preparation");
  // Carried files can be uncommitted on the coordinator's fresh checkout. Include
  // them in delivery even when the agent leaves their approved bytes unchanged,
  // so the single PR writer commits them with the implementation. Later receipt
  // repairs use the same verified files without manufacturing a code change.
  const manifest = { version: 1, inputHead, repo, branch, base, deliveryPaths: overlays.map(item => item.path), files: [...files.values()] };
  const bytes = gzipSync(Buffer.from(JSON.stringify(manifest)));
  if (bytes.length > AGENTS_LIMITS.uploadBytes || bytes.length * 4 / 3 > AGENTS_LIMITS.inputBytes - 65_536) throw executionError("AGENTS_SIZE", "portable snapshot exceeds inline request limits; reduce explicitly selected context");
  return { bytes, hash: contentHash(bytes), inputHead, repo, branch, base, hashes: Object.fromEntries(manifest.files.map(f => [f.path, f.hash])), modes: Object.fromEntries(manifest.files.map(f => [f.path, f.mode])) };
}

// Shipped into the sandbox. Outputs contain text changes and test records only;
// GitHub credentials and API keys stay with the coordinator's existing PR writer.
export const AGENTS_WORKSPACE_HELPER = String.raw`import base64,gzip,hashlib,json,pathlib,shutil,subprocess,sys
root=pathlib.Path('/workspace/repo')
def safe(path):
    p=pathlib.PurePosixPath(path)
    if p.is_absolute() or not p.parts or any(x in ('..','.git') for x in p.parts): raise ValueError('unsafe path')
    target=root.joinpath(*p.parts)
    if any(x.is_symlink() for x in (target,*target.parents) if x==root or root in x.parents): raise ValueError('output symlink')
    return target
def sha(data): return hashlib.sha256(data).hexdigest()
def restore(source, expected):
    raw=pathlib.Path(source).read_bytes()
    if sha(raw)!=expected: raise ValueError('snapshot hash mismatch')
    m=json.loads(gzip.decompress(raw))
    if root.exists(): shutil.rmtree(root)
    root.mkdir()
    for f in m['files']:
        p=safe(f['path']); data=base64.b64decode(f['data'],validate=True)
        if sha(data)!=f['hash']: raise ValueError('source hash mismatch')
        p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(data); p.chmod(f['mode'])
    subprocess.run(['git','init','-b',m['branch']],cwd=root,check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['git','add','--all'],cwd=root,check=True)
    subprocess.run(['git','-c','user.name=Workspace','-c','user.email=workspace@localhost','commit','-qm','Input snapshot'],cwd=root,check=True)
    pathlib.Path('/workspace/baseline.json').write_text(json.dumps(m))
def publish(prfile, testsfile):
    m=json.loads(pathlib.Path('/workspace/baseline.json').read_text()); before={f['path']:f for f in m['files']}; files=[]
    paths=set(before)
    selected=subprocess.run(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root,check=True,stdout=subprocess.PIPE).stdout.decode('utf-8')
    paths.update(x for x in selected.split('\x00') if x)
    for name in sorted(paths):
        p=safe(name); previous=before.get(name)
        if p.exists() and (p.stat().st_mode&0o777 != (previous['mode'] if previous else 0o644) or p.stat().st_size>max(1000000,len(base64.b64decode(previous['data'])) if previous else 0)): raise ValueError('unsupported output mode/size')
        data=p.read_bytes() if p.exists() else None
        after=sha(data) if data is not None else None
        if after==(previous['hash'] if previous else None) and name not in m.get('deliveryPaths',[]): continue
        if data is not None and b'\x00' in data: raise ValueError('unsupported output content')
        files.append({'path':name,'beforeHash':previous['hash'] if previous else None,'afterHash':after,'text':data.decode('utf-8') if data is not None else None})
    result={'version':1,'inputHead':m['inputHead'],'repo':m['repo'],'branch':m['branch'],'files':files,'pr':json.loads(pathlib.Path(prfile).read_text()),'tests':json.loads(pathlib.Path(testsfile).read_text())}
    raw=json.dumps(result).encode()
    if len(files)>100 or len(raw)>1000000: raise ValueError('bounded result exceeded')
    out=pathlib.Path('/workspace/outputs'); out.mkdir(exist_ok=True); (out/'result.json').write_bytes(raw)
if sys.argv[1]=='restore': restore(sys.argv[2],sys.argv[3])
elif sys.argv[1]=='publish': publish(sys.argv[2],sys.argv[3])
else: raise ValueError('unknown operation')
`;
