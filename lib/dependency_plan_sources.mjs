import { createRequire } from "node:module";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pinRepositoryRoot, readPinnedRepositoryFile } from "./repository_files.mjs";
import { contentDigest } from "./hash.mjs";
import { PLAN_LIMITS, planError } from "./dependency_plan_limits.mjs";

const require = createRequire(import.meta.url);
const decoder = new TextDecoder("utf-8", { fatal: true });
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor", "<<"]);
const yamlFeatures = new Set(["alias", "anchor", "tag", "directive-line", "explicit-key-ind"]);
const comparePath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const scalarControls = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const interpolation = /[$`]|%[A-Za-z_][A-Za-z_0-9]*%|^~/;

export function localPlanPath(value, at, { directory = false } = {}) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > PLAN_LIMITS.pathBytes
      || value !== value.trim() || value.startsWith("/") || /[:\\*?\[\]]/.test(value)
      || scalarControls.test(value) || interpolation.test(value)
      || value.split("/").some(part => part === ".." || part.toLowerCase() === ".git")) {
    throw planError(at, "expected a contained local path without traversal, globs or interpolation");
  }
  const normalized = value.split("/").filter(part => part && part !== ".").join("/");
  if (!directory && (!normalized || value.endsWith("/"))) throw planError(at, "expected a local file path");
  return normalized || ".";
}

function* documentTokens({ CST, Lexer, Parser }, text, lines, at, budget) {
  const parser = new Parser(lines.addNewLine);
  lines.addNewLine(0);
  let documents = 0, plainScalar = false;
  function* check(tokens) {
    for (const token of tokens) {
      if (token.type === "document" && ++documents > 1) throw planError(at(token.offset), "expected a single document");
      yield token;
    }
  }
  for (const lexeme of new Lexer().lex(text)) {
    if (++budget.tokens > PLAN_LIMITS.syntaxTokens) throw planError(at(parser.offset), "plan syntax token limit exceeded");
    const kind = plainScalar ? null : CST.tokenType(lexeme);
    if (yamlFeatures.has(kind)) throw planError(at(parser.offset), `YAML ${kind} is forbidden`);
    plainScalar = kind === "scalar";
    yield* check(parser.next(lexeme));
    // A node uses a map and its children use a sequence. Leave room for the
    // root, fields such as needs and the parser's document/scalar frames.
    if (parser.stack.length > 2 * PLAN_LIMITS.depth + 6) {
      throw planError(at(parser.offset), "plan syntax nesting limit exceeded (plan node depth is 32)");
    }
  }
  yield* check(parser.end());
}

function readNode(yaml, node, locate, fallback = 0) {
  const { isMap, isScalar, isSeq } = yaml;
  const at = locate(node?.range?.[0] ?? fallback);
  if (isMap(node)) {
    const value = Object.create(null);
    for (const pair of node.items) {
      const key = pair.key?.value;
      const keyAt = locate(pair.key?.range?.[0] ?? node.range[0]);
      if (!isScalar(pair.key) || typeof key !== "string" || !key || scalarControls.test(key)) {
        throw planError(keyAt, "expected a nonempty string mapping key");
      }
      if (forbiddenKeys.has(key)) throw planError(keyAt, `forbidden mapping key ${JSON.stringify(key)}`);
      if (Object.hasOwn(value, key)) throw planError(keyAt, "duplicate mapping key");
      const child = readNode(yaml, pair.value, locate, pair.key.range[0]);
      child.keyAt = keyAt;
      value[key] = child;
    }
    return { at, value };
  }
  if (isSeq(node)) return { at, value: node.items.map(child => readNode(yaml, child, locate, node.range[0])) };
  if (!isScalar(node)) throw planError(at, "expected a mapping, sequence or scalar");
  if (typeof node.value === "string" && (interpolation.test(node.value) || scalarControls.test(node.value))) {
    throw planError(at, "interpolation and control characters are forbidden");
  }
  return { at, value: node.value };
}

function parseDocument(path, text, budget) {
  const format = extname(path);
  if (![".json", ".yaml", ".yml"].includes(format)) throw planError(path, "expected a .json, .yaml or .yml plan source");
  if (format === ".json") {
    try {
      // Use the native JSON grammar. The shared tree reader below sees the
      // original keys (including duplicates) and retains their positions.
      JSON.parse(text);
    } catch (error) {
      const offset = Number(error.message.match(/at position (\d+)/)?.[1] ?? text.length);
      const prefix = text.slice(0, offset);
      throw planError(`${path}:${prefix.split("\n").length}:${offset - prefix.lastIndexOf("\n")}`, "invalid JSON syntax");
    }
  }
  // The parser's optional debug modes write raw source data to stdout.
  if (process.env.LOG_TOKENS || process.env.LOG_STREAM) throw planError(path, "unset LOG_TOKENS and LOG_STREAM before validating a plan");
  // Load the parser only when a plan source needs to be parsed.
  const yaml = require(fileURLToPath(import.meta.resolve("yaml")));
  const { Composer, LineCounter } = yaml;
  const lines = new LineCounter();
  const locate = offset => {
    const { line, col } = lines.linePos(offset);
    return `${path}:${line}:${col}`;
  };
  const composer = new Composer({ schema: "core", merge: false, uniqueKeys: false, prettyErrors: false });
  for (const doc of composer.compose(documentTokens(yaml, text, lines, locate, budget), true, text.length)) {
    const invalid = doc.errors[0] ?? doc.warnings[0];
    if (invalid) throw planError(locate(invalid.pos[0]), `invalid plan syntax (${invalid.code})`);
    return readNode(yaml, doc.contents, locate);
  }
}

export function isPlanManifest(path, text) {
  const { value } = parseDocument(path, text, { tokens: 0 });
  return value && Object.hasOwn(value, "repositories") && Object.hasOwn(value, "nodes");
}

export function planSources(directory, { inline, authorizeFile } = {}) {
  const requested = resolve(directory);
  const pinned = pinRepositoryRoot(requested, { invalidDirectory: () => planError("--dir", "expected an operator-approved directory") });
  const { root } = pinned;
  const files = new Map(), identities = new Set(), documents = new Map(), budget = { tokens: 0 };
  let total = 0;
  // An uploaded root is a virtual file. All other reads still use the same
  // containment, identity, parser and byte limits as a local manifest.
  const read = (path, at, binding = null) => {
    if (binding || path !== inline?.path) authorizeFile?.(path, at, binding);
    if (files.has(path)) return files.get(path);
    if (files.size >= PLAN_LIMITS.files) throw planError(at, "exceeds the 32-file source closure limit");
    try {
      const { bytes, identity } = path === inline?.path ? { bytes: Buffer.from(inline.text, "utf8") }
        : readPinnedRepositoryFile(pinned, path, PLAN_LIMITS.sourceBytes, PLAN_LIMITS.totalBytes - total);
      if (bytes.length > PLAN_LIMITS.sourceBytes || total + bytes.length > PLAN_LIMITS.totalBytes) throw new Error("exceeds the source byte limit");
      if (identity && identities.has(identity)) throw new Error("file aliases another source path");
      const text = decoder.decode(bytes);
      if (text.includes("\0")) throw new Error("expected a text file without NUL bytes");
      const source = { path, digest: contentDigest(bytes), text, bytes };
      if (identity) identities.add(identity);
      files.set(path, source);
      total += bytes.length;
      return source;
    } catch (error) {
      // Filesystem errors may contain absolute host paths. The relative input and
      // error code are sufficient to identify the file and correct the problem.
      const reason = error.code === "FILE_TOO_LARGE" ? "exceeds the 1 MiB per-source limit" : error.code || error.message;
      throw planError(at, `cannot read ${JSON.stringify(path)}: ${reason}`);
    }
  };
  return {
    root, reopen: () => planSources(requested, { inline, authorizeFile }),
    rootFile(file) {
      return localPlanPath(relative(requested, resolve(requested, file)).split(sep).join("/"), "plan file");
    },
    read,
    document(path, at) {
      if (!documents.has(path)) documents.set(path, parseDocument(path, read(path, at).text, budget));
      return documents.get(path);
    },
    closure() {
      return [...files.values()].map(({ path, digest }) => ({ path, digest })).sort(comparePath);
    },
    snapshots() { return [...files.values()]; },
  };
}
