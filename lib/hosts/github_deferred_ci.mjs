import { sign } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CI_BRANCH_RULE, CI_VARIABLE, deferredCIError } from "../ci_timing.mjs";
import { reviewDigest } from "../review_policy.mjs";
import { hostScope, httpRetryAt } from "../recovery_cooldown.mjs";
import { recoveryDeadline } from "../recovery_io.mjs";
import { candidateJob, checkContext, githubId, immediateName, inactiveGuardJob, requestName, sha } from "./github_ci_workflow.mjs";

const apiVersion = "2026-03-10";
const routeName = value => value.split("/").map(encodeURIComponent).join("/");
const drift = message => deferredCIError(message, "CI_DRIFT");
const requireHost = (ok, message) => { if (!ok) throw drift(message); };
const baseEligible = (set, p) => set?.enforcement === "active" && set.source_type === "Repository" &&
  set.source.toLowerCase() === p.repo && Array.isArray(set.bypass_actors) && Array.isArray(set.rules);
const exactRef = (set, ref) => isDeepStrictEqual(set.conditions, { ref_name: { include: [ref], exclude: [] } });
const boundedList = (data, field, limit = 100) =>
  Array.isArray(data?.[field]) && data[field].length === data.total_count && data.total_count <= limit ? data[field] : null;

const appPermissions = Object.freeze({
  author: { metadata: "read", contents: "write", pull_requests: "write", checks: "read", statuses: "read" },
  dispatcher: { metadata: "read", actions: "write" },
  enroller: { metadata: "read", contents: "write" },
  reporter: { metadata: "read", checks: "write" },
});

// The protected deployment supplies its App keys. Requests mint only a
// repository-bound installation token with the permissions for this role.
export function createGitHubCIApps({ readInstallation, cooldowns, fetch = globalThis.fetch, clock = Date }) {
  const tokens = new Map();
  async function request(path, token, { method = "GET", body, guard } = {}) {
    const timeout = recoveryDeadline(15_000);
    try { await guard?.(); }
    catch (error) { error.notAccepted = true; throw error; }
    let result;
    try {
      result = await fetch(`https://api.github.com/${path}`, { method, redirect: "error", signal: AbortSignal.timeout(timeout),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json",
          "X-GitHub-Api-Version": apiVersion, "User-Agent": "post-review-ci" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch {
      throw deferredCIError("GitHub did not acknowledge the App request. Inspect the saved request before retrying.", "GH_TRANSPORT");
    }
    if (!result.ok) {
      const retryAt = httpRetryAt(result.headers, clock.now());
      const limited = result.status === 429 || result.status === 403 && (result.headers.has("retry-after") || result.headers.get("x-ratelimit-remaining") === "0");
      throw Object.assign(deferredCIError(`GitHub returned HTTP ${result.status} for the scoped App request.`, limited ? "GH_RATE_LIMIT" : "CI_GITHUB_REQUEST"),
        { status: result.status, ...(limited || result.status >= 500 ? { retryAt } : {}),
          // Explicit authentication, authorization and validation refusals
          // prove that GitHub did not create the requested object.
          notAccepted: [400, 401, 403, 404, 422, 429].includes(result.status) });
    }
    if (result.status === 204 || result.status === 202) return null;
    try { return await result.json(); }
    catch { throw deferredCIError("GitHub did not return a complete acknowledgement. Reconcile the saved request.", "GH_TRANSPORT"); }
  }
  const inScope = (p, role, fn) => {
    const scope = hostScope("github.com", `ci-app:${p.repositoryId}:${p.roles[role].appId}`);
    return cooldowns ? cooldowns.call(scope, fn) : fn();
  };
  async function mint(p, role) {
    const id = p.roles[role].appId;
    const install = await readInstallation({ repo: p.repo, repositoryId: p.repositoryId, role, appId: id });
    if (!githubId(install?.id) || !install?.key) throw deferredCIError(`Restore the coordinator's ${role} App installation for ${p.repo}.`);
    const now = Math.floor(clock.now() / 1000);
    const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: String(id), iat: now - 60, exp: now + 480 })}`;
    let jwt;
    try { jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), install.key).toString("base64url")}`; }
    catch { throw deferredCIError(`Restore the private key for the ${role} App.`); }
    const app = await request("app", jwt);
    requireHost(app?.id === id, `The ${role} App identity changed.`);
    const installation = await request(`app/installations/${install.id}`, jwt);
    requireHost(installation?.app_id === id && !installation.suspended_at &&
      Object.entries(appPermissions[role]).every(([name, level]) => installation.permissions?.[name] === level ||
        level === "read" && installation.permissions?.[name] === "write"), `The ${role} App installation lost its approved permissions.`);
    // An author installation has no stronger token available. Even the
    // permission to edit workflow definitions is excluded at the App level.
    if (role === "author") requireHost(isDeepStrictEqual(installation.permissions, appPermissions.author),
      "The author App installation has permissions outside the approved author route.");
    const result = await request(`app/installations/${install.id}/access_tokens`, jwt, {
      method: "POST", body: { repository_ids: [p.repositoryId], permissions: appPermissions[role] },
    });
    const expires = Date.parse(result?.expires_at);
    requireHost(typeof result?.token === "string" && result.token.length > 10 && expires > clock.now() + 300_000 &&
      isDeepStrictEqual(result.permissions, appPermissions[role]) && result.repositories?.length === 1 &&
      result.repositories[0].id === p.repositoryId && result.repositories[0].full_name.toLowerCase() === p.repo,
    `GitHub did not issue an exact repository-scoped ${role} token.`);
    if (p.roles[role].actorId) {
      const user = await request(`users/${encodeURIComponent(app.slug + "[bot]")}`, result.token);
      requireHost(user?.type === "Bot" && user.id === p.roles[role].actorId,
        `The ${role} App's hosted actor does not match the approval.`);
    }
    return { expires, token: result.token };
  }
  async function token(p, role, minimumMs = 120_000) {
    const key = JSON.stringify([p.repo, p.repositoryId, role, p.roles[role]]);
    const saved = tokens.get(key);
    if (saved?.expires > clock.now() + minimumMs) return saved.token;
    const pending = saved?.pending ?? inScope(p, role, () => mint(p, role));
    tokens.set(key, { pending });
    try {
      const result = await pending;
      tokens.set(key, result);
      if (result.expires <= clock.now() + minimumMs) throw deferredCIError("The scoped credential cannot cover the approved author window.");
      return result.token;
    } catch (error) { if (tokens.get(key)?.pending === pending) tokens.delete(key); throw error; }
  }
  return {
    credential: async (p, role, minimumMs) => ({ token: await token(p, role, minimumMs),
      host: "github.com", repository: p.repo, source: `scoped ${role} App` }),
    async write(p, role, path, options) {
      let credential;
      try { credential = await token(p, role); }
      catch (error) { error.notAccepted = true; throw error; }
      try {
        return await inScope(p, role, () => request(`repos/${p.repo}/${path}`, credential, options));
      } catch (error) {
        if (["SERVICE_COOLDOWN", "RECOVERY_IO_BUDGET"].includes(error.code)) error.notAccepted = true;
        throw error;
      }
    },
  };
}

export function githubDeferredCI({ read, apps }) {
  const api = (p, path) => read(p.repo, path);
  const absent = async callback => {
    try { return await callback(); }
    catch (error) { if (error.status === 404) return null; throw error; }
  };
  const ref = (p, kind, name) => absent(() => api(p, `git/ref/${kind}/${routeName(name)}`));
  const verifiedRunUrl = (p, id) => `https://github.com/${p.repo}/actions/runs/${id}`;
  const run = (p, id) => api(p, `actions/runs/${id}`);
  async function locks(p) {
    const [enrollment, dispatch] = await Promise.all([
      api(p, `rulesets/${p.enrollmentRuleset}`), api(p, `rulesets/${p.dispatchRuleset}`),
    ]);
    const has = (record, types) => types.every(type => record.rules.some(rule => rule.type === type));
    requireHost(baseEligible(enrollment, p) && enrollment.target === "branch" &&
      exactRef(enrollment, CI_BRANCH_RULE) && has(enrollment, ["creation", "deletion", "non_fast_forward"]) &&
      isDeepStrictEqual(enrollment.bypass_actors, [{ actor_id: p.roles.enroller.appId, actor_type: "Integration", bypass_mode: "always" }]),
    "Restore the protected enrollment namespace and its sole enrollment App bypass.");
    requireHost(baseEligible(dispatch, p) && dispatch.target === "tag" && exactRef(dispatch, `refs/tags/${p.ref}`) &&
      !dispatch.bypass_actors.length && has(dispatch, ["creation", "update", "deletion"]),
    "Restore the immutable dispatch tag ruleset with no bypass.");
    return reviewDigest([enrollment, dispatch].map(({ conditions, rules, bypass_actors }) => ({ conditions, rules, bypass_actors })));
  }
  async function protection(p) {
    const [effective, classic] = await Promise.all([
      api(p, `rules/branches/${encodeURIComponent(p.base)}?per_page=100`),
      absent(() => api(p, `branches/${encodeURIComponent(p.base)}/protection`)),
    ]);
    requireHost(!classic && Array.isArray(effective) && effective.length < 100 &&
      effective.every(rule => rule.ruleset_source_type === "Repository" && githubId(rule.ruleset_id)),
    "The pilot requires readable repository rulesets on the protected base.");
    const ids = [...new Set(effective.map(rule => rule.ruleset_id))];
    const sets = await Promise.all(ids.map(id => api(p, `rulesets/${id}`)));
    requireHost(sets.every(set => baseEligible(set, p) && !set.bypass_actors.length) &&
      effective.some(rule => rule.type === "non_fast_forward") &&
      effective.some(rule => rule.type === "pull_request" && rule.parameters?.dismiss_stale_reviews_on_push === true &&
        rule.parameters.required_approving_review_count >= 1) &&
      !effective.some(rule => rule.type === "merge_queue"), "Restore no-bypass, current-review base protection.");
    const checks = effective.filter(rule => rule.type === "required_status_checks");
    const pinned = checks.find(rule => rule.ruleset_id === p.checksRuleset);
    requireHost(pinned?.parameters?.strict_required_status_checks_policy === true &&
      checks.every(rule => Array.isArray(rule.parameters?.required_status_checks)), "Restore strict up-to-date required checks.");
    const reports = checks.flatMap(rule => rule.parameters.required_status_checks.filter(check => check.context === checkContext)
      .map(check => [rule.ruleset_id, check.integration_id]));
    requireHost(!reports.length || isDeepStrictEqual(reports, [[p.checksRuleset, p.roles.reporter.appId]]),
      "Pin the distinct required context to the approved reporting App.");
    const original = effective.map(rule => rule.type === "required_status_checks"
      ? { ...rule, parameters: { ...rule.parameters, required_status_checks: rule.parameters.required_status_checks.filter(check => check.context !== checkContext) } }
      : rule).sort((a, b) => reviewDigest(a).localeCompare(reviewDigest(b)));
    const required = original.filter(rule => rule.type === "required_status_checks").flatMap(rule => rule.parameters.required_status_checks);
    requireHost(required.length > 0, "The existing required checks must remain enforced during qualification and cutover.");
    return { original: reviewDigest(original), reportRequired: reports.length === 1, required };
  }
  async function configuration(p) {
    const [repo, tag, conflictingRef, workflow, variable, rules, lockDigest] = await Promise.all([
      read(p.repo, ""), ref(p, "tags", p.ref), ref(p, "heads", p.ref), api(p, `actions/workflows/${p.workflowId}`),
      absent(() => api(p, `actions/variables/${CI_VARIABLE}`)), protection(p), locks(p),
    ]);
    requireHost(repo?.id === p.repositoryId && repo.full_name.toLowerCase() === p.repo && repo.visibility === "private" && repo.allow_forking === false &&
      repo.default_branch === p.base && repo.permissions?.admin === true, "Restore the private pilot identity and the coordinator's ruleset read authority.");
    requireHost(tag?.ref === `refs/tags/${p.ref}` && tag.object?.type === "commit" && tag.object.sha === p.revision && !conflictingRef &&
      workflow?.id === p.workflowId && workflow.path === p.workflow && workflow.state === "active",
    "Restore the approved dispatch tag and active workflow revision.");
    return { ...rules, lockDigest, enabled: variable?.value === "enabled" };
  }
  async function candidate(p, number) {
    if (!githubId(number)) throw drift("A hosted PR number is required.");
    const [pr, branch] = await Promise.all([api(p, `pulls/${number}`), ref(p, "heads", p.base)]);
    requireHost(pr?.number === number && pr.base?.repo?.id === p.repositoryId && pr.base?.ref === p.base &&
      pr.head?.repo?.id === p.repositoryId && pr.html_url?.toLowerCase() === `https://github.com/${p.repo}/pull/${number}` &&
      sha(pr.head.sha) && sha(pr.base.sha), "PR repository, branch or protected base differs from the approval.");
    const value = { number, url: pr.html_url, branch: pr.head.ref, head: pr.head.sha, base: pr.base.sha, author: pr.user?.id,
      createdAt: pr.created_at, state: pr.state, draft: pr.draft, merge: pr.merge_commit_sha };
    if (pr.state !== "open" || pr.draft) return value;
    requireHost(branch?.object?.sha === value.base, "Wait for GitHub to agree on the live base and test merge.");
    if (pr.mergeable !== true || !sha(value.merge)) return value;
    const merge = await api(p, `git/commits/${value.merge}`);
    requireHost(merge?.sha === value.merge && isDeepStrictEqual(merge.parents?.map(parent => parent.sha), [value.base, value.head]),
      "Wait for the test merge of the exact current head and base.");
    return { ...value, mergeProved: true, tested: value[p.checkout] };
  }
  function ownedRun(p, request, raw) {
    return githubId(raw?.id) && raw.repository?.id === p.repositoryId && raw.head_repository?.id === p.repositoryId &&
      raw.workflow_id === p.workflowId && raw.path === p.workflow && raw.head_sha === p.revision &&
      raw.head_branch === p.ref && raw.event === "workflow_dispatch" && raw.actor?.id === p.roles.dispatcher.actorId &&
      raw.display_title === requestName(request.id) && raw.html_url?.toLowerCase() === verifiedRunUrl(p, raw.id) &&
      Date.parse(raw.created_at) >= Date.parse(request.requestedAt) - 1000;
  }
  async function jobs(p, raw, refSha) {
    const page = await api(p, `actions/runs/${raw.id}/attempts/${raw.run_attempt}/jobs?per_page=100`);
    const result = boundedList(page, "jobs");
    requireHost(result && new Set(result.map(job => job.id)).size === result.length &&
      result.every(job => githubId(job.id) && job.run_id === raw.id && job.run_attempt === raw.run_attempt && job.head_sha === refSha),
    "GitHub did not return complete jobs for the exact run and attempt.");
    return result;
  }
  function suite(p, approvedJobs, raw, rows, tested, { dispatch = true, reviewId } = {}) {
    if (raw.run_attempt !== 1) return { failed: null, ok: false, reason: "The workflow was rerun in place. Review the terminal evidence and approve a fresh request." };
    const expected = [...(dispatch ? [candidateJob(tested, reviewId)] : []), ...approvedJobs];
    const selected = dispatch ? rows : rows.filter(job => !(job.name === inactiveGuardJob && job.conclusion === "skipped"));
    const matches = expected.map(name => selected.filter(job => job.name === name));
    const failed = matches.flat().find(job => job.status === "completed" && !["success", "skipped", "neutral"].includes(job.conclusion));
    const failure = failed && { id: failed.id, name: failed.name, conclusion: failed.conclusion,
      url: `${verifiedRunUrl(p, raw.id)}/job/${failed.id}` };
    const ok = raw.status === "completed" && raw.conclusion === "success" && selected.length === expected.length &&
      matches.every(group => group.length === 1 && group[0].status === "completed" && group[0].conclusion === "success");
    return { failed: failure || null, ok, reason: ok ? null : failed ? "Resolve the selected job failure before approving a new attempt."
      : "Every selected job must report actual success for the approved candidate." };
  }
  return {
    configuration, candidate, ownedRun, jobs, suite, run, verifiedRunUrl, ref, api,
    async findRun(p, request) {
      if (request.runId) {
        const row = await run(p, request.runId);
        requireHost(row?.id === request.runId && ownedRun(p, request, row), "The saved Actions run no longer matches its dispatch identity.");
        return row;
      }
      const created = new Date(Date.parse(request.requestedAt) - 1000).toISOString();
      const page = await api(p, `actions/workflows/${p.workflowId}/runs?event=workflow_dispatch&head_sha=${p.revision}&created=${encodeURIComponent(">=" + created)}&per_page=100`);
      const rows = boundedList(page, "workflow_runs");
      requireHost(rows, "The bounded dispatch observation is incomplete; inspect the saved request.");
      const matches = rows.filter(row => ownedRun(p, request, row));
      requireHost(matches.length < 2, "More than one Actions run matches the saved request; an operator must reconcile the dispatch.");
      return matches[0] ?? null;
    },
    async immediateRun(p, approval, value, id = null) {
      const path = `actions/workflows/${p.workflowId}/runs?event=pull_request&head_sha=${value.head}&per_page=100`;
      const rows = id ? [await run(p, id)] : boundedList(await api(p, path), "workflow_runs") ?? [];
      for (const raw of rows) {
        if (!value.mergeProved || !githubId(raw?.id) || (id && raw.id !== id) || raw.repository?.id !== p.repositoryId ||
            raw.head_repository?.id !== p.repositoryId || raw.workflow_id !== p.workflowId || raw.path !== p.workflow ||
            raw.head_sha !== value.head || raw.head_branch !== value.branch || raw.event !== "pull_request" || raw.status !== "completed" ||
            raw.display_title !== immediateName(value) || raw.html_url?.toLowerCase() !== verifiedRunUrl(p, raw.id) ||
            !Array.isArray(raw.pull_requests) || raw.pull_requests.length && !raw.pull_requests.some(pr => pr.number === value.number && pr.head?.repo?.id === p.repositoryId && pr.head.sha === value.head &&
              pr.base?.repo?.id === p.repositoryId && pr.base.ref === p.base && pr.base.sha === value.base)) continue;
        // This proof is accepted only for the transformed workflow, with
        // actual successful jobs from the event's original checkout semantics.
        // GitHub can omit pull_requests. The pinned run name still binds the
        // event's PR number, base and test merge from the protected workflow.
        if (suite(p, approval.jobs, raw, await jobs(p, raw, value.head), value.tested, { dispatch: false }).ok) return raw;
      }
      return null;
    },
    async reportProof(p, value, externalId) {
      const page = await api(p, `commits/${value.merge}/check-runs?filter=all&check_name=${encodeURIComponent(checkContext)}&per_page=100`);
      const rows = boundedList(page, "check_runs");
      requireHost(rows, "Read the complete reporting App check evidence before advancing.");
      const matches = rows.filter(row => row.app?.id === p.roles.reporter.appId && row.external_id === externalId &&
        row.name === checkContext && row.head_sha === value.merge);
      requireHost(matches.length <= 1, "The reported check identity is ambiguous.");
      return matches[0] ?? null;
    },
    report(p, value, externalId, url, description, guard) {
      return apps.write(p, "reporter", "check-runs", { method: "POST", guard, body: {
        name: checkContext, head_sha: value.merge, external_id: externalId, details_url: url,
        status: "completed", conclusion: "success", output: { title: "Verified selected CI jobs", summary: description },
      } });
    },
    enroll(p, branch, head, guard) {
      return apps.write(p, "enroller", "git/refs", { method: "POST", guard, body: { ref: `refs/heads/${branch}`, sha: head } });
    },
    dispatch(p, request, value, guard) {
      return apps.write(p, "dispatcher", `actions/workflows/${p.workflowId}/dispatches`, { method: "POST", guard, body: {
        ref: p.ref, inputs: { request: request.id, pr: String(value.number), branch: value.branch,
          head: value.head, base: value.base, merge: value.merge, tested: value.tested, revision: p.revision, review: String(request.review.id) },
      } });
    },
    cancel(p, id, guard) {
      if (!githubId(id)) throw drift("Cancellation requires an owned Actions run ID.");
      return apps.write(p, "dispatcher", `actions/runs/${id}/cancel`, { method: "POST", guard });
    },
    credential: (p, role, ms) => apps.credential(p, role, ms),
  };
}
