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
