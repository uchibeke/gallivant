import { createHash } from "node:crypto";

// A link target is Git object data, never a filesystem path to open or resolve.
export const MAX_REVIEW_LINK_BYTES = 4096;
export function inspectReviewLink(buffer, { path, side, revision }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_REVIEW_LINK_BYTES || buffer.includes(0) ||
      typeof path !== "string" || !path || !["before", "after"].includes(side) || !/^[a-f0-9]{40,64}$/.test(revision || "")) throw new Error("invalid or oversized review link object");
  let target;
  try { target = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new Error("review link target is not UTF-8"); }
  return { path, side, revision, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex"), target };
}
