// One fingerprint spelling for the whole product.
//
// `receiptHash` in deliverable.mjs was the first of these: twelve hex characters of a sha1, short enough to sit in a
// registry cursor and in a log line, long enough that two different texts never collide in a tree this size. The
// brief's contract needed the same thing, and a second spelling of "fingerprint a string" is exactly the duplication
// this codebase keeps paying for, so it is one function that both call rather than two that agree today.
//
// Not a security boundary and never used as one. Nothing signs anything with this: it answers "is this the same text
// as before", where both texts are ours and neither side is trying to collide. sha1 is what the existing receipt
// cursor already stores, and changing it would invalidate every cursor on disk for no gain.
import { createHash } from "node:crypto";

export const HASH_LENGTH = 12;

/** Twelve hex characters of the sha1 of `text`. `null` for nothing to hash, so a caller can tell absent from empty. */
export const shortHash = text => (text == null ? null : createHash("sha1").update(String(text)).digest("hex").slice(0, HASH_LENGTH));
