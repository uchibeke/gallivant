// The only module that talks to GitHub, and it does so through the `gh` CLI so there is no HTTP client, no token
// parsing and no pagination code to own. `exec` is injectable so the tick can be tested against a fake.
//
// Logins: GitHub renders bots as `name[bot]` in REST and as `login` + `is_bot` in gh's GraphQL output. Everything
// is normalised to the bare login plus a `bot` flag before any comparison.
import { execFile } from "node:child_process";
import { readText } from "./fs.mjs";

export const ROUND_MARKER = "<!-- gallivant round -->";
export const NUDGE_MARKER = "<!-- gallivant nudge -->";
export const RESET_MARKER = "<!-- gallivant reset -->";
export const READY_LABEL = "gallivant:ready-for-human";
export const NEEDS_LABEL = "gallivant:needs-human";

const GH_TIMEOUT_MS = 60_000;
const MAX_DIFF_BYTES = 1_000_000;

export const normalizeLogin = login => String(login || "").replace(/^app\//, "").replace(/\[bot\]$/, "").toLowerCase();

/** One shape for authors from either API: { login, bot }. */
export const actor = a => {
  if (!a) return { login: "", bot: false };
  const raw = a.login ?? a.user?.login ?? "";
  const bot = a.is_bot === true || a.type === "Bot" || a.user?.type === "Bot" || /\[bot\]$/.test(raw) || /^app\//.test(raw);
  return { login: normalizeLogin(raw), bot };
};

/** owner/name from any GitHub PR URL, as GitHub spells it (lowercased, since GitHub treats names case-insensitively). */
export function repoFromUrl(url) {
  const m = String(url || "").match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  return m ? { repo: `${m[1]}/${m[2]}`.toLowerCase(), number: Number(m[3]) } : null;
}

// Reviews and comments come from REST (numeric ids, `user.type`, `since` filters); the rest from `gh pr view`.
const PR_FIELDS = "number,url,title,state,isDraft,mergeable,headRefOid,headRefName,isCrossRepository,author,createdAt,updatedAt,statusCheckRollup,labels,body,baseRefName";

/** The token in a `github_token_file`, or empty when none is configured. The one reader for gh and git alike. */
export const readTokenFile = file => (file ? readText(file, "").trim() : "");

export function makeGh({ tokenFile = null, exec = execFileAsync, log = null } = {}) {
  const env = () => {
    const token = readTokenFile(tokenFile);
    return token ? { ...process.env, GH_TOKEN: token } : process.env;
  };
  const LABELS = [[READY_LABEL, "5319e7", "Gallivant: checks green, reviewer clear, receipt accepted"], [NEEDS_LABEL, "b60205", "Gallivant: stopped, see gallivant why"]];
  const run = async (args, { cwd, timeout = GH_TIMEOUT_MS } = {}) => {
    const { stdout } = await exec("gh", args, { cwd, env: env(), timeout, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  };
  const json = async (args, opts) => { const out = await run(args, opts); return out.trim() ? JSON.parse(out) : null; };
  // `--paginate` alone concatenates one JSON array per page; `--slurp` wraps them so the output parses as one array.
  const pages = path => json(["api", path, "--paginate", "--slurp"]).then(r => (r || []).flat());

  return {
    run,
    json,
    /** Login of the token in use. */
    user: () => json(["api", "user", "--jq", "{login: .login}"]).then(u => u.login),
    authStatus: () => run(["auth", "status"]).then(() => true).catch(() => false),
    /** owner/name and default branch for a checkout. */
    repoInfo: dir => json(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], { cwd: dir })
      .then(r => ({ nameWithOwner: r.nameWithOwner, defaultBranch: r.defaultBranchRef?.name })),
    prView: (repo, n) => json(["pr", "view", String(n), "--repo", repo, "--json", PR_FIELDS]),
    prListByHead: (repo, branch) => json(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url,body,headRefName,headRefOid,author,isCrossRepository,createdAt"]),
    prListMine: repo => json(["pr", "list", "--repo", repo, "--author", "@me", "--state", "open", "--limit", "100", "--json", "number,url,body,headRefName,headRefOid,author,isCrossRepository,createdAt"]),
    /** Reviews, REST, so `id` matches `pull_request_review_id` on inline comments. */
    reviews: (repo, n) => pages(`repos/${repo}/pulls/${n}/reviews?per_page=100`),
    /** Inline review comments, REST, filtered server-side by `since`. */
    inlineComments: (repo, n, since) => pages(`repos/${repo}/pulls/${n}/comments?per_page=100${since ? `&since=${encodeURIComponent(since)}` : ""}`),
    /** Issue-level comments, REST, optionally filtered server-side by `since`. */
    issueComments: (repo, n, since) => pages(`repos/${repo}/issues/${n}/comments?per_page=100${since ? `&since=${encodeURIComponent(since)}` : ""}`),
    /** Committer date of one commit; one small object instead of the PR's whole commit list. */
    commitDate: (repo, sha) => json(["api", `repos/${repo}/commits/${sha}`, "--jq", "{date: .commit.committer.date}"]).then(r => r?.date ?? null),
    /** One file's text at a ref, or null when it is not there. */
    fileAt: (repo, path, ref) => json(["api", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, "--jq", "{content: .content, encoding: .encoding}"])
      .then(r => (r?.content && r.encoding === "base64" ? Buffer.from(r.content, "base64").toString("utf8") : null)).catch(() => null),
    /** The PR diff, capped, for the completion gate's output scan. */
    prDiff: (repo, n) => run(["pr", "diff", String(n), "--repo", repo]).then(d => d.slice(0, MAX_DIFF_BYTES)).catch(() => null),
    comment: (repo, n, body) => run(["pr", "comment", String(n), "--repo", repo, "--body", body]),
    /** Create the two labels once per repo; `--force` makes it idempotent. Called when a repo is first watched. */
    ensureLabels: async repo => { for (const [name, color, desc] of LABELS) await run(["label", "create", name, "--repo", repo, "--color", color, "--description", desc, "--force"]); },
    addLabel: (repo, n, label) => run(["pr", "edit", String(n), "--repo", repo, "--add-label", label]),
    removeLabel: (repo, n, label) => run(["pr", "edit", String(n), "--repo", repo, "--remove-label", label]).catch(() => {}),
    setBody: (repo, n, body) => run(["pr", "edit", String(n), "--repo", repo, "--body", body]),
    rulesets: repo => json(["api", `repos/${repo}/rulesets`]).then(r => r || []),
    tokenScopes: () => exec("gh", ["api", "user", "-i"], { env: env(), timeout: GH_TIMEOUT_MS }).then(({ stdout }) => (stdout.match(/^x-oauth-scopes:\s*(.*)$/mi) || [])[1] ?? null),
  };
}

/** execFile as a promise, with a timeout, and an error that carries stdout, stderr and the exit code. */
export function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(`${cmd} ${args.slice(0, 3).join(" ")}: ${(stderr || err.message).trim()}`), { stdout, stderr, code: err.code, killed: err.killed }));
      resolve({ stdout, stderr });
    });
  });
}
