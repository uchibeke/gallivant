// Private context belongs to the workspace owner. Git tracks the base's file;
// the approved snapshot remains readable through the private context service.
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { repositoryPath, assertRepositoryTargets } from "./repository_files.mjs";
import { contentDigest } from "./hash.mjs";
import { syncDirectory } from "./fs.mjs";
import { portablePath } from "./openai_agents_sources.mjs";

const limit = 10 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { code: "base-repair-overlay" });
const identity = stat => [String(stat.dev), String(stat.ino)];
const same = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];

export function directoryProof(path, io = fs) {
  const stat = io.lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || io.realpathSync(path) !== path) throw fail("Repair directory identity changed. Restore the recorded workspace.");
  return identity(stat);
}

// A regular single-link file, opened without following its final component.
// Compare directory entries as well as the descriptor before returning bytes.
export function recoveryFile(root, rel, io = fs, { backupLink = false, maxBytes = limit, ...options } = {}) {
  const path = repositoryPath(root, rel, options);
  let folder;
  try { folder = directoryProof(dirname(path), io); }
  catch (error) {
    if (error.code === "ENOENT" && options.allowMissingParents) return { path, folder: null, file: null };
    throw error;
  }
  let before;
  try { before = io.lstatSync(path, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return { path, folder, file: null }; throw error; }
  if (!before.isFile() || (before.nlink !== 1n && !(backupLink && before.nlink === 2n)) || before.size > BigInt(maxBytes))
    throw fail("Repair requires a bounded regular file with one link. Preserve the workspace and reconcile the path.");
  const fd = io.openSync(path, io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK);
  try {
    const opened = io.fstatSync(fd, { bigint: true });
    if (!same(identity(before), identity(opened)) || opened.nlink !== before.nlink || !opened.isFile()) throw fail("Recovery file changed while opening.");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = io.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = io.lstatSync(path, { bigint: true });
    if (size !== Number(before.size) || !same(identity(before), identity(after)) || after.nlink !== before.nlink ||
        before.ctimeNs !== after.ctimeNs || !same(folder, directoryProof(dirname(path), io))) throw fail("Recovery file or parent changed while reading.");
    const data = bytes.subarray(0, size);
    return { path, folder, file: identity(after), hash: contentDigest(data), mode: Number(after.mode & 0o777n),
      links: Number(after.nlink), bytes: data };
  } finally { io.closeSync(fd); }
}

function privateRoot(stateDir, directory, io, create) {
  const root = io.realpathSync(stateDir);
  if (!/^[a-f0-9]{64}$/.test(directory)) throw fail("Unrecognized private repair backup reference.");
  let path = root;
  for (const child of ["git-recovery", directory]) {
    const parent = path;
    path = join(parent, child);
    if (create) {
      try { io.mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      syncDirectory(parent);
    }
    directoryProof(path, io);
    const stat = io.lstatSync(path);
    if ((stat.mode & 0o077) || process.getuid && stat.uid !== process.getuid()) throw fail("Repair backup directory is outside private workspace ownership.");
  }
  return path;
}

/** The caller has proved the literal Git path absent from the task head/index
 * and selected a regular blob at the pinned base. No bytes are written here. */
export function planOverlayMoves(worktree, items, tracked, { io = fs } = {}) {
  const root = io.realpathSync(worktree);
  assertRepositoryTargets(items.map(item => item.path), tracked);
  let size = 0;
  return items.map(({ path, text, baseBytes, blob }) => {
    portablePath(path);
    const approved = Buffer.from(text);
    const current = recoveryFile(root, path, io, { allowMissingParents: true });
    const expected = contentDigest(approved), base = contentDigest(baseBytes);
    if (current.file && current.hash !== expected && current.hash !== base)
      throw fail("A colliding context file contains unknown bytes. Preserve both copies and reconcile the carried source.");
    size += approved.length + (current.bytes?.length ?? 0);
    if (size > limit) throw fail("Approved context exceeds the repair backup limit.");
    return { path, approved: expected, base, blob, folder: current.folder, file: current.file,
      hash: current.hash ?? null, mode: current.mode ?? null, slot: contentDigest(path), restore: "private-if-tracked" };
  });
}

function writePrivate(root, name, expected, bytes, io) {
  const staging = name + ".pending";
  const read = name => recoveryFile(root, name, io, { backupLink: true });
  const current = read(name);
  let pending = read(staging);
  if (current.file) {
    if (current.hash !== expected || (current.mode & 0o077)) throw fail("Private backup differs from the journal. Preserve it for inspection.");
    if (current.links === 2) {
      if (!same(current.file, pending.file) || !same(current.folder, pending.folder) || current.hash !== pending.hash || pending.links !== 2)
        throw fail("Private backup has an unrecognized link.");
      io.unlinkSync(pending.path);
    } else if (pending.file) throw fail("Unexpected staging bytes beside the durable backup. Preserve them for inspection.");
  } else {
    if (contentDigest(bytes) !== expected) throw fail("Backup input differs from the journal.");
    if (!pending.file) {
      const fd = io.openSync(pending.path, "wx", 0o600);
      const created = identity(io.fstatSync(fd, { bigint: true }));
      try {
        io.writeFileSync(fd, bytes);
        io.fsyncSync(fd);
      } catch (error) {
        const unfinished = read(staging);
        if (same(created, unfinished.file) && unfinished.links === 1) io.unlinkSync(unfinished.path);
        throw error;
      } finally { io.closeSync(fd); }
      pending = read(staging);
      if (!same(created, pending.file)) throw fail("Backup staging identity changed after writing.");
    }
    const next = read(name);
    if (pending.links !== 1 || pending.hash !== expected || (pending.mode & 0o077) || next.file || !same(next.folder, pending.folder))
      throw fail("Private backup destination or staging bytes changed.");
    const fd = io.openSync(pending.path, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
    try {
      if (!same(identity(io.fstatSync(fd, { bigint: true })), pending.file)) throw fail("Backup staging identity changed before its flush.");
      io.fsyncSync(fd);
    } finally { io.closeSync(fd); }
    // Exclusive publication: a file appearing after the proof cannot be replaced.
    io.linkSync(pending.path, next.path);
    syncDirectory(root);
    const linked = read(name), staged = read(staging);
    if (!same(pending.file, linked.file) || !same(linked.file, staged.file) || linked.hash !== expected || linked.links !== 2)
      throw fail("Private backup link identity changed before settlement.");
    io.unlinkSync(staged.path);
  }
  syncDirectory(root);
  return recoveryFile(root, name, io);
}

// The complete plan and destination names must be durable before entering this
// method. The owner guard is synchronous and rechecks the protected reference.
export function relocateOverlays({ stateDir, worktree, directory, moves, source, guard, io = fs }) {
  if (!moves.length) return;
  const root = io.realpathSync(worktree), privateDir = privateRoot(stateDir, directory, io, true);
  for (const move of moves) {
    guard();
    const current = recoveryFile(root, move.path, io, { allowMissingParents: true });
    if (!same(current.folder, move.folder) || current.file && (!same(current.file, move.file) || current.hash !== move.hash || current.mode !== move.mode))
      throw fail("Colliding context file or directory changed after journaling. Preserve the new bytes.");
    const text = source(move.path);
    if (typeof text !== "string" || contentDigest(text) !== move.approved) throw fail("Approved context changed after journaling.");
    if (move.file) {
      const backup = recoveryFile(privateDir, move.slot, io, { backupLink: true });
      if (!current.file && (!backup.file || backup.hash !== move.hash)) throw fail("Displaced context has no matching durable backup.");
      writePrivate(privateDir, move.slot, move.hash, current.bytes ?? backup.bytes, io);
    }
    const approved = writePrivate(privateDir, move.slot + ".approved", move.approved, Buffer.from(text), io);
    if (!current.file) continue;
    // Recheck both the protected reference and directory entries after backup,
    // immediately before removing only the original, proved untracked copy.
    guard();
    const last = recoveryFile(root, move.path, io);
    const backup = recoveryFile(privateDir, move.slot, io);
    if (!same(last.folder, move.folder) || !same(last.file, move.file) || last.hash !== move.hash || last.mode !== move.mode ||
        !same(approved.folder, backup.folder) || backup.hash !== move.hash)
      throw fail("Context or backup changed before relocation. Preserve both copies.");
    io.unlinkSync(last.path);
    syncDirectory(dirname(last.path));
  }
}

export function restoredOverlay({ stateDir, directory, move, source, io = fs }) {
  const dir = privateRoot(stateDir, directory, io, false);
  const saved = recoveryFile(dir, move.slot + ".approved", io);
  if (!saved.file || (saved.mode & 0o077) || typeof source !== "string" || saved.hash !== move.approved || contentDigest(source) !== move.approved)
    throw fail("Restore the exact approved private overlay from its recorded backup.");
  return saved.bytes.toString("utf8");
}

export function privateOverlayPaths(entry) {
  return new Set([
    ...(entry.recovery_overlays ?? []).map(item => item.move.path),
    ...(entry.base_repair?.journal?.overlays ?? []).map(move => move.path),
  ]);
}

export function readRecoveryOverlays(ctx, id, entry) {
  const records = new Map((entry.recovery_overlays ?? []).map(item => [item.move.path, item]));
  const op = entry.base_repair;
  if (op?.journal?.overlays) for (const move of op.journal.overlays) records.set(move.path, { directory: op.journal.id, move });
  return [...records].map(([path, { directory, move }]) => ({
    path, text: restoredOverlay({ stateDir: dirname(ctx.state.file), directory, move,
      source: path === entry.prd ? ctx.readPrd(id) : ctx.readSource(id, path) }),
  }));
}

export function unresolvedWorkspaceRepair(entry) {
  return Boolean(entry?.base_repair?.journal && entry.base_repair.status !== "verified");
}
