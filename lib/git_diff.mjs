const lines = section => section.split(/\r?\n/);

function quotedPath(value) {
  if (!value.startsWith('"')) return null;
  const bytes = [];
  for (let i = 1; i < value.length;) {
    const char = value[i++];
    if (char === '"') {
      let path;
      try { path = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return null; }
      return { path, rest: value.slice(i) };
    }
    if (char !== "\\") {
      const point = value.codePointAt(i - 1), width = point > 0xffff ? 2 : 1;
      bytes.push(...Buffer.from(value.slice(i - 1, i - 1 + width))); i += width - 1; continue;
    }
    if (i >= value.length) return null;
    const escape = value[i++], simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }[escape];
    if (simple !== undefined) { bytes.push(simple); continue; }
    if (!/[0-7]/.test(escape)) return null;
    let octal = escape;
    while (octal.length < 3 && /[0-7]/.test(value[i] || "")) octal += value[i++];
    const byte = Number.parseInt(octal, 8);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return null;
}

function consumePath(value, expected) {
  if (value.startsWith('"')) {
    const parsed = quotedPath(value);
    return parsed?.path === expected ? parsed.rest : null;
  }
  return value.startsWith(expected) ? value.slice(expected.length) : null;
}

function pathLineMatches(value, expected, allowMetadata = false) {
  const rest = consumePath(value, expected);
  return rest === "" || allowMetadata && rest?.startsWith("\t");
}

function diffHeaderMatches(line, oldPath, newPath) {
  if (!line?.startsWith("diff --git ")) return false;
  const first = consumePath(line.slice("diff --git ".length), `a/${oldPath}`);
  if (!first?.startsWith(" ")) return false;
  return pathLineMatches(first.slice(1), `b/${newPath}`);
}

/** Match one complete raw Git diff section to one host changed-path record. */
export function gitDiffSectionMatches(section, { status, oldPath, newPath, binary = false }) {
  if (typeof section !== "string" || !["added", "modified", "removed", "renamed"].includes(status)) return false;
  const oldName = oldPath ?? newPath, newName = newPath ?? oldPath, rows = lines(section);
  if (!oldName || !newName || !diffHeaderMatches(rows[0], oldName, newName)) return false;
  if (binary && rows.some(row => /^Binary files .+ and .+ differ$/.test(row))) return true;
  const marker = (prefix, path) => rows.some(row => row.startsWith(`${prefix} `) && pathLineMatches(row.slice(prefix.length + 1), path, true));
  const metadata = (prefix, path) => rows.some(row => row.startsWith(prefix) && pathLineMatches(row.slice(prefix.length), path));
  const oldMarker = marker("---", `a/${oldName}`), newMarker = marker("+++", `b/${newName}`), hasMarkers = rows.some(row => /^(?:---|\+\+\+) /.test(row));
  if (status === "added") return marker("---", "/dev/null") && newMarker || rows.some(row => /^new file mode [0-7]{6}$/.test(row)) && !hasMarkers;
  if (status === "removed") return oldMarker && marker("+++", "/dev/null") || rows.some(row => /^deleted file mode [0-7]{6}$/.test(row)) && !hasMarkers;
  if (status === "renamed") return metadata("rename from ", oldName) && metadata("rename to ", newName) || oldMarker && newMarker;
  return oldMarker && newMarker || rows.some(row => /^old mode [0-7]{6}$/.test(row)) && rows.some(row => /^new mode [0-7]{6}$/.test(row)) && !hasMarkers;
}

/** Non-deleted destinations in a complete host diff, including quoted names and binary/mode-only changes. */
export function gitDiffChangedPaths(diff) {
  if (typeof diff !== "string") throw new Error("publication diff is unavailable");
  if (!diff.trim()) return [];
  if (!diff.startsWith("diff --git ")) throw new Error("publication diff has no complete Git file header");
  const result = [];
  const decode = value => {
    if (!value.startsWith('"')) return value;
    const parsed = quotedPath(value);
    if (!parsed || parsed.rest && !parsed.rest.startsWith("\t")) throw new Error("publication diff has an invalid quoted path");
    return parsed.path;
  };
  for (const section of diff.split(/(?=^diff --git )/m)) {
    const rows = lines(section), header = rows[0];
    // Read metadata only: hunk contents can contain lines that resemble headers.
    const end = rows.findIndex(row => row.startsWith("@@") || row === "GIT binary patch");
    const metadata = end < 0 ? rows : rows.slice(0, end);
    if (metadata.some(row => /^deleted file mode [0-7]{6}$/.test(row) || row === "+++ /dev/null")) continue;
    const destination = metadata.find(row => row.startsWith("+++ "));
    const rename = metadata.find(row => row.startsWith("rename to ") || row.startsWith("copy to "));
    let path;
    if (destination) {
      const value = destination.slice(4);
      const decoded = decode(value.startsWith('"') ? value : value.split("\t")[0]);
      if (!decoded.startsWith("b/")) throw new Error("publication diff has an invalid destination");
      path = decoded.slice(2);
      if (!rows.some(row => row.startsWith("@@"))) throw new Error("publication diff has no content hunk");
    } else if (rename) path = decode(rename.slice(rename.startsWith("rename") ? 10 : 8));
    else {
      if (!rows.some(row => /^(?:new file mode |old mode |Binary files |GIT binary patch$)/.test(row))) throw new Error("publication diff has incomplete file metadata");
      // Git omits ---/+++ for binary and mode-only changes. Their same-path
      // header is unambiguous even when an unquoted filename contains spaces.
      const value = header.slice("diff --git ".length);
      if (value.startsWith('"')) {
        const first = quotedPath(value);
        if (!first?.path.startsWith("a/") || !first.rest.startsWith(" ")) throw new Error("publication diff has an invalid file header");
        const second = decode(first.rest.slice(1));
        if (second !== `b/${first.path.slice(2)}`) throw new Error("publication diff has an ambiguous destination");
        path = second.slice(2);
      } else {
        const candidates = [...value.matchAll(/ b\//g)].map(match => [value.slice(0, match.index), value.slice(match.index + 1)])
          .filter(([oldPath, newPath]) => oldPath.startsWith("a/") && oldPath.slice(2) === newPath.slice(2));
        if (candidates.length !== 1) throw new Error("publication diff has an ambiguous destination");
        path = candidates[0][1].slice(2);
      }
    }
    if (!path) throw new Error("publication diff has an empty destination");
    const original = metadata.find(row => row.startsWith("rename from ") || row.startsWith("copy from "));
    const oldMarker = metadata.find(row => row.startsWith("--- a/") || row.startsWith('--- "a/'));
    const oldValue = oldMarker?.slice(4);
    const oldPath = original ? decode(original.slice(original.startsWith("rename") ? 12 : 10))
      : oldValue ? decode(oldValue.startsWith('"') ? oldValue : oldValue.split("\t")[0]).slice(2) : path;
    if (!diffHeaderMatches(header, oldPath, path)) throw new Error("publication diff destination differs from its file header");
    result.push(path);
  }
  return [...new Set(result)];
}
