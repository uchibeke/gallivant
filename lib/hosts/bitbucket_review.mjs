// A build execution is not a review. Only an explicit, exact-commit verdict
// posted by the configured host actor can answer the shared review gate.
export function bitbucketVerdict(body) {
  const blocks = [...String(body ?? "").matchAll(/^```work-review\s*\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) return null;
  try {
    const value = JSON.parse(blocks[0][1]);
    if (!value || Object.keys(value).sort().join(",") !== "head_sha,summary,verdict" ||
        !/^[0-9a-f]{40}$/i.test(value.head_sha) || !["blocking", "clear"].includes(value.verdict) ||
        typeof value.summary !== "string" || !value.summary.trim()) return null;
    return { headSha: value.head_sha.toLowerCase(), verdict: value.verdict };
  } catch { return null; }
}

export function bitbucketFeedback(pr) {
  const reviews = [];
  const comments = pr.comments.filter(c => !c.path);
  const inline = pr.comments.filter(c => c.path && !c.deleted && !c.resolved);
  for (const c of pr.comments) {
    const verdict = !c.deleted && bitbucketVerdict(c.body);
    if (!verdict || c.replyTo) continue;
    reviews.push({ ...c, ...verdict, id: `verdict:${c.id}`, eventId: `verdict:${c.id}`, kind: "review", headBinding: "exact", sequence: c.id,
      state: verdict.verdict === "blocking" ? "CHANGES_REQUESTED" : "APPROVED" });
  }
  // Native approvals have no immutable reviewed commit. Keep participants in
  // the snapshot, but never turn an approval retained after a push into clear.
  for (const p of pr.participants) {
    if (p.state !== "changes_requested") continue;
    const at = p.participatedAt;
    if (!at || !Number.isFinite(Date.parse(at))) throw new Error("Bitbucket change request lacks participated_on; recover complete review evidence");
    const id = `participant:${p.actor.login}:${at}`;
    reviews.push({ source: pr.source, actor: p.actor, id, eventId: id, headSha: null, headBinding: "pull-request", required: true,
      createdAt: at, updatedAt: at, at, kind: "review", state: "CHANGES_REQUESTED", url: pr.url,
      body: "Native change request has no reviewed SHA. Ask its author to post current-head feedback and remove the change request." });
  }
  for (const t of pr.tasks) {
    if (t.state !== "UNRESOLVED") continue;
    const comment = pr.comments.find(c => c.id === t.commentId);
    reviews.push({ ...t, id: `task:${t.id}`, eventId: `task:${t.id}`, kind: "review", state: "CHANGES_REQUESTED", required: true,
      headBinding: "pull-request", at: t.createdAt, path: comment?.path ?? null, line: comment?.line ?? null,
      body: `Unresolved required task ${t.id}: ${t.body}`, url: comment?.url ?? pr.url });
  }
  return { reviews, inline, comments, complete: true, headSha: pr.headRefOid };
}
