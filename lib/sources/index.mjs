// One gate, many sources. The contract in lib/prd.mjs takes a Request rather than a parsed file:
//
//     { id, repo, title, body, harness, status, source: { kind, url, author }, raw }
//
// plus the parsed fields the rules read (sections, titles, words, meta). Today the only adapter is the PRD file, and
// the shape is identical to what `parsePrd` always returned, so nothing about reading a PRD changed. What changed is
// that the rules no longer reach for a file: `repo` is a field the source supplies, and `source.kind` is what a
// kind-specific rule is checked against.
//
// This registry exists so a second source (a GitHub issue, and later Slack or a ticket) is an adapter plus a place to
// record its verdict, not a second gate. None of those is built. There is exactly one adapter below.
import * as prd from "./prd.mjs";

export const ADAPTERS = Object.freeze([prd]);

export const adapterFor = input => ADAPTERS.find(a => a.matches(input)) ?? null;

export const adapterOfKind = kind => ADAPTERS.find(a => a.kind === kind) ?? null;

/** The Request for whatever the operator typed. `deps` carries the dependencies a source needs, `git` for this one. */
export async function requestFor(input, deps = {}) {
  const adapter = adapterFor(input);
  if (!adapter) throw new Error(`nothing can read "${input}": give a path to a PRD file`);
  return adapter.load(input, deps);
}

export { prd };
