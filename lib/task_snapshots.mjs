import { join } from "node:path";
import { idSlug } from "./state.mjs";

/** Where the daemon keeps its own copy of each PRD, taken at start, so a session cannot rewrite its brief. */
export const prdSnapshotPath = (home, id) => join(home, "prds", `${idSlug(id)}.md`);

/**
 * Where a carried file's snapshot lives: one directory per entry, beside the brief's own snapshot and named the same
 * way. The relative path is kept inside that directory, so `docs/a.md` and `a.md` are two files rather than one and a
 * carried file lands back at the path the brief named.
 */
export const sourceSnapshotPath = (home, id, rel) => join(home, "prds", `${idSlug(id)}.sources`, rel);
