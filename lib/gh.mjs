// The only module that talks to GitHub, and it does so through the `gh` CLI so there is no HTTP client, no token
// parsing and no pagination code to own. `exec` is injectable so the tick can be tested against a fake.
//
// Logins: GitHub renders bots as `name[bot]` in REST and as `login` + `is_bot` in gh's GraphQL output. Everything
// is normalised to the bare login plus a `bot` flag before any comparison.
import { execFile } from "node:child_process";

import { ROUND_MARKER, NUDGE_MARKER, RESET_MARKER, READY_LABEL, NEEDS_LABEL, labelAliases } from "./public-format.mjs";
import { assertPublicText } from "./public_output.mjs";
import { normalizePublicBody, parseBlock, renderBlock } from "./block.mjs";
export { ROUND_MARKER, NUDGE_MARKER, RESET_MARKER, READY_LABEL, NEEDS_LABEL };

const GH_TIMEOUT_MS = 60_000;
/** The scan cap for a PR diff. A diff this size or larger cannot be shown to the output scan whole. */
export const MAX_DIFF_BYTES = 16 * 1024 * 1024;

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

/**
 * owner/repo from a git remote URL, lowercased, or null when the URL is not a GitHub remote we understand.
 * The supported forms are the ones `gh repo clone` and `git clone` produce: https, scp-style ssh, and ssh://.
 * Callers compare the result for equality, never by substring, so `acme/widget-fork` never matches `acme/widget`.
 */
export function repoFromRemote(url) {
  const s = String(url || "").trim().replace(/\/+$/, "");
  const m = s.match(/^(?:https?:\/\/(?:[^@/]*@)?github\.com\/|(?:ssh:\/\/)?(?:[^@/]+@)?github\.com[:/])([\w-][\w.-]*)\/([\w-][\w.-]*?)(?:\.git)?$/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

/** Whether a remote URL points at exactly this `owner/repo`. */
export const remoteMatches = (url, nameWithOwner) => {
  const parsed = repoFromRemote(url);
  return parsed !== null && parsed === String(nameWithOwner || "").toLowerCase();
};

// Reviews and comments come from REST (numeric ids, `user.type`, `since` filters); the rest from `gh pr view`.
const PR_FIELDS = "number,url,title,state,isDraft,mergeable,headRefOid,headRefName,isCrossRepository,author,createdAt,updatedAt,statusCheckRollup,labels,body,baseRefName,mergeCommit,mergedAt";

/**
 * The `gh` the daemon itself runs.
 *
 * `credential` is a function, resolved per call rather than captured once, for the reason `makeGit` gives: a
 * long-lived daemon outlives a token, and an operator who re-authenticates under it should not have to restart it.
 * It defaults to resolving nothing, in which case `gh` falls back to its own stores exactly as before, which is
 * right for the daemon (not sandboxed) and is what keeps every existing test working unchanged.
 */
export function makeGh({ credential = async () => null, exec = execFileAsync, log = null } = {}) {
  const env = async () => {
    const token = (await credential())?.token;
    return token ? { ...process.env, GH_TOKEN: token } : process.env;
  };
  const LABELS = [[READY_LABEL, "5319e7", "Checks green, reviewer clear, completion receipt accepted"], [NEEDS_LABEL, "b60205", "Work paused; operator attention required"]];
  const run = async (args, { cwd, timeout = GH_TIMEOUT_MS, signal } = {}) => {
    signal?.throwIfAborted();
    const resolvedEnv = await env();
    signal?.throwIfAborted();
    const { stdout } = await exec("gh", args, { cwd, env: resolvedEnv, timeout, maxBuffer: 32 * 1024 * 1024, ...(signal ? { signal } : {}) });
    return stdout;
  };
  const json = async (args, opts) => { const out = await run(args, opts); return out.trim() ? JSON.parse(out) : null; };
  // `--paginate` alone concatenates one JSON array per page; `--slurp` wraps them so the output parses as one array.
  const pages = path => json(["api", path, "--paginate", "--slurp"]).then(r => (r || []).flat());

  // Remove every historical spelling separately: one absent alias must not hide a forbidden/network failure on
  // another. Existing retry counters therefore cover the whole migration and never dispatch behind a stale label.
  const removeOneLabel = (repo, n, label, { lenient = false } = {}) => run(["pr", "edit", String(n), "--repo", repo, "--remove-label", label])
    .catch(e => {
      const message = String(e.message || "");
      const missingLabel = /\blabel\b.*\bnot found\b|\bdoes not have\b.*\blabel\b|\bno label\b/i.test(message)
        || (message.toLowerCase().includes(label.toLowerCase()) && /\bnot found\b/i.test(message));
      if (!lenient && !missingLabel) throw e;
    });
  const removeLabel = async (repo, n, label, opts) => {
    let result;
    for (const alias of labelAliases(label)) result = await removeOneLabel(repo, n, alias, opts);
    return result;
  };
  const labelsEnsured = new Set();
  const ensureLabels = async repo => {
    if (labelsEnsured.has(repo)) return;
    for (const [name, color, desc] of LABELS) await run(["label", "create", name, "--repo", repo, "--color", color, "--description", desc, "--force"]);
    labelsEnsured.add(repo);
  };
  const publicWrite = (args, value, field) => { assertPublicText(value, field); return run(args); };

  return {
    run,
    json,
    /** Login of the token in use. */
    user: options => json(["api", "user", "--jq", "{login: .login}"], options).then(u => u.login),
    authStatus: () => run(["auth", "status"]).then(() => true).catch(() => false),
    /** owner/name and default branch for a checkout. */
    repoInfo: dir => json(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], { cwd: dir })
      .then(r => ({ nameWithOwner: r.nameWithOwner, defaultBranch: r.defaultBranchRef?.name })),
    markReady: (repo, n) => run(["pr", "ready", String(n), "--repo", repo]),
    /** Only generated recovery/receipt transport may migrate before prose is corrected. Read fresh, and derive
     * the replacement here: callers cannot use this path to smuggle an arbitrary unguarded body to GitHub. */
    setRecoveryMetadata: async (repo, n, identity, { taskId = null } = {}) => {
      const pr = await json(["pr", "view", String(n), "--repo", repo, "--json", PR_FIELDS]);
      if (pr.isCrossRepository || identity.branch !== pr.headRefName) throw new Error("recovery identity branch differs from the same-repository PR head");
      const validated = parseBlock(renderBlock(identity));
      if (!validated.block) throw new Error(`invalid recovery identity: ${validated.reason}`);
      const body = normalizePublicBody(pr.body, { identity: validated.block, taskId });
      if (body !== pr.body) await run(["pr", "edit", String(n), "--repo", repo, "--body", body]);
      return { ...pr, body };
    },
    prView: (repo, n) => json(["pr", "view", String(n), "--repo", repo, "--json", PR_FIELDS]),
    refSha: (repo, ref) => json(["api", `repos/${repo}/commits/${encodeURIComponent(ref)}`]).then(r => r.sha),
    containsCommit: (repo, ref, sha) => json(["api", `repos/${repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(ref)}`])
      .then(r => ["ahead", "identical"].includes(r.status) && r.merge_base_commit?.sha === sha),
    // Queue approval must distinguish an absent file from an API failure or an unsupported content response.
    fileAtStrict: async (repo, path, ref) => {
      let r;
      try { r = await json(["api", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`]); }
      catch (e) { if (/HTTP 404/.test(e.stderr || e.message)) return null; throw e; }
      if (r?.type !== "file" || r.encoding !== "base64" || typeof r.content !== "string") throw new Error(`cannot read ${repo}:${path} at ${ref} as a text file`);
      return Buffer.from(r.content, "base64").toString("utf8");
    },
    prListByHead: (repo, branch) => json(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url,title,state,isDraft,body,headRefName,headRefOid,author,isCrossRepository,createdAt"]),
    prListMine: repo => json(["pr", "list", "--repo", repo, "--author", "@me", "--state", "open", "--limit", "100", "--json", "number,url,title,state,isDraft,body,headRefName,headRefOid,author,isCrossRepository,createdAt,baseRefName"]),
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
    /**
     * The PR diff for the completion gate's output scan. Failures are thrown, never swallowed: an empty string
     * passes the blocked-pattern scan trivially, so a diff that could not be read must not read as "clean". The
     * gate treats the throw as no decision yet and tries again on the next tick.
     *
     * A diff over the cap is one of those failures. Handing the scan the first megabyte and letting it answer
     * "clean" is the same fail-open as handing it an empty string: a blocked pattern past the cutoff is never
     * looked at. The cap stays, because a diff of any size in memory is its own problem; what it produces is a
     * refusal to decide rather than a partial answer presented as a whole one.
     */
    prDiff: (repo, n) => run(["pr", "diff", String(n), "--repo", repo]).then(d => {
      // At the cap, not only over it: a diff of exactly the cap is indistinguishable from one the cap cut short.
      const bytes = Buffer.byteLength(d);
      if (bytes >= MAX_DIFF_BYTES) throw new Error(`diff is ${bytes} bytes, at or over the ${MAX_DIFF_BYTES}-byte scan cap; refusing an incomplete output scan`);
      return d;
    }),
    comment: (repo, n, body) => publicWrite(["pr", "comment", String(n), "--repo", repo, "--body", body], body, "comment"),
    /** Create the two labels once per repo; `--force` makes it idempotent. Called when a repo is first watched. */
    ensureLabels,
    addLabel: async (repo, n, label) => {
      const [canonical, ...legacy] = labelAliases(label);
      assertPublicText(canonical, "label");
      if (canonical === READY_LABEL || canonical === NEEDS_LABEL) await ensureLabels(repo);
      for (const alias of legacy) await removeOneLabel(repo, n, alias);
      // A ready state must not coexist with either spelling of the stopped state, or vice versa.
      if (canonical === READY_LABEL || canonical === NEEDS_LABEL) await removeLabel(repo, n, canonical === READY_LABEL ? NEEDS_LABEL : READY_LABEL);
      return run(["pr", "edit", String(n), "--repo", repo, "--add-label", canonical]);
    },
    /**
     * Take a label off, ignoring one that is not there, which is the ordinary case and not a failure. Everything
     * else throws, so a caller that has to know whether the write reached GitHub at all (to retry it, or to decline
     * the step that depended on it) learns that by default.
     *
     * The default used to be the other way round: `strict` was opt-in, and the lenient behaviour swallowed a
     * rate-limited or forbidden write as if the label had merely been absent. Two callers of this one write then
     * disagreed, one passing `{ strict: true }` and one omitting it, which is this codebase's recurring defect shape.
     * A caller that omits an option must get the safe behaviour, so the option is now `lenient` and the dangerous
     * half is the one you have to ask for by name. There are no callers of `lenient` in the tree; it exists so a
     * future one states its intent at the site rather than by omission.
     */
    removeLabel,
    setBody: (repo, n, body) => publicWrite(["pr", "edit", String(n), "--repo", repo, "--body", body], body, "PR body"),
    setTitle: (repo, n, title) => publicWrite(["pr", "edit", String(n), "--repo", repo, "--title", title], title, "PR title"),
    async publishResultPr({ repo, branch, base, title, body }) {
      assertPublicText(title, "PR title"); assertPublicText(body, "PR body");
      const prs = await json(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url,headRefName,isCrossRepository,baseRefName"]);
      if ((prs || []).length > 1) throw new Error("ambiguous result PR ownership; reconcile the recorded branch before publishing");
      const existing = prs?.[0];
      if (existing) {
        if (existing.isCrossRepository || existing.headRefName !== branch || existing.baseRefName !== base) throw new Error("result PR differs from task branch/base ownership");
        await run(["pr", "edit", String(existing.number), "--repo", repo, "--title", title, "--body", body]);
        return existing;
      }
      await run(["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", title, "--body", body]);
      const created = await json(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url,headRefName,isCrossRepository,baseRefName"]);
      if (created?.length !== 1 || created[0].isCrossRepository || created[0].headRefName !== branch || created[0].baseRefName !== base) throw new Error("PR creation acceptance unresolved; reconcile the owned branch before retrying");
      return created[0];
    },
    rulesets: repo => json(["api", `repos/${repo}/rulesets`]).then(r => r || []),
    /** The default branch of a repo by name, for checks that must name the branch they verify. */
    repoDefaultBranch: repo => json(["repo", "view", repo, "--json", "defaultBranchRef"]).then(r => r?.defaultBranchRef?.name ?? null),
    /**
     * Whether one branch exists on the remote. Asked before anything is cloned, because a base that is not there is
     * something `gh pr create --base` discovers after a session has implemented the whole brief and spent the money.
     *
     * False for a 404 and for anything else that goes wrong, which the caller must read as "could not confirm" rather
     * than "absent": `start` says which of the two it saw, so a GitHub that is briefly unreachable does not read as a
     * misspelled branch name.
     */
    branchExists: (repo, branch) => json(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}`, "--jq", "{name: .name}"]).then(r => r?.name === branch).catch(() => false),
    tokenScopes: async () => exec("gh", ["api", "user", "-i"], { env: await env(), timeout: GH_TIMEOUT_MS }).then(({ stdout }) => (stdout.match(/^x-oauth-scopes:\s*(.*)$/mi) || [])[1] ?? null),
    /**
     * Whether the token in use can actually push to one repo, from `repos/<r>` and its `permissions` block.
     * A token that resolves but cannot write is the same defect one step later, so this asks GitHub rather than
     * inferring it from a scope string: a fine-grained PAT carries no scopes at all and would otherwise read as
     * "no permissions", and an org that has not approved the PAT answers here too.
     */
    repoPermissions: repo => json(["api", `repos/${repo}`, "--jq", "{push: .permissions.push, admin: .permissions.admin, archived: .archived}"]),
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
