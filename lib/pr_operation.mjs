import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { execFileAsync } from "./process.mjs";
import { makeHostRegistry } from "./hosts.mjs";
import { parseRemote, repositoryIdentity, assertBranchName } from "./repository.mjs";

// Small, bounded PR operation surface for a local session. No config-directory
// reads, remote installation, shell expansion, merge or repository settings API.
export async function prOperation(argv, { env = process.env, cwd = process.cwd(), exec = execFileAsync, registry = null, read = path => readFileSync(path, "utf8") } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: Object.fromEntries(
    ["base", "head", "title-file", "body-file", "reply-to"].map(k => [k, { type: "string" }])) });
  const [operation, number] = positionals;
  if (!["create", "view", "diff", "edit", "comment"].includes(operation) || positionals.length !== (operation === "create" ? 1 : 2)) throw new Error("Use task-pr create --base <branch> --head <branch> --title-file <file> --body-file <file>, or view|diff|edit|comment <number>");
  const allowed = { create: ["base", "head", "title-file", "body-file"], view: [], diff: [], edit: ["body-file"], comment: ["body-file", "reply-to"] }[operation];
  if (Object.keys(values).some(k => !allowed.includes(k))) throw new Error("Unsupported option for this PR operation");
  if (!env.HOST_API_HOST || !env.HOST_API_REPOSITORY || !env.HOST_API_TOKEN) throw new Error("No bound host API credential; run this command only in the authorized task session");
  const repository = repositoryIdentity(env.HOST_API_REPOSITORY, env.HOST_API_HOST);
  const git = async args => (await exec("git", args, { cwd })).stdout.trim();
  if (parseRemote(await git(["remote", "get-url", "origin"])).remoteIdentity !== repository.remoteIdentity) throw new Error("Checkout differs from the bound API repository");
  const branch = assertBranchName(await git(["branch", "--show-current"]));
  const settings = env.HOST_API_BINDING ? JSON.parse(env.HOST_API_BINDING) : null;
  registry ??= makeHostRegistry({ config: settings ? { git_hosts: { [repository.host]: { repositories: { [repository.path]: settings } } } } : {},
    credential: async () => ({ host: repository.host, repository: repository.path, token: env.HOST_API_TOKEN, email: env.HOST_API_EMAIL }) });
  const api = registry.api;
  const body = () => { if (!values["body-file"]) throw new Error("--body-file is required"); return read(values["body-file"]); };
  if (operation === "create") {
    if (values.head !== branch || !values["title-file"]) throw new Error("--head must match the current branch and --title-file is required");
    assertBranchName(values.base);
    return api.publishResultPr({ repo: repository.key, branch, base: values.base, title: read(values["title-file"]).trim(), body: body() });
  }
  if (!/^[1-9]\d*$/.test(number ?? "") || !Number.isSafeInteger(Number(number))) throw new Error("Use an exact positive PR number");
  const n = Number(number), pr = await api.prView(repository.key, n);
  if (pr.headRefName !== branch || pr.isCrossRepository) throw new Error("PR is not owned by this checkout branch");
  if (operation === "view") return pr;
  if (operation === "diff") return api.prDiff(repository.key, n);
  if (pr.state !== "OPEN") throw new Error("Only an open PR may be edited or answered");
  if (operation === "edit") return api.setBody(repository.key, n, body());
  const replyTo = values["reply-to"] === undefined ? null : Number(values["reply-to"]);
  if (replyTo !== null && (!/^[1-9]\d*$/.test(values["reply-to"]) || !Number.isSafeInteger(replyTo))) throw new Error("Invalid reply parent");
  return api.comment(repository.key, n, body(), { replyTo });
}
