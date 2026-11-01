// Repository identity is independent of transport, execution provider and harness.
// Bare owner/name is the persisted v1 GitHub spelling; other hosts are qualified.
export const LEGACY_HOST = "github.com";
export function assertBranchName(value) {
  if (typeof value !== "string" || !value || value.startsWith("-") || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value) || value.includes("..") || value.includes("@{") || value === "@" || value.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"))) throw new Error("Invalid Git branch name; select an explicit branch before repository transport");
  return value;
}
const segment = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const hostname = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const invalid = () => new Error("Invalid repository origin or identity; restore a canonical HTTPS or Git SSH origin and retry. Credentials in URLs are never included in diagnostics.");
// Cloud's SSH endpoint is a transport alias, never a separate repository identity.
const sshIdentityHosts = { "ssh.bitbucket.org": "bitbucket.org" };
const sshTransportHosts = { "bitbucket.org": "ssh.bitbucket.org" };

export function repositoryIdentity(value, host = LEGACY_HOST) {
  if (value && typeof value === "object") {
    const identity = repositoryIdentity(value.path ?? value.repo, value.host ?? host);
    if (value.host && identity.host !== value.host.toLowerCase()) throw invalid();
    return identity;
  }
  if (typeof value !== "string") throw invalid();
  const parts = value.split("/");
  if (parts.length === 3) host = parts.shift();
  host = String(host).toLowerCase();
  if (!hostname.test(host) || parts.length !== 2 || parts.some(p => !segment.test(p) || p === "." || p === "..")) throw invalid();
  const path = parts.join("/").toLowerCase();
  return Object.freeze({ host, path, remoteIdentity: `${host}/${path}`, key: host === LEGACY_HOST ? path : `${host}/${path}` });
}

/** Parse without URL normalization hiding traversal, ports, query strings or escapes. */
export function parseRemote(value) {
  const raw = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!raw || /[\s\\?#%\x00-\x1f\x7f]/.test(raw)) throw invalid();
  let match, transport;
  // HTTP is retained for historical GitHub remotes, but the adapter upgrades it before use.
  if ((match = raw.match(/^(https?):\/\/(?:[^/@]+@)?([^/:@]+)\/([^/]+\/[^/]+)$/i))) transport = match[1].toLowerCase();
  else if ((match = raw.match(/^(ssh):\/\/(?:[A-Za-z0-9._-]+@)?([^/:@]+)\/([^/]+\/[^/]+)$/i))) transport = "ssh";
  else {
    const scp = raw.match(/^(?:[A-Za-z0-9._-]+@)?([^/:@]+):([^/]+\/[^/]+)$/i);
    if (!scp) throw invalid();
    match = [raw, "ssh", scp[1], scp[2]]; transport = "ssh";
  }
  const host = match[2].toLowerCase();
  const identity = repositoryIdentity(match[3].replace(/\.git$/i, ""), transport === "ssh" ? sshIdentityHosts[host] ?? host : host);
  return Object.freeze({ ...identity, transport, url: transport === "ssh" ? `git@${sshTransportHosts[identity.host] ?? identity.host}:${identity.path}.git` : `https://${identity.host}/${identity.path}.git` });
}

export const safeOrigin = value => { try { return parseRemote(value).url; } catch { return "[invalid origin]"; } };
export const repositoryMatches = (a, b) => { try { return repositoryIdentity(a).remoteIdentity === repositoryIdentity(b).remoteIdentity; } catch { return false; } };
export const remoteMatches = (url, repo) => { try { return parseRemote(url).remoteIdentity === repositoryIdentity(repo).remoteIdentity; } catch { return false; } };
export const repoFromRemote = url => { try { return parseRemote(url).key; } catch { return null; } };

export function parsePullRequestUrl(value) {
  // Host adapters own the PR route. This parses only the URL envelope, never userinfo.
  const m = typeof value === "string" && value.match(/^https:\/\/([^/:@]+)\/([^?#\s\\%]+)$/i);
  if (!m || !hostname.test(m[1].toLowerCase())) throw invalid();
  return { host: m[1].toLowerCase(), pathname: m[2] };
}

/** Read old records without rewriting IDs, cursors or counters. Contradictions require recovery. */
export function savedRepository(entry) {
  const identity = repositoryIdentity(entry.repo);
  if ((entry.host && entry.host !== identity.host) || (entry.repository && repositoryIdentity(entry.repository).remoteIdentity !== identity.remoteIdentity) ||
      (entry.url && (parsePullRequestUrl(entry.url).host !== identity.host || !parsePullRequestUrl(entry.url).pathname.toLowerCase().startsWith(`${identity.path}/`)))) {
    throw new Error("Ambiguous saved repository identity; stop the coordinator, back up state, and reconcile its repository, host and PR URL before retrying. Do not redispatch.");
  }
  return identity;
}
