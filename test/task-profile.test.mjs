import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deliveryProfile, validateDeliveryProfile, assertProfileBound, savedProfile, typedEraTask, stableProfile, deliveryScreen, maskLiterals, statements, validateDeliveryTag, profileCovers, unaccountedTerms, deliveryQuestion, deliveryQuestionId, deliveryProfileFromPrd, deliveryScreens, profileView, DELIVERY_CAPABILITIES, PROFILE_VERSION, COMPLETION_CONDITIONS } from "../lib/task_profile.mjs";
import { intakeModelProblems, validateIntakeModelConfig, intakeModelRoute, intakeModelRouteSummary, pinnedModelRoute, savedModelRoute, MODEL_ROUTE_CEILINGS } from "../lib/task_model_config.mjs";
import { COMPLETION_SCHEMA } from "../lib/task_completion.mjs";
import { MAX_ANSWER_ID_CHARACTERS } from "../lib/task_limits.mjs";
import { prepareModelTurn, isModelRouteReceipt, estimateTokens, estimateUsd } from "../lib/task_model_route.mjs";
import { repositorySnapshot, REPOSITORY_CONTEXT_LIMITS } from "../lib/task_repository_context.mjs";
import { fragments, parseDraft, renderDraft, draftPrompt, FRAGMENT_VERSION, fragmentsForTask, MAX_INPUT_BYTES } from "../lib/task_contract.mjs";
import { check, parsePrd, contractOf } from "../lib/prd.mjs";
import { validate as validateConfig, merge as mergeConfig } from "../lib/config.mjs";
import { makeGit } from "../lib/git.mjs";
import { profileRequests } from "../templates/plugin/task-profile-requests.mjs";
import { draftFor } from "./fixtures/task-intake.mjs";
import { currentContract, savedContract, contractDrift } from "../scripts/task-intake-contract.mjs";
import { tempHome, CONFIG } from "./helpers.mjs";

const PROFILE = { version: 1, action: "pull_request", target: { kind: "github-pull-request", repository: "acme/widget", base: "main" }, completion: { condition: "delivery_ready" } };
const ROUTE = { adapter: "openai-chat", model: "fixture-model", endpoint: "https://api.example-provider.com/v1/chat/completions", credential_env: "FIXTURE_MODEL_KEY",
  budget: { max_calls: 3, max_input_tokens: 50000, max_output_tokens: 6000, allowance_usd: 0.1, input_usd_per_million: 1, output_usd_per_million: 10 }, timeout_ms: 5000 };
const sha = value => createHash("sha256").update(value).digest("hex");
// Tasks pin their route selection at creation; later turns run against it.
const pinned = config => pinnedModelRoute(validateIntakeModelConfig(config));
const withRoute = (task, config) => Object.assign(task, { modelRoute: pinned(config) });

function taskFor(text, overrides = {}) {
  const requirements = fragments(text);
  return { id: "task-" + "0".repeat(24), fragmentVersion: FRAGMENT_VERSION, original: text, requirements, answers: {}, questionHistory: {}, questionMappings: {}, context: [{ path: "package.json", text: JSON.stringify({ scripts: { test: "node --test" }, packageManager: "npm@10.0.0" }), hash: "x" }], modelRoute: pinned(ROUTE),
    explicitVerifyCommands: [], attempts: [], allowance: { budgetUsd: 5, runtimeMs: 60_000 }, repo: "acme/widget", base: "main", harness: "gemini", route: "model", deliveryProfile: PROFILE, completion: { version: 1, target: "delivery_ready" }, ...overrides };
}
const memoryStore = () => { const saves = []; return { saves, save: task => saves.push(structuredClone(task)) }; };
const response = (body, { status = 200, headers = {} } = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null }, text: async () => typeof body === "string" ? body : JSON.stringify(body), body: { cancel: async () => {} } });

test("typed profiles are built only from owner input and bound to the resolved repository and base", () => {
  const profile = deliveryProfile(undefined, { repository: "Acme/Widget", base: "main" });
  assert.deepEqual(profile, PROFILE);
  assert.deepEqual(deliveryProfile({ action: "pull_request", completion: "integrated" }, { repository: "acme/widget", base: "main" }).completion, { condition: "integrated" });
  assert.deepEqual(deliveryProfile(undefined, { completion: "integrated", repository: "acme/widget", base: "main" }).completion, { condition: "integrated" });
  for (const action of ["merge", "deploy"]) assert.throws(() => deliveryProfile({ action }, { repository: "acme/widget", base: "main" }), e => e.code === "TASK_INPUT" && /explicit supported .* control and authorization/.test(e.message));
  assert.throws(() => deliveryProfile({ action: "publish" }, { repository: "acme/widget", base: "main" }), { code: "TASK_INPUT" });
  assert.throws(() => deliveryProfile({ action: "pull_request", completion: "integrated" }, { completion: "delivery_ready", repository: "acme/widget", base: "main" }), { code: "TASK_INPUT" });
  assert.throws(() => deliveryProfile({ action: "pull_request", merge: true }, { repository: "acme/widget", base: "main" }), { code: "TASK_INPUT" });
  assert.throws(() => deliveryProfile("pull_request", { repository: "acme/widget", base: "main" }), { code: "TASK_INPUT" });
  assert.equal(DELIVERY_CAPABILITIES.actions.filter(a => a.supported).map(a => a.id).join(), "pull_request");
  assert.deepEqual(DELIVERY_CAPABILITIES.expandableBy, []);
  assert.equal(stableProfile(PROFILE), JSON.stringify(PROFILE));
});

test("saved profiles validate strictly and unsupported versions fail closed with a recovery path", () => {
  assert.deepEqual(validateDeliveryProfile(PROFILE), PROFILE);
  for (const broken of [{ ...PROFILE, version: 2 }, { ...PROFILE, action: "merge" }, { ...PROFILE, target: { ...PROFILE.target, kind: "gitlab" } }, { ...PROFILE, completion: { condition: "shipped" } }, { ...PROFILE, extra: true }, null, "pull_request"]) {
    assert.throws(() => validateDeliveryProfile(broken), e => e.code === "TASK_PROFILE_UNSUPPORTED" && /prepare a new task/.test(e.message));
  }
  // A profile is bound to the task it was reviewed on: another repository, base or completion target fails closed.
  const bound = { repo: "acme/widget", base: "main", completion: { version: 1, target: "delivery_ready" }, deliveryProfile: PROFILE };
  assert.equal(profileView(bound).supported, true); assert.deepEqual(assertProfileBound(PROFILE, bound), PROFILE);
  for (const foreign of [{ ...bound, repo: "acme/other" }, { ...bound, base: "develop" }, { ...bound, completion: { version: 1, target: "integrated" } }]) {
    assert.throws(() => assertProfileBound(PROFILE, foreign), e => e.code === "TASK_PROFILE_UNSUPPORTED" && /not bound to this task/.test(e.message));
    const unbound = profileView(foreign);
    assert.equal(unbound.supported, false); assert.match(unbound.error.message, /not bound to this task/);
  }
  const view = profileView({ ...bound, deliveryProfile: { ...PROFILE, version: 2 } });
  assert.equal(view.supported, false); assert.equal(view.error.code, "TASK_PROFILE_UNSUPPORTED"); assert.match(view.error.message, /does not pin the namespace/);
  assert.deepEqual(profileView({ completion: { version: 1, target: "integrated" } }), { legacy: true, version: null, action: null, target: null, completion: { condition: "integrated" }, supported: true, source: "completion-target", label: "Historical task; its original interpretation is retained" });
  assert.equal(profileView({ ownerDelivery: { version: 5 } }).source, "owner-delivery-contract");
  assert.equal(profileView(bound).mergeAuthorized, false);
});

test("the delivery screen is deterministic over the fixture corpus and masks literal examples", () => {
  for (const fixture of profileRequests) {
    const first = deliveryScreen(fixture.text, PROFILE.target), second = deliveryScreen(fixture.text, PROFILE.target);
    assert.deepEqual(first, second, fixture.text);
    assert.equal(first.tier, fixture.screen.tier, `${fixture.kind}: ${fixture.text} → ${JSON.stringify(first)}`);
    for (const term of fixture.screen.terms || []) assert.ok(first.terms.includes(term), `${fixture.text} should mention ${term}`);
  }
  assert.equal(maskLiterals('Keep "do not push" and `merge main` and “deploy” visible?'), 'Keep ' + " ".repeat(13) + ' and ' + " ".repeat(12) + ' and ' + " ".repeat(8) + ' visible?');
  assert.equal(deliveryScreen('"Unmatched quote hides nothing: merge it').tier, "question");
  // Emphasis directly after a control phrase is the control's target, not an example, and an introductory colon does not end the statement.
  for (const text of ['Do not "open a pull request" for this.', "Do not `open a pull request` for this.", "Do not: open a pull request.", "Do not -- open a pull request.", 'Never “merge the PR”.']) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.controlled.includes(/merge/.test(text) ? "merge" : "pull_request"), `${text} → ${JSON.stringify(screen)}`);
  }
  assert.equal(maskLiterals('Do not "open a pull request".'), 'Do not "open a pull request".');
  assert.equal(maskLiterals('Please do not ever "open a pull request".'), 'Please do not ever "open a pull request".');
  assert.ok(deliveryScreen('Please do not ever "open a pull request" for this.').controlled.includes("pull_request"));
  assert.equal(maskLiterals('Add a test; keep the "do not merge" label text.'), 'Add a test; keep the ' + " ".repeat(14) + ' label text.', "a span in an uncontrolled statement is still an example");
  // A control after the span governs it too, and a control inside another example never counts.
  assert.equal(maskLiterals('"Open a pull request" is forbidden.'), '"Open a pull request" is forbidden.');
  assert.ok(deliveryScreen('"Open a pull request" is forbidden for this change.').controlled.includes("pull_request"));
  assert.equal(deliveryScreen('Opening a `pull request` is not allowed; label it "merge later".').controlled.includes("pull_request"), true);
  assert.equal(maskLiterals('Show "do not merge" and "open a PR" labels.'), "Show " + " ".repeat(14) + " and " + " ".repeat(11) + " labels.");
  for (const text of ["Opening a pull request is out of scope.", "A merge is outside the scope of this task.", "Exclude deployment from this work.", "Pull requests are disallowed.", "Opening a pull request isn't allowed.", "Merging is not permitted.", "Deployment is off limits.", "I will open the pull request myself afterwards.", "Leave the pull request to me.", "Implement export. Let me open the pull request afterwards.", "Let us merge it ourselves.", "Please let me review the PR first.", "We'll create the PR ourselves.", "The merge is mine to do.", "Implement the change, except opening a pull request.", "Do everything except create a PR.", "Do the implementation, other than opening a PR.", "Everything apart from the PR is yours.", "Implement it but not the pull request."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.controlled.length, `${text} → ${JSON.stringify(screen)}`);
  }
  assert.deepEqual(unaccountedTerms(deliveryScreen("Opening a pull request is out of scope."), { action: "pull_request" }), ["pull_request"]);
  for (const text of ["Leave the changes uncommitted.", "Leave all changes unpublished.", "Keep the branch unpushed and unmerged.", "Leave the changes unstaged.", "Keep all edits in the working tree.", "Keep the result in my checkout only.", "Don't stage anything."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.terms.includes("local"), text);
  }
  assert.equal(maskLiterals('Keep the literal "open a pull request" text.'), "Keep the literal " + " ".repeat(21) + " text.");
  assert.deepEqual(statements("Do not: open a PR. Then: run tests; stop"), ["Do not: open a PR", " Then", " run tests", " stop"]);
  assert.deepEqual(deliveryScreen(""), { terms: [], controlled: [], affirmed: [], escalated: [], controls: [], tier: "none" });
  assert.deepEqual(deliveryScreen(42), { terms: [], controlled: [], affirmed: [], escalated: [], controls: [], tier: "none" });
  // Affirmative controls state a requirement: a requested-action tag speaks for the term, a prohibition does not, and a negated form stays a prohibition.
  for (const text of ["Opening a pull request is required.", "A pull request is mandatory.", "A PR remains required for every change."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.deepEqual(screen.affirmed, ["pull_request"], text); assert.deepEqual(screen.controlled, [], text);
    assert.deepEqual(unaccountedTerms(screen, { action: "pull_request" }), [], text);
    assert.deepEqual(unaccountedTerms(screen, { action: "restrict", prohibits: ["pull_request"] }), ["pull_request"], text);
  }
  const negated = deliveryScreen("A pull request is not required.");
  assert.deepEqual(negated.controlled, ["pull_request"]); assert.deepEqual(negated.affirmed, []);
  assert.deepEqual(unaccountedTerms(negated, { action: "pull_request" }), ["pull_request"]);
  assert.deepEqual(unaccountedTerms(deliveryScreen("Do not merge; a pull request is required."), { action: "pull_request", prohibits: ["merge"] }), []);
  // A bare publish verb anywhere escalates; publish as a noun modifier or a feature infinitive stays an assumption.
  for (const text of ["Publish this package to npm.", "Implement export. Then publish it to the registry.", "Please publish the docs site.", "Implement the feature and publish the package to npm.", "After implementation, publish the package.", "Could you publish the package?"]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.deepEqual(screen.escalated, ["publish"], text);
    assert.deepEqual(unaccountedTerms(screen, { action: "pull_request" }), ["publish"], text);
  }
  for (const text of ["Add a publish button.", "Add a command to publish docs.", "The button publishes the report.", "Add a list of published articles.", "Show the publish status on the page."]) assert.equal(deliveryScreen(text).tier, "assumption", text);
  // Package submission, store uploads and registry tool commands are publication; a feature infinitive or descriptive form is not.
  for (const text of ["Submit the package to npm.", "Implement export. Then upload the build to the App Store.", "Push the image to Docker Hub after tests pass.", "Run gem push once the gem builds.", "Post the release to PyPI.", "Run twine upload when done."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("publish"), `${text} → ${JSON.stringify(screen)}`);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("publish"), text);
    assert.equal(unaccountedTerms(screen, { action: "publish" }).includes("publish"), false, text);
  }
  for (const text of ["Add a form to submit packages to the registry.", "Add a button that uploads files to the marketplace.", "Submit the form to the server.", "Upload avatars to S3."]) assert.equal(deliveryScreen(text).escalated.includes("publish"), false, text);
  // Approval escalates when the statement waits on someone's decision, not when it names an approval feature.
  for (const text of ["Wait for my approval before opening a PR.", "Get sign-off before opening a PR.", "Open a PR once approved.", "Implement export; it needs approval before merging.", "Approve the plan first."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("approval"), `${text} → ${JSON.stringify(screen)}`);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("approval"), text);
    assert.equal(unaccountedTerms(screen, { action: "wait_for_approval" }).includes("approval"), false, text);
  }
  for (const text of ["Add an approval workflow to the admin UI.", "Show the approval status column.", "List approved expenses on the dashboard.", "Add a button to approve comments.", "Send approval notifications by email."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "assumption", text); assert.deepEqual(screen.terms, ["approval"], text); assert.deepEqual(screen.escalated, [], text);
  }
  // Shipping, rollout and go-live wording, and a production destination, read as deployment.
  for (const text of ["Ship this change to production.", "Roll this out to production.", "Implement export, then roll it out.", "Go live with the new pricing page.", "Promote the build to staging.", "Ship it."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.terms.includes("deploy"), `${text} → ${JSON.stringify(screen)}`);
  }
  for (const text of ["Add a shipping address field.", "Show the shipment tracker.", "Fix the crash reported in production logs."]) assert.equal(deliveryScreen(text).terms.includes("deploy"), false, text);
  // A control word elsewhere on the line does not turn an ordinary feature clause into a question.
  const unrelated = deliveryScreen("Add a PR status badge. Authentication is required.");
  assert.equal(unrelated.tier, "assumption"); assert.deepEqual(unrelated.controlled, []); assert.ok(unrelated.controls.length, "the control word is still recorded for the review");
});

test("conversational owner confirmations remain approval gates", () => {
  for (const text of ["Check with me before opening a pull request.", "Ask me before opening a PR.", "Get my go-ahead before opening the pull request.", "Confirm with us before opening a PR.", "Consult me before opening the PR.", "Get my confirmation before opening a PR.", "Open a PR once you have my go ahead.", 'Get my `go-ahead` before opening a PR.', "Check with ‘me’ before opening a PR."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("approval"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("approval"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Go ahead and open a PR for review.", "Add a confirmation dialog.", "Add a button to ask me before opening a PR.", 'Show "Check with me before opening a PR" as a label.', "Add a go-ahead button."]) assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
});

test("prose reviews and comments on existing PRs cannot use creation authority", () => {
  for (const text of ["Review pull request #123 and leave feedback.", "Comment on pull request #123 with the test results.", "Review PR#123.", "Leave feedback on the PR.", "Post a comment to pull request #123.", "Reply to the pull request.", "The PR #123 must be reviewed.", 'Review `pull request #123`.', "Comment on ‘pull request #123’ with results."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("pull_request_lifecycle"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("pull_request_lifecycle"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Open one PR for review.", "Add a button to review PRs.", "Add support for commenting on PRs.", "Show reviewed PRs in the dashboard.", 'Render "Comment on pull request #123" as an example.']) assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
});

test("imperative infrastructure mutations retain deployment intent", () => {
  for (const text of ["Run terraform apply after implementing it.", "Execute helm upgrade api ./chart.", 'Run `terraform apply` after tests.', 'Execute "helm upgrade api ./chart".', "Run terraform -chdir=infra apply.", "Run terraform destroy.", "Run tofu apply.", "Run helm install api ./chart.", "Run helm rollback api 1.", "Run helm uninstall api.", "Run helm -n prod upgrade api ./chart.", "Run helm --debug --debug --debug --debug --debug upgrade api ./chart.", "Run kubectl apply -f app.yaml.", "Run kubectl --context prod delete deployment api.", "Run kubectl rollout restart deployment/api.", "Run kubectl scale deployment/api --replicas=3.", "Run helm upgrade api ./chart --dry-run=none.", "Run helm --dry-run=none upgrade api ./chart.", "Run helm upgrade api ./chart --dry-run=client --dry-run=none.", "Run helm upgrade api ./chart --dry-run=client and helm upgrade api ./chart.", "Run helm upgrade api ./chart and helm upgrade api ./chart --dry-run=client.", 'Run `helm upgrade api ./chart --set note=" --dry-run=client"`.', "Run helm upgrade api ./chart --kubeconfig --dry-run=client."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("deploy"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("deploy"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Run terraform plan.", "Run helm template api ./chart.", "Run helm lint ./chart.", "Run kubectl get pods.", "Run helm upgrade api ./chart --dry-run.", "Run helm --dry-run=client upgrade api ./chart.", "Run helm upgrade api ./chart --dry-run=client --dry-run=server.", "Run kubectl apply -f app.yaml --dry-run=client.", 'Document how to run `terraform apply`.', "Add a command to run terraform apply.", "Add support for running helm upgrade.", 'Render "helm upgrade" as a label.']) assert.equal(deliveryScreen(text, PROFILE.target).escalated.includes("deploy"), false, text);
});

test("object-storage transfers clarify outbound writes while preserving downloads", () => {
  for (const text of ["Run aws s3 cp build.zip s3://bucket/a --unknown \"--help\".", "Upload avatars to S3.", "Run aws s3 cp build.zip s3://bucket/out.zip.", "Upload build.zip to S3.", "Run aws s3 sync dist/ s3://bucket/site/ --delete.", "Run gsutil cp build.zip gs://bucket/out.zip.", "Run gsutil -m rsync -r dist/ gs://bucket/site/.", "Run `aws s3 cp \"build artifact.zip\" \"s3://bucket/out.zip\"`.", "Run aws --profile prod s3 cp --region us-east-1 build.zip s3://bucket/out.zip.", "Run aws s3 cp s3://source/a s3://target/a.", "Run aws s3 mv s3://bucket/a ./a.", "Run gsutil mv gs://bucket/a ./a.", "Run aws s3 cp build.zip \"$DEST\".", "Run aws s3 cp build.zip s3://bucket/a --dryrun=false.", "Run aws s3 cp build.zip s3://bucket/a --metadata note=--dryrun.", "Run aws s3 cp s3://bucket/a ./a and aws s3 cp ./a s3://bucket/b.", "Upload the build to `S3`.", "Sync the build to Google Cloud Storage.", "Run gsutil cp -n build.zip gs://bucket/a.", "Run aws s3 cp build.zip s3://bucket/a --metadata \"note=--help\".", "Run aws s3 cp build.zip s3://bucket/a and aws s3 cp s3://bucket/a ./a --dryrun."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("storage_mutation"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("storage_mutation"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Run aws s3 cp s3://bucket/a ./a.", "Run aws s3 sync s3://bucket/site/ ./site/ --delete.", "Run gsutil cp gs://bucket/a ./a.", "Run gsutil -m rsync -r gs://bucket/site/ ./site/.", "Run aws s3 cp s3://bucket/a -.", "Run aws s3 cp build.zip s3://bucket/a --dryrun.", "Run gsutil rsync -n -r dist/ gs://bucket/site/.", "Run aws s3 ls s3://bucket/.", "Run gsutil ls gs://bucket/.", "Run aws s3 cp --help.", "Add a button to upload build.zip to S3.", "Add a command to run aws s3 cp build.zip s3://bucket/a.", "Document how to run `gsutil cp build.zip gs://bucket/a`.", "Show 'Upload build.zip to S3' as a label.", "Run aws s3 cp s3://bucket/a ./a --metadata \"note=aws s3 cp build.zip s3://bucket/b\".", "Run gsutil cp -J gs://bucket/a ./a.", "Run gsutil rsync -e -r gs://bucket/a ./a.", "Download build.zip from S3."]) {
    assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
});

test("Pulumi resource writes retain deployment intent while previews stay read-only", () => {
  for (const text of ["Run pulumi up.", "Run pulumi destroy.", "Run `pulumi up --yes` after tests.", "Execute \"pulumi destroy --stack dev\".", "Run pulumi --cwd infra up.", "Run pulumi -C infra --stack dev destroy.", "Run pulumi refresh.", "Run pulumi import aws:s3/bucket:Bucket logs bucket-id.", "Run pulumi cancel.", "Run pulumi preview and pulumi up.", "Run pulumi up --skip-preview.", "Run pulumi up --message \"--help\".", "Run pulumi refresh --preview-only --preview-only=false.", "Run pulumi up --preview-only.", "Run pulumi refresh --message \"--preview-only\"."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("deploy"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("deploy"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Run pulumi preview.", "Run pulumi preview --refresh.", "Run pulumi stack output.", "Run pulumi history.", "Run pulumi about.", "Run pulumi --cwd up preview.", "Run pulumi up --help.", "Add a command to run pulumi up.", "Add support for running pulumi destroy.", "Document how to run `pulumi up`.", "Show 'pulumi destroy' as a label.", "Run pulumi refresh --preview-only.", "Run pulumi refresh --preview-only=true."]) {
    assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
});

test("pushes of tags and non-task refs cannot be covered by the task-branch profile", () => {
  for (const text of ["Run git push --tags.", 'Run `git push --tags`.', "Push tag v1.0 to origin.", "Push all tags to origin.", "Push the Git notes to origin.", "Push all branches to origin.", "Run git push origin --follow-tags HEAD.", "Run git push --mirror origin.", "Run git push --all origin.", "Run git push origin refs/tags/v1.0.", "Run git push origin HEAD:refs/notes/ci.", "Run git push origin +refs/heads/release:refs/heads/release.", "Run git push origin :refs/tags/v1.0.", "Run git push --delete origin old-branch.", "Run git -C . push origin tag v1.0.", "Run git push origin other-branch.", "Run git push --repo origin other-branch.", "Run git push --repo=origin other-branch.", "Run git push --repo --tags HEAD.", "Push branch release/2.0 to origin.", "Run git push origin HEAD:other-branch.", 'Push `tag v1.0` to origin.']) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("direct_push"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("direct_push"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Push the task branch for review.", "Run git push -u origin HEAD.", "Run git push --repo origin HEAD.", "Run git push --repo=origin HEAD.", 'Run `git push origin HEAD` after tests.', "Run git push origin HEAD and run tests.", 'Show `git push --tags` as an example.', "Add a command to push tags to origin.", "Add support for pushing tags to origin.", 'Add a button to run `git push --tags`.', "Push notifications to subscribers.", "Push the button to continue."]) assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
});

test("wrapped delivery instructions retain adjacent source context and stable clause mappings", () => {
  for (const text of ["Do not\nopen a pull request", "Do\r\nnot\r\nopen a PR", "Upload the package\nto npm", "Create a GitHub\nissue for the follow-up", 'Run `gh workflow\nrun smoke.yml`', "Open the PR against\nstaging"]) {
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    const saved = structuredClone(task.requirements);
    for (const tagged of [false, true]) {
      const delivery = tagged ? Object.fromEntries(task.requirements.map(r => [r.id, { action: "pull_request" }])) : {};
      const out = parseDraft(JSON.stringify(draftFor(task, { delivery })), task);
      assert.ok(out.questions.length > 0, text);
      assert.deepEqual(task.requirements, saved, "context never rekeys or rewrites source fragments");
      assert.equal(out.mapping.length, saved.length);
      for (const r of saved) assert.equal(text.slice(r.source.start, r.source.end), r.text);
      assert.match(renderDraft(task, out), /q-delivery-r-/, text);
    }
  }
  for (const text of ['Show "Create a GitHub\nissue" as a label.', "Add a button to upload packages\nto npm.", "Run gh workflow\nview smoke.yml."]) {
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
  for (const text of ["Do not merge.\nOpen a PR.", "Do not merge\n\nOpen a PR.", "- Do not merge\n- Open a PR."]) {
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery: { "r-1": { action: "restrict", prohibits: ["merge"] }, "r-2": { action: "pull_request" } } })), task).questions, [], text);
  }
});

test("workflow dispatch and state mutations cannot borrow pull-request authority", () => {
  for (const text of ["Run gh workflow run smoke.yml.", "Run gh workflow enable smoke.yml.", "Run gh workflow disable smoke.yml.", 'Run `gh workflow run smoke.yml`.', 'Run gh workflow --repo "acme/widget" run smoke.yml.', "Run gh workflow -Racme/widget disable smoke.yml.", "Trigger the GitHub Actions workflow.", "Dispatch the workflow after tests.", "Enable the GitHub workflow.", "Run gh run rerun 123.", "Run gh run cancel 123.", "Run gh run delete 123."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("workflow_mutation"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }, { "r-1": { action: "restrict", prohibits: [] } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Run gh workflow list.", "Run gh workflow view smoke.yml.", "Run gh run view 123.", "Run gh run watch 123.", "Add a button to trigger the workflow.", 'Add a command to run `gh workflow run smoke.yml`.', 'Show "gh workflow run smoke.yml" as an example.', "Document how to enable the workflow."]) assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
  assert.throws(() => validateDeliveryTag({ action: "workflow_mutation" }), /delivery tag action/);
  assert.throws(() => validateDeliveryTag({ action: "restrict", prohibits: ["workflow_mutation"] }), /prohibits must list/);
});

test("issue mutations remain unsupported delivery actions across prose, commands and quoted references", () => {
  const requests = ["Create a GitHub issue describing the follow-up.", "Open a new issue for the follow-up.", "File an issue after tests pass.", "Edit issue #123 with the test results.", "Update the GitHub issue title.", "Comment on issue #123 with the test results.", "Leave feedback on the GitHub issue.", "Reply to issue #123.", "Close the GitHub issue.", "Reopen issue #123.", "Delete issue #123.", "Lock issue #123.", "Unlock issue #123.", "Assign issue #123 to alice.", "Transfer issue #123 to acme/other.", "The GitHub issue must be created.", "Issue#123 should be reopened.", "GitHub issue 123 must be closed.", 'Create a `GitHub issue` for the follow-up.', 'Update "issue #123".', 'Label "issue #123" as a bug.', 'Assign "issue #123" to alice.', 'The "GitHub issue #123" must be closed.', "Close https://github.com/acme/widget/issues/123.", "Comment on https://github.com/acme/widget/issues/123.", 'Run `gh issue create --title Follow-up`.', "Run gh issue --repo acme/widget create.", 'Run gh issue --repo "acme/widget" create.', "Run gh issue -Racme/widget comment 123 --body done."];
  for (const command of ["create", "edit", "comment", "close", "reopen", "delete", "develop", "lock", "unlock", "pin", "unpin", "transfer"]) requests.push(`Run gh issue ${command}.`);
  for (const text of requests) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("issue_mutation"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("issue_mutation"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }, { "r-1": { action: "restrict", prohibits: [] } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Fix the issue with CSV export.", "Add a button to create a GitHub issue.", "Add support for closing issues.", "Add a command to run gh issue create.", 'Add a command to run `gh issue create`.', "Document how to reopen an issue.", "Show closed issues in the dashboard.", "Edit the issue template.", "Close the issue dialog.", "Open the issue editor.", "Review issue #123 for context.", "Open https://github.com/acme/widget/issues/123 for context.", "Run gh issue list.", "Run gh issue view 123.", "Run gh issue status.", "Run gh issue --repo acme/widget list.", 'Run `gh issue view 123`.', "Show 'Create a GitHub issue' as an example.", "Show the label 'Close pull request #123'.", "Add a test for the exact label 'Deploy to production'.", "Document `gh issue create` in help."]) {
    assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
  assert.throws(() => validateDeliveryTag({ action: "issue_mutation" }), /delivery tag action/);
  assert.throws(() => validateDeliveryTag({ action: "restrict", prohibits: ["issue_mutation"] }), /prohibits must list/);
});

test("existing PR lifecycle changes remain distinct from creating a new review PR", () => {
  for (const text of ["Close pull request #123.", "Reopen the pull request.", "Delete the PR.", "Edit the pull request title.", "Lock the pull request.", "Unlock PR #123.", "Retarget the pull request to staging.", "Convert the PR to draft.", "Mark the PR ready for review.", "The pull request must be closed.", "The PR should be reopened.", "Pull request #123 must be closed.", "The PR #123 should be reopened.", "PR#123 must be closed.", "Pull request 123 should be reopened.", "Run gh pr close 123.", "Run gh pr reopen 123.", "Run gh pr lock 123.", "Run gh pr unlock 123.", "Run gh pr comment 123 --body done.", "Run gh pr review 123 --approve.", "Run gh pr edit 123 --base staging.", "Run gh pr ready 123 --undo.", 'Close `pull request #123`.', "Reopen ‘the pull request’."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("pull_request_lifecycle"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("pull_request_lifecycle"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Open a new PR for review.", "Create a pull request ready for review.", "Add a button to close pull requests.", "Add support for closing PRs.", "Document how to reopen the PR.", "Show closed pull requests in the dashboard.", "Add a closed PR count.", 'Render "Reopen the pull request" as a label.', 'Add a command to run `gh pr close 123`.']) assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
  assert.throws(() => validateDeliveryTag({ action: "pull_request_lifecycle" }), /delivery tag action/);
});

test("landing a PR or change retains merge intent through delivery validation", () => {
  for (const text of ["Land the pull request after CI passes.", "Please land this change.", "Land the PR.", "Land the patch once tests pass.", "Land it after CI.", "Finish by landing our changes.", "The bot lands the commits.", "Make sure the PR is landed after CI.", "The change must be landed.", 'Land `the pull request` after CI.', "Land ‘the change’ after tests."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("merge"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("merge"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request", prohibits: ["merge"] }).includes("merge"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }, { "r-1": { action: "merge" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Do not land the changes.", "I will land the changes afterwards.", "Let me land the patch."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.ok(screen.controlled.includes("merge"), text);
    assert.deepEqual(unaccountedTerms(screen, { action: "restrict", prohibits: ["merge"] }), [], text);
  }
  for (const text of ["Build a landing page.", "Add a field for the aircraft landing time.", "Land the plane in the simulation.", "Add a command to land changes.", "Add support for landing changes.", 'Add a button to land `the pull request`.', "Document how to land a PR.", "Show the label 'Land the pull request'.", 'Add a test for the exact text “Land the change”.']) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.terms.includes("merge"), false, text);
    assert.notEqual(screen.tier, "question", text);
  }
});

test("imperative command spans stay visible through delivery validation", () => {
  for (const text of ['Run `npm publish` after the tests.', 'Execute "npm publish" after the tests.', "Run 'npm publish' after the tests.", 'Run ‘npm publish’ after tests.', 'Please run: `npm publish`.', 'Run `npm test` and `npm publish`.', '`npm publish`', 'Run `git push origin main` after tests.', 'Run `git push --force origin HEAD:main` after tests.', "Run `git push origin 'main'` after tests.", 'Stop after `git commit`.']) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ['Add a button to run `npm publish`.', 'Document how to run `npm publish`.', 'Run `npm test` and document `npm publish` in help.']) assert.equal(deliveryScreen(text).tier, "none", text);
});

test("single-quoted examples mask contractions while apostrophes and quote emphasis preserve controls", () => {
  for (const text of ["Add a test for the exact label 'Deploy to production'.", "Add a test for the exact label ‘Deploy to production’.", "Render 'npm publish' as an example.", "Show 'Don't deploy' in help.", "Show ‘Don’t deploy’ in help.", "Show 'do not merge' and 'open a PR' labels."]) assert.equal(deliveryScreen(text).tier, "none", text);
  for (const text of ["Don't 'open a PR'.", "Do not ‘open a PR’.", "The owner's changes must not deploy to production.", "Don't merge the user's PR."]) assert.equal(deliveryScreen(text).tier, "question", text);
  for (const text of ["Add a label 'Deploy to production", "Add a label ‘Deploy to production"]) assert.equal(deliveryScreen(text).tier, "question", text);
});

test("multiple and separate PR requests remain conflicts with the one-PR profile", () => {
  for (const text of ["Open two pull requests, one for the API and one for the UI.", 'Open two `pull requests` for the API and UI.', "Open 2 PRs.", "Create separate pull requests for the API and UI.", "Use separate PRs for each component.", "I need two PRs.", "Separate PRs for the API and UI.", "Open a separate PR for each package.", "Open one PR per package.", "Open a PR for the API and another for the UI.", "Open a PR for the API and open a PR for the UI.", "Open pull requests for the changes.", 'Run `gh pr create` and `gh pr create`.', 'Run `gh pr create` twice.']) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.terms.includes("pull_request_count"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("pull_request_count"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Open one pull request for the API and UI.", "Open a single PR for review.", "I want you to open one PR.", "Add a button to open two PRs.", "List two pull requests on the dashboard.", 'Document "Open two pull requests" in help.']) assert.equal(deliveryScreen(text, PROFILE.target).terms.includes("pull_request_count"), false, text);
});

test("hosted registry names and hosts retain publication intent through delivery validation", () => {
  for (const text of ["Push the image to ghcr.io/acme/app.", "Upload the package to GitHub Packages.", "Upload the package to GitLab Package Registry.", "Push the image to quay.io/acme/app.", "Push the image to us.gcr.io/acme/app.", "Push the image to us-central1-docker.pkg.dev/acme/repo/app.", "Push the image to acme.azurecr.io/app.", "Push the image to 123456789012.dkr.ecr.us-east-1.amazonaws.com/app.", "Push the image to public.ecr.aws/acme/app.", "Push the image to 123456789012.dkr-ecr.us-east-1.on.aws/app.", "Upload the package to npm.pkg.github.com/acme/app.", "Upload the package to Azure Artifacts.", "Upload the package to JFrog Artifactory.", "Push the image to https://ghcr.io/acme/app.", "Push the image to registry.acme.test:5000/app.", "Upload the package to packages.acme.test/acme/app.", 'Push the image to "ghcr.io/acme/app".', 'Upload the package to `GitHub Packages`.', "Remove the image from ghcr.io/acme/app.", 'Remove the image from "ghcr.io/acme/app".']) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("publish"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("publish"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }, { "r-1": { action: "restrict", prohibits: ["publish"] } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Add a button to upload packages to GitHub Packages.", 'Add a button to upload packages to "GitHub Packages".', "Add support for uploading images to ghcr.io.", "Document how to upload packages to GitHub Packages.", "Add support for upload to GitHub Packages.", "Upload the image to photos.example.com.", "Pull the image from ghcr.io/acme/app.", "Download the package from GitHub Packages.", "Compare GitHub Packages and ghcr.io.", "Show 'Upload the package to GitHub Packages' as a label."]) {
    assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
  for (const text of ["Do not upload the package to GitHub Packages.", 'Do not upload the image to "ghcr.io/acme/app".']) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.ok(screen.controlled.includes("publish"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery: { "r-1": { action: "restrict", prohibits: ["publish"] } } })), task).questions, [], text);
  }
});

test("registry removal, deprecation and yanking require clarification without publication authority", () => {
  for (const text of ["Run npm unpublish old-package.", "npm deprecate pkg@1.0.", "Run npm --force --loglevel silent deprecate pkg@1.0.", "Yank version 1.2 from crates.io.", "Run `npm unpublish old-package`.", "Run npm --registry=https://registry.npmjs.org deprecate pkg@1.0.", "Run cargo yank --version 1.2.0 old-package.", "Run gem yank old-package -v 1.2.", "Remove the package from npm.", "Delete version 1.2 from the package registry.", "Deprecate old-package on npm.", "Unpublish old-package.", "Do not unpublish old-package."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.terms.includes("publish"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("publish"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Run npm uninstall old-package.", "Remove old-package from package.json.", "Deprecate the legacy API.", "Delete the local package cache.", "Add a command to run npm unpublish.", "Add support for yanking versions from crates.io.", "Document how to run npm deprecate pkg@1.0.", "Show 'npm unpublish' as a label.", "Add a test for `Yank version 1.2 from crates.io`."]) assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
});

test("outbound messages stay outside pull-request delivery", () => {
  for (const text of ["Post the test results to Slack.", "Send an email when finished.", "Send a message to the team.", "Notify me when finished.", "Notify `me` when finished.", 'Post "the test results to Slack".', "Message the team on Discord.", "Post the results to a webhook.", "Send the test report to https://hooks.example.test/results.", "Do not send an email when finished.", "Run `sendmail owner@example.test`."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("external_communication"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("external_communication"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }, { "r-1": { action: "restrict", prohibits: [] } }]) {
      const output = parseDraft(JSON.stringify(draftFor(task, { delivery })), task);
      assert.deepEqual(output.questions.map(q => q.id), ["q-delivery-r-1"], text);
      assert.match(output.mapping[0].conflict.reason, /not authorized/, text);
    }
  }
  for (const text of ["Add a button to post results to Slack.", "Add a command to send an email.", "Document how to notify me.", "Show 'Send an email when finished' as a label.", "Add email notification templates.", "Write the test results to stdout.", "Post a message to the local log."]) {
    assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
  assert.throws(() => validateDeliveryTag({ action: "external_communication" }), /action must be/);
});

test("HTTP mutations clarify while read-only requests and argument values retain their meaning", () => {
  for (const text of ["Run curl -X POST https://hooks.example.test/results.", "Run `curl -XPOST https://hooks.example.test/results`.", "Run curl --request=DELETE https://api.example.test/items/1.", "Run curl -sSX PATCH https://api.example.test/items/1.", "Run curl -d payload https://hooks.example.test/results.", "Run curl --json '{\"status\":\"done\"}' https://hooks.example.test/results.", "Run curl -F file=@results.txt https://hooks.example.test/results.", "Run curl -T results.txt https://uploads.example.test/results.", "Run curl -X GET -T results.txt https://uploads.example.test/results.", "Run curl -X $METHOD https://api.example.test/items.", "Run curl --config request.conf.", "Run curl -X POST https://hooks.example.test/results --next -X GET https://api.example.test/status.", "Run curl -H \"X-Note: --request GET\" --request POST https://api.example.test/items."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("http_mutation"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("http_mutation"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }, { "r-1": { action: "restrict", prohibits: [] } }]) {
      const output = parseDraft(JSON.stringify(draftFor(task, { delivery })), task);
      assert.deepEqual(output.questions.map(q => q.id), ["q-delivery-r-1"], text);
      assert.match(output.mapping[0].conflict.reason, /not authorized/, text);
    }
  }
  for (const text of ["Run curl https://api.example.test/status.", "Run curl -X GET https://api.example.test/status.", "Run curl --request HEAD https://api.example.test/status.", "Run curl --request=OPTIONS https://api.example.test/status.", "Run curl -I https://api.example.test/status.", "Run curl -G -d query=value https://api.example.test/search.", "Run curl -X GET -d query=value https://api.example.test/search.", "Run curl -X POST -X GET https://api.example.test/status.", "Run curl -H \"X-Note: --request POST\" https://api.example.test/status.", "Run curl --help all.", "Run curl --version.", 'Run curl --url-query "q=$VALUE" https://api.example.test/search.', 'Run `curl -H "X-Test: curl -X POST" https://api.example.test/status`.', "Add a command to run curl -X POST https://hooks.example.test/results.", "Document how to run `curl -X POST https://hooks.example.test/results`.", "Show 'curl -X POST https://hooks.example.test/results' as a label."]) {
    assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
  assert.throws(() => validateDeliveryTag({ action: "http_mutation" }), /action must be/);
});

test("authenticated API writes cannot use PR delivery authority", () => {
  for (const text of ["Run gh api -X POST repos/acme/widget/hooks.", "Run gh api --method=DELETE repos/acme/widget/hooks/1.", "Run `gh api -XPOST repos/acme/widget/hooks`.", "Run gh api -iX PATCH repos/acme/widget.", "Run gh api repos/acme/widget/hooks -f name=web.", "Run gh api repos/acme/widget/hooks --raw-field=name=web.", "Run gh api repos/acme/widget/hooks -F active=true.", "Run gh api repos/acme/widget/hooks --field=active=true.", "Run gh api repos/acme/widget/hooks --input payload.json.", "Run gh api repos/acme/widget/hooks --input=-.", "Run gh api -X $METHOD repos/acme/widget/hooks.", "Run gh api --method GET --method POST repos/acme/widget/hooks.", "Run gh api -H \"X-Note: --method GET\" -X POST repos/acme/widget/hooks.", "Run gh api --unknown \"--help\" -X POST repos/acme/widget/hooks.", "Run gh api repos/acme/widget and gh api -X DELETE repos/acme/widget/hooks/1.", "Run gh api graphql -f query=\"mutation { addStar(input: {starrableId: \\\"id\\\"}) { clientMutationId } }\".", "Run gh api -X=POST repos/acme/widget/hooks.", "Run gh api --method POST repos/acme/widget/hooks --help=false.", "Run gh api repos/acme/widget/hooks --method.", "Run gh api $ARGS."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("http_mutation"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("http_mutation"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Run gh api repos/acme/widget.", "Run gh api -X GET repos/acme/widget.", "Run gh api --method=GET search/issues -f q=repo:acme/widget.", "Run gh api -F q=widget --method GET search/issues.", "Run gh api --method HEAD repos/acme/widget.", "Run gh api --method OPTIONS repos/acme/widget.", "Run gh api -X POST -X GET repos/acme/widget.", "Run gh api --method GET --input payload.json repos/acme/widget.", "Run gh api -H \"X-Note: --method POST\" repos/acme/widget.", "Run `gh api -H \"X-Note: gh api -X POST\" repos/acme/widget`.", "Run gh api --help.", "Run gh api --method POST repos/acme/widget/hooks --help.", "Add a command to run gh api -X POST repos/acme/widget/hooks.", "Document how to run `gh api -X POST repos/acme/widget/hooks`.", "Show 'gh api -X POST repos/acme/widget/hooks' as a label.", "Run gh api -X=GET repos/acme/widget.", "Run gh api -X GET --input - repos/acme/widget.", "Run gh api -X GET search/issues -f q=\"$QUERY\".", "Run gh api --cache 1h --jq \".name\" repos/acme/widget."]) {
    assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
});

test("source-before-remote pushes retain base and non-task branch conflicts", () => {
  for (const text of ["Push main to origin.", "Push the main branch to origin.", "Push main branch to upstream.", "Push `main` to origin.", "Push the \"main\" branch to origin.", "Push refs/heads/main to origin.", "Push main to our remote fork.", "Push the release/2.0 branch to origin."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("direct_push"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("direct_push"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Push the task branch to origin.", "Push the feature branch to origin.", "Push main2 to origin.", "Push notifications to subscribers.", "Add a command to push main to origin.", "Add support for pushing main to origin.", "Show 'Push main to origin' as a label."]) {
    assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
  for (const base of ["staging", "release/2.0", "feature+qualified", "MAIN"]) {
    const profile = { ...PROFILE, target: { ...PROFILE.target, base } };
    for (const text of [`Push ${base} to origin.`, `Push the ${base} branch to fork.`]) {
      assert.ok(deliveryScreen(text, profile.target).escalated.includes("direct_push"), text);
      const task = taskFor(text, { commandCandidates: ["npm test"], base, deliveryProfile: profile });
      for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
    }
    assert.equal(deliveryScreen(`Push ${base}2 to origin.`, profile.target).escalated.includes("direct_push"), false, base);
  }
});

test("quoted PR target qualifiers retain exact matching without unmasking product examples", () => {
  for (const [open, close] of [["`", "`"], ['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"]]) {
    for (const text of [`Open a PR against ${open}main${close}.`, `Open a PR in ${open}acme/widget${close}.`, `Open a PR in ${open}Acme/Widget${close} against ${open}main${close}.`, `Against ${open}main${close}, in ${open}acme/widget${close}, open a PR.`]) {
      assert.equal(deliveryScreen(text, PROFILE.target).targetConflicts, undefined, text);
      assert.equal(maskLiterals(text), text, text);
      const task = taskFor(text, { commandCandidates: ["npm test"] });
      for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions, [], text);
    }
    for (const text of [`Open a PR against ${open}staging${close}.`, `Open a PR in ${open}acme/other${close}.`, `Against ${open}MAIN${close}, open a PR.`]) {
      const screen = deliveryScreen(text, PROFILE.target);
      assert.equal(screen.tier, "question", text); assert.ok(screen.targetConflicts?.length, text);
      assert.ok(screen.targetConflicts.every(reason => /differs from selected/.test(reason)), text);
      const task = taskFor(text, { commandCandidates: ["npm test"] });
      for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
    }
  }
  for (const text of ['Show "Open a PR against main" as a label.', 'Add a button to open a PR against "staging".', 'Open a PR and document it in "README".', 'Open a PR and run the tests on `Linux`.']) {
    assert.equal(deliveryScreen(text, PROFILE.target).targetConflicts, undefined, text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
});

test("PR creation modes cannot change regular review delivery", () => {
  for (const text of ["Run gh pr create --draft.", "Run gh pr create --dry-run.", "Run gh pr create -d.", "Run gh pr create -fd.", "Run gh pr create --draft=true.", "Run gh pr create --dry-run=1.", "Run gh pr create -d=true.", "Run `gh pr create --draft`.", "Run gh pr create --draft=false --draft.", "Run gh pr create --dry-run=$MODE.", "Open a draft pull request.", "Create a PR as a draft.", "Open a PR in draft mode."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.terms.includes("pull_request_mode"), text);
    assert.equal(screen.targetConflicts, undefined, "mode qualifiers do not invent a base: " + text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("pull_request_mode"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }, { "r-1": { action: "restrict", prohibits: [] } }]) {
      const output = parseDraft(JSON.stringify(draftFor(task, { delivery })), task);
      assert.deepEqual(output.questions.map(q => q.id), ["q-delivery-r-1"], text);
      assert.match(output.mapping[0].conflict.reason, /regular review PR/, text);
    }
  }
  for (const text of ["Run gh pr create --help.", "Run gh pr create -h.", "Run gh pr create --draft=false.", "Run gh pr create --dry-run=0.", "Run gh pr create -d=false.", "Run gh pr create --help=false.", 'Run gh pr create --title "--draft" --body "--dry-run".', "Run gh pr create --body-file --draft.", "Run gh pr create -- --draft.", "Run gh pr create and echo --draft.", "Run gh pr create; echo --dry-run.", "Add a command to run gh pr create --draft.", "Document how to run `gh pr create --dry-run`.", "Show 'gh pr create --draft' as a label.", "Add a button to open a draft PR."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.notEqual(screen.tier, "question", text); assert.ok(!screen.terms.includes("pull_request_mode"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
  assert.throws(() => validateDeliveryTag({ action: "pull_request_mode" }), /action must be/);
});

test("registry administration writes require clarification while reads stay implementation scope", () => {
  for (const text of ["Run npm access set status=public pkg.", "npm owner add alice pkg.", "Run npm --help=false owner add alice pkg.", "npm dist-tag add pkg@2.0 latest.", "Run npm access grant read-write acme:team pkg.", "Run npm access revoke acme:team pkg.", "Run npm access public pkg.", "Run npm access restricted pkg.", "Run npm access 2fa-required pkg.", "Run npm access 2fa-not-required pkg.", "Run npm owner rm alice pkg.", "Run npm dist-tag rm pkg latest.", "Run npm --registry=https://registry.npmjs.org owner add alice pkg.", "Run npm access --registry https://registry.npmjs.org set mfa=none pkg.", "Run `npm dist-tag add pkg@2.0 latest`.", "Run npm owner $ACTION alice pkg.", 'Run npm owner "add" alice pkg.', 'Run `npm owner "add" alice pkg`.',  "Run npm owner add alice pkg and npm owner ls pkg."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("publish"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("publish"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Run npm access list packages.", "Run npm access list collaborators pkg.", "Run npm access get status pkg.", "Run npm access ls-packages.", "Run npm owner ls pkg.", "Run npm dist-tag ls pkg.", "Run npm dist-tag pkg.", "Run npm --registry https://registry.npmjs.org owner ls add.", "Run npm --userconfig owner access get status pkg.", "Run npm access get status add.", "Run npm owner ls pkg and echo add.", "Run npm owner ls pkg; echo add.", "Run npm --help owner add alice pkg.", "Run npm owner add alice pkg --help.", "Run npm dist-tag add pkg@2 latest -h.", "Add a command to run npm access set status=public pkg.", "Document how to run `npm owner add alice pkg`.", "Show 'npm dist-tag add pkg@2.0 latest' as a label.", "Run npm pkg set access=public.", 'Run npm --userconfig "x npm owner add" access get status pkg.', 'Run `npm --userconfig "x npm owner add" access get status pkg`.',  'Run npm --userconfig "x owner add" access get status pkg.', "Run npm --registry 'owner add' owner ls pkg.", 'Run npm owner "ls add" pkg.', "Run npm --userconfig x owner ls pkg; run npm --userconfig 'x owner add' access get status pkg."]) {
    assert.notEqual(deliveryScreen(text, PROFILE.target).tier, "question", text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
});

test("PR creation command flags retain target qualifiers without borrowing option values or later commands", () => {
  for (const text of ["Run gh pr create --base staging.", "Run gh pr create --repo acme/other.", "Run gh pr create -B staging -R acme/widget.", "Run gh pr create --base=staging.", "Run gh pr create -Bstaging.", "Run gh pr create -Racme/other.", "Run gh pr create -fBstaging.", 'Run gh pr create --base "staging".', 'Run `gh pr create --repo "acme/other"`.', "Run gh pr create --repo git.example/acme/widget.", "Run gh pr create --base main --base staging.", "Run gh pr create --base $BASE.", 'Run gh pr create --title "quoted \\" title" --base staging.', "Run gh pr create --base.", "Run gh pr create --repo=.", "Run gh pr create --base --repo acme/widget."]) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.targetConflicts?.length, text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("pull_request_target"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Run gh pr create --base main --repo Acme/Widget.", "Run gh pr create -Bmain -Rgithub.com/acme/widget.", 'Run gh pr create --base "main" --repo \'acme/widget\'.', 'Run `gh pr create --base main --repo "acme/widget"`.', 'Run gh pr create --title "--base staging" --base main.', 'Run gh pr create --body "and --repo acme/other; --base staging" --base main.', "Run gh pr create --title --base --repo acme/widget.", "Run gh pr create --base main and run echo --base staging.", "Run gh pr create --base main; run echo --repo acme/other.", "Run gh pr create --base main -- --base staging.", "Add a command to run gh pr create --base staging.", "Document how to run gh pr create --base staging.", "Show 'gh pr create --base staging' as a label."]) {
    assert.equal(deliveryScreen(text, PROFILE.target).targetConflicts, undefined, text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task)), task).questions, [], text);
  }
});

test("PR destinations are compared with the selected repository and case-sensitive base even when the planner omits them", () => {
  const tag = { action: "pull_request" };
  for (const text of ["Open the pull request against staging.", "Against staging, open a PR.", "Create a PR targeting MAIN.", "Open a PR to staging.", "Open a PR on the staging branch.", "Open a PR in acme/other.", "Open a PR in https://github.com/acme/other.", "Open a PR in https://gitlab.com/acme/widget.", "In acme/other, open a pull request.", "Open a PR in another repository.", 'Open a PR against "staging".', 'Open a `PR` against staging.']) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.equal(screen.tier, "question", text); assert.ok(screen.targetConflicts.length, text);
    assert.ok(unaccountedTerms(screen, tag).includes("pull_request_target"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": tag }]) {
      const output = parseDraft(JSON.stringify(draftFor(task, { delivery })), task);
      assert.deepEqual(output.questions.map(q => q.id), ["q-delivery-r-1"], text);
      assert.match(output.mapping[0].conflict.reason, /base|repository|target/);
      assert.match(output.questions[0].text, /acme\/widget against main/);
    }
  }
  for (const text of ["Open a PR against main.", "Open a PR in Acme/Widget against main.", "Open a PR in https://github.com/acme/widget.", "Add export to CSV and open a PR.", "Add a button to open a PR against staging.", 'Document "Open a PR against staging" in help.']) {
    assert.equal(deliveryScreen(text, PROFILE.target).targetConflicts, undefined, text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery: { "r-1": tag } })), task).questions, [], text);
  }
  assert.equal(deliveryScreen("Open a PR against release/1.2.", { ...PROFILE.target, base: "release/1.2" }).targetConflicts, undefined);
});

test("PR target qualifiers stay attached to their instruction across independent actions", () => {
  for (const text of ["Open a PR and run the tests on Linux.", "Open a PR and document it in the README.", "Open a PR and document it in docs/README.md.", "Open a PR in acme/widget against main and run the tests on Linux.", "Open a PR for review, then document it in the README.", "Open a PR, run the tests on Linux.", "Open a PR and compare code in another repository.", "Run the tests on Linux and open a PR.", "Compare code in acme/other and open a PR."]) {
    assert.equal(deliveryScreen(text, PROFILE.target).targetConflicts, undefined, text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions, [], text);
  }
  for (const text of ["Open a PR against staging and run the tests on Linux.", "Open a PR for review against staging.", "Open a PR for review, against staging.", "Open a PR for team review and in acme/other.", "Open a PR in acme/other against main and document it in the README.", "Against staging, in acme/other, open a PR.", "Open a PR against main and then open a PR against staging.", "Open a PR in another repository and document it in the README.", 'Open a PR against "staging" and run the tests on Linux.', 'Against "staging", open a PR.', 'Open a PR in "acme/other".']) {
    const screen = deliveryScreen(text, PROFILE.target);
    assert.ok(screen.targetConflicts?.length, text);
    assert.equal(screen.tier, "question", text);
  }
});

test("dotted registry destinations retain publication controls and feature examples stay product text", () => {
  for (const registry of ["hex.pm", "crates.io", "crates", "npm", "PyPI"]) {
    for (const verb of ["Upload the package", "Push the package", "Submit the package"]) {
      const text = `${verb} to ${registry}.`;
      const screen = deliveryScreen(text);
      assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("publish"), text);
      assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("publish"), text);
    }
  }
  assert.equal(deliveryScreen("Add a command to upload packages to hex.pm.").tier, "assumption");
  assert.equal(deliveryScreen('Document "Upload the package to hex.pm" in help.').tier, "none");
  assert.ok(deliveryScreen('Do not upload "the package" to hex.pm.').controlled.includes("publish"));
});

test("each delivery term retains positive and negative occurrences across control scopes", () => {
  for (const connector of [", but", ";", ".", ", however", ", yet"]) {
    for (const first of ["merge", "deploy"]) {
      const text = `Do not ${first}${connector} deploy this to production.`;
      const screen = deliveryScreen(text);
      assert.ok(screen.uncontrolled.includes("deploy"), text);
      assert.ok(unaccountedTerms(screen, { action: "restrict", prohibits: ["merge", "deploy"] }).includes("deploy"), text);
    }
  }
  assert.deepEqual(unaccountedTerms(deliveryScreen("Do not merge or deploy to production."), { action: "restrict", prohibits: ["merge", "deploy"] }), []);
  assert.deepEqual(unaccountedTerms(deliveryScreen("Do not merge, but do not deploy either."), { action: "restrict", prohibits: ["merge", "deploy"] }), []);
});

test("consent and authorization gates survive omitted or covered planner delivery tags", () => {
  for (const text of ["Get my consent before opening a PR.", "Wait for my authorization before opening a PR.", "Get my authorisation before opening a PR.", "Open a PR only after I consent.", "I must authorize opening the PR first.", "Get my permission before opening a PR.", "Get CONSENT before opening a PR."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("approval"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("approval"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) {
      const output = parseDraft(JSON.stringify(draftFor(task, { delivery })), task);
      assert.deepEqual(output.questions.map(q => q.id), ["q-delivery-r-1"], text);
      assert.equal(output.mapping[0].conflict.screen.escalated.includes("approval"), true, text);
    }
  }
  for (const text of ["Add a consent banner.", "Fix the authorization middleware.", "Show the permission status column.", "Add a button to authorize users.", "List authorized users.", "Show consented records."]) {
    const screen = deliveryScreen(text);
    assert.deepEqual(screen.terms, ["approval"], text); assert.equal(screen.tier, "assumption", text);
  }
  for (const text of ['Document "Get my consent before opening a PR" in help.', "Render `Wait for my authorization` as an example."]) assert.equal(deliveryScreen(text).tier, "none", text);
});

test("terminal stops after committing remain local delivery restrictions with or without planner tags", () => {
  for (const text of ["Implement the fix, but stop after committing the changes.", "Stop once the changes are committed.", "Once committed, stop.", "After committing the changes, halt.", "Pause after the commit.", "Stop immediately after committing.", "Stop after creating the commit.", "I want this task to stop after committing the changes.", "Stop after committing the changes and document committing the database transaction."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.terms.includes("local"), text);
    assert.ok(unaccountedTerms(screen, { action: "pull_request" }).includes("local"), text);
    const task = taskFor(text, { commandCandidates: ["npm test"] });
    for (const delivery of [{}, { "r-1": { action: "pull_request" } }]) assert.deepEqual(parseDraft(JSON.stringify(draftFor(task, { delivery })), task).questions.map(q => q.id), ["q-delivery-r-1"], text);
  }
  for (const text of ["Add an option to stop after committing changes.", "Stop after committing the database transaction.", 'Document "Stop once committed" in help.']) assert.equal(deliveryScreen(text).terms.includes("local"), false, text);
});

test("planner delivery tags are validated and compared with the profile without granting anything", () => {
  const target = { repository: "Acme/Widget", base: "main" };
  assert.deepEqual(validateDeliveryTag({ action: "pull_request", target }), { action: "pull_request", target });
  assert.equal(profileCovers(PROFILE, { action: "pull_request", target }).covered, true);
  for (const target of [{ repository: "acme/other" }, { base: "staging" }, { base: "MAIN" }]) assert.equal(profileCovers(PROFILE, { action: "pull_request", target }).covered, false);
  for (const target of [null, [], {}, { base: "" }, { base: "main\n" }, { repository: "other" }, { kind: "github-pull-request" }]) assert.throws(() => validateDeliveryTag({ action: "pull_request", target }));
  assert.deepEqual(validateDeliveryTag({ action: "pull_request", prohibits: ["merge"] }), { action: "pull_request", prohibits: ["merge"] });
  for (const bad of [null, { action: "ship" }, { action: "pull_request", count: 2 }, { action: "pull_request", prohibits: ["rm -rf"] }, { action: "pull_request", prohibits: ["merge", "merge"] }, { action: "pull_request", completion: "done" }, { action: "pull_request", grant: "merge" }, { action: "restrict" }]) {
    assert.throws(() => validateDeliveryTag(bad));
  }
  assert.equal(profileCovers(PROFILE, { action: "pull_request" }).covered, true);
  assert.equal(profileCovers(PROFILE, { action: "pull_request", prohibits: ["merge", "deploy"] }).covered, true);
  assert.equal(profileCovers(PROFILE, { action: "restrict", prohibits: ["merge"] }).covered, true);
  for (const tag of [{ action: "merge" }, { action: "deploy" }, { action: "local_only" }, { action: "wait_for_approval" }, { action: "pull_request", prohibits: ["push"] }, { action: "restrict", prohibits: ["pull_request"] }, { action: "pull_request", completion: "integrated" }]) {
    const coverage = profileCovers(PROFILE, tag);
    assert.equal(coverage.covered, false, JSON.stringify(tag)); assert.ok(coverage.reason);
  }
  // A requested action speaks only for terms outside a control word; a prohibition only for terms under one.
  const unaccounted = (text, tag) => unaccountedTerms(deliveryScreen(text), tag);
  assert.deepEqual(unaccounted("Do not open a pull request.", { action: "pull_request" }), ["pull_request"]);
  assert.deepEqual(unaccounted("Do not open a pull request.", { action: "restrict", prohibits: ["pull_request"] }), []);
  assert.deepEqual(unaccounted("Merge the PR.", { action: "pull_request", prohibits: ["merge"] }), ["merge"]);
  assert.deepEqual(unaccounted("Merge the PR.", { action: "merge" }), []);
  assert.deepEqual(unaccounted("Open a PR for review; do not merge it.", { action: "pull_request", prohibits: ["merge"] }), []);
  // "do not push" also reads as local-only output, an escalating term no pull_request tag can speak for.
  assert.deepEqual(unaccounted("Do not push and open a PR.", { action: "pull_request", prohibits: ["push"] }), ["pull_request", "local"], "a control word binds across a conjunction");
  // A write aimed at the base branch escalates; only a prohibition of direct_push can speak for it, and a pull_request tag cannot.
  for (const text of ["Push the changes directly to main.", "Commit straight to master.", "Land it on the default branch without a pull request.", "Push to main."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("direct_push"), `${text} → ${JSON.stringify(screen)}`);
    assert.deepEqual(unaccountedTerms(screen, { action: "pull_request" }).includes("direct_push"), true, text);
  }
  assert.deepEqual(unaccounted("Do not push directly to main.", { action: "pull_request", prohibits: ["push", "direct_push"] }), ["local"], "a prohibition of the direct write speaks for it; 'do not push' also reads as local-only");
  assert.equal(profileCovers(PROFILE, { action: "restrict", prohibits: ["direct_push"] }).covered, true, "the profile never writes to the base directly");
  for (const text of ["Push notifications to subscribers.", "Push the button to continue."]) assert.equal(deliveryScreen(text).escalated.includes("direct_push"), false, text);
  // An explicitly direct write names any branch; the selected base is matched by name through the screen's base option.
  for (const text of ["Push the changes directly to staging.", "Commit straight to release/2.4.", "Land it directly on the staging branch."]) {
    const screen = deliveryScreen(text);
    assert.ok(screen.escalated.includes("direct_push"), `${text} → ${JSON.stringify(screen)}`); assert.deepEqual(unaccountedTerms(screen, { action: "pull_request" }).includes("direct_push"), true, text);
  }
  for (const [text, base] of [["Push the changes to staging.", "staging"], ["Commit the fix onto release/2.4.", "release/2.4"], ["Land it on the staging branch after tests pass.", "staging"], ["Implement export and push to Develop.", "develop"]]) {
    const screen = deliveryScreen(text, { base });
    assert.ok(screen.escalated.includes("direct_push"), `${text} (base ${base}) → ${JSON.stringify(screen)}`); assert.equal(screen.tier, "question", text);
    assert.deepEqual(unaccountedTerms(screen, { action: "pull_request" }).includes("direct_push"), true, text);
  }
  assert.equal(deliveryScreen("Push the changes to staging.").escalated.includes("direct_push"), false, "without the base, a plain push to another branch is only an effect term");
  assert.equal(deliveryScreen("Push the changes to staging2.", { base: "staging" }).escalated.includes("direct_push"), false, "the base name is matched whole");
  assert.equal(deliveryScreen("Push the feature branch for review.", { base: "staging" }).escalated.includes("direct_push"), false);
  assert.deepEqual(deliveryScreen("Do not push to staging.", { base: "staging" }).controlled, ["push", "direct_push", "local"]);
  // Stop-before and pause-before wording prohibits the delivery term that follows it.
  for (const text of ["Implement the fix, but stop before opening a pull request.", "Pause before the merge.", "Stop short of deploying."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.controlled.length, `${text} → ${JSON.stringify(screen)}`);
  }
  assert.deepEqual(unaccounted("Implement the fix, but stop before opening a pull request.", { action: "pull_request" }), ["pull_request"]);
  assert.deepEqual(deliveryScreen("Open a PR for review; do not merge it.").controlled, ["merge"]);
  // A review prohibited outright conflicts with pull-request delivery and no tag speaks for it; a review named as a condition or as optional does not.
  for (const text of ["Do not create a code review.", "Implement export. Do not send this for review.", "Open a PR without review.", "No code review for this change.", "Reviews are forbidden for this change.", "Skip the review and open the PR."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.escalated.includes("review"), `${text} → ${JSON.stringify(screen)}`);
    assert.ok(unaccounted(text, { action: "pull_request" }).includes("review"), text);
    assert.ok(unaccounted(text, { action: "restrict", prohibits: ["merge"] }).includes("review"), text);
  }
  for (const [text, tag] of [["Keep the result out of main until someone has reviewed it.", { action: "pull_request", prohibits: ["merge"] }], ["Do not merge until reviewed.", { action: "pull_request", prohibits: ["merge"] }], ["Do not push until reviewed.", { action: "pull_request", prohibits: ["push"] }], ["A code review is not required.", { action: "pull_request" }], ["Open one pull request for review.", { action: "pull_request" }]]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.escalated.includes("review"), false, `${text} → ${JSON.stringify(screen)}`); assert.equal(unaccounted(text, tag).includes("review"), false, text);
  }
  assert.deepEqual(unaccounted("Keep the result out of main until someone has reviewed it.", { action: "pull_request", prohibits: ["merge"] }), []);
  assert.deepEqual(unaccounted("Do not merge until reviewed.", { action: "pull_request", prohibits: ["merge"] }), []);
  const requirement = { id: "r-3", text: "Merge it." };
  assert.deepEqual(deliveryQuestion(PROFILE, requirement), deliveryQuestion(PROFILE, requirement));
  assert.equal(deliveryQuestion(PROFILE, requirement).id, "q-delivery-r-3");
  assert.doesNotMatch(deliveryQuestion(PROFILE, requirement).text, /Merge it/, "question text never echoes a planner reading");
});

test("recursive delivery question identifiers remain bounded, stable and distinct", () => {
  let requirementId = "r-1";
  const seen = new Set();
  for (let depth = 0; depth < 128; depth++) {
    const id = deliveryQuestionId(requirementId);
    assert.ok(id.length <= 64, `depth ${depth}: ${id.length} characters`);
    assert.match(id, /^q-[a-z0-9-]{1,64}$/);
    assert.equal(deliveryQuestionId(requirementId), id);
    assert.equal(seen.has(id), false); seen.add(id);
    requirementId = `a-${id}-1`;
  }
  const long = "a-" + "q-delivery-".repeat(32) + "r-1-1";
  assert.notEqual(deliveryQuestionId(long), deliveryQuestionId(long + "-2"));
  assert.equal(deliveryQuestionId("r-1"), "q-delivery-r-1");
  for (const length of [128, 129]) {
    const requirementId = "a-" + "x".repeat(length - 13), id = `q-delivery-${requirementId}`;
    const task = { questionHistory: { [id]: { id, requirements: [requirementId] } }, questionMappings: { [id]: [requirementId] }, answers: {} };
    if (length === 128) { assert.equal(deliveryQuestionId(requirementId, task), id); assert.ok(id.length <= MAX_ANSWER_ID_CHARACTERS); }
    else { assert.ok(deliveryQuestionId(requirementId, task).length <= 64); task.answers[id] = "Do it anyway."; assert.equal(deliveryQuestionId(requirementId, task), id, "accepted historical answer keys retain their provenance"); }
    delete task.questionMappings[id];
    assert.ok(deliveryQuestionId(requirementId, task).length <= 64, "history alone cannot establish question ownership");
  }
});

test("same-line material clauses can independently map to criteria assumptions and questions", () => {
  const text = "  Implement CSV export. The proposed filename is only a suggestion; Ask which delimiter to use.  ";
  const task = taskFor(text, { commandCandidates: ["npm test"] });
  assert.deepEqual(task.requirements.map(r => r.text), ["Implement CSV export.", "The proposed filename is only a suggestion;", "Ask which delimiter to use."]);
  assert.deepEqual(fragments(text), task.requirements);
  for (const r of task.requirements) assert.equal(text.slice(r.source.start, r.source.end), r.text);
  const draft = draftFor(task, { assumptions: { "r-2": "The filename is advisory." } });
  draft.mapping[2] = { requirementId: "r-3", questionId: "q-delimiter" };
  draft.questions = [{ id: "q-delimiter", text: "Which delimiter should be used?", requirements: ["r-3"] }];
  draft.criteria = draft.criteria.slice(0, 1);
  const out = parseDraft(JSON.stringify(draft), task), rendered = renderDraft(task, out);
  assert.deepEqual(out.mapping.map(m => m.requirementId), ["r-1", "r-2", "r-3"]);
  assert.deepEqual(out.mapping[0].criteria, ["ac-1"]); assert.equal(out.mapping[1].assumption, "The filename is advisory."); assert.equal(out.mapping[2].questionId, "q-delimiter");
  for (const r of task.requirements) assert.ok(rendered.includes(JSON.stringify(r.text)));
});

test("clause spans preserve quoted code paths decimals abbreviations and UTF-16 offsets", () => {
  const cases = [
    ["Run `npm test`. Ask which filename to use.", ["Run `npm test`.", "Ask which filename to use."]],
    ["  Export café 😀. Filename is advisory; Ask about delimiters?  ", ["Export café 😀.", "Filename is advisory;", "Ask about delimiters?"]],
    ['Render "Ready. Deploy; now!" as text. Keep `npm test; npm run lint` literal.', ['Render "Ready. Deploy; now!" as text.', 'Keep `npm test; npm run lint` literal.']],
    ["Show 'Hello. World!' and ‘One; two.’ as labels. Keep them exact.", ["Show 'Hello. World!' and ‘One; two.’ as labels.", "Keep them exact."]],
    ["Run git -C . push origin tag v1.0. Preserve ./docs/v1.2.md and https://example.test/a. Ask Dr. Smith, e.g. for version 1.2.", ["Run git -C . push origin tag v1.0.", "Preserve ./docs/v1.2.md and https://example.test/a.", "Ask Dr. Smith, e.g. for version 1.2."]],
    ["First clause.\r\n  Second clause; third clause!", ["First clause.", "Second clause;", "third clause!"]],
    ['Keep `first.\nsecond;` as one example. Then test.', ['Keep `first.\nsecond;` as one example.', 'Then test.']],
  ];
  for (const [text, expected] of cases) {
    const parts = fragments(text);
    assert.deepEqual(parts.map(r => r.text), expected, text); assert.deepEqual(parts, fragments(text));
    assert.deepEqual(parts.map(r => r.id), expected.map((_, i) => `r-${i + 1}`));
    for (const r of parts) assert.equal(text.slice(r.source.start, r.source.end), r.text);
    const legacy = fragmentsForTask({}, text);
    assert.deepEqual(legacy, fragments(text, "r", "original", 1));
    assert.throws(() => fragmentsForTask({ fragmentVersion: 999 }, text), { code: "TASK_PROFILE_UNSUPPORTED" });
  }
});

test("fragments carry stable source spans into the immutable request and answers", () => {
  const text = "  Add export.  \r\n\n\tDo not add dependencies.\nOpen a PR.";
  const parts = fragments(text);
  assert.deepEqual(parts.map(p => p.id), ["r-1", "r-2", "r-3"]);
  for (const part of parts) assert.equal(text.slice(part.source.start, part.source.end), part.text);
  assert.equal(parts[0].source.of, "original");
  assert.equal(fragments("Use CSV.", "a-q-r-1")[0].source.of, "answer:q-r-1");
});

test("the brief carries the canonical profile section and the PRD checker and fingerprint read it", () => {
  const task = taskFor("Add CSV export.\nDo not add dependencies.", { commandCandidates: ["npm test"] });
  const output = parseDraft(JSON.stringify(draftFor(task)), task);
  const rendered = renderDraft(task, output);
  const prd = parsePrd(rendered, "docs/prds/task-000000000000000000000000.md");
  assert.deepEqual(deliveryProfileFromPrd(prd), PROFILE);
  assert.equal(check(prd).ok, true);
  assert.equal(contractOf(prd).deliveryProfile.trim(), "```json\n" + stableProfile(PROFILE) + "\n```");
  const edited = rendered.replace('"action":"pull_request"', '"action":"merge"');
  const verdict = check(parsePrd(edited, prd.path));
  assert.equal(verdict.ok, false); assert.match(verdict.results.find(r => r.id === "criteria").detail, /not supported/);
  assert.notEqual(contractOf(parsePrd(edited, prd.path)).deliveryProfile, contractOf(prd).deliveryProfile, "editing the profile changes the contract");
  const doubled = rendered.replace("## Delivery profile", "## Delivery profile\n\n```json\n{}\n```\n\n## Delivery profile");
  assert.equal(check(parsePrd(doubled, prd.path)).ok, false);
});

test("mapping targets include explicit assumptions and planner output cannot author reserved questions", () => {
  const task = taskFor("Add CSV export.\nWe use Postgres in production.", { commandCandidates: ["npm test"] });
  const out = draftFor(task, { assumptions: { "r-2": "The Postgres note is context only; no database change is requested." } });
  const parsed = parseDraft(JSON.stringify(out), task);
  assert.deepEqual(parsed.mapping[1], { requirementId: "r-2", assumption: "The Postgres note is context only; no database change is requested." });
  assert.match(renderDraft(task, parsed), /r-2: "We use Postgres in production\." → assumption "The Postgres note is context only/);
  const missing = draftFor(task, { assumptions: { "r-2": "Not listed." } }); missing.assumptions = ["Export includes the currently visible rows."];
  assert.throws(() => parseDraft(JSON.stringify(missing), task), /must appear verbatim in assumptions/);
  const both = draftFor(task); both.mapping[1].assumption = both.assumptions[0];
  assert.throws(() => parseDraft(JSON.stringify(both), task), /criteria or one explicit assumption, not both/);
  const forged = draftFor(task); forged.questions = [{ id: "q-delivery-r-1", text: "Shall I merge?", requirements: ["r-1"] }]; forged.mapping[0] = { requirementId: "r-1", questionId: "q-delivery-r-1" };
  assert.throws(() => parseDraft(JSON.stringify(forged), task), /reserved for the delivery profile/);
  const badTag = draftFor(task); badTag.mapping[0].delivery = { action: "grant-merge" };
  assert.throws(() => parseDraft(JSON.stringify(badTag), task), /delivery tag action must be one of/);
  const legacy = taskFor("Add CSV export.", { deliveryProfile: undefined, route: undefined, modelRoute: undefined, repositoryContext: undefined, commandCandidates: ["npm test"] });
  const tagged = draftFor(legacy); tagged.mapping[0].delivery = { action: "pull_request" };
  assert.throws(() => parseDraft(JSON.stringify(tagged), legacy), /delivery tags require a typed delivery profile/);
  assert.equal(typedEraTask(legacy), false); assert.equal(savedProfile(legacy), null); assert.equal(profileView(legacy).legacy, true);
  // A typed-era record (planner route, snapshot or pinned model route) without a profile is damaged state, not a historical task.
  for (const orphan of [taskFor("Add CSV export.", { deliveryProfile: undefined, commandCandidates: ["npm test"] }), taskFor("Add CSV export.", { deliveryProfile: null, route: undefined, modelRoute: undefined, repositoryContext: { status: "unavailable" }, commandCandidates: ["npm test"] }), taskFor("Add CSV export.", { deliveryProfile: undefined, route: "harness", modelRoute: undefined, commandCandidates: ["npm test"] })]) {
    assert.equal(typedEraTask(orphan), true);
    assert.throws(() => savedProfile(orphan), { code: "TASK_PROFILE_UNSUPPORTED" });
    assert.throws(() => parseDraft(JSON.stringify(draftFor(orphan)), orphan), /typed delivery profile but none is saved/);
    const view = profileView(orphan);
    assert.equal(view.legacy, false); assert.equal(view.supported, false); assert.equal(view.error.code, "TASK_PROFILE_UNSUPPORTED");
  }
});

test("intake model configuration is validated, ceilings cannot be raised and secrets stay in the environment", () => {
  assert.deepEqual(intakeModelProblems(ROUTE), []);
  const validated = validateIntakeModelConfig(ROUTE);
  assert.equal(validated.budget.maxCalls, 3); assert.equal(validated.credentialEnv, "FIXTURE_MODEL_KEY");
  for (const [patch, pattern] of [
    [{ budget: { ...ROUTE.budget, max_calls: 4 } }, /max_calls must be an integer from 1 to 3/],
    [{ budget: { ...ROUTE.budget, max_input_tokens: 50001 } }, /max_input_tokens/],
    [{ budget: { ...ROUTE.budget, max_output_tokens: 6001 } }, /max_output_tokens/],
    [{ budget: { ...ROUTE.budget, allowance_usd: 0.11 } }, /allowance_usd/],
    [{ budget: { ...ROUTE.budget, input_usd_per_million: undefined } }, /input_usd_per_million/],
    [{ endpoint: "http://api.example-provider.com/v1" }, /HTTPS/],
    [{ endpoint: "https://localhost/v1" }, /public provider host/],
    [{ endpoint: "https://10.0.0.5/v1" }, /public provider host/],
    [{ endpoint: "https://user:pw@api.example-provider.com/v1" }, /HTTPS/],
    [{ adapter: "shell" }, /adapter must be one of/],
    [{ credential_env: "sk-live-123" }, /environment variable/],
    [{ api_key: "sk-live-123" }, /unknown key api_key/],
    [{ timeout_ms: 999999 }, /timeout_ms/],
  ]) assert.match(intakeModelProblems({ ...ROUTE, ...patch }).join("\n"), pattern, JSON.stringify(patch));
  assert.equal(MODEL_ROUTE_CEILINGS.allowanceUsd, 0.1);
  const disabled = intakeModelRoute({}, {});
  assert.equal(disabled.enabled, false); assert.match(disabled.reason, /intake_model is not configured/);
  const noKey = intakeModelRoute({ intake_model: ROUTE }, {});
  assert.equal(noKey.enabled, false); assert.match(noKey.reason, /export FIXTURE_MODEL_KEY/);
  assert.equal(intakeModelRoute({ intake_model: ROUTE }, { FIXTURE_MODEL_KEY: "k" }).enabled, true);
  const summary = intakeModelRouteSummary({ intake_model: ROUTE }, { FIXTURE_MODEL_KEY: "secret-value" });
  assert.doesNotMatch(JSON.stringify(summary), /secret-value|FIXTURE_MODEL_KEY|chat\/completions/);
  assert.equal(summary.endpointHost, "api.example-provider.com"); assert.deepEqual(summary.tools, []);
  // The whole operator config file validates the route together with everything else.
  const cfg = mergeConfig({ ...CONFIG, intake_model: { ...ROUTE, budget: { ...ROUTE.budget, allowance_usd: 1 } } }, CONFIG.home);
  assert.ok(validateConfig(cfg, CONFIG.home).some(problem => /allowance_usd/.test(problem)));
  assert.equal(validateConfig(mergeConfig({ ...CONFIG, intake_model: ROUTE }, CONFIG.home), CONFIG.home).filter(problem => /intake_model/.test(problem)).length, 0);
});

test("the model route records usage-derived cost, labels unknown billing honestly and never stores the key", async () => {
  const draft = JSON.stringify(draftFor(taskFor("Add CSV export.", { commandCandidates: ["npm test"] })));
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return response({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 800 } }); };
  const ctx = { config: { intake_model: ROUTE }, env: { FIXTURE_MODEL_KEY: "sk-fixture-secret-000000" }, fetch: fetcher };
  const task = taskFor("Add CSV export.", { commandCandidates: ["npm test"] }), store = memoryStore();
  const message = await prepareModelTurn(ctx, task, store, []);
  assert.equal(message, draft);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, ROUTE.endpoint); assert.equal(calls[0].init.redirect, "error");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.max_tokens, 6000); assert.equal(body.tools, undefined); assert.equal(body.functions, undefined); assert.equal(body.model, "fixture-model");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-fixture-secret-000000");
  const attempt = task.attempts[0];
  // The reservation bounds the complete billed request, not only the user prompt.
  assert.ok(attempt.estimate.inputTokens >= Buffer.byteLength(calls[0].init.body) + 64, "system message, framing fields and protocol margin are inside the bound");
  assert.ok(attempt.estimate.inputTokens > Buffer.byteLength(body.messages[1].content) + Buffer.byteLength(body.messages[0].content));
  assert.equal(attempt.route, "model"); assert.equal(isModelRouteReceipt(attempt.receipt), true); assert.equal(isModelRouteReceipt(attempt.receipt, task), true); assert.deepEqual(attempt.receipt.tools, []);
  // The receipt is bound to this task and its pinned route: a foreign task, route or model cannot replay it.
  assert.equal(isModelRouteReceipt(attempt.receipt, { ...task, id: "task-" + "1".repeat(24) }), false);
  assert.equal(isModelRouteReceipt(attempt.receipt, { ...task, route: "harness" }), false);
  assert.equal(isModelRouteReceipt(attempt.receipt, { ...task, modelRoute: { ...task.modelRoute, model: "other-model" } }), false);
  const foreign = taskFor("Add CSV export.", { id: "task-" + "2".repeat(24), commandCandidates: ["npm test"], attempts: [{ ...structuredClone(attempt), consumed: false }] });
  await assert.rejects(prepareModelTurn({ config: {}, env: ctx.env, fetch: async () => { throw new Error("must not call"); } }, foreign, memoryStore(), []), e => e.code === "TASK_PREPARATION_BOUNDARY" && /this task's text-only model route/.test(e.message));
  assert.deepEqual(attempt.usage, { inputTokens: 1200, outputTokens: 800 });
  assert.equal(attempt.cost, estimateUsd(validateIntakeModelConfig(ROUTE).budget, 1200, 800)); assert.equal(attempt.spend.status, "reported");
  assert.match(attempt.spend.basis, /not a provider invoice/);
  // Valid reported usage releases the pre-call reservation, so the allowance that follows this call is the reported spend, not the ceiling held during the call.
  assert.equal(attempt.reservedUsd, null); assert.ok(attempt.spend.releasedReservationUsd > attempt.cost); assert.equal(attempt.estimate.usd, attempt.spend.releasedReservationUsd);
  assert.equal(task.attempts.reduce((sum, a) => sum + Math.max(a.cost ?? 0, a.reservedUsd ?? 0), 0), attempt.cost, "the implementation allowance subtracts the reported cost only");
  assert.doesNotMatch(JSON.stringify(task) + JSON.stringify(store.saves), /sk-fixture-secret/);
  assert.ok(store.saves.length >= 2, "intent is persisted before the request and settled after it");
  assert.equal(store.saves[0].attempts[0].settled, false);
  // Without usage the cost is unknown, never zero, and the reservation stays as the bound.
  const silent = { ...ctx, fetch: async () => response({ choices: [{ message: { content: draft }, finish_reason: "stop" }] }) };
  const quiet = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await prepareModelTurn(silent, quiet, memoryStore(), []);
  assert.equal(quiet.attempts[0].cost, null); assert.equal(quiet.attempts[0].spend.status, "unknown"); assert.ok(quiet.attempts[0].reservedUsd > 0);
});

test("the model route stops before a call that would exceed its limits and rejects over-limit or truncated output", async () => {
  const draft = JSON.stringify(draftFor(taskFor("Add CSV export.", { commandCandidates: ["npm test"] })));
  const key = { FIXTURE_MODEL_KEY: "sk-fixture-key-333333" };
  let calls = 0;
  const ok = async () => { calls++; return response({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }); };
  // Call ceiling: three settled calls, the fourth is refused before any request.
  const exhausted = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  exhausted.attempts = Array.from({ length: 3 }, (_, i) => ({ name: `model-${i + 1}`, route: "model", settled: true, consumed: true, ok: true, cost: 0.001, reservedUsd: 0.001, startedAt: 1 }));
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, exhausted, memoryStore(), []), e => e.code === "TASK_ALLOWANCE" && /allows 3 calls/.test(e.message));
  assert.equal(calls, 0);
  // Input token ceiling, checked before the request.
  const big = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  big.context = [{ path: "docs/big.md", text: "word ".repeat(16_000), hash: "h" }];
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, withRoute(big, { ...ROUTE, budget: { ...ROUTE.budget, max_input_tokens: 20_000 } }), memoryStore(), []), e => e.code === "TASK_INPUT" && /input limit is 20000/.test(e.message));
  assert.equal(calls, 0);
  // Allowance pre-check: the estimate for one call exceeds what is left, so nothing is started and billing uncertainty is stated.
  const pricey = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, withRoute(pricey, { ...ROUTE, budget: { ...ROUTE.budget, allowance_usd: 0.05, output_usd_per_million: 10 } }), memoryStore(), []), e => e.code === "TASK_ALLOWANCE" && /the call was not started/.test(e.message) && /not provider invoices/.test(e.message));
  assert.equal(calls, 0); assert.deepEqual(pricey.attempts, []);
  // The task's own allowance also bounds the route.
  const capped = taskFor("Add CSV export.", { commandCandidates: ["npm test"], allowance: { budgetUsd: 0.0001, runtimeMs: 1000 } });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, capped, memoryStore(), []), { code: "TASK_ALLOWANCE" });
  assert.equal(calls, 0);
  // The remaining task runtime bounds the call's deadline, and too little remaining runtime refuses before the request.
  const spent = taskFor("Add CSV export.", { commandCandidates: ["npm test"], allowance: { budgetUsd: 5, runtimeMs: 1500 }, attempts: [{ route: "model", settled: true, consumed: true, ok: true, elapsedMs: 1000, cost: 0.001 }] });
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, spent, memoryStore(), []), e => e.code === "TASK_ALLOWANCE" && /500 ms left, below the 1000 ms/.test(e.message));
  assert.equal(calls, 0); assert.equal(spent.attempts.length, 1);
  const shortRun = taskFor("Add CSV export.", { commandCandidates: ["npm test"], allowance: { budgetUsd: 5, runtimeMs: 4000 }, attempts: [{ route: "model", settled: true, consumed: true, ok: true, elapsedMs: 1000, cost: 0.001 }] });
  await prepareModelTurn({ config: {}, env: key, fetch: ok }, shortRun, memoryStore(), []);
  assert.equal(shortRun.attempts[1].timeoutMs, 3000, "the deadline is capped to the remaining runtime rather than the configured timeout"); assert.equal(shortRun.attempts[1].deadline - shortRun.attempts[1].startedAt, 3000);
  calls = 0;
  // Truncated output is rejected with a bounded error; the call is still recorded with its usage.
  const truncated = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: async () => response({ choices: [{ message: { content: "{" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 6000 } }) }, truncated, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /incomplete/.test(e.message));
  assert.equal(truncated.attempts[0].ok, false); assert.equal(truncated.attempts[0].spend.status, "reported");
  // Over-limit output reported by the provider is rejected too.
  const over = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: async () => response({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 6001 } }) }, over, memoryStore(), []), /above the configured limit/);
  // Provider failures keep the reservation and report unknown billing; the message never echoes the key.
  const failing = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: { FIXTURE_MODEL_KEY: "sk-fixture-secret-111111" }, fetch: async () => response("denied", { status: 401 }) }, failing, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /HTTP 401/.test(e.message) && !/sk-fixture/.test(e.message));
  assert.equal(failing.attempts[0].spend.status, "unknown"); assert.ok(failing.attempts[0].reservedUsd > 0);
  const network = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: { FIXTURE_MODEL_KEY: "sk-fixture-secret-222222" }, fetch: async () => { throw new Error("connect ECONNREFUSED sk-fixture-secret-222222"); } }, network, memoryStore(), []), e => /failed/.test(e.message) && !/sk-fixture/.test(e.message));
  // A settled failure replays without a second request; a settled success replays its message.
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, network, memoryStore(), []), { code: "TASK_MODEL_ROUTE" });
  assert.equal(calls, 0);
  const replay = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, replay, memoryStore(), []);
  assert.equal(await prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, replay, memoryStore(), []), draft);
  assert.equal(calls, 1);
  // Disabled configuration is an actionable refusal, not a silent fallback.
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, taskFor("Add CSV export.", { modelRoute: undefined }), memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /no pinned model route/.test(e.message) && /no model call was made/.test(e.message));
  // A pinned route cannot carry budgets above the ceilings or run without its named credential.
  assert.throws(() => savedModelRoute({ ...pinned(ROUTE), budget: { ...pinned(ROUTE).budget, maxCalls: 9 } }), { code: "TASK_MODEL_ROUTE" });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: {}, fetch: ok }, taskFor("Add CSV export."), memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /export FIXTURE_MODEL_KEY/.test(e.message));
  assert.equal(calls, 1);
  // Settled output replays from its saved receipt without the credential and without a request; only a new call needs the key.
  const settled = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await prepareModelTurn({ config: {}, env: key, fetch: ok }, settled, memoryStore(), []);
  assert.equal(calls, 2); settled.attempts[0].consumed = false;
  assert.equal(await prepareModelTurn({ config: {}, env: {}, fetch: async () => { throw new Error("must not call"); } }, settled, memoryStore(), []), draft);
  assert.equal(calls, 2); assert.equal(settled.attempts.length, 1);
  calls = 1; // Restore the counter the later checks in this test were written against.
  // The Anthropic request shape is text-only too.
  const anthropic = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  let seen;
  withRoute(anthropic, { ...ROUTE, adapter: "anthropic-messages", endpoint: "https://api.example-provider.com/v1/messages" });
  await prepareModelTurn({ config: {}, env: key, fetch: async (url, init) => { seen = { url, init }; return response({ content: [{ type: "text", text: draft }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 7 } }); } }, anthropic, memoryStore(), []);
  assert.equal(seen.init.headers["x-api-key"], "sk-fixture-key-333333"); assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
  const anthropicBody = JSON.parse(seen.init.body);
  assert.equal(anthropicBody.tools, undefined); assert.equal(anthropicBody.max_tokens, 6000);
  assert.deepEqual(anthropic.attempts[0].usage, { inputTokens: 5, outputTokens: 7 });
  // The pre-call bound is one token per UTF-8 byte, so emoji and rare scripts
  // cannot slip under the ceiling or the spend reservation.
  assert.equal(estimateTokens("abcdef"), 6); assert.equal(estimateTokens("🚀".repeat(10)), 40); assert.equal(estimateTokens("日本語"), 9);
  const emoji = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  emoji.context = [{ path: "docs/emoji.md", text: "🚀".repeat(6_000), hash: "h" }];
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, withRoute(emoji, { ...ROUTE, budget: { ...ROUTE.budget, max_input_tokens: 20_000 } }), memoryStore(), []), e => e.code === "TASK_INPUT" && /input limit is 20000/.test(e.message));
  assert.equal(calls, 1);
  // Negative or malformed usage is a malformed response: it never becomes a spend record that could offset the allowance.
  for (const usage of [{ prompt_tokens: -900, completion_tokens: 10 }, { prompt_tokens: 10, completion_tokens: -50_000 }, { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: "10", completion_tokens: 10 }]) {
    const negative = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
    await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: async () => response({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage }) }, negative, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /usage is malformed/.test(e.message));
    assert.equal(negative.attempts[0].ok, false); assert.equal(negative.attempts[0].cost, null); assert.equal(negative.attempts[0].spend.status, "unknown"); assert.ok(negative.attempts[0].reservedUsd > 0);
  }
  // Reported input usage above the ceiling is rejected even when the byte bound passed.
  const overInput = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: async () => response({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 50_001, completion_tokens: 10 } }) }, overInput, memoryStore(), []), /reported 50001 input tokens, above the configured limit/);
  assert.equal(overInput.attempts[0].ok, false);
});

test("the model route enforces the response limit while streaming and keeps its deadline over a stalled body", async () => {
  const draft = JSON.stringify(draftFor(taskFor("Add CSV export.", { commandCandidates: ["npm test"] })));
  const key = { FIXTURE_MODEL_KEY: "sk-fixture-key-666666" };
  // A chunked body with no Content-Length is cancelled once the limit is crossed, before it is buffered.
  let pulls = 0, cancelled = false;
  const chunk = new Uint8Array(256 * 1024).fill(32);
  const endless = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(chunk); }, cancel() { cancelled = true; } });
  const big = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: async () => new Response(endless, { status: 200 }) }, big, memoryStore(), []), /exceeds the bounded limit/);
  assert.ok(pulls <= 6, `the reader stopped after ${pulls} chunks`); assert.equal(cancelled, true); assert.equal(big.attempts[0].spend.status, "unknown");
  // A well-formed streamed body still parses, with the usage it carries.
  const encoded = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30 } }));
  const streamed = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  const parts = [encoded.subarray(0, 100), encoded.subarray(100)];
  await prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: async () => new Response(new ReadableStream({ pull(controller) { if (parts.length) controller.enqueue(parts.shift()); else controller.close(); } }), { status: 200 }) }, streamed, memoryStore(), []);
  assert.deepEqual(streamed.attempts[0].usage, { inputTokens: 20, outputTokens: 30 }); assert.equal(streamed.attempts[0].message, draft);
  // Headers arrive promptly but the body never completes: the configured timeout aborts the read and settles the attempt.
  let stalledCancelled = false;
  const stalled = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { stalledCancelled = true; } });
  const hung = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  const startedAt = Date.now();
  withRoute(hung, { ...ROUTE, timeout_ms: 1000 });
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: async () => new Response(stalled, { status: 200 }) }, hung, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /did not complete within 1000 ms/.test(e.message));
  assert.ok(Date.now() - startedAt < 5000, "the stalled body was abandoned at the deadline"); assert.equal(stalledCancelled, true);
  assert.equal(hung.attempts[0].settled, true); assert.equal(hung.attempts[0].spend.status, "unknown");
  // A complete JSON prefix followed by a stream that never closes is cancelled at the deadline and must not be accepted as a draft.
  const prefix = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30 } }));
  let prefixSent = false, openCancelled = false;
  const openEnded = new ReadableStream({ pull(controller) { if (!prefixSent) { prefixSent = true; controller.enqueue(prefix); return; } return new Promise(() => {}); }, cancel() { openCancelled = true; } });
  const dangling = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  withRoute(dangling, { ...ROUTE, timeout_ms: 1000 });
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: async () => new Response(openEnded, { status: 200 }) }, dangling, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /did not complete within 1000 ms/.test(e.message));
  assert.equal(openCancelled, true); assert.equal(dangling.attempts[0].ok, false); assert.equal(dangling.attempts[0].message, undefined);
  // An error status whose body cancellation never settles is abandoned at the deadline instead of holding the task lock.
  const errorBody = { cancel: () => new Promise(() => {}) };
  const refused = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  withRoute(refused, { ...ROUTE, timeout_ms: 1000 });
  const refusedAt = Date.now();
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: async () => ({ ok: false, status: 503, body: errorBody }) }, refused, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /HTTP 503/.test(e.message));
  assert.ok(Date.now() - refusedAt < 5000, "the pending cancellation was abandoned at the deadline"); assert.equal(refused.attempts[0].settled, true); assert.equal(refused.attempts[0].spend.status, "unknown");
  // An oversized stream whose cancellation never settles is abandoned at the deadline too.
  const stuck = new ReadableStream({ pull(controller) { controller.enqueue(chunk); }, cancel() { return new Promise(() => {}); } });
  const stuckTask = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  withRoute(stuckTask, { ...ROUTE, timeout_ms: 1000 });
  const stuckAt = Date.now();
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: async () => new Response(stuck, { status: 200 }) }, stuckTask, memoryStore(), []), /exceeds the bounded limit/);
  assert.ok(Date.now() - stuckAt < 5000, "the stuck cancellation was abandoned at the deadline"); assert.equal(stuckTask.attempts[0].settled, true);
});

test("repository snapshots are read-only, bounded, exclude private and ignored paths and report unavailability", async () => {
  const revision = "a".repeat(40);
  const tree = ["src/app.mjs", ".env", "config/credentials.json", "keys/id_rsa", "build/out.js", "docs/a.md", "deploy.pem", "x\u0001y", "docs/removed.md"];
  const treeRequests = [];
  // The index holds a staged addition (not in the tree, never listed) and lacks a staged deletion (in the tree, excluded as unverified).
  const ruleRequests = [];
  const git = { revision: async () => revision, treePaths: async (_dir, rev) => { treeRequests.push(rev); return tree; }, indexPaths: async () => [...tree.filter(p => p !== "docs/removed.md"), "docs/staged-new.md"], ignoredTrackedPaths: async () => ["build/out.js"], ignoreRuleChanges: async (_dir, rev) => { ruleRequests.push(rev); return []; } };
  const snapshot = await repositorySnapshot(git, "/checkout");
  assert.equal(snapshot.status, "collected"); assert.equal(snapshot.revision, revision); assert.equal(snapshot.readOnly, true);
  assert.deepEqual(treeRequests, [revision], "the listing is enumerated from the recorded revision's tree");
  assert.deepEqual(ruleRequests, [revision, revision], "ignore rules are compared against the recorded revision before and after enumeration");
  // A .gitignore edit or a moved HEAD between the reads makes the collected state inconsistent: nothing is listed.
  let ruleCalls = 0;
  const racedRules = await repositorySnapshot({ ...git, ignoreRuleChanges: async () => ruleCalls++ === 0 ? [] : [".gitignore"] }, "/checkout");
  assert.equal(racedRules.status, "unavailable"); assert.match(racedRules.reason, /changed while the snapshot was being collected/); assert.deepEqual(racedRules.paths, []);
  let revisionCalls = 0;
  const racedHead = await repositorySnapshot({ ...git, revision: async () => revisionCalls++ === 0 ? revision : "b".repeat(40) }, "/checkout");
  assert.equal(racedHead.status, "unavailable"); assert.match(racedHead.reason, /changed while the snapshot was being collected/);
  // An index that changes between the listings (a staged deletion of a force-tracked ignored path) is detected by re-reading it afterwards.
  let indexCalls = 0;
  const racedIndex = await repositorySnapshot({ ...git, indexPaths: async () => { indexCalls++; return indexCalls === 1 ? [...tree, "docs/staged-new.md"] : tree.filter(p => p !== "build/out.js"); } }, "/checkout");
  assert.equal(racedIndex.status, "unavailable"); assert.match(racedIndex.reason, /revision, index or \.gitignore files changed/); assert.equal(indexCalls, 2);
  // An edited or untracked .gitignore means the rules in force are not the recorded revision's: nothing is listed or guessed.
  const diverged = await repositorySnapshot({ ...git, ignoreRuleChanges: async () => [".gitignore", "docs/.gitignore"] }, "/checkout");
  assert.equal(diverged.status, "unavailable"); assert.match(diverged.reason, /2 \.gitignore file\(s\) differ from the recorded revision/); assert.deepEqual(diverged.paths, []); assert.equal(diverged.digest, null);
  assert.deepEqual(snapshot.paths, ["docs/a.md", "src/app.mjs"]);
  assert.deepEqual(snapshot.counts, { tracked: 9, ignored: 1, private: 5, unverified: 1, listed: 2, truncated: 0 });
  assert.equal(snapshot.digest, sha(JSON.stringify({ revision, paths: ["docs/a.md", "src/app.mjs"] })));
  assert.notEqual((await repositorySnapshot({ ...git, revision: async () => "b".repeat(40) }, "/checkout")).digest, snapshot.digest, "the digest is pinned to the revision");
  const bulk = Array.from({ length: 1000 }, (_, i) => `src/file-${String(i).padStart(4, "0")}.mjs`);
  const many = await repositorySnapshot({ ...git, treePaths: async () => bulk, indexPaths: async () => bulk, ignoredTrackedPaths: async () => [], ignoreRuleChanges: async () => [] }, "/checkout");
  assert.equal(many.paths.length, REPOSITORY_CONTEXT_LIMITS.paths); assert.equal(many.counts.truncated, 1000 - REPOSITORY_CONTEXT_LIMITS.paths);
  for (const broken of [{}, { ...git, revision: async () => { throw new Error("fatal: not a git repository token=abc"); } }, { ...git, revision: async () => "HEAD" }]) {
    const result = await repositorySnapshot(broken, "/checkout", { secrets: ["abc"] });
    assert.equal(result.status, "unavailable"); assert.equal(result.digest, null); assert.deepEqual(result.paths, []); assert.doesNotMatch(result.reason, /abc/);
  }
  // A real repository through the production Git adapter.
  const home = tempHome(), repo = join(home, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "index.mjs"), "export const x = 1;\n"); writeFileSync(join(repo, ".env"), "SECRET=1\n"); writeFileSync(join(repo, "notes.log"), "ignored\n"); writeFileSync(join(repo, ".gitignore"), "*.log\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: home };
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"], ["add", "-f", "notes.log"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "force-add"]]) execFileSync("git", args, { cwd: repo, env, stdio: "ignore" });
  const real = await repositorySnapshot(makeGit({ config: { home, worktrees: join(home, "wt") } }), repo);
  assert.equal(real.status, "collected"); assert.match(real.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(real.paths, [".gitignore", "src/index.mjs"]); assert.equal(real.counts.ignored, 1); assert.equal(real.counts.private, 1);
});

test("duplicate statements preserve target occurrences, PR counts and mixed control scopes", () => {
  const targets = deliveryScreen("Open a PR against staging. ".repeat(4).trim(), PROFILE.target);
  assert.equal(targets.targetConflicts.length, 4);
  assert.ok(targets.targetConflicts.every(reason => reason === 'base "staging" differs from selected base "main"'));
  assert.ok(targets.escalated.includes("pull_request_count"));
  const mixed = deliveryScreen("Do not merge; merge it; do not merge; merge it; do not merge; merge it.", PROFILE.target);
  assert.ok(mixed.controlled.includes("merge")); assert.ok(mixed.uncontrolled.includes("merge"));
  assert.deepEqual(unaccountedTerms(mixed, { action: "restrict", prohibits: ["merge"] }), ["merge"]);
  assert.equal(deliveryScreen("Add a button to close PRs. ".repeat(4), PROFILE.target).tier, "assumption");
  const matching = deliveryScreen("Open a PR against staging.", { ...PROFILE.target, base: "staging" });
  assert.equal(matching.tier, "assumption", "statement cache never crosses target or call boundaries");
});

test("the screen and mapping stay fast at the request and mapping limits", () => {
  const wrapped = "Do not\n" + ("context ".repeat(31).trim() + "\n").repeat(126) + "open a pull request";
  assert.ok(Buffer.byteLength(wrapped) <= MAX_INPUT_BYTES);
  const clauses = fragments(wrapped), cpuStart = process.cpuUsage();
  let contextual;
  for (let i = 0; i < 20; i++) contextual = deliveryScreens(wrapped, clauses, PROFILE.target);
  const cpuUsed = process.cpuUsage(cpuStart);
  assert.equal(contextual.size, 128);
  assert.ok([...contextual.values()].every(screen => screen.controlled.includes("pull_request")));
  assert.ok((cpuUsed.user + cpuUsed.system) / 20000 < 50, "128 wrapped source spans reuse the bounded statement screen");

  const clause = "Implement export and merge the PR after approval; do not push until reviewed. ";
  const atLimit = (unit, prefix = "", suffix = "") => prefix + unit.repeat(Math.floor((MAX_INPUT_BYTES - Buffer.byteLength(prefix + suffix)) / Buffer.byteLength(unit))) + suffix;
  // Each test file runs in its own process. Charge work to this process, not
  // time that a parallel CI job leaves it waiting to be scheduled.
  const cases = [
    ["Post the test results to Slack. ", "question"],
    ["Run curl -X POST https://hooks.example.test/results. ", "question"],
    ["Run curl -X GET https://api.example.test/status. ", "none"],
    ["-H header:value ", "question", "curl ", "-X POST https://hooks.example.test/results"],
    ['Open a PR in "acme/widget" against `main`. ', "question"],
    ["Add a button to open a PR against `main`. ", "assumption"],
    ["Run npm owner add alice pkg. ", "question"],
    ["Run npm owner ls pkg. ", "none"],
    ["--registry x ", "question", "npm ", "owner add alice pkg"],
    ["--title x ", "question", "gh pr create ", "--draft"],
    ["Create a GitHub issue. ", "question"],
    ["Add a button to create a GitHub issue. ", "none"],
    ["--repo acme/widget ", "question", "gh issue ", "create"],
    ["--repo ", "none", "gh issue ", "list"],
    ["Push the image to ghcr.io/acme/app. ", "question"],
    ['Upload the package to "GitHub Packages". ', "question"],
    ["Run npm unpublish old-package. ", "question"],
    ["Run gh pr create --base staging. ", "question"],
    ["--title x ", "question", "gh pr create ", "--base staging"],
    ["--debug ", "question", "helm ", "upgrade api ./chart"],
    [clause, "question"],
    ["'npm publish' ", "none"],
    ['Run `npm publish`. ', "question"],
    ["landing ", "none"], ["landed ", "none"],
    ["Add a command to land changes. ", "none"],
    ["Land the PR after CI passes. ", "question"],
    ["Run git push origin HEAD. ", "assumption"],
    ["Run git push --tags. ", "question"],
    ["Close pull request #123. ", "question"],
    ["Add a button to close PRs. ", "assumption"],
    ["Ask me before opening a PR. ", "question"],
    ["Review pull request #123 and leave feedback. ", "question"],
    ["Run gh api -X POST repos/acme/widget/hooks. ", "question"],
    ["-H x:y ", "question", "gh api ", "-f active=true repos/acme/widget/hooks"],
    ["Run gh api -X GET repos/acme/widget. ", "none"],
    ["Push main to origin. ", "question"],
    ["Run aws s3 cp build.zip s3://bucket/a. ", "question"],
    ["Run aws s3 cp s3://bucket/a ./a. ", "none"],
    ["Run pulumi up. ", "question"],
    ["Run pulumi preview. ", "none"],
    ["Run terraform apply. ", "question"],
    ["Add a command to run terraform apply. ", "none"],
  ];
  for (const [unit, tier, prefix, suffix] of cases) {
    const input = atLimit(unit, prefix, suffix), bytes = Buffer.byteLength(input);
    assert.ok(bytes <= MAX_INPUT_BYTES, "performance fixtures must fit the accepted request byte limit");
    assert.ok(bytes > MAX_INPUT_BYTES - Buffer.byteLength(unit), "fixtures fill the byte allowance to within one complete unit");
    const started = process.hrtime.bigint(), cpuStarted = process.cpuUsage();
    let screen;
    for (let i = 0; i < 20; i++) screen = deliveryScreen(input);
    const wallPerCall = Number(process.hrtime.bigint() - started) / 20 / 1e6;
    const cpu = process.cpuUsage(cpuStarted), perCall = (cpu.user + cpu.system) / 20 / 1000;
    assert.equal(screen.tier, tier, "maximum-size examples and commands retain their interpretation");
    assert.ok(perCall < 50, `screening a ${Buffer.byteLength(input)} byte request took ${perCall.toFixed(1)} CPU ms (${wallPerCall.toFixed(1)} wall ms)`);
  }
  const lines = Array.from({ length: 64 }, (_, i) => `Merge ${i + 1}.`).join("\n");
  const task = taskFor(lines, { commandCandidates: ["npm test"] });
  const out = draftFor(task);
  const parseStart = process.hrtime.bigint();
  const parsed = parseDraft(JSON.stringify(out), task);
  renderDraft(task, parsed);
  const elapsed = Number(process.hrtime.bigint() - parseStart) / 1e6;
  assert.equal(parsed.questions.length, 64, "every escalating clause is screened");
  assert.ok(elapsed < 2000, `parsing and rendering 64 screened clauses took ${elapsed.toFixed(0)} ms`);
  assert.ok(Buffer.byteLength(draftPrompt(task)) < 120 * 1024);
});

test("the vendored validator and fixture corpus are pinned byte-for-byte with their schema version", () => {
  const saved = savedContract(), current = currentContract();
  assert.deepEqual(contractDrift(), [], "run npm run contract:intake -- --write after reviewing a validator change");
  assert.equal(saved.fragmentVersion, FRAGMENT_VERSION); assert.equal(saved.profileVersion, PROFILE_VERSION); assert.equal(saved.validator, "lib/task_profile.mjs");
  assert.equal(saved.files["lib/task_profile.mjs"], sha(readFileSync(new URL("../lib/task_profile.mjs", import.meta.url))));
  assert.equal(current.files["templates/plugin/task-profile-requests.mjs"], saved.files["templates/plugin/task-profile-requests.mjs"]);
  // Both pinned files live under packaged paths, so the published artifact carries the exact corpus.
  const packaged = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).files;
  for (const path of Object.keys(saved.files)) assert.ok(packaged.some(entry => path === entry || path.startsWith(entry + "/")), `${path} is inside the package allowlist`);
  assert.match(saved.upgrade, /task-intake-vendor-sync/);
  // The vendored validator loads on its own: no imports, so the pinned hash covers every rule it applies.
  const source = readFileSync(new URL("../lib/task_profile.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m); assert.doesNotMatch(source, /\brequire\(/);
  assert.deepEqual([...COMPLETION_CONDITIONS], COMPLETION_SCHEMA.properties.target.enum, "the self-contained copy of the completion conditions matches the coordinator schema");
});
