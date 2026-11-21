import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Composer, CST, Lexer, LineCounter, Parser, isMap, isScalar, isSeq } from "yaml";
import { repositoryPath } from "./repository_files.mjs";
import { contentDigest } from "./hash.mjs";
import { PLAN_LIMITS, planError } from "./dependency_plan_limits.mjs";

const stats = path => lstatSync(path, { bigint: true });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameRevision = (a, b) => sameFile(a, b) && a.size === b.size && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
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

function readBytes(root, rootStat, rel, remaining) {
  // A transient parent rename or link swap can leave the final filename and
  // inode back where they started. Pin the directory chain around the read.
  const parents = [[root, stats(root)]];
  if (!sameFile(rootStat, parents[0][1])) throw new Error("approved root changed before reading");
  for (const part of rel.split("/").slice(0, -1)) {
    const path = join(parents.at(-1)[0], part);
    const parent = stats(path);
    if (!parent.isDirectory()) throw new Error("expected a regular parent directory without symlinks");
    parents.push([path, parent]);
  }
  const path = repositoryPath(root, rel);
  const before = stats(path);
  if (!before.isFile() || before.nlink !== 1n) throw new Error("expected a regular file without hard links");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    const confirmPath = () => {
      const named = repositoryPath(root, rel);
      const canonical = realpathSync.native(named);
      const within = relative(root, canonical);
      if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)
          || !sameRevision(opened, stats(canonical)) || !sameRevision(opened, stats(named))
          || parents.some(([path, before]) => !sameRevision(before, stats(path)))) {
        throw new Error("file identity or containment changed while reading");
      }
    };
    if (!opened.isFile() || !sameRevision(before, opened)) throw new Error("file changed before it could be read");
    confirmPath();
    if (opened.size > PLAN_LIMITS.sourceBytes) throw new Error("exceeds the 1 MiB per-source limit");
    if (opened.size > remaining) throw new Error("exceeds the 8 MiB total input limit");
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count !== bytes.length - 1 || !sameRevision(opened, fstatSync(fd, { bigint: true }))) {
      throw new Error("file changed while reading");
    }
    confirmPath();
    return { bytes: bytes.subarray(0, count), identity: `${opened.dev}:${opened.ino}` };
  } finally {
    closeSync(fd);
  }
}

function* documentTokens(text, lines, at, budget) {
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

function readNode(node, locate, fallback = 0) {
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
      const child = readNode(pair.value, locate, pair.key.range[0]);
      child.keyAt = keyAt;
      value[key] = child;
    }
    return { at, value };
  }
  if (isSeq(node)) return { at, value: node.items.map(child => readNode(child, locate, node.range[0])) };
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
  const lines = new LineCounter();
  const locate = offset => {
    const { line, col } = lines.linePos(offset);
    return `${path}:${line}:${col}`;
  };
  const composer = new Composer({ schema: "core", merge: false, uniqueKeys: false, prettyErrors: false });
  for (const doc of composer.compose(documentTokens(text, lines, locate, budget), true, text.length)) {
    const invalid = doc.errors[0] ?? doc.warnings[0];
    if (invalid) throw planError(locate(invalid.pos[0]), `invalid plan syntax (${invalid.code})`);
    return readNode(doc.contents, locate);
  }
}

export function planSources(directory) {
  const requested = resolve(directory);
  const root = realpathSync.native(requested);
  const rootStat = stats(root);
  if (!rootStat.isDirectory()) throw planError("--dir", "expected an operator-approved directory");
  const files = new Map(), identities = new Set(), documents = new Map(), budget = { tokens: 0 };
  let total = 0;
  const read = (path, at) => {
    if (files.has(path)) return files.get(path);
    if (files.size >= PLAN_LIMITS.files) throw planError(at, "exceeds the 32-file source closure limit");
    try {
      const { bytes, identity } = readBytes(root, rootStat, path, PLAN_LIMITS.totalBytes - total);
      if (identities.has(identity)) throw new Error("file aliases another source path");
      const text = decoder.decode(bytes);
      if (text.includes("\0")) throw new Error("expected a text file without NUL bytes");
      const source = { path, digest: contentDigest(bytes), text };
      identities.add(identity);
      files.set(path, source);
      total += bytes.length;
      return source;
    } catch (error) {
      // Filesystem errors may contain absolute host paths. The relative input and
      // error code are sufficient to identify the file and correct the problem.
      const reason = error.code || error.message;
      throw planError(at, `cannot read ${JSON.stringify(path)}: ${reason}`);
    }
  };
  return {
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
  };
}
