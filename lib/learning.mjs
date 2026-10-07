// One coordinator-owned service. CLI/daemon callers cannot supply approval flags,
// trust keys, arbitrary URLs, commands or an alternative active-state writer.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { actor } from "./gh.mjs";
import { deriveEvents } from "./events.mjs";
import { learningStore, safePath, inside } from "./learning_store.mjs";
import { openSshSigner, NAMESPACE, SIGNER_ID, encryptedKey, validateAuthority } from "./learning_signer.mjs";
import { canonical, hash, candidate, digestField, candidateId, closed, repository, repositoryName, dateRange, minimized, safeDisplay, textField, parseJson, learningError, iso, literalPath } from "./learning_data.mjs";
import { boundedCall } from "./execution_io.mjs";
import { probeLearningIsolation } from "./learning_qualification.mjs";

export const LEARNING_LIMITS = Object.freeze({ deliveries: 1000, deliveryBytes: 16 * 1024, pathAuditBytes: 2048, prs: 100, findings: 1000, pages: 60, candidates: 20, observations: 10_000, lessons: 20, contextBytes: 8192, retentionDays: 30, deadlineMs: 60_000, extractionMs: 30_000, extractionUsd: 0 });
export const unqualified = () => ({ qualified: false, status: "UNQUALIFIED", reason: "installed execution profiles do not enforce an outer learning authority boundary; collection only", remedy: "qualify key/trust/checkpoint/verifier and terminal/control denial with an enforced execution profile; no config flag or TTY can qualify it" });
const ordered = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const refs = rules => rules.map(({ id, digest }) => ({ id, digest })).sort((a, b) => ordered(a.id, b.id));
const refKey = r => `${r.id}:${r.digest}`;
const ruleKey = (id, digest) => { candidateId(id); digestField(digest); return `${id}:${digest}`; };
const sourceId = (pr, kind, id) => `${pr}:${kind}:${id}`;
const clone = value => parseJson(canonical(value), 32 * 1024 * 1024);
const dispatchSnapshot = value => ({ ...clone(value), delivered: false, runId: null });
// Arrival order differs between concurrent scans and daemon reads. Source time
// wins; observation time and digest break ties deterministically without ever
// treating two versions of one source as current evidence.
const reconcileObservations = observations => {
  const latest = new Map();
  const rank = ([key, o]) => [Date.parse(o.content.updatedAt), Date.parse(o.observedAt), key];
  const compare = (a, b) => { const x = rank(a), y = rank(b); return ordered(x[0], y[0]) || ordered(x[1], y[1]) || ordered(x[2], y[2]); };
  for (const item of Object.entries(observations)) {
    const source = item[1].content.source, previous = latest.get(source);
    if (!previous || compare(item, previous) > 0) latest.set(source, item);
  }
  for (const [key, o] of Object.entries(observations)) o.superseded = latest.get(o.content.source)[0] !== key;
};

export function createLearningService({ root, store = learningStore(root), signer = openSshSigner(), clock = { now: Date.now }, gh = null, trust = null, qualify = unqualified, probeIsolation = probeLearningIsolation, extractor = null, onRevocation = async () => [] } = {}) {
  const at = () => new Date(clock.now()).toISOString();
  const revocationIntent = (s, removed, reason) => {
    const affected = Object.values(s.deliveries).filter(d => d.rules.some(r => !removed || removed.some(x => refKey(x) === refKey(r))));
    for (const d of affected) d.revoked ??= { reason, at: at() };
    return { repo: s.repo, removed, reason, prepared: affected.filter(d => !d.delivered && d.taskId).map(d => ({ taskId: d.taskId, profile: d.profile, key: d.key, operationId: d.operationId })) };
  };
  // Transport metadata is not part of immutable repository identity or approval scope.
  // Resolution is read-only, including during dry-run; observations retain the classification.
  const resolvedRepositories = new Map();
  const visibilityFor = (repo, name, supplied) => {
    const resolved = resolvedRepositories.get(name?.toLowerCase());
    const value = supplied ?? (resolved && canonical(resolved.repo) === canonical(repo) ? resolved.visibility : null);
    return ["public", "private", "internal"].includes(value) ? value : "unknown";
  };
  const expired = o => o.expired || Date.parse(o.observedAt) < clock.now() - LEARNING_LIMITS.retentionDays * 86400_000;
  const expire = s => {
    for (const scan of s.scans) for (const review of scan.continuation?.source?.reviews || []) {
      const observed = Date.parse(review.observedAt);
      if (!Number.isFinite(observed) || observed < clock.now() - LEARNING_LIMITS.retentionDays * 86400_000) review.excerpt = { ...review.excerpt, excerpt: "[raw excerpt expired]", incomplete: true };
    }
    let count = 0; for (const o of Object.values(s.observations)) if (!o.expired && expired(o)) { o.content.excerpt = "[raw excerpt expired]"; o.expired = true; count++; } return count; };
  // The root comes from protected operator configuration, never a task or candidate.
  let pinnedAuthority = null;
  const authority = () => {
    const value = store.readAuthority();
    if (!value) throw learningError("TRUST", "learning authority not enrolled; run learn setup in the operator terminal");
    validateAuthority(value);
    if (pinnedAuthority && canonical(value) !== pinnedAuthority) throw learningError("TRUST", "enrolled trust root changed during this service lifetime");
    pinnedAuthority ??= canonical(value);
    if (canonical(value.enrollment) !== canonical({ version: 1, type: "enrollment", authority: value.id, repo: null, namespace: NAMESPACE, identity: SIGNER_ID, publicKey: value.publicKey, fingerprint: value.fingerprint, signer: value.signer, keyPath: value.keyPath })) throw learningError("TRUST", "enrollment manifest differs from trust root");
    signer.verify(canonical(value.enrollment), value.signature, value);
    return value;
  };
  const qualified = async (repo, profile = null) => {
    const evidence = await qualify({ repo, profile, root: store.root });
    if (evidence?.qualified !== true) throw learningError("UNQUALIFIED", `${evidence?.status || "UNQUALIFIED"}: ${evidence?.reason || "execution isolation unavailable"}; ${evidence?.remedy || "run opt-in qualification on a supported host"}`);
    return evidence;
  };
  const putCandidate = (s, value) => {
    const revision = candidate(value, s.repo), key = ruleKey(value.id, revision.digest);
    if (value.evidence.some(d => !s.observations[d])) throw learningError("EVIDENCE", "candidate references unknown evidence revisions");
    // Exact evidence/text revisions, including rejected ones, cannot be reproposed under another ID.
    const identity = hash({ ...value, id: null, provenance: { ...value.provenance, at: null } });
    const duplicate = Object.values(s.candidates).find(c => c.identity === identity);
    if (duplicate) return { ...duplicate, duplicate: true };
    if (s.candidates[key]) return { ...s.candidates[key], duplicate: true };
    if (Object.keys(s.candidates).length >= 2000) throw learningError("STORAGE", "candidate history reached its 2,000 revision cap; preserve dispositions and review storage before proposing more");
    const record = { ...revision, identity, status: "pending", reason: null, createdAt: at() };
    s.candidates[key] = record;
    return record;
  };
  const selected = (s, id, revision) => {
    candidateId(id);
    if (revision) return s.candidates[ruleKey(id, revision)] ?? (() => { throw learningError("REVISION", "unknown exact revision"); })();
    const versions = Object.values(s.candidates).filter(c => c.content.id === id);
    if (versions.length !== 1) throw learningError("REVISION", "select an exact --revision digest; candidate has zero or multiple revisions");
    return versions[0];
  };
  const conflicts = (s, content) => Object.values(s.candidates).filter(c => c.content.id !== content.id && c.status !== "rejected" && (c.content.paths.length === 0 || content.paths.length === 0 || c.content.paths.some(p => content.paths.some(q => p === q || p.startsWith(q + "/") || q.startsWith(p + "/"))))).map(c => ({ id: c.content.id, digest: c.digest, status: c.status, guidance: c.content.guidance, kind: c.content.guidance === content.guidance ? "repeated-guidance" : "overlapping-scope; contradiction requires human review" }));
  const review = (s, record) => ({ ...record, evidence: record.content.evidence.map(digest => { const o = clone(s.observations[digest]); if (expired(o)) { o.content.excerpt = "[raw excerpt expired]"; o.expired = true; } return { digest, ...o }; }), conflicts: conflicts(s, record.content) });
  const observe = (s, { pr, reviews = [], inline = [], comments = [], completeKinds = [], visibility, reviewExcerpts = {} }, range = null, limit = LEARNING_LIMITS.findings) => {
    expire(s);
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw learningError("INPUT", "invalid source PR identity");
    if (!trust) throw learningError("TRUST", "collection requires the shared reviewer eligibility rules");
    const result = { eligible: 0, added: 0, duplicates: 0, capped: false };
    const groups = { review: reviews, inline, command: comments };
    const events = deriveEvents({ pr: { ...pr, headRefOid: null }, reviews, inline, comments, entry: { cursor: { since: "1970-01-01T00:00:00Z", dispatched: [], checks_sha: null } }, trust }).events;
    for (const event of events) {
      if (event.kind === "check") continue;
      const raw = groups[event.kind].find(r => r.id === event.id);
      if (!raw) continue;
      if (!Number.isSafeInteger(event.id) || event.id < 1 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/.test(event.author)) throw learningError("INPUT", "invalid source identity");
      const updated = raw.updated_at || raw.submitted_at || raw.created_at || event.at;
      if (range && (Date.parse(updated) < Date.parse(range.since) || Date.parse(updated) >= Date.parse(range.until))) continue;
      if (result.eligible >= limit || Object.keys(s.observations).length >= LEARNING_LIMITS.observations) { result.capped = true; break; }
      result.eligible++;
      const excerpt = event.kind === "review" && reviewExcerpts[event.id] ? clone(reviewExcerpts[event.id]) : minimized(event.body);
      let path = null; try { if (event.path) path = literalPath(event.path); } catch { excerpt.incomplete = true; }
      const sha = v => typeof v === "string" && /^[a-f0-9]{40,64}$/.test(v) ? v : null;
      const content = { version: 1, repo: s.repo, source: sourceId(pr.number, event.kind, event.id), pr: pr.number, kind: event.kind, id: String(event.id), reviewId: event.reviewId == null ? null : String(event.reviewId), author: event.author, createdAt: event.at, updatedAt: updated, path, originalSha: sha(raw.original_commit_id || raw.commit_id), fixSha: sha(pr.headRefOid || pr.head?.sha), url: `https://github.com/${repositoryName(pr.repo)}/pull/${pr.number}`, visibility: visibilityFor(s.repo, pr.repo, visibility), disposition: raw.state === "DISMISSED" ? "retracted" : "unconfirmed", ...excerpt };
      iso(content.createdAt); iso(content.updatedAt);
      const digest = hash(content);
      if (s.observations[digest]) { result.duplicates++; continue; }
      const previous = Object.values(s.observations).filter(o => o.content.source === content.source && !o.superseded).map(o => o.content.sourceDigest);
      s.observations[digest] = { content, observedAt: at(), superseded: false, deleted: false, expired: false, previous };
      result.added++;
    }
    reconcileObservations(s.observations);
    // Only a complete, unfiltered source enumeration proves absence. Automatic
    // coding reads are filtered and cannot accidentally tombstone old findings.
    for (const kind of completeKinds) {
      const rawIds = new Set((groups[kind] || []).map(r => sourceId(pr.number, kind, r.id)));
      for (const o of Object.values(s.observations)) if (o.content.pr === pr.number && o.content.kind === kind && !o.superseded && !o.deleted && !rawIds.has(o.content.source)) { o.deleted = true; o.retractedAt ??= at(); }
    }
    for (const raw of reviews) if (raw.state === "DISMISSED") {
      for (const o of Object.values(s.observations)) if (o.content.pr === pr.number && (o.content.kind === "review" && o.content.id === String(raw.id) || o.content.reviewId === String(raw.id))) { o.retracted = true; o.retractedAt ??= at(); }
    }
    return result;
  };
  const verifyState = (s, a) => {
    let active = [], parent = null;
    if (s.sequence > 10_000 || !Number.isSafeInteger(s.sequence) || s.sequence < 0) throw learningError("STATE", "invalid transition sequence");
    for (let sequence = 1; sequence <= s.sequence; sequence++) {
      const t = s.transitions[String(sequence)];
      if (!t) throw learningError("CHECKPOINT", "missing approval history; application blocked");
      const m = t.manifest;
      validateManifest(m, s.repo, a);
      if (m.sequence !== sequence || m.parent !== parent || hash(m) !== t.digest) throw learningError("REPLAY", "approval sequence/parent/content mismatch");
      signer.verify(canonical(m), t.signature, a);
      active = applyManifest(active, m, s, a);
      parent = t.digest;
    }
    if (canonical(active) !== canonical(s.active) || parent !== s.parent || canonical(s.checkpoint) !== canonical(s.sequence ? { authority: a.id, repo: s.repo, sequence: s.sequence, parent, activeDigest: hash(active) } : null)) throw learningError("CHECKPOINT", "active set or monotonic checkpoint inconsistent; application blocked");
    return { active, parent };
  };
  const validateManifest = (m, repo, a) => {
    closed(m, ["version", "type", "namespace", "authority", "repo", "fingerprint", "action", "sequence", "parent", "add", "remove", "activeDigest", "evidenceDigests", "reason", "at"], "transition");
    if (m.version !== 1 || m.type !== "transition" || m.namespace !== NAMESPACE || m.authority !== a.id || m.fingerprint !== a.fingerprint || canonical(m.repo) !== canonical(repo) || !["approve", "replace", "retire"].includes(m.action)) throw learningError("SIGNATURE", "foreign transition or unknown authorization schema");
    iso(m.at); digestField(m.activeDigest); if (m.parent !== null) digestField(m.parent);
    if (!Number.isSafeInteger(m.sequence) || m.sequence < 1 || !Array.isArray(m.add) || m.add.length > LEARNING_LIMITS.candidates || !Array.isArray(m.remove) || m.remove.length > LEARNING_LIMITS.candidates || !Array.isArray(m.evidenceDigests) || m.evidenceDigests.length > 400) throw learningError("SIGNATURE", "invalid transition bounds");
    if (m.action === "retire" ? m.add.length !== 0 || !m.remove.length : !m.add.length) throw learningError("SIGNATURE", "invalid transition action");
    if (m.action === "approve" && m.remove.length) throw learningError("SIGNATURE", "approve cannot hide replacements");
    if (m.action === "replace" && !m.remove.length) throw learningError("SIGNATURE", "replacement must enumerate removals");
    if (m.reason !== null) textField(m.reason, "transition reason");
    if (m.action === "retire" && m.reason === null) throw learningError("SIGNATURE", "retirement requires a reviewed reason");
    m.remove.forEach(r => { closed(r, ["id", "digest"], "removed revision"); ruleKey(r.id, r.digest); });
    m.evidenceDigests.forEach(digestField);
  };
  const applyManifest = (prior, m, s) => {
    let active = clone(prior);
    if (new Set(m.remove.map(refKey)).size !== m.remove.length || new Set(m.add.map(r => r.content.id)).size !== m.add.length) throw learningError("SIGNATURE", "duplicate batch revisions");
    for (const ref of m.remove) {
      if (!active.some(r => refKey(r) === refKey(ref))) throw learningError("REPLAY", "removal is not an exact active revision");
      active = active.filter(r => refKey(r) !== refKey(ref));
    }
    const evidence = [];
    for (const add of m.add) {
      closed(add, ["content", "digest", "evidence"], "added revision");
      const validated = candidate(add.content, s.repo);
      if (validated.digest !== add.digest || !Array.isArray(add.evidence) || add.evidence.length !== add.content.evidence.length) throw learningError("SIGNATURE", "signed revision/evidence differs");
      if (active.some(r => r.id === add.content.id)) throw learningError("SIGNATURE", "replacement omitted exact previous revision");
      for (let i = 0; i < add.evidence.length; i++) {
        if (hash(add.evidence[i]) !== add.content.evidence[i] || canonical(add.evidence[i].repo) !== canonical(s.repo)) throw learningError("SIGNATURE", "signed evidence hash/scope differs");
        evidence.push(hash(add.evidence[i]));
      }
      active.push({ id: add.content.id, digest: add.digest });
    }
    active = refs(active);
    if (hash(active) !== m.activeDigest || canonical(evidence.sort()) !== canonical(m.evidenceDigests)) throw learningError("SIGNATURE", "extra batch content or resulting bundle digest differs");
    return active;
  };
  const commit = async (s, a, manifest, signature) => {
    validateManifest(manifest, s.repo, a);
    const digest = hash(manifest), committed = s.transitions[String(manifest.sequence)];
    if (committed?.digest === digest && committed.signature === signature) { verifyState(s, a); delete s.prepared[digest]; return { digest, sequence: manifest.sequence, idempotent: true }; }
    verifyState(s, a);
    if (manifest.sequence !== s.sequence + 1 || manifest.parent !== s.parent) throw learningError("STALE", "stale/replayed approval; review a new preview against the current parent");
    signer.verify(canonical(manifest), signature, a);
    const active = applyManifest(s.active, manifest, s, a);
    // Only exact pending selected revisions may enter through this writer.
    for (const add of manifest.add) {
      const record = s.candidates[ruleKey(add.content.id, add.digest)];
      if (!record || record.status !== "pending" || canonical(record.content) !== canonical(add.content)) throw learningError("REVISION", "candidate changed or was disposed after preview");
      record.status = "active";
    }
    for (const ref of manifest.remove) s.candidates[refKey(ref)].status = "retired";
    s.transitions[String(manifest.sequence)] = { manifest, signature, digest, committedAt: at() };
    s.active = active; s.sequence = manifest.sequence; s.parent = digest;
    if (manifest.remove.length) revocationIntent(s, manifest.remove, "signed retirement/replacement");
    s.checkpoint = { authority: a.id, repo: s.repo, sequence: s.sequence, parent: digest, activeDigest: hash(active) };
    delete s.prepared[digest];
    return { digest, sequence: s.sequence, idempotent: false };
  };
  const service = {
    async resolveRepo(name, { remember = false, signal } = {}) {
      repositoryName(name); if (!gh) throw learningError("TRANSPORT", "GitHub transport unavailable");
      const r = await gh.learningRepository(name, { signal }), repo = repository({ host: r.host, id: r.id });
      signal?.throwIfAborted();
      resolvedRepositories.set(name.toLowerCase(), { repo, visibility: r.visibility });
      if (remember) store.remember(name, repo, visibilityFor(repo, name));
      return repo;
    },
    identityFor(name) {
      repositoryName(name);
      const remembered = store.identities()[name.toLowerCase()];
      if (!remembered) return null;
      // Older installations stored identity alone. New records retain last-resolved
      // classification outside that identity, without adding transport to a tick.
      const repo = repository(remembered.repo ?? remembered);
      if (remembered.repo && !resolvedRepositories.has(name.toLowerCase())) resolvedRepositories.set(name.toLowerCase(), remembered);
      return repo;
    },
    rememberRepo(name, repo) { repositoryName(name); repository(repo); store.remember(name, repo, visibilityFor(repo, name)); },
    mode(repo) { repository(repo); return store.load(repo).mode; },
    async doctor(repo = null, profile = null) {
      let openssh; try { openssh = signer.probe(); } catch (e) { openssh = { available: false, code: e.code, reason: e.message }; }
      let enrollment; try { enrollment = { enrolled: true, authority: authority().id }; } catch (e) { enrollment = { enrolled: false, reason: e.message }; }
      return { version: 1, platform: process.platform, openssh, enrollment, isolation: { ...await qualify({ repo, profile, root: store.root }), standalone: await probeIsolation() }, apply: "requires enrollment and qualified profile; off by default" };
    },
    async setup({ keyPath, confirm }) {
      // Both the explicit CLI command and a real terminal are required. There is no --yes path.
      signer.terminal(); if (store.readAuthority()) throw learningError("TRUST", "authority already enrolled; rotation/recovery requires separate continuity review");
      const isolation = await qualify({ repo: null, root: store.root });
      if (isolation?.qualified !== true) throw learningError("UNQUALIFIED", "setup refused before key creation: execution isolation is UNQUALIFIED; collection remains available");
      signer.probe();
      safePath(keyPath, { file: true });
      if (inside(keyPath, store.root) || inside(store.root, join(keyPath, ".."))) throw learningError("KEY", "approval key directory must be separate from the learning store");
      const validatePending = intent => {
        if (!intent) return;
        closed(intent, ["version", "id", "keyPath", "key", "signer"], "enrollment intent");
        if (intent.version !== 1 || typeof intent.id !== "string" || !/^[0-9a-f-]{36}$/.test(intent.id) || intent.keyPath !== keyPath || canonical(intent.signer) !== canonical(signer.pinned()) || canonical(intent.key) !== canonical(encryptedKey(keyPath))) throw learningError("TRUST", "pending enrollment key, path or signer changed");
      };
      let intent = store.readEnrollment(); validatePending(intent);
      const expected = canonical(intent);
      if (await confirm(safeDisplay({ action: intent ? "retry signed enrollment of the exact pending encrypted key" : "create dedicated encrypted Ed25519 key and signed enrollment", keyPath, signer: signer.pinned(), isolation, pending: intent })) !== true) throw learningError("CANCELLED", "setup cancelled; no enrollment created");
      if (!intent) {
        const key = signer.createKey(keyPath);
        intent = { version: 1, id: randomUUID(), keyPath, key, signer: signer.pinned() };
      }
      const persist = (expectedIntent, write) => {
        const release = store.lock();
        try {
          if (store.readAuthority() || canonical(store.readEnrollment()) !== expectedIntent) throw learningError("TRUST", "concurrent enrollment changed; refusing trust replacement");
          validatePending(intent); write();
        } finally { release(); }
      };
      persist(expected, () => store.writeEnrollment(intent));
      const frozen = canonical(intent);
      const a = { version: 1, id: intent.id, namespace: NAMESPACE, identity: SIGNER_ID, ...intent.key, signer: intent.signer, keyPath, enrollment: null, signature: null };
      a.enrollment = { version: 1, type: "enrollment", authority: a.id, repo: null, namespace: NAMESPACE, identity: SIGNER_ID, publicKey: a.publicKey, fingerprint: a.fingerprint, signer: a.signer, keyPath };
      a.signature = signer.sign(canonical(a.enrollment), a); signer.verify(canonical(a.enrollment), a.signature, a);
      persist(frozen, () => store.writeAuthority(a));
      pinnedAuthority = canonical(a); return { enrolled: true, authority: a.id, fingerprint: a.fingerprint };
    },
    async configure(repo, mode, profile = null) {
      if (!["off", "collect", "apply"].includes(mode)) throw learningError("INPUT", "mode is off, collect or apply");
      if (mode === "apply") { const a = authority(); await qualified(repo, profile); verifyState(store.load(repo), a); }
      const { result, intent } = await store.transaction(repo, s => { const before = s.mode; s.mode = mode; return { result: { before, mode }, intent: mode !== "apply" ? revocationIntent(s, null, "learning application disabled") : null }; });
      // The durable disabled mode is also the retry intent. Repeat controls even
      // if an earlier invocation committed it before a registry/control failure.
      if (intent) result.controls = await onRevocation(intent);
      return result;
    },
    async observe(repo, snapshot) {
      if (store.load(repo).mode === "off") return { skipped: "learning off" };
      return store.transaction(repo, s => { if (s.mode === "off") return { skipped: "learning off" }; return observe(s, snapshot); });
    },
    async collect(repo, name, { since, until, dryRun = false } = {}) {
      repository(repo); repositoryName(name);
      if (!gh) throw learningError("TRANSPORT", "GitHub transport unavailable");
      const started = clock.now(), request = { since: since ?? null, until: until ?? null };
      const freshRange = dateRange(since, until, started);
      const s = clone(store.load(repo)); expire(s);
      if (!dryRun && s.mode === "off") throw learningError("OFF", "configure collect explicitly before storing feedback");
      // A relative window belongs to its scan, not its retry's wall clock. Legacy
      // reports lack request fields; match their original window conservatively.
      const pending = until == null && s.scans.findLast(scan => !scan.complete && (scan.request
        ? canonical(scan.request) === canonical(request)
        : scan.since === dateRange(since, undefined, Date.parse(scan.until)).since));
      const range = pending ? { since: pending.since, until: pending.until } : freshRange;
      const id = hash({ repo, ...range });
      const old = s.scans.find(scan => scan.id === id && !scan.complete);
      const report = { id, request, ...range, dryRun, prs: 0, pages: 0, eligible: 0, added: 0, duplicates: 0, capped: false, complete: false, retryAt: null, continuation: old?.continuation ?? { page: 1, index: 0 }, coverage: "bounded PR update-order scan with identity-deduplicated listing overlap; concurrent upstream changes may leave coverage incomplete; only fully enumerated sources can establish deletion", caps: LEARNING_LIMITS, extraction: dryRun ? "not run (dry-run)" : "not run; separate explicit allowance required" };
      report.completedPrs = old?.completedPrs ?? [];
      report.listingPage = old?.listingPage ?? 1;
      report.sweepAdded = old?.sweepAdded ?? false;
      const completedPrs = new Set(report.completedPrs);
      const save = async () => {
        if (dryRun) return;
        await store.transaction(repo, current => {
          if (current.mode === "off") throw learningError("OFF", "learning was disabled during collection; no new feedback acknowledged");
          // Merge only observation revisions/dispositions; never overwrite approval/task state from this scan snapshot.
          for (const [key, o] of Object.entries(s.observations)) {
            if (!current.observations[key]) current.observations[key] = clone(o);
            else {
              const existing = current.observations[key];
              for (const flag of ["deleted", "retracted"]) if (o[flag]) existing[flag] = true;
              if (o.retractedAt && (!existing.retractedAt || o.retractedAt < existing.retractedAt)) existing.retractedAt = o.retractedAt;
            }
          }
          reconcileObservations(current.observations);
          expire(current);
          current.backoffUntil = report.retryAt ?? (current.backoffUntil > clock.now() ? current.backoffUntil : null);
          current.scans = [...current.scans.filter(x => x.id !== id).slice(-49), clone(report)];
          expire(current);
        });
      };
      const page = async (kind, pr, n) => {
        if (report.pages >= LEARNING_LIMITS.pages || clock.now() - started >= LEARNING_LIMITS.deadlineMs) { report.capped = true; return null; }
        report.pages++;
        let result;
        try { result = await boundedCall(signal => gh.learningPage(name, kind, { pr, page: n, signal }), { deadlineMs: Math.max(1, LEARNING_LIMITS.deadlineMs - (clock.now() - started)) }); }
        catch (e) { report.error = { code: e.code || "LEARNING_TRANSPORT", message: "bounded transport failed; unfinished PR retained for retry" }; return null; }
        if (result.rateLimited) { report.retryAt = result.retryAt; return null; }
        if (!Array.isArray(result.items) || result.items.length > 100 || typeof result.complete !== "boolean") throw learningError("TRANSPORT", "invalid bounded page response");
        return result;
      };
      const retryAt = Math.max(old?.retryAt || 0, s.backoffUntil || 0);
      if (retryAt > clock.now()) return { ...report, retryAt, extraction: "not run; repository transport backoff retained" };
      // Persist traversal across bounded invocations. A pass that discovers PRs
      // is followed by a deduplicated pass to catch movement ahead of its cursor.
      const firstPage = report.listingPage;
      outer: for (let n = firstPage; ; n++) {
        report.listingPage = n;
        const prs = await page("pulls", null, n); if (!prs) break;
        let reachedEnd = prs.complete;
        const items = n === firstPage && report.continuation.source ? [report.continuation.source.pr, ...prs.items] : prs.items;
        for (let i = 0; i < items.length; i++) {
          const pr = items[i];
          if (completedPrs.has(pr.number)) continue;
          const prior = report.continuation.source?.pr.number === pr.number ? report.continuation.source : null;
          report.continuation = { page: n, index: i, ...(prior ? { source: prior } : {}) };
          if (Date.parse(pr.updated_at) < Date.parse(range.since)) { reachedEnd = true; break; }
          if (completedPrs.size >= LEARNING_LIMITS.observations || report.prs >= LEARNING_LIMITS.prs || report.eligible >= LEARNING_LIMITS.findings) { report.capped = true; break outer; }
          const kinds = [["reviews", "reviews", "review"], ["inline", "inline", "inline"], ["comments", "comments", "command"]];
          const source = prior ?? { pr: { number: pr.number, updated_at: pr.updated_at, headRefOid: pr.headRefOid ?? pr.head?.sha ?? null }, kind: 0, page: 1, missing: null, reviews: [] };
          report.continuation.source = source;
          for (; source.kind < kinds.length;) {
            const [kind, target, eventKind] = kinds[source.kind];
            source.missing ??= Object.entries(s.observations).filter(([, o]) => o.content.pr === pr.number && o.content.kind === eventKind && !o.superseded && !o.deleted).map(([digest]) => digest);
            for (;;) {
              // Reserve a full transport page so no eligible tail can be lost at
              // the invocation cap. Only minimized observations and bounded IDs
              // survive a checkpoint; raw bodies are never buffered across pages.
              if (report.eligible + 200 > LEARNING_LIMITS.findings) { report.capped = true; break outer; }
              const findings = await page(kind, pr.number, source.page); if (!findings) break outer;
              const seen = new Set(findings.items.map(raw => String(raw.id)));
              source.missing = source.missing.filter(d => !seen.has(s.observations[d]?.content.id));
              if (kind === "reviews") {
                for (const raw of findings.items) if ((raw.state === "DISMISSED" || trust.isOwn(actor(raw.user)) || (raw.state === "COMMENTED" && trust.isReviewer(actor(raw.user)))) && !source.reviews.some(r => r.id === raw.id)) source.reviews.push({ id: raw.id, user: raw.user ? { login: raw.user.login ?? null, type: raw.user.type ?? null } : null, state: raw.state ?? null, submitted_at: raw.submitted_at ?? null, updated_at: raw.updated_at ?? null, commit_id: raw.commit_id ?? null, observedAt: at(), excerpt: minimized(raw.body || "") });
                if (source.reviews.length > LEARNING_LIMITS.observations) { report.capped = true; report.error = { code: "LEARNING_STORAGE", message: "review context identity cap reached; source coverage incomplete" }; break outer; }
              }
              const attached = new Set(findings.items.map(raw => raw.pull_request_review_id));
              const context = source.reviews.filter(r => r.state === "DISMISSED" || attached.has(r.id));
              const snapshot = { pr: { ...pr, repo: name },
                reviews: context.map(r => ({ ...r, body: r.excerpt.excerpt, submitted_at: r.state === "COMMENTED" ? r.submitted_at : null })),
                reviewExcerpts: Object.fromEntries(context.map(r => [r.id, r.excerpt])), [target]: findings.items };
              const r = observe(s, snapshot, range, LEARNING_LIMITS.findings - report.eligible);
              for (const key of ["eligible", "added", "duplicates"]) report[key] += r[key];
              if (r.capped) { report.capped = true; await save(); break outer; }
              source.page++;
              if (findings.complete) {
                // Absence is meaningful only after this entire source, including
                // all earlier checkpoints, has been enumerated.
                for (const digest of source.missing) { const o = s.observations[digest]; if (o) { o.deleted = true; o.retractedAt ??= at(); } }
                source.page = 1; source.missing = null;
                break;
              }
              await save();
            }
            // Save the next kind together with the last page's dispositions.
            source.kind++; if (source.kind >= 2) source.reviews = []; await save();
          }
          report.prs++; report.sweepAdded = true; completedPrs.add(pr.number); report.completedPrs = [...completedPrs];
          report.continuation = { page: n, index: i + 1 }; await save();
        }
        if (reachedEnd) {
          if (!report.sweepAdded) { report.complete = true; break; }
          report.sweepAdded = false; report.listingPage = 1; report.continuation = { page: 1, index: 0 };
          await save(); n = 0; continue;
        }
        report.listingPage = n + 1;
        report.continuation = { page: n + 1, index: 0 };
      }
      report.latencyMs = clock.now() - started;
      if (report.complete) report.continuation = null;
      await save(); return report;
    },
    async extract(repo, { allowanceUsd = 0 } = {}) {
      const boundary = await qualify({ repo, extraction: true, root: store.root });
      if (!boundary?.qualified || !extractor?.dataOnly || !extractor?.execute || !(allowanceUsd > 0) || allowanceUsd > 1) return { status: "unavailable", reason: "enforced data-only extraction profile and separate positive learning allowance required", inference: false };
      const reservation = await store.transaction(repo, s => {
        if (s.mode === "off") throw learningError("OFF", "learning off");
        expire(s);
        const reserved = new Set(s.extraction.flatMap(e => e.observationDigests || []));
        let remaining = Object.entries(s.observations).filter(([digest, o]) => !reserved.has(digest) && !o.expired && !o.deleted && !o.superseded && !o.retracted);
        let observations, inputDigest;
        for (;;) {
          if (!remaining.length) return { result: clone(s.extraction.at(-1) ?? { status: "empty", count: 0, inference: false }) };
          observations = remaining.slice(0, LEARNING_LIMITS.findings).map(([digest, o]) => ({ digest, ...o.content }));
          inputDigest = hash(observations);
          const prior = s.extraction.find(e => e.inputDigest === inputDigest);
          if (!prior) break;
          // Legacy exact-batch reservations acquire revision keys without paid work.
          prior.observationDigests ??= observations.map(o => o.digest);
          remaining = remaining.slice(observations.length);
        }
        const intent = { inputDigest, observationDigests: observations.map(o => o.digest), status: "intent", reservedUsd: allowanceUsd, costUsd: null, at: at(), count: 0 };
        s.extraction.push(intent);
        return { intent: clone(intent), observations };
      });
      if (reservation.result) return reservation.result;
      const { intent: reservedIntent, observations } = reservation, { inputDigest } = reservedIntent;
      const started = clock.now();
      let output, failure;
      try {
        output = await boundedCall(signal => extractor.execute({ observations, inputDigest, repo, maxCandidates: LEARNING_LIMITS.candidates, allowanceUsd, signal }), { deadlineMs: LEARNING_LIMITS.extractionMs });
      } catch (e) { failure = e; }
      // Never carry a cloned store across external execution. A failed merge
      // leaves the durable reservation intact, so retries cannot repurchase it.
      return store.transaction(repo, s => {
        const intent = s.extraction.find(e => e.inputDigest === inputDigest);
        if (!intent || canonical(intent) !== canonical(reservedIntent)) throw learningError("EXTRACTION", "extraction reservation changed before result merge");
        expire(s);
        intent.costUsd = Number.isFinite(output?.costUsd) && output.costUsd >= 0 ? output.costUsd : null;
        intent.tokens = Number.isSafeInteger(output?.tokens) && output.tokens >= 0 ? output.tokens : null;
        try {
          if (failure) throw failure;
          if (s.mode === "off") throw learningError("OFF", "learning disabled during extraction");
          const values = parseJson(output.json);
          if (!Array.isArray(values) || values.length > LEARNING_LIMITS.candidates) throw learningError("INPUT", "invalid extraction candidate count");
          const validated = values.map(v => candidate(v, repo));
          if (Object.keys(s.candidates).length + validated.length > 2000) throw learningError("STORAGE", "candidate revision cap reached before extraction proposals were applied");
          for (const v of validated) {
            if (v.content.provenance.inputDigest !== inputDigest) throw learningError("INPUT", "extraction provenance differs");
            if (v.content.evidence.some(d => !intent.observationDigests.includes(d))) throw learningError("EVIDENCE", "extraction references evidence outside the reserved batch");
          }
          for (const v of validated) if (v.content.evidence.some(d => {
            const o = s.observations[d];
            return !o || o.expired || o.deleted || o.superseded || o.retracted;
          })) throw learningError("EVIDENCE", "extraction evidence changed during execution");
          const proposed = validated.map(v => putCandidate(s, v.content));
          intent.status = "completed"; intent.count = proposed.filter(p => !p.duplicate).length;
        } catch (e) { intent.status = "unresolved"; intent.code = e.code || "LEARNING_EXTRACTION"; }
        intent.latencyMs = clock.now() - started; return clone(intent);
      });
    },
    list(repo, status = null) { if (status && !["pending", "rejected", "superseded", "approved", "active", "retired"].includes(status)) throw learningError("INPUT", "unknown candidate disposition"); const s = store.load(repo); return Object.values(s.candidates).filter(c => !status || c.status === status).sort((a, b) => ordered(ruleKey(a.content.id, a.digest), ruleKey(b.content.id, b.digest))).map(c => review(s, c)); },
    show(repo, id, revision = null) { const s = store.load(repo); return review(s, selected(s, id, revision)); },
    async revise(repo, id, value) { candidateId(id); if (value.id !== id) throw learningError("INPUT", "revision ID differs"); return store.transaction(repo, s => putCandidate(s, value)); },
    async reject(repo, id, revision, reason) { textField(reason, "rejection reason"); return store.transaction(repo, s => { const c = selected(s, id, revision); if (!["pending", "rejected"].includes(c.status)) throw learningError("REVISION", "rejection cannot alter active or retired content"); c.status = "rejected"; c.reason = reason; return review(s, c); }); },
    async approve(repo, selections, { action = "approve", reason = null, confirm } = {}) {
      if (!Array.isArray(selections) || !selections.length || selections.length > LEARNING_LIMITS.candidates) throw learningError("INPUT", "enumerate exact revisions for approval");
      if (!["approve", "retire"].includes(action)) throw learningError("INPUT", "invalid approval action");
      selections.forEach(r => { closed(r, ["id", "digest"], "selection"); ruleKey(r.id, r.digest); });
      if (new Set(selections.map(refKey)).size !== selections.length || new Set(selections.map(r => r.id)).size !== selections.length) throw learningError("INPUT", "duplicate selected revisions");
      signer.terminal(); const a = authority(); await qualified(repo);
      // Freeze the complete review under lock; prompts never hold the shared lock.
      let release = store.lock();
      let result, removals = [];
      try {
        let s = store.load(repo); verifyState(s, a);
        const add = [], remove = [];
        for (const ref of selections) {
          const c = selected(s, ref.id, ref.digest);
          if (action === "retire") { if (c.status !== "active") throw learningError("REVISION", "retirement requires exact active revision"); remove.push(ref); }
          else {
            if (c.status !== "pending") throw learningError("REVISION", "approval requires an exact pending revision");
            const old = s.active.find(r => r.id === ref.id); if (old) remove.push(old);
            if (c.content.evidence.some(d => expired(s.observations[d]))) throw learningError("EVIDENCE", "raw evidence expired; collect and review a new evidence revision before approval");
            add.push({ content: clone(c.content), digest: c.digest, evidence: c.content.evidence.map(d => clone(s.observations[d].content)) });
          }
        }
        if (reason !== null) textField(reason, "approval reason");
        const manifest = { version: 1, type: "transition", namespace: NAMESPACE, authority: a.id, repo, fingerprint: a.fingerprint, action: action === "retire" ? "retire" : remove.length ? "replace" : "approve", sequence: s.sequence + 1, parent: s.parent, add, remove, activeDigest: hash(refs([...s.active.filter(r => !remove.some(x => refKey(x) === refKey(r))), ...add.map(r => ({ id: r.content.id, digest: r.digest }))])), evidenceDigests: add.flatMap(r => r.content.evidence).sort(), reason, at: at() };
        validateManifest(manifest, repo, a);
        const bytes = canonical(manifest), digest = hash(bytes);
        const previewFor = state => safeDisplay({ manifest, digest, selected: selections.map(r => review(state, selected(state, r.id, r.digest))), removed: remove.map(r => review(state, selected(state, r.id, r.digest))) });
        const preview = previewFor(s), mode = s.mode;
        const recheck = () => {
          if (canonical(authority()) !== canonical(a)) throw learningError("TRUST", "authority changed while signing");
          s = store.load(repo); verifyState(s, a);
          if (s.mode !== mode || s.sequence + 1 !== manifest.sequence || s.parent !== manifest.parent || previewFor(s) !== preview) throw learningError("REPLAY", "approval state changed; review a new preview");
        };
        release(); release = null;
        if (typeof confirm !== "function" || await confirm(preview) !== true) throw learningError("CANCELLED", "approval cancelled; active bundle unchanged");
        release = store.lock(); recheck();
        s.prepared[digest] = { manifest, signature: null, preparedAt: at() }; store.saveLocked(repo, s);
        release(); release = null;
        const signature = signer.sign(bytes, a);
        release = store.lock(); recheck();
        if (!s.prepared[digest] || canonical(s.prepared[digest].manifest) !== bytes) throw learningError("REPLAY", "approval preparation changed while signing");
        s.prepared[digest].signature = signature; store.saveLocked(repo, s);
        // Verify against the same immutable objects used for the preview, then write
        // history, checkpoint and active pointer together in one fsynced atomic rename.
        if (canonical(authority()) !== canonical(a)) throw learningError("TRUST", "authority changed while signing");
        result = await commit(s, a, manifest, signature); store.saveLocked(repo, s); removals = remove;
      } finally { release?.(); }
      if (removals.length) result.controls = await onRevocation(revocationIntent(store.load(repo), removals, "signed retirement/replacement"));
      return result;
    },
    async recover(repo) {
      const a = authority();
      const committed = await store.transaction(repo, s => {
        verifyState(s, a);
        const removed = [...new Map(Object.values(s.transitions).flatMap(t => t.manifest.remove).map(r => [refKey(r), r])).values()].filter(r => !s.active.some(active => refKey(active) === refKey(r)));
        return { pending: Object.values(s.prepared).some(t => t.signature), intent: removed.length ? revocationIntent(s, removed, "signed retirement/replacement") : null };
      });
      const controls = committed.intent ? [{ controls: await onRevocation(committed.intent) }] : [];
      if (!committed.pending) return controls;
      await qualified(repo);
      const { results, intent } = await store.transaction(repo, async s => {
        verifyState(s, a); const results = [];
        for (const [key, t] of Object.entries(s.prepared).sort((a, b) => a[1].manifest.sequence - b[1].manifest.sequence || ordered(a[0], b[0]))) if (t.signature) {
          validateManifest(t.manifest, repo, a);
          const digest = hash(t.manifest), committed = s.transitions[String(t.manifest.sequence)];
          if (key !== digest) throw learningError("SIGNATURE", "prepared content digest differs");
          signer.verify(canonical(t.manifest), t.signature, a);
          if (t.manifest.sequence <= s.sequence && (committed?.digest !== digest || committed.signature !== t.signature)) {
            // A newer reviewed transition already consumed this sequence. Keep
            // the verified obsolete bytes for audit, never rebase or activate them.
            if (Object.keys(s.preparationHistory).length >= 1000) throw learningError("STORAGE", "obsolete preparation history reached its 1,000 record cap");
            const disposition = { digest, sequence: t.manifest.sequence, disposition: "obsolete", supersededBy: committed.digest };
            s.preparationHistory[digest] = { ...t, ...disposition, retiredAt: at() };
            delete s.prepared[key]; results.push(disposition);
          } else results.push(await commit(s, a, t.manifest, t.signature));
        }
        // Signed history survives failure after commit, including a lost reply
        // from revocation controls. Reconcile outside the learning-store lock.
        const removed = [...new Map(Object.values(s.transitions).flatMap(t => t.manifest.remove).map(r => [refKey(r), r])).values()].filter(r => !s.active.some(active => refKey(active) === refKey(r)));
        return { results, intent: removed.length ? revocationIntent(s, removed, "signed retirement/replacement") : null };
      });
      if (intent) results.push({ controls: await onRevocation(intent) });
      return results;
    },
    async context(repo, { operationId, profile, paths = [], inputDigest, previous = null, taskId = null } = {}) {
      repository(repo); textField(operationId, "dispatch identity", 256); digestField(inputDigest); paths.forEach(literalPath);
      if (taskId !== null) textField(taskId, "task identity", 256);
      const mode = store.load(repo).mode;
      if (mode !== "apply") return { section: "", delivered: false, freshSessionRequired: !!previous?.rules?.length, mode };
      const a = authority(); await qualified(repo, profile);
      return store.transaction(repo, s => {
        if (s.mode !== "apply") return { section: "", delivered: false, freshSessionRequired: !!previous?.rules?.length, mode: s.mode };
        const { active } = verifyState(s, a), key = hash({ operationId, profile, inputDigest });
        const existing = s.deliveries[key];
        if (existing) {
          if (existing.revoked || (existing.taskId ?? null) !== taskId) throw learningError("STALE_CONTEXT", "revoked or differently owned learning intent; prepare a new operation identity");
          if (!existing.delivered && existing.bundleDigest !== s.parent) throw learningError("STALE_CONTEXT", "undelivered learning intent belongs to an older bundle; reconcile the dispatch and prepare a new operation identity");
          return dispatchSnapshot(existing);
        }
        // Never evict exact retry identities or pending revocation targets. Reserve
        // capacity before accepting a new operation, leaving control writes usable.
        if (Object.keys(s.deliveries).length >= LEARNING_LIMITS.deliveries) throw learningError("STORAGE", "delivery audit capacity reached; existing retries and disable/recovery remain available");
        const selectedRules = [], omitted = []; let section = "Reviewed repository advice (advisory only; task gates, Verify commands, permissions and budgets remain authoritative):\n";
        for (const ref of active) {
          // Take one verified copy from signed content; never reread candidate files after validation.
          const t = Object.values(s.transitions).find(t => t.manifest.add.some(a => a.digest === ref.digest && a.content.id === ref.id));
          const c = clone(t.manifest.add.find(a => a.digest === ref.digest && a.content.id === ref.id).content);
          const applies = c.paths.length === 0 || paths.some(p => c.paths.some(scope => p === scope || p.startsWith(scope + "/")));
          const line = `${safeDisplay({ id: ref.id, revision: ref.digest, applicability: c.applicability, guidance: c.guidance })}\n`;
          const reason = !applies ? paths.length ? "unmatched literal scope" : "task paths unknown" : selectedRules.length >= LEARNING_LIMITS.lessons || Buffer.byteLength(section + line) > LEARNING_LIMITS.contextBytes ? "context budget" : null;
          if (reason) omitted.push({ ...ref, reason }); else { selectedRules.push({ ...ref, reason: c.paths.length ? "literal project scope" : "repository-wide" }); section += line; }
        }
        // Selection uses every accepted path; persistent audit detail is sampled
        // by encoded size while its digest commits to the complete input list.
        const auditPaths = [];
        for (const path of paths) {
          if (Buffer.byteLength(canonical([...auditPaths, path])) > LEARNING_LIMITS.pathAuditBytes) break;
          auditPaths.push(path);
        }
        const pathAudit = { digest: hash(paths), count: paths.length, omitted: paths.length - auditPaths.length };
        const delivery = { version: 1, key, taskId, operationId, profile, paths: auditPaths, pathAudit, inputDigest, bundleSequence: s.sequence, bundleDigest: s.parent, activeDigest: hash(active), rules: selectedRules, omitted, section: selectedRules.length ? section : "", contextDigest: hash(selectedRules.length ? section : ""), at: at(), freshSessionRequired: !!previous?.rules?.some(r => !selectedRules.some(x => refKey(x) === refKey(r))), delivered: false, runId: null };
        if (Buffer.byteLength(canonical(delivery)) > LEARNING_LIMITS.deliveryBytes) throw learningError("STORAGE", "delivery detail byte limit exceeded");
        s.deliveries[key] = delivery; return clone(delivery);
      });
    },
    async dispatch(repo, { key, taskId, contextDigest }, launch) {
      digestField(key); digestField(contextDigest); textField(taskId, "task identity", 256);
      await qualified(repo, store.load(repo).deliveries[key]?.profile);
      const release = store.lock();
      try {
        const s = store.load(repo), d = s.deliveries[key];
        if (s.mode !== "apply" || !d || d.revoked || d.taskId !== taskId || d.contextDigest !== contextDigest) throw learningError("STALE_CONTEXT", "learning dispatch was revoked or changed; nothing launched");
        const { active } = verifyState(s, authority());
        if (d.rules.some(r => !active.some(x => refKey(x) === refKey(r)))) throw learningError("STALE_CONTEXT", "learning dispatch includes a retired revision; nothing launched");
        // Serialize launch acceptance with retirement/disable. The prepared task
        // identity remains durable if acceptance or the subsequent registry save
        // is lost; controls can find it without an accepted registry snapshot.
        // No persistence/await follows acceptance here, so an audit failure cannot
        // hide a successfully launched run from the caller.
        return await launch();
      } finally { release(); }
    },
    async delivered(repo, key, runId) { digestField(key); textField(runId, "run ID", 256); return store.transaction(repo, s => {
      const d = s.deliveries[key];
      if (!d) throw learningError("DISPATCH", "unknown learning input intent");
      if (d.runId && d.runId !== runId) throw learningError("DISPATCH", "learning intent already belongs to another attempt");
      // Also reconcile intents written before revocation markers were available.
      if (d.rules.length && (s.mode !== "apply" || d.rules.some(r => !s.active.some(x => refKey(x) === refKey(r))))) d.revoked ??= { reason: s.mode !== "apply" ? "learning application disabled" : "signed retirement/replacement", at: at() };
      d.delivered = true; d.runId = runId; return clone(d);
    }); },
    explain(repo, operationId) { return Object.values(store.load(repo).deliveries).filter(d => d.operationId === operationId || d.runId === operationId); },
    report(repo) {
      const s = clone(store.load(repo)), counts = {}; expire(s);
      for (const c of Object.values(s.candidates)) counts[c.status] = (counts[c.status] || 0) + 1;
      return { version: 1, repo, mode: s.mode, observations: Object.keys(s.observations).length, dispositions: counts, preparations: { pending: Object.keys(s.prepared).length, obsolete: Object.keys(s.preparationHistory).length }, scans: s.scans, extraction: s.extraction, deliveries: Object.values(s.deliveries), deliveryCapacity: { used: Object.keys(s.deliveries).length, limit: LEARNING_LIMITS.deliveries, detailBytes: LEARNING_LIMITS.deliveryBytes, policy: "retain exact audit and retry identities; refuse new intents at capacity" }, eligibleRunDenominator: Object.values(s.deliveries).filter(d => d.delivered).length, denominatorDefinition: "accepted attempts in apply mode processed by this service", confirmedRecurrence: { count: null, evidence: [], status: "unmeasured" }, suggestedRecurrence: Object.values(s.candidates).filter(c => c.content.evidence.length > 1).map(c => ({ id: c.content.id, digest: c.digest, evidenceCount: c.content.evidence.length })), costs: { knownUsd: !s.extraction.length || s.extraction.some(e => e.costUsd === null) ? null : s.extraction.reduce((n, e) => n + e.costUsd, 0), measured: s.extraction.length > 0 }, effectiveness: "unmeasured; unmatched feedback is not zero recurrence; deliveries do not prove compliance", qualification: "UNQUALIFIED until an enforced execution profile is demonstrated" };
    },
    async prune(repo) { return store.transaction(repo, s => ({ expired: expire(s), retained: "minimized signed evidence, dispositions and audit digests" })); },
    display: safeDisplay,
    async reviseFromFile(repo, id, path) { path = resolve(path); safePath(path, { file: true }); if (statSync(path).size > 256 * 1024) throw learningError("INPUT", "candidate file byte limit"); return service.revise(repo, id, parseJson(readFileSync(path))); },
  };
  return service;
}
