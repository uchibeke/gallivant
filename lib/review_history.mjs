// Full historical reviews are immutable private evidence. Keep only the small
// fields needed for dispatch decisions in the frequently rewritten registry.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./fs.mjs";

const marker = "_gallivantReviewArchive";
const digest = value => createHash("sha256").update(value).digest("hex");
const summaryDigest = (key, disposition) => digest(JSON.stringify({ key, disposition }));
const error = () => Object.assign(new Error("historical review evidence is missing, corrupt or mismatched; restore the private review archive before continuing"), { code: "REVIEW_HISTORY" });

export function reviewHistoryStore(home) {
  const directory = join(home, "reviews", "history");
  const pathFor = hash => {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw error();
    return join(directory, `${hash}.json`);
  };
  const read = hash => {
    const path = pathFor(hash);
    try {
      if (!lstatSync(path).isFile()) throw error();
      const bytes = readFileSync(path);
      if (digest(bytes) !== hash) throw error();
      return JSON.parse(bytes.toString("utf8"));
    } catch { throw error(); }
  };
  const reference = (record, hash) => ({ key: record.key, ...(Object.hasOwn(record, "disposition") ? { disposition: record.disposition } : {}),
    [marker]: { version: 1, digest: hash, summary: summaryDigest(record.key, record.disposition) } });
  const hydrate = item => {
    if (!item || typeof item !== "object" || !Object.hasOwn(item, marker)) return item;
    const ref = item[marker];
    if (!ref || Object.keys(ref).sort().join() !== "digest,summary,version" || ref.version !== 1 ||
      Object.keys(item).some(key => !["key", "disposition", marker].includes(key)) ||
      ref.summary !== summaryDigest(item.key, item.disposition)) throw error();
    const record = read(ref.digest);
    if (!record || typeof record !== "object" || Object.hasOwn(record, marker) || record.key !== item.key ||
      summaryDigest(record.key, record.disposition) !== ref.summary) throw error();
    return record;
  };
  const archive = item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    if (Object.hasOwn(item, marker)) {
      const ref = item[marker];
      if (!ref || ref.version !== 1 || Object.keys(ref).sort().join() !== "digest,summary,version" ||
        Object.keys(item).some(key => !["key", "disposition", marker].includes(key))) throw error();
      const path = pathFor(ref.digest);
      if (!existsSync(path) || !lstatSync(path).isFile()) throw error();
      if (ref.summary === summaryDigest(item.key, item.disposition)) return item;
      // A compact projection is never itself an authorized mutation. Callers
      // must hydrate and verify the original before making a new revision.
      throw error();
    }
    const bytes = Buffer.from(JSON.stringify(item)), hash = digest(bytes), path = pathFor(hash);
    // Reusing immutable evidence should not create/fsync/unlink a duplicate
    // temporary file. Verify existing bytes before trusting their reference.
    if (existsSync(path)) { read(hash); return reference(item, hash); }
    ensureDir(directory);
    const temporary = join(directory, `.pending-${process.pid}-${randomUUID()}`);
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, bytes); fsyncSync(fd);
      closeSync(fd); fd = undefined;
      try { linkSync(temporary, path); }
      catch (cause) { if (cause.code !== "EEXIST") throw cause; read(hash); }
      const directoryFd = openSync(directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* crash leftovers are never referenced */ } }
    return reference(item, hash);
  };
  return { hydrate, archive };
}
