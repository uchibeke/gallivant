import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// The v1 registry hashes the UTF-8 JSON spelling of each scalar tuple.
export const recoveryDigest = tuple => bytesToHex(sha256(utf8ToBytes(JSON.stringify(tuple))));
