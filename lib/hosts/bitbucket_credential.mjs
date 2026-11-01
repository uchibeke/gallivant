import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { expand } from "../fs.mjs";

export const BITBUCKET_SCOPES = ["read:repository:bitbucket", "write:repository:bitbucket", "read:pullrequest:bitbucket", "write:pullrequest:bitbucket"];
export const BITBUCKET_REVIEW_SCOPES = BITBUCKET_SCOPES.filter(scope => scope !== "write:repository:bitbucket");
const missing = (detail, scopes = BITBUCKET_SCOPES) => Object.assign(new Error(`${detail}. Configure git_hosts["bitbucket.org"].api with an Atlassian account email and private token_file granting ${scopes.join(", ")}. An SSH key authorizes Git only; PR/comment API access needs an API token. No GitHub credential is used.`), { code: "NO_CREDENTIAL" });
// Published by Atlassian: https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/
const HOST_FINGERPRINTS = new Set(["FC73VB6C4OQLSCrjEayhMp9UMxS97caD/Yyi2bhW/J0", "ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM", "46OSHA1Rmj8E8ERTC6xkNcmGOw9oFxYr0WF6zWW8l1E"]);
export function verifyBitbucketHostKeys(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (!lines.length || lines.some(line => {
    const fields = line.split(/\s+/);
    return fields.length < 3 || fields[0] !== "ssh.bitbucket.org" || !HOST_FINGERPRINTS.has(createHash("sha256").update(Buffer.from(fields[2], "base64")).digest("base64").replace(/=+$/, ""));
  })) throw missing("Use a dedicated known_hosts file containing only ssh.bitbucket.org keys matching Atlassian's published SHA256 fingerprints; verify host-key rotations before updating pins");
}
function privateToken(file, scopes) {
  try {
    const path = expand(file), stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error();
    const token = readFileSync(path, "utf8").trim();
    if (!token || /\s/.test(token)) throw new Error();
    return token;
  } catch { throw missing("The selected Bitbucket token file is missing, empty, unreadable or not private (chmod 600); no fallback was attempted", scopes); }
}
export function bitbucketSettings(config, path) {
  const host = config?.git_hosts?.["bitbucket.org"] || {};
  const local = host.repositories?.[path] || {};
  return { ...host, ...local };
}
export async function resolveBitbucketCredential(config, { host = "bitbucket.org", path, repository = path, operation = "api" } = {}) {
  const scopes = operation === "review" ? BITBUCKET_REVIEW_SCOPES : BITBUCKET_SCOPES;
  if (host !== "bitbucket.org") throw missing("Bitbucket credential host mismatch");
  const settings = bitbucketSettings(config, repository), api = settings.api;
  if (operation === "git" && settings.git?.transport === "ssh") {
    const key = expand(settings.git.ssh_key || ""), knownHosts = expand(settings.git.known_hosts || "");
    if (![key, knownHosts].every(p => isAbsolute(p) && !/[\r\n\0%]/.test(p))) throw missing("SSH requires explicit absolute ssh_key and verified known_hosts paths without control characters or SSH percent expansions");
    try {
      if (!statSync(key).isFile() || (statSync(key).mode & 0o077) || !statSync(knownHosts).isFile()) throw new Error();
      verifyBitbucketHostKeys(readFileSync(knownHosts, "utf8"));
    } catch { throw missing("SSH key must be private (chmod 600) and known_hosts must contain only verified ssh.bitbucket.org host keys matching Atlassian's published fingerprints; automatic key acceptance is disabled"); }
    const resolved = { host, repository, sshKey: key, knownHosts, source: "Bitbucket selected SSH key" };
    return { ...resolved, sshCommand: bitbucketSshCommand(resolved) };
  }
  if (!api || !/^[^\s:@]+@[^\s:@]+$/.test(api.email || "") || !api.token_file) throw missing("No Bitbucket account API credential selected", scopes);
  if (api.scopes && scopes.some(scope => !api.scopes.includes(scope))) throw missing("The configured Bitbucket API token scope declaration is missing required repository or pull-request scopes", scopes);
  const file = operation === "git" && settings.git?.token_file ? settings.git.token_file : api.token_file;
  const token = privateToken(file, scopes);
  const binding = settings.uuid ? { uuid: settings.uuid, workspaceUuid: settings.workspaceUuid } : null;
  return { host, repository, token, email: api.email,
    ...(operation === "api" ? { environment: { HOST_API_HOST: host, HOST_API_REPOSITORY: repository, HOST_API_TOKEN: token, HOST_API_EMAIL: api.email, HOST_API_BINDING: binding ? JSON.stringify(binding) : "" } } : {}), username: "x-bitbucket-api-token-auth", source: "Bitbucket selected token_file" };
}

// Only the coordinator's Git process receives these paths. This grants no sandbox access and never uses an agent.
export function bitbucketSshCommand(credential) {
  if (credential.host !== "bitbucket.org" || !credential.knownHosts || !credential.sshKey) throw new Error("Explicit Bitbucket SSH key and verified known_hosts are required");
  const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  // This option is parsed twice: by the shell and by OpenSSH's config parser (a list of filenames).
  const knownHosts = credential.knownHosts.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null -o ${quote(`UserKnownHostsFile="${knownHosts}"`)} -i ${quote(credential.sshKey)}`;
}
