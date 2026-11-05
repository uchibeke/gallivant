import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { reviewError } from "./review_policy.mjs";

// Limits apply before decompression, and again when evidence is restored.
export const REVIEW_IMAGE_LIMITS = Object.freeze({ count: 32, individualBytes: 5 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024, dimension: 8192, pixels: 16_000_000 });
const fail = message => { throw reviewError("REVIEW_INCOMPLETE", message); };
const require = createRequire(import.meta.url);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const revision = value => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
const within = (parent, child) => {
  const rel = relative(parent, child);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > REVIEW_IMAGE_LIMITS.dimension || height > REVIEW_IMAGE_LIMITS.dimension || width * height > REVIEW_IMAGE_LIMITS.pixels) fail("image dimensions exceed the review limit");
}

function decodePng(bytes) {
  if (bytes.length < 33 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(8) !== 13) fail("invalid PNG header");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  dimensions(width, height);
  // Bound the inflate stream before pngjs sees it, including its interlaced
  // path. Eight bytes per pixel plus seven row-filter bytes is conservative
  // for every PNG colour type and Adam7 pass.
  const idat = [];
  let offset = 8, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) fail("truncated PNG chunk");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") { if (length || end !== bytes.length) fail("invalid PNG ending"); ended = true; break; }
    offset = end;
  }
  if (!ended || !idat.length) fail("incomplete PNG image");
  let decoder;
  try { decoder = require("pngjs").PNG; } catch { fail("PNG review decoder is unavailable"); }
  try {
    inflateSync(Buffer.concat(idat), { maxOutputLength: width * height * 8 + height * 7 + 64 });
    const decoded = decoder.sync.read(bytes, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height) fail("PNG dimensions differ");
  } catch (error) { if (error.code === "REVIEW_INCOMPLETE") throw error; fail("corrupt or oversized PNG image"); }
  return { format: "png", width, height };
}

function decodeJpeg(bytes) {
  if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) fail("incomplete JPEG image");
  // Inspect a frame header before the decoder allocates pixel buffers.
  let at = 2, frame = null;
  while (at + 4 <= bytes.length) {
    if (bytes[at++] !== 0xff) fail("invalid JPEG marker");
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (at + 2 > bytes.length) fail("truncated JPEG marker");
    const size = bytes.readUInt16BE(at);
    if (size < 2 || at + size > bytes.length) fail("truncated JPEG marker");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || size < 8) fail("invalid JPEG frame");
      frame = { width: bytes.readUInt16BE(at + 5), height: bytes.readUInt16BE(at + 3) };
      dimensions(frame.width, frame.height);
    }
    at += size;
  }
  if (!frame) fail("unsupported JPEG frame");
  let decoder;
  try { decoder = require("jpeg-js"); } catch { fail("JPEG review decoder is unavailable"); }
  try {
    const decoded = decoder.decode(bytes, { tolerantDecoding: false, maxResolutionInMP: 16, maxMemoryUsageInMB: 128 });
    dimensions(decoded.width, decoded.height);
    if (decoded.width !== frame.width || decoded.height !== frame.height) fail("JPEG dimensions differ");
    return { format: "jpeg", width: decoded.width, height: decoded.height };
  } catch (error) { if (error.code === "REVIEW_INCOMPLETE") throw error; fail("corrupt or oversized JPEG image"); }
}

export function inspectReviewImageSet(images, { head, mergeBase }) {
  if (!Array.isArray(images) || images.length > REVIEW_IMAGE_LIMITS.count || !revision(head) || !revision(mergeBase)) fail("image inventory or revisions are invalid");
  let total = 0;
  const seen = new Set();
  for (const image of images) {
    const { bytes, identity } = image ?? {};
    if (identity?.revision !== (identity?.side === "before" ? mergeBase : head)) fail("image revision differs from its bound side");
    const key = JSON.stringify([identity?.path, identity?.side]);
    if (seen.has(key)) fail("duplicate image side");
    seen.add(key);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > REVIEW_IMAGE_LIMITS.individualBytes) fail("image byte limit exceeded or image is empty");
    total += bytes.length;
    if (total > REVIEW_IMAGE_LIMITS.totalBytes) fail("total image byte limit exceeded");
  }
  return images.map(({ bytes, identity }) => inspectReviewImage(bytes, identity));
}

export function inspectReviewImage(bytes, identity) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > REVIEW_IMAGE_LIMITS.individualBytes) fail("image byte limit exceeded or image is empty");
  if (!identity || !revision(identity.revision) || !["before", "after"].includes(identity.side) || typeof identity.path !== "string" || !identity.path || identity.path.includes("\0")) fail("image identity is incomplete");
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpg) fail("unsupported image format");
  const metadata = png ? decodePng(bytes) : decodeJpeg(bytes);
  return { path: identity.path, side: identity.side, revision: identity.revision, ...metadata, bytes: bytes.length, sha256: hash(bytes) };
}

export function verifyReviewImage(bytes, expected) {
  const actual = inspectReviewImage(bytes, expected);
  if (["format", "width", "height", "bytes", "sha256"].some(key => actual[key] !== expected?.[key])) fail("image identity or hash differs from captured evidence");
  return actual;
}

// This creates only coordinator-named files, never paths supplied by an author.
// Callers must still recheck the returned file immediately before native launch.
export function copyReviewImage(workspace, bytes, expected) {
  verifyReviewImage(bytes, expected);
  if (!constants.O_NOFOLLOW) fail("image copy requires no-follow file access");
  const root = realpathSync(workspace);
  if (!lstatSync(workspace).isDirectory() || lstatSync(workspace).isSymbolicLink()) fail("image workspace is not a directory");
  const directory = mkdtempSync(join(root, "review-image-"));
  const file = join(directory, expected.format === "png" ? "attachment.png" : "attachment.jpg");
  try {
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    verifyReviewImageCopy(root, file, expected);
    return { file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

export function verifyReviewImageCopy(workspace, file, expected) {
  if (!constants.O_NOFOLLOW) fail("image copy requires no-follow file access");
  const root = realpathSync(workspace), directory = realpathSync(join(file, ".."));
  if (!within(root, directory) || !within(directory, file)) fail("image copy is outside the controlled workspace");
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected?.bytes || stat.size > REVIEW_IMAGE_LIMITS.individualBytes) fail("image copy is not the captured regular file");
    return verifyReviewImage(readFileSync(fd), expected);
  } catch (error) { if (error.code === "REVIEW_INCOMPLETE") throw error; fail("image copy cannot be verified"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
