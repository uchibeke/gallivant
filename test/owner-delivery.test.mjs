import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerDelivery, ownerImplementation, validateOwnerDelivery, ownerDeliveryFromPrd, assertDeliveryAnswer } from "../lib/owner_delivery.mjs";
import { completionView } from "../lib/task_completion.mjs";
import { parsePrd, prdFingerprint, contractOf, contractDiff, check } from "../lib/prd.mjs";
import { GOOD_PRD } from "./helpers.mjs";
import { workflowRequests, applicationRequests, publicationTemporalConnectors, publicationTailConnectors } from "./fixtures/owner-actions.mjs";

test("merge and Git artifact instructions cannot alter new-task delivery authority", () => {
  for (const text of workflowRequests) {
    for (const prefix of ["", "Implement export. Open a PR for review. "])
      assert.throws(() => ownerDelivery(prefix + text), { code: "TASK_DELIVERY_SCOPE" }, prefix + text);
    for (const task of [{}, { completion: { version: 1, target: "delivery_ready" } }])
      assert.throws(() => assertDeliveryAnswer(task, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
});

test("application publishing, delivery and merge requirements remain exact provider scope", () => {
  for (const text of applicationRequests) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
    const source = text + " Open a PR for review.", contract = ownerDelivery(source);
    assert.equal(ownerImplementation(contract).join(""), text + " ", text);
    assert.equal(contract.spans.map(span => source.slice(span.start, span.end)).join(""), source);
    for (const restriction of ["Do not push.", "Please merge it.", "Do not create a branch."])
      assert.throws(() => ownerDelivery(text + " " + restriction), { code: "TASK_DELIVERY_SCOPE" }, text + restriction);
  }
});

test("synthetic pull requests in test fixtures are not delivery requests", () => {
  for (const text of [
    "Generate a dummy PR in the unit test.",
    "Create a fabricated pull request for the test fixture.",
    "Create a synthetic review PR in integration tests.",
    "Create an example PR in tests.",
    "Generate a fixture PR for tests.",
    "Create one hundred mock PR fixtures for unit tests.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  for (const text of [
    "Generate a public PR for review in the unit test.",
    "Create a fabricated pull request for review in the test fixture.",
    "Create a PR in the unit test.",
    "Generate a test PR in the unit test.",
    "For tests, create one hundred mock PRs on GitHub.",
    "For tests, create a fake PR on GitHub.",
    "For tests, create a non-fake PR.",
    "For tests, create a not-fake PR.",
    "For tests, create a non fake PR.",
    "In the integration test, create a non-synthetic PR.",
    "Create a non-mock PR in the unit test.",
    "Create a non‑dummy pull request for the test fixture.",
  ]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  const mixed = "Generate a dummy PR in the unit test. Open a PR for review.";
  const contract = ownerDelivery(mixed);
  assert.equal(ownerImplementation(contract).join(""), "Generate a dummy PR in the unit test. ");
  assert.equal(contract.spans.at(-1).owner, "coordinator");
  assert.throws(() => assertDeliveryAnswer({}, "Generate a dummy PR in the unit test. Open a PR for review."), { code: "TASK_DELIVERY_SCOPE" });
});

test("fixture labels cannot hide review requests within the publication action", () => {
  for (const action of ["submit a fake PR", "create a mock pull request", "generate synthetic PRs"])
    for (const label of ["", "fixture", "fixtures", "test data", "fixture data", "test object", "test objects", "as test data"])
      for (const review of ["review", "human review", "code review"]) {
        const source = `For tests, ${action} ${label ? label + " " : ""}for ${review}.`;
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
  for (const source of [
    "For tests, create a fake PR fixture and a mock PR test object for review.",
    "For tests, create a fake PR fixture and submit that fixture data for code review.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const source of [
    "For tests, create a fake PR fixture.",
    "For tests, create a fake PR fixture and draft a report for review.",
    "For tests, create a fake PR fixture, then upload logs for code review.",
    "For tests, create a fake PR fixture before uploading logs for code review.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("repeated fixture clauses stay bounded and a live repository target stays visible", () => {
  const fixtures = Array(1100).fill("For tests, create a fake PR").join(", ") + ".";
  assert.ok(Buffer.byteLength(fixtures) < 32 * 1024);
  assert.equal(ownerDelivery(fixtures), null);
  const live = "For tests, create one hundred mock PRs on GitHub.";
  assert.throws(() => ownerDelivery(live), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, live), { code: "TASK_DELIVERY_SCOPE" });
  // A Git destination counts only inside the synthetic action's own clause.
  for (const text of ["For tests, create a fake PR fixture and upload logs to GitHub.", "For tests, create a fake PR fixture, then upload logs to GitHub.",
    "For tests, create a fake PR fixture before uploading logs to GitHub.",
    "For tests, create a fake PR fixture after uploading logs to GitHub.",
    "For tests, create a fake PR fixture while uploading logs to GitHub.",
    "For tests, create a fake PR fixture and upload logs via GitHub.",
    "For tests, create a fake PR fixture and upload logs in a GitHub repository.",
    "For tests, create a fake PR fixture and upload logs in our GitHub repository.",
    "For tests, create a fake PR fixture / upload logs inside our GitHub repository.",
    "For tests, create a fake PR fixture from fixtures/requests in the unit test.",
    "For tests, create a fake PR fixture using a local GitHub mock."]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  for (const text of ["For tests, create a fake PR on GitHub.", "For tests, create a fake PR against the upstream repository.", "For tests, create a fake PR fixture and a mock PR on GitHub.",
    "For tests, create a fake PR fixture via GitHub.",
    "For tests, create a fake PR fixture through GitHub.",
    "For tests, create a fake PR fixture using GitHub.",
    "For tests, create a fake PR fixture to our origin.",
    "For tests, create a fake PR fixture from fixtures/requests inside our GitHub repository.",
    "For tests, create a fake PR fixture and open it via GitHub."]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const forge of ["GitHub", "GitLab"]) for (const determiner of ["a", "an", "the", "my", "our", "your", "their", "his", "her", "its"])
    for (const action of ["", "and open it "]) for (const preposition of ["in", "inside", "within"]) {
      const source = `For tests, create a fake PR fixture ${action}${preposition} ${determiner} ${forge} repository.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
});

test("fixture destinations recognize forge URLs within their own action", () => {
  for (const host of ["github.com", "gitlab.com"]) for (const url of [
    `https://${host}/acme/widget`, `https://git@${host}/acme/widget.git`,
    `ssh://git@${host}/acme/widget.git`, `git@${host}:acme/widget.git`,
  ]) {
    for (const action of ["at", "via", "and open it at"]) {
      const source = `For tests, create a fake PR fixture ${action} ${url}.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
    for (const connector of ["and upload", "before uploading", "/ upload"]) {
      const source = `For tests, create a fake PR fixture ${connector} logs to ${url}.`;
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const contract = ownerDelivery(source + " Open a PR for review.");
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    }
  }
  const source = "For tests, create a fake PR fixture using a mock at https://github.com.example.invalid/acme/widget.";
  assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" });
});

test("forge subdomains and quoted URL data retain fixture clause boundaries", () => {
  for (const host of ["www.github.com", "ssh.github.com", "www.gitlab.com", "group.gitlab.com"])
    for (const url of [`https://${host}/acme/widget`, `ssh://git@${host}:443/acme/widget.git`, `git@${host}:acme/widget.git`]) {
      for (const action of ["at", "and open it at"]) {
        const source = `For tests, create a fake PR fixture ${action} ${url}.`;
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
      const source = `For tests, create a fake PR fixture and upload logs to ${url}.`;
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const original = source + " Open a PR for review.", contract = ownerDelivery(original);
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
      assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
    }
  for (const url of ["https://www.github.com.example.invalid/acme/widget", "https://notgithub.com/acme/widget",
    "https://github.com@example.invalid/acme/widget", "ssh://git@www.gitlab.com.example.invalid/acme/widget.git"]) {
    const source = `For tests, create a fake PR fixture using a mock at ${url}.`;
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    const data = `For tests, create a fake PR fixture using a mock with URL "${url}".`;
    assert.equal(ownerDelivery(data), null, data);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, data), data);
  }
});

test("fixture publication cannot target an explicit network endpoint on any forge", () => {
  for (const url of ["https://bitbucket.org/acme/widget", "https://codeberg.org/acme/widget", "https://git.example.net/acme/widget",
    "ssh://git@git.sr.ht/~acme/widget", "git@forge.example.net:acme/widget.git", "git+ssh://git@forge.example.net/acme/widget.git", "a@b:."])
    for (const action of ["at", "via", "in", "inside", "within", "and open it at", "and open it in", "and upload it to"]) {
      const source = `For tests, create a fake PR fixture ${action} ${url}.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "For tests, create a fake PR fixture and upload logs to https://bitbucket.org/acme/widget.",
    "For tests, create a fake PR fixture before uploading logs to ssh://git@forge.example.net/acme/widget.git.",
    'For tests, create a fake PR fixture with the URL field "https://bitbucket.org/acme/widget".',
    "For tests, create a fake PR fixture at ./fixtures/request.json.",
    "For tests, create a fake PR fixture at file:///tmp/request.json.",
    "For tests, create a fake PR fixture in our repository fixtures directory.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("scheme-less fixture endpoints retain live destination and local path boundaries", () => {
  for (const endpoint of ["www.github.com/acme/widget", "github.com/acme/widget", "bitbucket.org/acme/widget",
    "forge.example.net:8443/acme/widget", "localhost:3000/acme/widget", "127.0.0.1:3000/acme/widget",
    "[::1]:3000/acme/widget", "//git.example.net/acme/widget"])
    for (const action of ["at", "via", "inside", "within", "and open it at", "and upload it to"]) {
      const source = `For tests, create a fake PR fixture ${action} ${endpoint}.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "For tests, create a fake PR fixture and upload logs to www.github.com/acme/widget.",
    "For tests, create a fake PR fixture before uploading logs to forge.example.net:8443/acme/widget.",
    "For tests, create a fake PR fixture / upload logs to bitbucket.org/acme/widget.",
    'For tests, create a fake PR fixture with the URL field "www.github.com/acme/widget".',
    "For tests, create a fake PR fixture at fixtures/github.com/acme/widget.json.",
    "For tests, create a fake PR fixture at ./www.github.com/acme/widget.json.",
    "For tests, create a fake PR fixture at file:///tmp/www.github.com/acme/widget.json.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("SCP fixture destinations support omitted usernames without masking local paths", () => {
  for (const endpoint of ["example.com:acme/widget", "forge:acme/widget", "localhost:acme/widget",
    "[::1]:acme/widget", "git@example.com:acme/widget", "git@[::1]:acme/widget", "example.com:/srv/widget"])
    for (const action of ["at", "via", "within", "and open it at", "and upload it to"]) {
      const source = `For tests, create a fake PR fixture ${action} ${endpoint}.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "For tests, create a fake PR fixture and upload logs to example.com:acme/widget.",
    'For tests, create a fake PR fixture with the URL field "example.com:acme/widget".',
    "For tests, create a fake PR fixture at ./example.com:acme/widget.json.",
    "For tests, create a fake PR fixture at fixtures/example.com:acme/widget.json.",
    "For tests, create a fake PR fixture at file:///tmp/example.com:acme/widget.json.",
    "For tests, create a fake PR fixture at C:/fixtures/widget.json.",
    "For tests, create a fake PR fixture at C:\\fixtures\\widget.json.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("publication fixture masking cannot hide coordinated live PRs", () => {
  for (const connector of ["plus", "+", "/", "as well as", "along with", "alongside", "together with", "in addition to", "not to mention", "besides", "versus", "vs", "vs.", "compared with", "compared to", "but", "yet"]) {
    const source = `For tests, create a fake PR ${connector} a real PR.`;
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  assert.equal(ownerDelivery("For tests, create a fake PR plus a synthetic PR fixture."), null);
  assert.equal(ownerDelivery("For tests, create a fake PR fixture + a synthetic PR fixture."), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, "For tests, create a fake PR fixture + a synthetic PR fixture."));
  assert.equal(ownerDelivery("For tests, create a fake PR alongside a synthetic PR fixture."), null);
  for (const separator of [" / ", "/", " /", "/ "]) {
    const live = `For tests, create a fake PR fixture${separator}a real PR.`;
    assert.throws(() => ownerDelivery(live), { code: "TASK_DELIVERY_SCOPE" }, live);
    assert.throws(() => assertDeliveryAnswer({}, live), { code: "TASK_DELIVERY_SCOPE" }, live);
    const synthetic = `For tests, create a fake PR fixture${separator}a synthetic PR fixture.`;
    assert.equal(ownerDelivery(synthetic), null, synthetic);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, synthetic), synthetic);
  }
  for (const connector of ["but", "yet"]) {
    const source = `For tests, create a fake PR fixture ${connector} a synthetic PR fixture.`;
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
  for (const connector of ["versus", "vs", "vs.", "compared with", "compared to"]) {
    const source = `For tests, create a fake PR fixture ${connector} a synthetic PR fixture.`;
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
  const liveDestination = "For tests, create a fake PR fixture vs. a mock PR on GitHub.";
  assert.throws(() => ownerDelivery(liveDestination), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, liveDestination), { code: "TASK_DELIVERY_SCOPE" });
  const laterLivePr = "For tests, create a fake PR fixture before sending a real PR to GitHub.";
  assert.throws(() => ownerDelivery(laterLivePr), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, laterLivePr), { code: "TASK_DELIVERY_SCOPE" });
});

test("synthetic fixtures cannot hide a live modifier on one PR noun", () => {
  for (const source of [
    "For tests, create both fake and real PRs.",
    "For tests, create fake or actual PRs.",
    "For tests, create fake + genuine PRs.",
    "For tests, create fake/real PRs.",
    "For tests, create fake, mock, and real PRs.",
    "For tests, create fake as well as real PRs.",
    "For tests, create mock but live PRs.",
    "For tests, create dummy yet actual PRs.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const source of [
    "For tests, create both fake and mock PRs.",
    "For tests, create fake + synthetic PRs.",
    "For tests, create fake/mock PRs.",
    "For tests, create fake as well as mock PRs.",
    "For tests, create mock but dummy PRs.",
    "For tests, create fake and real PR dashboard cards.",
    "For tests, create a fake and accessible PR UI.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("synthetic fixtures do not mask referential live publication actions", () => {
  for (const source of [
    "For tests, create a fake PR fixture and open it on GitHub.",
    "For tests, create a fake PR fixture, then submit it to the remote repository.",
    "For tests, create a fake PR fixture + publish it on GitLab.",
    "For tests, create a fake PR fixture / open it within our GitLab repository.",
    "For tests, create a fake PR fixture and upload it to GitHub.",
    "For tests, create a fake PR fixture before opening it on GitHub.",
    "For tests, create a fake PR fixture. Open it on GitHub.",
    "For tests, create a fake PR fixture and submit it for review.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const source of [
    "For tests, create a fake PR fixture and open it in the test UI.",
    "For tests, create a fake PR fixture + upload logs to GitHub.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("subordinating clauses after product PR conditions retain delivery controls", () => {
  for (const connector of ["where", "even though", "though", "because", "since", "given that"]) {
    const source = `The button creates a PR after tests pass ${connector} PRs must not be published.`;
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  const laterCondition = "The button creates a PR after tests pass since PRs only after human review.";
  assert.throws(() => ownerDelivery(laterCondition), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, laterCondition), { code: "TASK_DELIVERY_SCOPE" });
  for (const source of [
    "The button creates a PR after tests pass since changes must not be merged.",
    "The button creates a PR after tests pass since work must not be merged.",
    "The button creates a PR after tests pass since we must keep changes local.",
    "The button creates a PR after tests pass since my approval is required.",
    "Changes must not be merged.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const source of [
    "The button creates a PR after tests pass where the user can inspect it.",
    "The button creates a PR after tests pass even though retries are enabled.",
    "The button creates a PR after tests pass since the queue is ready.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("product-condition tails retain later publication directives", () => {
  for (const connector of ["provided that", "assuming that", "as long as"])
    for (const publication of ["you open another PR", "we generate a new pull request", "you submit a PR for review", "have the team create a PR"]) {
      const source = `The button creates a PR after tests pass ${connector} ${publication}.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "The button creates a PR after tests pass provided that the form is valid.",
    "The button creates a PR after tests pass provided that you create a PR template.",
    "The button creates a PR after tests pass provided that you generate a daily report about PRs.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("passive merge controls recognize shared negative modals before product masking", () => {
  for (const control of ["cannot", "can't", "can’t", "couldn't", "couldn’t", "mustn't", "shouldn't", "won't", "wouldn't", "isn't", "aren't", "might not", "would not", "must never"])
    for (const restriction of [`Changes ${control} be merged.`, `Work ${control} be merged.`])
      for (const source of [restriction, "The button creates a PR after tests pass since " + restriction.toLowerCase()]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
  for (const source of [
    "The button creates a PR after tests pass since the queue is ready for merging.",
    'Show the warning "Changes cannot be merged" in the PR dialog.',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
  }
});

test("modified passive controls remain visible without swallowing application data", () => {
  for (const restriction of [
    "Changes cannot ever be merged.", "Work can't automatically be merged.", "Code can’t really ever be merged.",
    "PRs must not immediately be silently merged.", "Changes must never again be merged.",
    "Changes are not ever to be merged.", "Code is not to ever be merged.", "Work is not to be automatically merged.",
    "Commits must not automatically be created.", "Commits must never again be written.", "Commits cannot naïvely be written.",
    "Git branches cannot ever be generated.", "Git branches are not to ever be created.",
  ])
    for (const source of ["The button creates a PR after tests pass since " + restriction.toLowerCase(), restriction]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "Customer records cannot ever be merged.",
    "The button creates a PR after tests pass since customer records cannot ever be merged.",
    "Bank branches cannot automatically be created without an address.",
    'Show the warning "Changes cannot ever be merged" in the PR dialog.',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("passive branch merge controls distinguish application domains from Git", () => {
  for (const source of [
    "Syntax tree branches cannot ever be merged.",
    "Bank branches must not ever be merged.",
    "Syntax tree branch cannot ever be merged.",
    "Bank branches are not to be silently merged.",
    "Branches cannot ever be merged in the syntax tree.",
    "Branches must not ever be merged across the bank network.",
    "Bank branches cannot be created without an address. Syntax tree branches cannot ever be merged.",
    "Syntax tree branches cannot ever be merged. Bank branches cannot be created without an address.",
    "The button creates a PR after tests pass. Bank branches must not ever be merged.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
  for (const source of [
    "Branches cannot ever be merged.",
    "Branch must not ever be merged.",
    "Git branches must not ever be merged.",
    "Branches cannot ever be merged in the repository.",
    "Branches cannot ever be merged in GitLab.",
    "Branches cannot ever be generated in GitLab.",
    "Syntax tree branches cannot ever be merged into origin/main.",
    "The button creates a PR after tests pass since branches cannot ever be merged.",
    "Syntax tree branches cannot ever be merged. Branches must not ever be merged.",
    "Syntax tree branches cannot ever be merged. Changes cannot ever be merged.",
    "Syntax tree branches cannot ever be merged and branches must not ever be merged.",
    "Branches cannot ever be merged and customer records remain in the bank network.",
    "Bank branches cannot be created without an address. Git branches cannot ever be generated.",
    "Bank branches cannot be created without an address. Commits must not automatically be created.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
});

test("passive code merges distinguish application destinations from Git controls", () => {
  // Active merges share the destination validator with the passive exception.
  for (const source of ["Merge arrays inside the editor.", "Merge records within the editor."]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
  for (const subject of ["Code", "Changes", "Edits", "Work", "Implementation"])
    for (const destination of ["into one cell", "in the editor", "within the document editor"])
      for (const source of [
        `${subject} cannot be merged ${destination}.`,
        `${subject} must not ever be merged ${destination}.`,
        `The button creates a PR after tests pass since ${subject.toLowerCase()} cannot be merged ${destination}.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  for (const source of [
    "Code cannot be merged.",
    "Changes cannot ever be merged.",
    "Reviewed changes cannot be merged.",
    "Code cannot be merged into main.",
    "Changes cannot be merged into origin/main.",
    "Work cannot be merged in the repository.",
    "Implementation cannot be merged in GitLab.",
    "Code cannot be merged in the editor into main.",
    "Code cannot be merged into one cell and main.",
    "Code cannot be merged in the editor or origin/main.",
    "Merge arrays inside main.",
    "Merge records within origin/main.",
    "Changes cannot be merged into one cell in the repository.",
    "PRs cannot be merged in the editor.",
    "Code cannot be merged and records remain in the editor.",
    "Code cannot be merged into one cell. Changes cannot be merged.",
    "Code cannot be merged into one cell and changes cannot be merged.",
    "The button creates a PR after tests pass since changes cannot be merged.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
});

test("infinitive passive prohibitions stay visible before product masking", () => {
  for (const restriction of [
    "Changes are not to be merged.", "Work is not to be merged.", "PRs aren't to be merged.",
    "Changes are never to be merged.", "Code is never to be merged.", "Implementation isn’t to be merged.",
    "Commits are not to be created.", "Git branches are not to be generated.",
  ])
    for (const source of [restriction, "The button creates a PR after tests pass since " + restriction.toLowerCase()]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "Customer records are not to be merged.",
    "The button creates a PR after tests pass since customer records are not to be merged.",
    "Bank branches are not to be created without an address.",
    'Show the warning "Changes are not to be merged" in the PR dialog.',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("merge commands remain visible when branch names look like feature predicates", () => {
  for (const source of ["Merge mergeable branches.", "Squash-merge selectable branches.", "Merge only mergeable branches."]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  assert.equal(ownerDelivery("Add a mergeable branch selector."), null);
  assert.equal(ownerDelivery("Add a squash-merge settings panel."), null);
});

test("delegated application publication recognizes product surfaces before actors", () => {
  for (const subject of ["the button", "the submit button", "our webhook handler", "the service", "the Dashboard"])
    for (const [lead, action] of [["Ensure", "creates"], ["Have", "create"], ["Let", "open"], ["Get", "to create"]]) {
      const source = `${lead} ${subject} ${action} a PR.`;
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const contract = ownerDelivery(source + " Open a PR for review.");
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    }
  const conditional = "Ensure the button creates a PR after tests pass.";
  assert.equal(ownerDelivery(conditional), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, conditional));
  for (const source of [
    "Ensure the button creates a PR after tests pass since changes must not be merged.",
    "Ensure the button creates a PR, and PRs must not be published.",
    "Have the button create a PR, then have John create a PR.",
    "Ensure the developer creates a PR.",
    "Ensure the team creates a PR.",
    "Ensure John creates a PR.",
    "Ensure alex creates a PR.",
    "Ensure the automation creates a PR.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
});

test("actor-led publication stays visible after coordinated product actions", () => {
  const actors = ["the agent", "our developer", "the team", "the automation", "human agent", "John", "Jane Doe", "alex"];
  const connectors = ["and", "and then", "but", "then", "as well as", ",", "&", "+", " / "];
  for (const actor of actors)
    for (const connector of connectors) {
      const source = `Ensure the button creates a PR after tests pass ${connector} ${actor} opens another PR.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "The agent opens another PR.",
    "The developer submits a pull request.",
    "Ensure the button creates a PR after tests pass provided that the agent opens another PR.",
    "Ensure the button creates a PR, and the team creates another PR.",
    "Clicking submit creates a PR and the agent opens another PR.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const source of [
    "Ensure the button creates a PR after tests pass and the service opens another PR.",
    "The button opens a PR and our webhook handler creates another PR.",
    "Clicking submit creates a PR and the service opens another PR.",
    "Ensure the button creates a PR after tests pass and the agent creates a PR template.",
    "Ensure the button creates a PR after tests pass and the agent generates a report about PRs.",
    'Show the example "the agent opens another PR" in the button help.',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("actor publication uses every current publication verb and its inflections", () => {
  const verbs = [
    ["file", "files", "filed", "filing"], ["issue", "issues", "issued", "issuing"],
    ["publish", "publishes", "published", "publishing"], ["deliver", "delivers", "delivered", "delivering"],
    ["draft", "drafts", "drafted", "drafting"], ["generate", "generates", "generated", "generating"],
    ["prepare", "prepares", "prepared", "preparing"], ["send", "sends", "sent", "sending"],
    ["produce", "produces", "produced", "producing"], ["start", "starts", "started", "starting"],
    ["begin", "begins", "began", "beginning"], ["open", "opens", "opened", "opening"],
    ["create", "creates", "created", "creating"], ["raise", "raises", "raised", "raising"],
    ["submit", "submits", "submitted", "submitting"], ["make", "makes", "made", "making"],
  ];
  for (const [base, third, past, gerund] of verbs) {
    for (const source of [
      `The button creates a PR after tests pass and the agent ${third} another PR.`,
      `Ensure the button creates a PR after tests pass provided that Mary Jane Watson ${third} another PR.`,
      `Mary Jane Watson quickly ${third} a PR.`,
      `Ensure the agent ${base} a PR.`,
      `The agent ${past} a PR.`,
      `The agent ${gerund} a PR.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
    for (const source of [
      `The button ${third} a PR after tests pass.`,
      `Ensure the button ${third} a PR after tests pass.`,
      `The button can ${base} a PR after tests pass.`,
      `The button creates a PR after tests pass and the service ${third} another PR.`,
      `The button creates a PR after tests pass and the agent ${third} a PR template.`,
      `The button creates a PR after tests pass and the agent ${third} a report about PRs.`,
      `Show the example "the agent ${third} another PR" in the button help.`,
    ]) {
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const original = source + " Open a PR for review.", contract = ownerDelivery(original);
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
      assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
    }
  }
});

test("API, parser and serializer product behavior retains implementation scope", () => {
  for (const surface of ["API", "parser", "serializer"]) {
    for (const source of [
      `The ${surface} generates a PR object.`,
      `The ${surface} creates a PR node.`,
      `Ensure the ${surface} creates a PR object.`,
      `The ${surface} generates a PR after tests pass.`,
      `The button creates a PR after tests pass and the ${surface} creates another PR object.`,
    ]) {
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const original = source + " Open a PR for review.", contract = ownerDelivery(original);
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
      assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
    }
    for (const control of ["and the agent opens another PR", "provided that you open another PR", "since changes cannot be merged"])
      for (const text of [`The ${surface} generates a PR after tests pass ${control}.`, `Ensure the ${surface} creates a PR object ${control}.`]) {
        assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
        assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
      }
  }
});

test("conjunctive adverbs keep later actor publications outside product masks", () => {
  for (const reviewed of [
    "The button creates a PR after tests pass, alternatively the agent opens another PR.",
    "The button creates a PR after tests pass, conversely the agent opens another PR.",
    "The button creates a PR after tests pass, likewise the agent opens another PR.",
  ]) {
    assert.throws(() => ownerDelivery(reviewed), { code: "TASK_DELIVERY_SCOPE" }, reviewed);
    assert.throws(() => assertDeliveryAnswer({}, reviewed), { code: "TASK_DELIVERY_SCOPE" }, reviewed);
  }
  for (const separator of ["&", "+", "/"])
    for (const modifier of ["also", "additionally", "likewise", "similarly", "equally", "correspondingly", "analogously", "conversely", "contrariwise", "alternatively", "alternately"])
      for (const actor of ["the agent", "Jane Doe"])
        for (const source of [
          `The button creates a PR after tests pass ${separator} ${actor} ${modifier} files another PR.`,
          `Ensure the button creates a PR after tests pass ${separator} ${actor} ${modifier} files another PR.`,
        ]) {
          assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
          assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
        }
  for (const separator of ["&", "+", "/"])
    for (const source of [
      `The button creates a PR after tests pass ${separator} the service additionally files another PR.`,
      `The button creates a PR after tests pass ${separator} Jane Doe also creates a PR template.`,
    ]) {
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    }
  for (const connector of [...publicationTailConnectors, "meanwhile", "meantime", "in the meantime", "subsequently", "afterward", "afterwards", "thereafter", "MEANWHILE",
    "therefore", "consequently", "accordingly", "thus", "hence", "THEREFORE",
    "however", "nevertheless", "nonetheless", "instead", "otherwise", "HOWEVER",
    "moreover", "furthermore", "additionally", "also", "in addition", "MOREOVER", "albeit", "ALBEIT",
    "likewise", "similarly", "equally", "correspondingly", "analogously", "in the same way", "LIKEWISE",
    "conversely", "contrariwise", "in contrast", "by contrast", "on the contrary", "on the other hand", "CONVERSELY",
    "alternatively", "alternately", "as an alternative", "as another option", "or else", "ALTERNATIVELY"])
    for (const action of ["the agent files another PR", "the agent opens another PR", "our senior developer quickly creates another PR", "Alice King will submit another pull request"])
      for (const source of [
        `The button creates a PR after tests pass, ${connector} ${action}.`,
        `Ensure the button creates a PR after tests pass ${connector} ${action}.`,
        // Only known transitions have standalone grammar; every transition
        // below must preserve an actor inside an actual product-condition tail.
        ...(!publicationTailConnectors.includes(connector) || publicationTemporalConnectors.includes(connector) ? [`${connector} ${action}.`] : []),
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
  for (const connector of [...publicationTailConnectors, "meanwhile", "meantime", "in the meantime", "subsequently", "afterward", "afterwards", "thereafter",
    "therefore", "consequently", "accordingly", "thus", "hence",
    "however", "nevertheless", "nonetheless", "instead", "otherwise",
    "moreover", "furthermore", "additionally", "also", "in addition", "albeit",
    "likewise", "similarly", "equally", "correspondingly", "analogously", "in the same way",
    "conversely", "contrariwise", "in contrast", "by contrast", "on the contrary", "on the other hand",
    "alternatively", "alternately", "as an alternative", "as another option", "or else"])
    for (const source of [
      `The button creates a PR after tests pass, ${connector} the service opens another PR.`,
      `Ensure the button creates a PR after tests pass ${connector} the service opens another PR.`,
      `The button creates a PR after tests pass, ${connector} the agent creates a PR template.`,
      `The button creates a PR after tests pass, ${connector} the agent generates a report about PRs.`,
      `Show the example "${connector} the agent opens another PR" in the button help.`,
    ]) {
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const original = source + " Open a PR for review.", contract = ownerDelivery(original);
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
      assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
    }
});

test("multi-part actor names keep publication directives visible within their clause", () => {
  for (const actor of ["Mary Jane Watson", "John Ronald Reuel Tolkien", "Jean-Luc Mary O’Neill", "Ana María De La Cruz"])
    for (const source of [
      `The button creates a PR after tests pass and ${actor} opens another PR.`,
      `Ensure the button creates a PR after tests pass provided that ${actor} quickly opens another PR.`,
      `Ensure ${actor} creates a PR.`,
      `${actor} also opens another PR.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "The Mary Jane Watson button creates a PR after tests pass.",
    "Ensure the Mary Jane Watson button creates a PR after tests pass.",
    "The button creates a PR after tests pass and Mary Jane Watson creates a PR template.",
    "The button creates a PR after tests pass and Mary Jane Watson generates a report about PRs.",
    "Clicking submit creates a PR and the service opens another PR.",
    'Show the example "Mary Jane Watson opens another PR" in the button help.',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("modified actor-led publication stays visible without changing product ownership", () => {
  for (const actor of ["the agent", "our developer", "the automation", "John", "Jane Doe", "alex"])
    for (const lead of ["quickly", "also", "likewise", "similarly", "equally", "correspondingly", "analogously", "conversely", "contrariwise", "will quickly", "must not silently", "to immediately", "very carefully"])
      for (const source of [
        `The button creates a PR after tests pass and ${actor} ${lead} opens another PR.`,
        `Ensure the button creates a PR after tests pass provided that ${actor} ${lead} opens another PR.`,
        `Ensure ${actor} ${lead} creates a PR.`,
        `${actor} ${lead} opens another PR.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
  for (const source of [
    "The button creates a PR after tests pass and the service quickly opens another PR.",
    "Ensure the button quickly creates a PR after tests pass.",
    "The button quickly creates a PR after tests pass.",
    "The button likewise creates a PR after tests pass.",
    "The button conversely creates a PR after tests pass.",
    "Ensure the button contrariwise creates a PR after tests pass.",
    "Ensure the button likewise creates a PR after tests pass.",
    "The button creates a PR after tests pass and the service likewise opens another PR.",
    "Have the submit button to immediately create a PR.",
    "The button creates a PR after tests pass and the agent quickly creates a PR template.",
    "Clicking submit quickly creates a PR and the service also opens another PR.",
    'Show the example "the agent quickly opens another PR" in the button help.',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
  for (const source of [
    "Ensure the button quickly creates a PR after tests pass since changes cannot be merged.",
    "Ensure the button creates a PR after tests pass and the agent quickly creates a PR after I approve the code.",
    "The button creates a PR after tests pass & Jane Doe also submits another PR.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
});

test("multiword automation subjects retain publication authority checks", () => {
  for (const actor of ["the release workflow", "our automation workflow", "the CI pipeline", "the nightly job",
    "our scheduled automation", "the release runner", "the CI scheduler", "our build daemon"])
    for (const source of [
      `The button creates a PR after tests pass and ${actor} opens another PR.`,
      `Ensure the button creates a PR after tests pass provided that ${actor} quickly files another PR.`,
      `The button creates a PR after tests pass & ${actor} alternatively submits another PR.`,
      `Ensure ${actor} creates a PR.`,
      `${actor} opens another PR.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "The release workflow button creates a PR after tests pass.",
    "Ensure our automation workflow service creates a PR.",
    "The button creates a PR after tests pass and the release workflow creates a PR template.",
    "The button creates a PR after tests pass and our automation workflow generates a report about PRs.",
    'Show the example "the release workflow opens another PR" in the button help.',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("publication actors retain bounded modifiers before recognized roles", () => {
  for (const actor of ["the senior agent", "our experienced developer", "a very senior coding agent",
    "the background automation coordinator", "the AI senior assistant"])
    for (const source of [
      `The button creates a PR after tests pass and ${actor} opens another PR.`,
      `${actor} opens another PR.`,
      `Ensure ${actor} creates a PR.`,
      `Ensure the button creates a PR after tests pass provided that ${actor} quickly opens another PR.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "The senior agent button creates a PR after tests pass.",
    "Ensure our experienced developer service creates a PR.",
    "The button creates a PR after tests pass and the senior agent creates a PR template.",
    'Show the example "the senior agent opens another PR" in the button help.',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("large repeated feature-object clauses stay within the supported request size", () => {
  const source = Array(1638).fill("Make PRs mergeable.").join(" ");
  assert.ok(Buffer.byteLength(source) < 32 * 1024);
  assert.equal(ownerDelivery(source), null);
});

test("new publication predicates, actors, adverbs and approval gates fail closed", () => {
  for (const text of [
    "Create a PR ASAP.",
    "Do not create a PR this time.",
    "Make PRs obligatory.",
    "Make PRs compulsory.",
    "Open PRs whenever tests pass.",
    "Create a PR provided that tests pass.",
    "Make PRs so long as tests pass.",
    "Make PRs mandatory before release.",
    "Make PRs require tests to pass.",
    "Make PRs await code review.",
    "Implement export. Open a PR titled export support.",
    "Implement export. Open PRs simultaneously.",
    "A PR is forbidden.",
    "PR is not allowed.",
    "Pull requests are forbidden.",
    "Implement export. Created a PR for review.",
    "Implement export. Opened a PR for review.",
    "Implement export. Submitted a PR for review.",
    "The LLM creates a PR when tests pass.",
    "The AI creates a PR after tests pass.",
    "The model creates a PR when tests pass.",
    "The provider creates a PR when tests pass.",
    "Ensure the team creates a PR for review.",
    "Have John create a PR for review.",
    "Let John create a PR for review.",
    "Ship it after I approve the code.",
    "Update the service after I approve.",
    "Build the feature after my approval.",
    "Fix the bug once I consent.",
    "Implement export after I explicitly approve.",
    "After I personally approve, implement export.",
    "After I have approved, update the service.",
    "After I've approved, update the service.",
    "Once we have approved, continue.",
    "Release it after I approve the implementation.",
    "Package it after I approve the code.",
    "Build the widget after I permit it.",
    "Build the widget after I agree.",
    "Build the widget after I review it.",
    "Refine the implementation after I approve the purchase.",
    "Polish the code after I approve the refund.",
    "Implement export. Make the team a PR for review.",
    "Create John a pull request for review.",
    "Create a PR and assign me.",
    "Do not create a PR whatsoever.",
    "Do not create a PR going forward.",
    "Create a PR visible to outsiders.",
    "Do not generate a PR visible to outsiders.",
    "Produce a PR public to everyone.",
    "Implement export. Create a well-tested PR for review.",
    "Implement export. Create a well‑tested PR for review.",
    "Implement export. Create a well–tested PR for review.",
    "Do not create a non‑draft PR.",
  ]) assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
  const longOrdinaryAnswer = "Create ".repeat(4500);
  assert.equal(Buffer.byteLength(longOrdinaryAnswer), 31500);
  assert.equal(ownerDelivery(longOrdinaryAnswer), null, "large ordinary text without an approval condition stays implementation scope");
  for (const text of ["After I have approved, update the service.", "After I've approved, update the service.", "Once we have approved, continue."]) {
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }

  // Policy fields describing this product's PR behavior remain implementation
  // requirements, regardless of the verb used to expose the field.
  for (const verb of ["Document", "Read", "Return", "Validate", "Persist"])
    assert.equal(ownerDelivery(`${verb} whether PRs are optional in settings.`), null);

  // The structural check must not turn a business approval rule into an owner
  // authorization gate simply because it mentions an approval.
  for (const text of [
    "If a customer approves the refund, send the customer an email.",
    "If we approve a refund, send the customer an email.",
    "If I approve the purchase, show a confirmation page.",
    "If I approve the purchase, apply the discount.",
    "If I approve the purchase, create a customer account.",
    "If I approve the support request, finish the checkout.",
    "Apply the discount after I approve the purchase.",
    "Send the customer an email after I approve the refund.",
    "Show a confirmation page after I approve the purchase.",
    "Send a receipt after I approve the expense.",
    "Notify the user once I approve the loan.",
    "Approve the refund before emailing the customer.",
    "After I have approved the invoice, mark it paid.",
    "When I have approved the comment, display it.",
    "After the owner approves the invoice, send a receipt.",
    "Provided the owner approves the invoice, send a confirmation.",
    "Provided that the owner approves the invoice, send a confirmation.",
    "Validate the cart, and if I approve the purchase, apply the discount.",
    "When checkout completes, if I approve the purchase, send a receipt.",
    "Send a receipt after the owner approves the invoice.",
    "Send a confirmation provided the owner approves the invoice.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  for (const text of [
    "If I approve the purchase, continue with implementation.",
    "If we approve a refund, deploy the service.",
    "If I approve the code, send an email.",
    "If I approve the purchase, apply the patch.",
    "If I approve the purchase, create a widget.",
    "Create the widget after I approve the purchase.",
    "Make a new dashboard after I approve the comment.",
    "Create the account page after I approve the invoice.",
    "After I approve the purchase, generate the customer dashboard.",
    "If I approve the support request, finish the implementation.",
    "Build the widget after I approve the purchase.",
    "Build the widget after I approve the purchase, then send a receipt.",
    "If I approve the invoice, email the customer yet wait until the owner approves.",
    "If I approve the invoice, email the customer, wait until the owner approves.",
    "Add tests after I approve the plan.",
    "Fix the bug after I approve the plan.",
    "Implement export after I approve the code, and if I approve the purchase, apply the discount.",
  ]) assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
  assert.equal(ownerDelivery("If I approve the invoice, email the customer, apply the discount."), null);
});

test("passive branch restrictions require repository context", () => {
  for (const text of [
    "Empty branches are not allowed in the syntax tree.",
    "Bank branches are not allowed to be created without an address.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  for (const text of [
    "Git branches are not allowed.",
    "Repository branches are forbidden.",
    "Branches are not allowed in the repository.",
  ]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
});

test("PR-shaped application features stay implementation requirements while real delivery remains visible", () => {
  const features = [
    "The button opens a PR.",
    "Clicking submit creates a pull request.",
    "Make PRs searchable in the dashboard.",
    "Make pull requests visible to administrators.",
    "Make PRs visible to administrators.",
    "Make a PR checker.",
    "Make a pull request API.",
    "Make PRs easier to find.",
    "Make a PR-ready changelog.",
    "Make a PR-friendly report.",
    "Make PRs private in the dashboard.",
    "Make PRs collapsible.",
    "Make pull requests read-only for guests.",
    "Make the PR optional field editable.",
    "Make the PR's title editable.",
    "Generate the PR's title from the branch name.",
    "Generate a daily report summarizing PRs.",
    "The application created a PR when a check completes.",
    "The application submitted a PR when requested.",
    "The application publishes a PR after approval.",
    "Create a report summarizing pull requests.",
    "Do not generate a PR number in the error message.",
    "Do not generate a PR preview for draft changes.",
    "Generate a dashboard listing PRs.",
    "Create a list of PRs in the dashboard.",
    "Create a collection of PRs for the dashboard.",
    "Create a graph of PRs in the dashboard.",
    "Create a chart of PRs.",
    "Create a map of PRs for analytics.",
    "Create a view of PRs.",
    "Create a grid of PRs.",
    "Create a group of PRs.",
    "Create an index of PRs.",
    "Generate an index of pull requests for search.",
    "Document whether PRs are optional in settings.",
  ];
  for (const text of features) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  for (const text of [
    "Implement endpoint updates. Create an API PR for review.",
    "Implement endpoint updates. Create a report PR for review.",
    "Implement endpoint updates. Create a dashboard PR for review.",
  ]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  assert.equal(ownerDelivery("Create a report about the PR."), null);
  for (const text of ["Do not create a PR visible to outsiders.", "Do not create a PR private from the owner."]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  assert.equal(ownerDelivery("Do not generate a PR number in the error message."), null);
  const makeContract = ownerDelivery("Implement export. Make a PR for review.");
  assert.equal(makeContract.version, 5);
  assert.deepEqual(ownerImplementation(makeContract), ["Implement export. "]);
  const makeMeContract = ownerDelivery("Implement export. Make me a PR for review.");
  assert.equal(makeMeContract.version, 5);
  assert.deepEqual(ownerImplementation(makeMeContract), ["Implement export. "]);
  for (const text of [
    "Create an actual PR in the integration test.",
    "Create a real PR in the test.",
    "Create a number of PRs for review.",
    "Create any number of PRs for review.",
    "Make one hundred and six PRs for review.",
    "Submit 1,024 pull requests for review.",
    "Make dozens of PRs for review.",
    "Make a pair of PRs.",
    "Make a handful of PRs.",
    "Create a series of PRs.",
    "Create a plethora of PRs.",
    "Make a multitude of PRs for review.",
    "Create a truckload of PRs.",
    "Create a lot of PRs.",
    "Create a bunch of PRs.",
    "Create loads of PRs.",
    "Create tons of PRs.",
    "John should create a PR for review.",
    "The team must create a PR for review.",
    "Do not create a PR anyone can see.",
    "Create a PR everyone can review.",
  ]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const text of [
    "For tests, create a mock PR.",
    "In the unit test, generate a fake PR.",
    "Generate a dummy PR in the unit test.",
    "Create a fabricated pull request for the test fixture.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
});

test("PR references remain separate from the created implementation object", () => {
  for (const text of [
    "Create tests for PRs.", "Create a parser about PRs.", "Create tests for two PRs.",
    "Create tests using PRs.", "Create checks concerning PRs.", "Create a parser referencing PRs.",
    "Generate documentation about pull requests.", "Create a parser with PRs as input.",
    "Created tests for PRs.", "Do not create tests for PRs.", "Avoid creating tests for PRs.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
    const original = text + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, text);
    assert.equal(ownerImplementation(contract).join(""), text + " ", text);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, text);
    assert.throws(() => ownerDelivery(text + " Do not open a PR."), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text + " Create another PR."), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const text of ["Create an API PR for review.", "Create a report PR for review.", "Create a pair of PRs.",
    "Create tests and PRs.", "Create tests for PRs and open another PR."]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
});

test("application publication conditions stop before colon and dash clauses", () => {
  for (const text of [
    "The button creates a PR after tests pass: PRs must not be published.",
    "The button creates a PR after tests pass — PRs must not be published.",
    "The button creates a PR after tests pass - PRs must not be published.",
  ]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
});

test("business approval masking stops at colon and dash before a later owner gate", () => {
  for (const text of [
    "If I approve the invoice, email the customer: wait until the owner approves.",
    "If I approve the invoice, email the customer — wait until the owner approves.",
    "If I approve the invoice, email the customer - wait until the owner approves.",
  ]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const text of [
    "If the tax is calculated: the owner approves the payment. Implement export.",
    "If the tax is calculated — the owner approves the payment. Implement export.",
    "If the tax is calculated - the owner approves the payment. Implement export.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
});

test("approval rules validate actions across colon and dash continuations", () => {
  for (const separator of [": ", "—", " – ", " - ", " -- "]) {
    for (const source of [
      `If I approve the invoice, email the customer${separator}then proofread the article.`,
      `Email the customer after I approve the invoice${separator}then proofread the article.`,
      `Proofread the article${separator}then email the customer after I approve the invoice.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
    for (const source of [
      `If I approve the invoice, email the customer${separator}then apply the discount.`,
      `Email the customer after I approve the invoice${separator}then apply the discount.`,
    ]) {
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const contract = ownerDelivery(source + " Open a PR for review.");
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    }
  }
  const separate = "If I approve the invoice, email the customer. Proofread the article.";
  assert.equal(ownerDelivery(separate), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, separate));
});

test("conditioned approval after many coordinated business actions stays visible", () => {
  const source = `If I approve x, email y ${"and x ".repeat(4000)}and if tests pass the owner approves it`;
  assert.ok(source.length < 32 * 1024);
  assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" });
});

test("business approval rules do not mask unclassified coordinated implementation work", () => {
  for (const connector of ["and", "as well as", "along with", "alongside", "together with", "in addition to", "not to mention", "besides", "plus"])
    for (const action of ["proofread", "polish", "edit"]) {
      const source = `If I approve the article, email the customer ${connector} ${action} the article.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  const supportedBusinessSequence = "If I approve the invoice, email the customer and apply the discount.";
  assert.equal(ownerDelivery(supportedBusinessSequence), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, supportedBusinessSequence));
  for (const connector of ["as well as", "in addition to", "alongside"]) {
    const supported = `If I approve the invoice, email the customer ${connector} apply the discount.`;
    assert.equal(ownerDelivery(supported), null, supported);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, supported), supported);
  }
  const missingFirstObject = "If I approve the invoice, email the report alongside apply the discount.";
  assert.throws(() => ownerDelivery(missingFirstObject), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, missingFirstObject), { code: "TASK_DELIVERY_SCOPE" });
});

test("business approval rules validate purpose-infinitive actions", () => {
  for (const connector of ["to", "to not", "in order to", "so as to", "in order not to", "so as not to", "in order to not"]) {
    for (const source of [
      `If I approve the invoice, email the customer ${connector} proofread the article.`,
      `Email the customer ${connector} proofread the article after I approve the invoice.`,
      `If I approve the invoice, email the report ${connector} apply the discount.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
    const source = `If I approve the invoice, email the customer ${connector} apply the discount.`;
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const contract = ownerDelivery(source + " Open a PR for review.");
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
  }
  for (const recipient of ["the customer", "our customer", "customer", "them", "Alice", "Alice Smith"]) {
    const source = `If I approve the invoice, send a receipt to ${recipient}.`;
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
  for (const source of [
    "If I approve the invoice, send a receipt to the customer to proofread the article.",
    "If I approve the invoice, email the customer to Proofread the article.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  const coordinated = "If I approve the invoice, email the customer not to mention apply the discount.";
  assert.equal(ownerDelivery(coordinated), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, coordinated));
});

test("finite purpose clauses validate their actions and business objects", () => {
  for (const connector of ["so", "so that", "SO THAT"]) {
    for (const action of ["you can proofread the invoice", "our senior editor can proofread the invoice", "Alice King proofreads the invoice", "the invoice can be proofread", "you can email the report"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
        `If I approve the invoice, email the customer ${connector} you can apply the discount before ${action}.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    const borrowedObject = `If I approve the invoice, email the report ${connector} you can apply the discount.`;
    assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    for (const action of ["you can apply the discount", "our senior editor can email the customer", "Alice King emails the customer", "the discount can be applied", "the recurring payment clears"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  }
  const otherRelative = "If I approve the invoice, email the customer that proofreads the invoice.";
  assert.throws(() => ownerDelivery(otherRelative), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, otherRelative), { code: "TASK_DELIVERY_SCOPE" });
  for (const source of [
    "If I approve the invoice, send a receipt to So.",
    "If I approve the invoice, send a receipt to So Smith.",
    "If I approve the invoice, send a receipt to  So Smith after you apply the discount.",
    "If I approve the invoice, email the customer so as to apply the discount.",
    "If I approve the invoice, email the customer so as not to apply the discount.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("relative temporal clauses validate approval-dependent actions and their own objects", () => {
  for (const connector of ["after which", "before which", "AFTER WHICH", "whereupon", "WHEREUPON"]) {
    for (const action of ["you proofread the invoice", "you must proofread the invoice", "our senior editor proofreads the invoice", "Alice King must proofread the invoice",
      "the invoice must be proofread", "our archive specialist proofreads the invoice", "you email the report"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
        `If I approve the invoice, email the customer ${connector} you apply the discount after which ${action}.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    const borrowedObject = `If I approve the invoice, email the report ${connector} you apply the discount.`;
    assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    for (const action of ["you must apply the discount", "our senior editor emails the customer", "Alice King must email the customer", "the discount must be applied"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  }
  const quoted = 'If I approve the invoice, email the customer with the note "whereupon you proofread the invoice".';
  assert.equal(ownerDelivery(quoted), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, quoted));
});

test("symbol-coordinated business actions keep approval-dependent implementation visible", () => {
  for (const separator of [" & ", " + ", " / ", "&", "+", "\t/\t"])
    for (const source of [
      `If I approve the invoice, email the customer${separator}proofread the invoice.`,
      `Email the customer${separator}proofread the invoice after I approve the invoice.`,
      `If I approve the invoice, email the report${separator}apply the discount.`,
      `If I approve the invoice, email the customer${separator}apply the report.`,
      `If I approve the invoice, email the customer${separator}apply the discount${separator}proofread the invoice.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    ...[" & ", " + ", " / ", "&", "+"].map(separator => `If I approve the invoice, email the customer${separator}apply the discount.`),
    "Email the customer / apply the discount after I approve the invoice.",
    "If I approve the invoice, email the customer & send a receipt to Alice.",
    "If I approve the invoice, email the customer at customer/checkout.",
    'If I approve the invoice, email the customer with the label "& proofread the invoice / +".',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("business approval rules validate purpose gerunds", () => {
  for (const connector of ["with a view to", "for the purpose of", "for purposes of", "with the aim of", "with the goal of", "with the intent of", "with the intention of", "with the objective of"]) {
    for (const source of [
      `If I approve the invoice, email the customer ${connector} proofreading the article.`,
      `Email the customer ${connector} proofreading the article after I approve the invoice.`,
      `If I approve the invoice, email the customer ${connector} not proofreading the article.`,
      `If I approve the invoice, email the report ${connector} applying the discount.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
    const source = `If I approve the invoice, email the customer ${connector} applying the discount.`;
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const contract = ownerDelivery(source + " Open a PR for review.");
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
  }
});

test("unrecognized nominal purpose clauses retain owner approval gates", () => {
  for (const connector of ["in the hope of", "in hopes of", "with the expectation of", "for the eventual prospect of"])
    for (const action of ["proofreading the article", "not proofreading the article", "carefully proofreading the article", "applying the discount"]) {
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    }
  for (const source of [
    "If I approve the invoice, email the customer with a list of invoices.",
    "If I approve the invoice, email the customer for a record of invoices.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("nominal that complements retain owner approval gates", () => {
  for (const connector of ["with the expectation that", "in the hope that", "with the assumption that", "for the purpose that"])
    for (const action of ["you proofread the article", "our senior editor proofreads the article", "the article is proofread", "you apply the discount"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
  for (const source of [
    "If I approve the invoice, email the customer with a list of invoices.",
    "If I approve the invoice, email the customer with the aim of applying the discount.",
    'If I approve the invoice, email the customer with a note saying "with the expectation that you proofread the article".',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("causative relative clauses validate approval-dependent actions and their objects", () => {
  for (const relative of ["which lets", "that lets", "which makes", "which helps", "which allows", "which enables", "that requires", "which can let", "which does not let"])
    for (const action of ["you proofread the article", "our senior editor proofread the article", "our archive specialist proofread the article", "Alice proofread the article", "you to proofread the article", "you email the report"])
      for (const source of [
        `If I approve the invoice, send the customer an email ${relative} ${action}.`,
        `Send the customer an email ${relative} ${action} after I approve the invoice.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
  for (const source of [
    "If I approve the invoice, send the customer an email which lets you apply the discount.",
    "Send the customer an email which helps Alice apply the discount after I approve the invoice.",
    "If I approve the invoice, send the customer an email which allows our senior editor to apply the discount.",
    "If I approve the invoice, send the customer an email which contains the receipt.",
    'If I approve the invoice, send the customer an email with the label "which lets you proofread the article".',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("modified relative causatives validate every approval-dependent action", () => {
  for (const relative of ["which also lets", "which normally makes", "which very carefully helps", "which can also let", "which also can let", "which does not usually let", "which doesn't normally let", "which also allows", "which also enables", "which also permits", "which also requires", "which also has", "which also have", "which also had", "which " + "also ".repeat(40) + "lets"])
    for (const action of ["you proofread the article", "us proofread the invoice", "our senior editor proofread the invoice", "our archive specialist proofread the invoice", "Alice King proofread the invoice", "you email the report"])
      for (const source of [
        `If I approve the invoice, send the customer an email ${relative} ${action}.`,
        `Send the customer an email ${relative} ${action} after I approve the invoice.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
  for (const source of [
    "If I approve the invoice, send the customer an email which also lets you apply the discount.",
    "Send the customer an email which can also let Alice King apply the discount after I approve the invoice.",
    "If I approve the invoice, send the customer an email which also has us apply the discount.",
    "If I approve the invoice, send the customer an email which also has the receipt sent.",
    "If I approve the invoice, send the customer an email which also has the receipt.",
    "If I approve the invoice, send the customer an email which usually contains the receipt.",
    'If I approve the invoice, send the customer an email with the label "which also lets you proofread the article".',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("relative have causatives retain approval gates while business possession stays descriptive", () => {
  for (const relative of ["which has", "that has", "which have", "which had", "which can have", "which does not have"])
    for (const action of ["you proofread the article", "us proofread the invoice", "our senior editor proofread the invoice", "our archive specialist proofread the invoice", "Alice King proofread the invoice", "the invoice proofread", "you email the report", "the customer" + " ".repeat(170) + "proofread the invoice"])
      for (const source of [
        `If I approve the invoice, send the customer an email ${relative} ${action}.`,
        `Send the customer an email ${relative} ${action} after I approve the invoice.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
  for (const source of [
    "If I approve the invoice, send the customer an email which has you apply the discount.",
    "Send the customer an email which can have Alice King apply the discount after I approve the invoice.",
    "If I approve the invoice, send the customer an email which has our senior editor email the customer.",
    "If I approve the invoice, send the customer an email which has us apply the discount.",
    "If I approve the invoice, send the customer an email which has the receipt sent.",
    "If I approve the invoice, send the customer an email which has the receipt.",
    "If I approve the invoice, send the customer an email which has a confirmation page.",
    'If I approve the invoice, send the customer an email with the label "which has you proofread the article".',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("business approval rules keep temporal implementation actions visible", () => {
  for (const connector of ["before", "after", "while", "once", "until", "when"])
    for (const action of ["proofreading", "editing"]) {
      const source = `If I approve the invoice, email the customer ${connector} ${action} the article.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  const business = "If I approve the invoice, email the customer before applying the discount.";
  assert.equal(ownerDelivery(business), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, business));
  for (const connector of ["before", "after", "while", "once", "until", "when", "by the time"])
    for (const subject of ["you", "the editor"]) {
      const source = `If I approve the invoice, email the customer ${connector} ${subject} proofread the article.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "If I approve the invoice, email the customer after our team proofreads the invoice.",
    "If I approve the invoice, email the customer before their editors proofread the article.",
    "If I approve the invoice, email the customer while Alice proofreads the article.",
    "If I approve the invoice, email the customer once our team proofreads the invoice.",
    "If I approve the invoice, email the customer until Alice proofreads the article.",
    "If I approve the invoice, email the customer as soon as you proofread the article.",
    "If I approve the invoice, email the customer as soon as our team proofreads the invoice.",
    "If I approve the invoice, email the customer as soon as proofreading the article.",
    "If I approve the invoice, email the customer as you proofread the article.",
    "If I approve the invoice, email the customer as our team proofreads the invoice.",
    "If I approve the invoice, email the customer as proofreading the article.",
    "If I approve the invoice, email the customer by the time our team proofreads the invoice.",
    "If I approve the invoice, email the customer after the article is proofread.",
    "If I approve the invoice, email the customer before the invoice is proofread.",
    "If I approve the invoice, email the customer by the time the article has been edited.",
    "If I approve the invoice, email the customer when the article gets edited.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const source of [
    "If I approve the invoice, email the customer after you apply the discount.",
    "If I approve the invoice, email the customer after our team emails the customer.",
    "If I approve the invoice, email the customer after the payment clears.",
    "If I approve the invoice, email the customer once you apply the discount.",
    "If I approve the invoice, email the customer until the payment clears.",
    "If I approve the invoice, email the customer when our team emails the customer.",
    "If I approve the invoice, email the customer as soon as you apply the discount.",
    "If I approve the invoice, email the customer as soon as the payment clears.",
    "If I approve the invoice, email the customer as you apply the discount.",
    "If I approve the invoice, email the customer as the payment clears.",
    "If I approve the invoice, email the customer by the time you apply the discount.",
    "If I approve the invoice, email the customer after the discount is applied.",
    "If I approve the invoice, email the customer once the receipt is sent.",
    "If I approve the invoice, email the customer after the receipt gets sent.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("whilst approval clauses share while action and object boundaries", () => {
  for (const connector of ["whilst", "while", "WHILST"]) {
    for (const action of ["you proofread the invoice", "you must proofread the invoice", "our senior editor proofreads the invoice",
      "Alice King proofreads the invoice", "carefully proofreading the invoice", "the invoice is proofread", "you email the report"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
        `If I approve the invoice, email the customer ${connector} you apply the discount before ${action}.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    const borrowedObject = `If I approve the invoice, email the report ${connector} you apply the discount.`;
    assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    for (const action of ["you must apply the discount", "our senior editor emails the customer", "Alice King emails the customer",
      "carefully applying the discount", "the discount is applied"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  }
  for (const source of [
    "If I approve the invoice, email the customer whilst you apply the discount and wait until the owner approves.",
    "Email the customer whilst if I approve the invoice, proofread the article.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const source of [
    "Whilst the discount is applied, if I approve the invoice, email the customer.",
    "Email the customer whilst if I approve the invoice, apply the discount.",
    'If I approve the invoice, email the customer with the note "whilst you proofread the invoice".',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("whenever approval clauses validate finite gerund and passive actions", () => {
  for (const action of ["you proofread the invoice", "our senior editor proofreads the invoice", "Alice proofreads the invoice", "proofreading the invoice", "carefully proofreading the invoice", "the invoice is proofread"])
    for (const source of [
      `If I approve the invoice, email the customer whenever ${action}.`,
      `Email the customer whenever ${action} after I approve the invoice.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const action of ["you apply the discount", "our senior editor emails the customer", "Alice King emails the customer", "carefully applying the discount", "the discount is applied", "the payment clears"]) {
    const source = `If I approve the invoice, email the customer whenever ${action}.`;
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("conditional approval clauses validate finite gerund and passive actions", () => {
  for (const action of ["you proofread the article", "our senior editor proofreads the invoice", "Alice King proofreads the invoice", "carefully proofreading the invoice", "the invoice is proofread", "you email the report"])
    for (const source of [
      `If I approve the invoice, email the customer if ${action}.`,
      `Email the customer if ${action} after I approve the invoice.`,
      `If I approve the invoice, email the customer if you apply the discount before ${action}.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const action of ["you apply the discount", "our senior editor emails the customer", "Alice King emails the customer", "carefully applying the discount", "the discount is applied", "the recurring payment clears"])
    for (const source of [
      `If I approve the invoice, email the customer if ${action}.`,
      `Email the customer if ${action} after I approve the invoice.`,
    ]) {
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const original = source + " Open a PR for review.", contract = ownerDelivery(original);
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
      assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
    }
});

test("assuming approval clauses validate each action and its own business object", () => {
  for (const connector of ["assuming", "assuming that", "ASSUMING", "ASSUMING THAT"]) {
    for (const action of ["you proofread the invoice", "you must proofread the invoice", "our senior editor proofreads the invoice",
      "Alice King proofreads the invoice", "carefully proofreading the invoice", "the invoice is proofread", "you email the report"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
        `If I approve the invoice, email the customer ${connector} you apply the discount before ${action}.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    const borrowedObject = `If I approve the invoice, email the report ${connector} you apply the discount.`;
    assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    for (const action of ["you must apply the discount", "our senior editor emails the customer", "Alice King emails the customer",
      "carefully applying the discount", "the discount is applied", "the recurring payment clears"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  }
  const quoted = 'If I approve the invoice, email the customer with the note "assuming you proofread the invoice".';
  assert.equal(ownerDelivery(quoted), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, quoted));
});

test("provided given and supposing conditions validate every approval-gated action", () => {
  for (const word of ["provided", "providing", "given", "supposing"])
    for (const connector of [word, word + " that", word.toUpperCase() + " THAT"]) {
      for (const action of ["you proofread the invoice", "you must proofread the invoice", "our senior editor proofreads the invoice",
        "Alice King proofreads the invoice", "carefully proofreading the invoice", "the invoice is proofread", "you email the report"])
        for (const source of [
          `If I approve the invoice, email the customer ${connector} ${action}.`,
          `Email the customer ${connector} ${action} after I approve the invoice.`,
          `If I approve the invoice, email the customer ${connector} you apply the discount before ${action}.`,
        ]) {
          assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
          assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
        }
      const borrowedObject = `If I approve the invoice, email the report ${connector} you apply the discount.`;
      assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
      assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
      for (const action of ["you must apply the discount", "our senior editor emails the customer", "Alice King emails the customer",
        "carefully applying the discount", "the discount is applied", "the recurring payment clears"])
        for (const source of [
          `If I approve the invoice, email the customer ${connector} ${action}.`,
          `Email the customer ${connector} ${action} after I approve the invoice.`,
        ]) {
          assert.equal(ownerDelivery(source), null, source);
          assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
          const original = source + " Open a PR for review.", contract = ownerDelivery(original);
          assert.equal(validateOwnerDelivery(contract), contract, source);
          assert.equal(ownerImplementation(contract).join(""), source + " ", source);
          assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
        }
    }
  const quoted = 'If I approve the invoice, email the customer with the note "provided you proofread the invoice".';
  assert.equal(ownerDelivery(quoted), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, quoted));
});

test("lest clauses validate approval-gated actions and retain unrecognized heads", () => {
  for (const connector of ["lest", "LEST"]) {
    for (const action of ["you proofread the invoice", "you should proofread the invoice", "our senior editor proofreads the invoice",
      "Alice King should proofread the invoice", "the invoice should be proofread", "our archive specialist proofreads the invoice", "you email the report"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
        `If I approve the invoice, email the customer ${connector} you apply the discount after which ${action}.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    const borrowedObject = `If I approve the invoice, email the report ${connector} you apply the discount.`;
    assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    for (const action of ["you apply the discount", "our senior editor emails the customer", "Alice King should email the customer", "the discount should be applied"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  }
  const quoted = 'If I approve the invoice, email the customer with the note "lest you proofread the invoice".';
  assert.equal(ownerDelivery(quoted), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, quoted));
});

test("unless approval clauses validate each action and its own business object", () => {
  for (const action of ["you proofread the invoice", "our senior editor proofreads the invoice", "Alice King proofreads the invoice", "carefully proofreading the invoice", "the invoice is proofread", "you email the report"])
    for (const source of [
      `If I approve the invoice, email the customer unless ${action}.`,
      `Email the customer unless ${action} after I approve the invoice.`,
      `If I approve the invoice, email the customer unless you apply the discount before ${action}.`,
    ]) {
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  const borrowedObject = "If I approve the invoice, email the report unless you apply the discount.";
  assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" });
  for (const action of ["you apply the discount", "our senior editor emails the customer", "Alice King emails the customer", "carefully applying the discount", "the discount is applied", "the recurring payment clears"])
    for (const source of [
      `If I approve the invoice, email the customer unless ${action}.`,
      `Email the customer unless ${action} after I approve the invoice.`,
    ]) {
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const original = source + " Open a PR for review.", contract = ownerDelivery(original);
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
      assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
    }
});

test("causal approval clauses validate their actions and business objects", () => {
  for (const connector of ["because", "since"]) {
    for (const action of ["you must proofread the invoice", "our senior editor proofreads the invoice", "Alice King proofreads the invoice", "carefully proofreading the invoice", "the invoice is proofread", "you must email the report"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
        `If I approve the invoice, email the customer ${connector} you apply the discount before ${action}.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    const borrowedObject = `If I approve the invoice, email the report ${connector} you must apply the discount.`;
    assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    for (const action of ["you must apply the discount", "our senior editor must email the customer", "Alice King emails the customer", "carefully applying the discount", "the discount is applied", "the recurring payment clears"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  }
});

test("concessive approval clauses validate each action and its own business object", () => {
  for (const connector of ["albeit", "ALBEIT", "even though", "though", "although", "whereas", "EVEN THOUGH"]) {
    for (const action of ["proofreading the invoice", "you proofread the invoice", "you must proofread the invoice", "our senior editor proofreads the invoice",
      "Alice King proofreads the invoice", "carefully proofreading the invoice", "not carefully proofreading the invoice", "the invoice is proofread", "you email the report"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
        `If I approve the invoice, email the customer ${connector} you apply the discount before ${action}.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    const borrowedObject = `If I approve the invoice, email the report ${connector} you apply the discount.`;
    assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    for (const action of ["you must apply the discount", "our senior editor emails the customer", "Alice King emails the customer",
      "carefully applying the discount", "the discount is applied"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  }
  for (const source of [
    "If I approve the invoice, email the customer even though you apply the discount and wait until the owner approves.",
    "Email the customer though if I approve the invoice, proofread the article.",
    "Email the customer albeit if I approve the invoice, proofread the article.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const source of [
    "Though the discount is applied, if I approve the invoice, email the customer.",
    "Email the customer though if I approve the invoice, apply the discount.",
    "Email the customer albeit if I approve the invoice, apply the discount.",
    'If I approve the invoice, email the customer with the note "even though you proofread the invoice".',
    'If I approve the invoice, email the customer with the note "albeit proofreading the invoice".',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("prepositional concessions validate approval-gated actions and their own objects", () => {
  for (const connector of ["despite", "DESPITE", "notwithstanding", "NOTWITHSTANDING"]) {
    for (const action of ["you proofread the invoice", "Alice King must proofread the invoice", "the invoice is proofread",
      "proofreading the invoice", "carefully proofreading the invoice", "not carefully proofreading the invoice",
      "you proofreading the invoice", "our senior editor proofreading the invoice", "Alice King proofreading the invoice",
      "emailing the report", "applying the discount before proofreading the invoice"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    const borrowedObject = `If I approve the invoice, email the report ${connector} applying the discount.`;
    assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    for (const complement of ["you apply the discount", "Alice King must email the customer", "the receipt is sent",
      "applying the discount", "carefully applying the discount", "you applying the discount",
      "our senior editor emailing the customer", "Alice King emailing the customer", "the discount", "a recurring payment"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${complement}.`,
        `Email the customer ${connector} ${complement} after I approve the invoice.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  }
  for (const source of [
    "If I approve the invoice, email the customer despite the fact that you proofread the invoice.",
    "If I approve the invoice, email the customer in spite of proofreading the invoice.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  const quoted = 'If I approve the invoice, email the customer with the note "despite proofreading the invoice".';
  assert.equal(ownerDelivery(quoted), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, quoted));
  const quotedNotwithstanding = 'If I approve the invoice, email the customer with the note "notwithstanding you proofread the invoice".';
  assert.equal(ownerDelivery(quotedNotwithstanding), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, quotedNotwithstanding));
});

test("upon clauses validate approval-gated actions and relative continuations", () => {
  for (const connector of ["upon", "UPON"]) {
    for (const action of ["proofreading the invoice", "carefully proofreading the invoice", "not carefully proofreading the invoice",
      "you proofreading the invoice", "our senior editor proofreading the invoice", "Alice King proofreading the invoice",
      "emailing the report", "applying the discount before proofreading the invoice"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    const borrowedObject = `If I approve the invoice, email the report ${connector} applying the discount.`;
    assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    for (const complement of ["applying the discount", "carefully applying the discount", "you applying the discount",
      "our senior editor emailing the customer", "Alice King emailing the customer", "receipt of payment"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${complement}.`,
        `Email the customer ${connector} ${complement} after I approve the invoice.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  }
  for (const connector of ["upon which", "UPON WHICH"]) {
    for (const action of ["you proofread the invoice", "Alice King must proofread the invoice", "the invoice is proofread", "our archive specialist proofreads the invoice"]) {
      const source = `If I approve the invoice, email the customer ${connector} ${action}.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
    for (const action of ["you apply the discount", "Alice King must email the customer", "the receipt is sent"]) {
      const source = `If I approve the invoice, email the customer ${connector} ${action}.`;
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const original = source + " Open a PR for review.", contract = ownerDelivery(original);
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
      assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
    }
  }
  const quoted = 'If I approve the invoice, email the customer with the note "upon proofreading the invoice".';
  assert.equal(ownerDelivery(quoted), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, quoted));
});

test("following and possessive gerunds retain approval gates and own their objects", () => {
  for (const connector of ["following", "FOLLOWING", "after", "before", "upon", "by", "despite", "notwithstanding"]) {
    for (const action of ["your proofreading the invoice", "our carefully proofreading the invoice", "their editing the invoice",
      "Alice's proofreading the invoice", "our editor’s proofreading the invoice", "your emailing the report"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
    const borrowedObject = `If I approve the invoice, email the report ${connector} your applying the discount.`;
    assert.throws(() => ownerDelivery(borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    assert.throws(() => assertDeliveryAnswer({}, borrowedObject), { code: "TASK_DELIVERY_SCOPE" }, borrowedObject);
    for (const complement of ["your applying the discount", "your carefully applying the discount", "your emailing the customer",
      "Alice's emailing the customer", "our editor’s emailing the customer", "your recurring payment", "the recurring payment"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${complement}.`,
        `Email the customer ${connector} ${complement} after I approve the invoice.`,
      ]) {
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
        const original = source + " Open a PR for review.", contract = ownerDelivery(original);
        assert.equal(validateOwnerDelivery(contract), contract, source);
        assert.equal(ownerImplementation(contract).join(""), source + " ", source);
        assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
      }
  }
  for (const source of [
    "If I approve the invoice, email the customer following proofreading the invoice.",
    "If I approve the invoice, email the customer FOLLOWING Alice King proofreading the invoice.",
    "If I approve the invoice, email the customer following which our archive specialist proofreads the invoice.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const source of [
    "If I approve the invoice, email the customer FOLLOWING WHICH the receipt is sent.",
    'If I approve the invoice, email the customer with the note "following your proofreading the invoice".',
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("temporal approval gerunds retain modifiers without hiding implementation", () => {
  for (const connector of ["before", "after", "while", "once", "until", "when", "as soon as", "by the time", "as"])
    for (const modifier of ["carefully", "very carefully", "not carefully"]) {
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${modifier} proofreading the article.`,
        `Email the customer ${connector} ${modifier} proofreading the article after I approve the invoice.`,
        `If I approve the invoice, email the customer ${connector} ${modifier} proofreading the invoice.`,
        `If I approve the invoice, email the report ${connector} ${modifier} applying the discount.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
      const source = `If I approve the invoice, email the customer ${connector} ${modifier} applying the discount.`;
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const contract = ownerDelivery(source + " Open a PR for review.");
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    }
  const laterAction = "If I approve the invoice, email the customer after carefully emailing the customer before proofreading the article.";
  assert.throws(() => ownerDelivery(laterAction), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, laterAction), { code: "TASK_DELIVERY_SCOPE" });
  for (const source of [
    "If I approve the invoice, email the customer after the recurring payment clears.",
    "If I approve the invoice, email the customer after Alice King emails the customer.",
    "If I approve the invoice, email the customer after the recurring payment is processed.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("method gerunds retain approval gates and validate their own business objects", () => {
  for (const connector of ["by", "via", "through", "on", "with", "in", "from", "for", "at", "into", "onto", "about", "of"])
    for (const modifier of ["", "first ", "not carefully "]) {
      for (const source of [
        `If I approve the support request, complete the request ${connector} ${modifier}proofreading the article.`,
        `Complete the request ${connector} ${modifier}proofreading the article after I approve the support request.`,
        `If I approve the support request, complete the report ${connector} ${modifier}emailing the customer.`,
        `If I approve the support request, complete the request ${connector} ${modifier}emailing the report.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
      const source = `If I approve the support request, complete the request ${connector} ${modifier}emailing the customer.`;
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const contract = ownerDelivery(source + " Open a PR for review.");
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    }
  for (const source of [
    "If I approve the support request, complete the request by our senior editor first proofreading the article.",
    "If I approve the support request, complete the request by first proofreading the article via emailing the customer.",
    "If I approve the support request, complete the request by first emailing the customer on proofreading the article.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const destination of ["by an email", "via the customer portal", "through the customer account", "on the invoice", "by the billing department", "by Alice King"]) {
    const source = `If I approve the support request, complete the request ${destination}.`;
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("result gerunds retain approval gates and their own business objects", () => {
  for (const connector of ["thereby", "thus", "hence"])
    for (const modifier of ["", "carefully ", "not carefully "]) {
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${modifier}proofreading the invoice.`,
        `Email the customer ${connector} ${modifier}proofreading the invoice after I approve the invoice.`,
        `If I approve the invoice, email the report ${connector} ${modifier}applying the discount.`,
        `If I approve the invoice, email the customer ${connector} ${modifier}emailing the report.`,
        `If I approve the invoice, email the customer ${connector} ${modifier}applying the discount before proofreading the invoice.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
      const source = `If I approve the invoice, email the customer ${connector} ${modifier}applying the discount.`;
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const original = source + " Open a PR for review.", contract = ownerDelivery(original);
      assert.equal(validateOwnerDelivery(contract), contract, source);
      assert.equal(ownerImplementation(contract).join(""), source + " ", source);
      assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
    }
});

test("finite nominal clauses after method prepositions retain approval gates", () => {
  for (const connector of ["on condition that", "on the condition that", "in case", "in case that", "by agreement that", "via the assurance that"])
    for (const action of ["you proofread the article", "our senior editor proofreads the article", "the article is proofread", "you email the customer"])
      for (const source of [
        `If I approve the invoice, email the customer ${connector} ${action}.`,
        `Email the customer ${connector} ${action} after I approve the invoice.`,
      ]) {
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
  for (const destination of ["on the invoice", "in the customer portal", "via the customer account", "by Alice King", "in case-sensitive mode", "in case‑sensitive mode", 'with a label "in case you proofread the article"']) {
    const source = `If I approve the invoice, email the customer ${destination}.`;
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
    const original = source + " Open a PR for review.", contract = ownerDelivery(original);
    assert.equal(validateOwnerDelivery(contract), contract, source);
    assert.equal(ownerImplementation(contract).join(""), source + " ", source);
    assert.equal(contract.spans.map(span => original.slice(span.start, span.end)).join(""), original, source);
  }
});

test("temporal approval actors include modifiers before their role", () => {
  for (const actor of ["our senior editor", "the experienced reviewer", "their very experienced editors"]) {
    const source = `If I approve the invoice, email the customer after ${actor} proofreads the article.`;
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    const business = `If I approve the invoice, email the customer after ${actor} emails the customer.`;
    assert.equal(ownerDelivery(business), null, business);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, business), business);
  }
  for (const response of ["we email the customer", "Alice will email the customer"])
    assert.equal(ownerDelivery(`If I approve the invoice, ${response}.`), null, response);
});

test("synthetic PR fixtures cannot hide a coordinated live publication", () => {
  for (const source of [
    "For tests, create a fake PR and a real PR.",
    "For tests, create a fake pull request and a live pull request for review.",
    "For tests, prepare data and create a fake PR and a real PR.",
    "For tests, create a fake PR and a non-fake PR.",
    "For tests, create a fake PR, a real PR.",
    "For tests, create a fake PR, then a real PR.",
    "For tests, create a fake PR, a live pull request for review.",
    "For tests, create a fake PR & a real PR.",
    "For tests, create a fake PR & a live pull request for review.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const fixtures of ["For tests, create a fake PR and a fake pull request fixture.", "For tests, create a fake PR, a mock PR fixture.", "For tests, create a fake PR & a mock PR fixture."]) {
    assert.equal(ownerDelivery(fixtures), null, fixtures);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, fixtures), fixtures);
  }
});

test("business approval exemptions do not mask technical implementation objects", () => {
  for (const source of [
    "If I approve the migration proposal, generate the database migration.",
    "If I approve the code proposal, record the repository commit.",
    "If I approve the proposal, generate the Docker image.",
    "If I approve the artwork, create the lockfile.",
    "If I approve the proposal, generate the deployment bundle.",
    "If I approve the proposal, apply the Terraform plan.",
    "If I approve the Terraform plan, apply it.",
    "Apply it after I approve the Terraform plan.",
    "If I approve the payment SDK, display it.",
    "If I approve the code comment, display it.",
    "If I approve the invoice, apply it and send the report.",
    "If I approve the proposal, apply the Kubernetes manifest.",
    "Apply the Terraform plan after I approve the proposal.",
    "If I approve the plan, send the report.",
    "If I approve the proposal, create the payment SDK.",
    "If I approve the proposal, generate the customer API.",
    "Create the payment SDK after I approve the proposal.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  for (const businessOutcome of ["If I approve the purchase, generate a customer receipt.", "If I approve the purchase, show a confirmation page.", "If a customer approves the refund, send the customer an email.", "If I approve the invoice, apply it and mark it paid."]) {
    assert.equal(ownerDelivery(businessOutcome), null, businessOutcome);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, businessOutcome), businessOutcome);
  }
});

test("publication controls remain visible beside PR feature predicates and qualifiers", () => {
  for (const source of [
    "Implement endpoint updates. Create an API PR for review.",
    "Implement report generation. Create a report PR for review.",
    "Implement dashboard updates. Create a dashboard PR for review.",
    "Do not create a PR visible to outsiders.",
    "Create a PR shareable with outsiders.",
    "Generate a PR discoverable by everyone.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
});

test("saved version-two contracts retain their original approval and PR-policy grammar", () => {
  for (const source of [
    "Build the widget after I approved it. Open a PR for review.",
    "Document whether PRs are optional in settings. Open a PR for review.",
  ]) {
    const split = source.lastIndexOf("Open a PR"), saved = { version: 2, offsets: "utf16", source, spans: [
      { start: 0, end: split, owner: "implementation" },
      { start: split, end: source.length, owner: "coordinator", kind: "pull_request" },
    ] };
    assert.equal(validateOwnerDelivery(saved), saved, source);
  }
  for (const verb of ["Created", "Opened", "Submitted", "Made", "Creates", "Opens", "Raises", "Submits"]) {
    const source = `Build the widget. ${verb} a PR for review.`, split = source.indexOf(`${verb} a PR`);
    const saved = { version: 2, offsets: "utf16", source, spans: [
      { start: 0, end: split, owner: "implementation" },
      { start: split, end: source.length, owner: "coordinator", kind: "pull_request" },
    ] };
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, `new request: ${source}`);
    assert.equal(validateOwnerDelivery(saved), saved, `historical contract: ${source}`);
  }
  for (const action of ["Opening a PR for review.", "Open pull requests for review.", "Make PRs for review."]) {
    const source = `Build the widget. ${action}`, split = source.indexOf(action);
    const saved = { version: 2, offsets: "utf16", source, spans: [
      { start: 0, end: split, owner: "implementation" },
      { start: split, end: source.length, owner: "coordinator", kind: "pull_request" },
    ] };
    assert.equal(validateOwnerDelivery(saved), saved, `historical contract: ${source}`);
  }

  const suffixSource = "Implement export. Open a PR after my approval.";
  const suffixStart = suffixSource.indexOf("Open a PR"), suffixEnd = suffixStart + "Open a PR".length;
  const truncated = { version: 2, offsets: "utf16", source: suffixSource, spans: [
    { start: 0, end: suffixStart, owner: "implementation" },
    { start: suffixStart, end: suffixEnd, owner: "coordinator", kind: "pull_request" },
    { start: suffixEnd, end: suffixSource.length, owner: "implementation" },
  ] };
  assert.throws(() => validateOwnerDelivery(truncated), { code: "TASK_DELIVERY_SCOPE" }, "saved publication span cannot leave its approval qualifier in implementation ownership");
});

test("historical publication authority uses each producer's affirmative grammar", () => {
  const savedContract = (version, clause) => {
    const source = `Implement export. ${clause}`, start = source.indexOf(clause);
    return { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end: source.length, owner: "coordinator", kind: "pull_request" },
    ] };
  };
  const fromPrd = saved => ownerDeliveryFromPrd(parsePrd(GOOD_PRD +
    `\n## Coordinator delivery contract\n\n\`\`\`json\n${JSON.stringify(saved)}\n\`\`\`\n`, "docs/prds/example.md"));
  for (const version of [1, 2]) {
    const unsupported = ["Publishing a PR.", "Prepared a PR.", "Publish a PR.", "Published a PR.", "Prepares a PR.", "Preparing a PR.", "Send a PR.", "Sends a PR.", "Sent a PR.", "Sending a PR.", "File a PR.", "Files a PR.", "Filed a PR.", "Filing a PR.", "Generate a PR.", "Please publish a PR for review.", "Open a pull-request."];
    if (version === 1) unsupported.push("Make a PR.", "Made a PR.", "Opening a PR.", "Created a PR.", "Creates a PR.", "Open PRs.", "Open an PR.", "Open another new PR.", "Openly a PR for review.", "Openhearted a PR for review.", "Creation a PR for review.", "Submittable a PR for review.");
    for (const clause of unsupported) {
      const saved = savedContract(version, clause), before = structuredClone(saved);
      for (const act of [() => validateOwnerDelivery(saved), () => ownerImplementation(saved), () => fromPrd(saved)])
        assert.throws(act, { code: "TASK_DELIVERY_SCOPE" }, `v${version}: ${clause}`);
      assert.deepEqual(saved, before, `invalid v${version} record remains unchanged`);
    }
    // v1's grammar is from ab3c37f; 3db059f emitted the wider v2 forms.
    const supported = ["Open a PR.", "Create one new pull request for code review.", "Raise the PR!", "Submit a PR for human review."];
    if (version === 2) supported.push("Opening a PR.", "Opened a PR.", "Creates a PR.", "Created a PR.", "Raises a PR.", "Raised a PR.", "Submits a PR.", "Submitted a PR.", "Make PRs.", "Makes a PR.", "Making a PR.", "Made a PR.", "Open pull requests.", "Open another new PR.");
    // Running the v2 producer at 3db059f emits these exact records too. Its
    // wildcard suffixes were not limited to grammatical verb inflections.
    if (version === 2) supported.push("Openly a PR for review.", "Openhearted a PR for review.", "Creation a PR for review.", "Submittable a PR for review.");
    for (const clause of supported) {
      const saved = savedContract(version, clause), before = structuredClone(saved);
      assert.equal(validateOwnerDelivery(saved), saved, `v${version}: ${clause}`);
      assert.deepEqual(ownerImplementation(saved), ["Implement export. "], `v${version}: ${clause}`);
      assert.deepEqual(fromPrd(saved), saved, `loaded v${version}: ${clause}`);
      assert.equal(saved.spans.map(span => saved.source.slice(span.start, span.end)).join(""), saved.source);
      assert.deepEqual(saved, before, `valid v${version} record remains unchanged`);
    }
  }
});

test("new business approval rules validate with the same v5 predicates used at intake", () => {
  const source = "If I approve the purchase, apply the discount. Implement export. Open a PR for review.";
  const contract = ownerDelivery(source);
  assert.equal(contract.version, 5);
  assert.equal(validateOwnerDelivery(contract), contract);
});

test("saved v3 and v4 contracts preserve indirect PR recipients accepted by their producer", () => {
  for (const version of [3, 4]) for (const action of [
    "Make me a PR for review.",
    "Create us a pull request for review.",
    "Submit a PR for review.",
  ]) {
    const source = `Build the widget. ${action}`;
    const start = source.indexOf(action);
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end: source.length, owner: "coordinator", kind: "pull_request" },
    ] };
    assert.equal(validateOwnerDelivery(saved), saved, `historical v${version} contract: ${source}`);
  }
});

test("saved ownership versions reapply delivery and approval controls outside the PR span", () => {
  const source = "Implement export. Open a PR for review. Wait for my approval.";
  const publicationStart = source.indexOf("Open a PR for review.");
  const publicationEnd = publicationStart + "Open a PR for review.".length;
  const spans = [
    { start: 0, end: publicationStart, owner: "implementation" },
    { start: publicationStart, end: publicationEnd, owner: "coordinator", kind: "pull_request" },
    { start: publicationEnd, end: source.length, owner: "implementation" },
  ];
  for (const version of [1, 2, 3, 4, 5])
    assert.throws(() => validateOwnerDelivery({ version, offsets: "utf16", source, spans }), { code: "TASK_DELIVERY_SCOPE" }, `saved v${version}`);
  const safe = ownerDelivery("Implement export. Open a PR for review.");
  for (const version of [1, 2, 3, 4, 5]) assert.doesNotThrow(() => validateOwnerDelivery({ ...safe, version }), `safe saved v${version}`);
});

test("historical publication spans cannot leave timing, destination or condition qualifiers in implementation scope", () => {
  for (const version of [1, 2]) for (const qualifier of [", assuming tests pass", " without delay", " ASAP", " for the release"]) {
    const source = `Implement export. Open a PR${qualifier}.`, start = source.indexOf("Open a PR"), end = start + "Open a PR".length;
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end, owner: "coordinator", kind: "pull_request" },
      { start: end, end: source.length, owner: "implementation" },
    ] };
    assert.throws(() => validateOwnerDelivery(saved), { code: "TASK_DELIVERY_SCOPE" }, `v${version}: ${source}`);
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, `fresh intake: ${source}`);
  }
  for (const version of [1, 2, 3, 4]) for (const qualifier of [" tomorrow", " against release", " to GitHub", " when tests pass"]) {
    const source = `Implement export. Open a PR${qualifier}.`, start = source.indexOf("Open a PR"), end = start + "Open a PR".length;
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end, owner: "coordinator", kind: "pull_request" },
      { start: end, end: source.length, owner: "implementation" },
    ] };
    assert.throws(() => validateOwnerDelivery(saved), { code: "TASK_DELIVERY_SCOPE" }, `v${version}: ${source}`);
  }
  for (const version of [1, 2, 3, 4]) {
    const source = "Implement export. Open a PR; when tests pass.", start = source.indexOf("Open a PR"), end = start + "Open a PR;".length;
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end, owner: "coordinator", kind: "pull_request" },
      { start: end, end: source.length, owner: "implementation" },
    ] };
    assert.throws(() => validateOwnerDelivery(saved), { code: "TASK_DELIVERY_SCOPE" }, `v${version}: semicolon qualifier remains outside coordinator ownership`);
  }
  for (const version of [1, 2, 3, 4]) for (const suffix of ["Tomorrow", "against release", "to GitHub", "when tests pass", "and when tests pass"]) {
    const source = `Implement export. Open a PR. ${suffix}.`, start = source.indexOf("Open a PR."), end = start + "Open a PR.".length;
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end, owner: "coordinator", kind: "pull_request" },
      { start: end, end: source.length, owner: "implementation" },
    ] };
    assert.throws(() => validateOwnerDelivery(saved), { code: "TASK_DELIVERY_SCOPE" }, `v${version}: sentence-delimited ${suffix} qualifier remains outside coordinator ownership`);
  }
  for (const version of [1, 2, 3, 4]) {
    const source = "Implement export. Open a PR. To make it usable, add UI tests.", start = source.indexOf("Open a PR."), end = start + "Open a PR.".length;
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end, owner: "coordinator", kind: "pull_request" },
      { start: end, end: source.length, owner: "implementation" },
    ] };
    assert.doesNotThrow(() => validateOwnerDelivery(saved), `v${version}: implementation continuation is preserved`);
  }
});

test("positive merge auxiliary sequences refuse while negative and application counterparts remain requirements", () => {
  for (const subject of ["You", "We", "The agent"]) {
    for (const lead of ["need to", "will need to", "will have to", "will be required to", "need you to", "should please", "are expected to"])
      for (const action of ["merge the PR.", "enable auto-merge."]) {
        const text = `${subject} ${lead} ${action}`;
        assert.throws(() => ownerDelivery("Implement export. " + text), { code: "TASK_DELIVERY_SCOPE" }, text);
        assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
      }
    for (const lead of ["will not have to", "do not need to", "are not required to", "must never"]) {
      const text = `${subject} ${lead} merge the PR.`;
      assert.equal(ownerDelivery(text), null, text);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
    }
  }
  assert.equal(ownerDelivery("We need you to merge duplicate contacts before saving."), null);
  assert.equal(ownerDelivery("Implement import. We will have to merge customer records before saving."), null);
});

test("publication policy modifiers retain command scope after earlier sentences", () => {
  for (const prefix of ["", "Implement export. ", "Implement export! ", "Implement export? ", "Implement export; ", "Implement export.\n\n", `${"Context ".repeat(100)}. `]) {
    for (const command of ["Do not create a PR visible to outsiders.", "Create a PR visible to outsiders.", "Do not create a PR private from the owner.", "Do not make PRs selectable."]) {
      const text = prefix + command;
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
      assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
    }
    for (const feature of ["Make PRs visible.", "Make the PR collapsible.", "Document whether PRs are selectable."]) {
      const text = prefix + feature;
      assert.equal(ownerDelivery(text), null, text);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
    }
  }
});

test("generic policy modifiers cannot mask imperative merge actions", () => {
  for (const text of [
    "Merge mergeable PRs.",
    "Merge selectable commits.",
    "Squash-merge mergeable PRs.",
    "Rebase-merge selectable commits.",
    "Please merge mergeable PRs.",
    "Tell the agent to merge selectable commits.",
    "After tests pass, merge mergeable PRs.",
    "Do not commit reviewable changes.",
    "Never commit mergeable changes.",
    "Implement export. Do not commit editable files.",
  ]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const text of [
    "Make PRs mergeable.",
    "PRs should be mergeable.",
    "Mergeable PRs are visible.",
    "Document whether PRs are mergeable.",
    "Build a settings page that lists mergeable PRs.",
    "Show whether commits are selectable.",
    "Add a commit selectable field.",
    "Document the commit editable flag.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  assert.throws(() => ownerDelivery(`${"context ".repeat(80)} and merge mergeable PRs.`), { code: "TASK_DELIVERY_SCOPE" });
});

test("coordinated application actions are scanned once without hiding Git controls", () => {
  const ordinary = `Do not create x ${"and commit a database transaction ".repeat(100)}`;
  assert.equal(ownerDelivery(ordinary), null);
  const gated = `${"If I approve x, email y, ".repeat(1000)}wait until the owner approves.`;
  assert.ok(Buffer.byteLength(gated) < 32 * 1024);
  assert.throws(() => ownerDelivery(gated), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, gated), { code: "TASK_DELIVERY_SCOPE" });
});

test("repeated application publication actions have bounded destination parsing", () => {
  const source = `${Array(1100).fill("publish messages to queue").join(", ")}.`;
  assert.ok(Buffer.byteLength(source) < 32 * 1024);
  assert.equal(ownerDelivery(source), null);
  const delayedGitDestination = `publish messages ${"with context ".repeat(180)}to GitHub.`;
  assert.ok(Buffer.byteLength(delayedGitDestination) > 2048);
  assert.ok(Buffer.byteLength(delayedGitDestination) < 32 * 1024);
  assert.throws(() => ownerDelivery(delayedGitDestination), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, delayedGitDestination), { code: "TASK_DELIVERY_SCOPE" });
});

test("negative modals share workflow controls without rejecting their application counterparts", () => {
  for (const modal of ["cannot", "can not", "can't", "could not", "couldn’t", "must not", "mustn't", "should not", "shouldn't", "will not", "won't", "would not", "wouldn't", "shall not", "shan't", "may not", "might not", "mightn't", "are not allowed to", "aren't permitted to"]) {
    for (const action of ["push changes", "commit changes", "create branches", "generate commits"]) {
      const text = `You ${modal} ${action}.`;
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
      assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
    }
    for (const action of ["publish duplicate events to Kafka", "commit the database transaction", "create duplicate user records"]) {
      const text = `You ${modal} ${action}.`;
      assert.equal(ownerDelivery(text), null, text);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
    }
  }
});

test("delegated merge requests refuse while negative constraints and data merges remain requirements", () => {
  for (const lead of ["I require you to", "We request you to", "I would like the agent to", "Have the agent", "Tell the agent to", "Instruct the assistant to", "Ask the agent to", "Make sure the agent", "Let's", "Make the agent", "Get the agent to", "I demand that you", "We mandate that you", "I authorize you to", "Assign the agent to"]) {
    for (const action of ["merge the PR", "merge it", "squash-merge the PR"]) {
      const text = `${lead} ${action}.`;
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
      assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
    }
    for (const object of ["duplicate contacts", "invoices", "database rows", "accounts", "files", "custom widgets"]) {
      const technical = `${lead} merge ${object} before saving.`;
      assert.equal(ownerDelivery(technical), null, technical);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, technical), technical);
    }
  }
  for (const text of ["I do not require you to merge the PR.", "Don't tell the agent to merge it.", "Never have the agent merge the PR.", "Let's not merge the PR.", "Require a merge summary in the UI."]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
});

test("passive publication prohibitions cover equivalent terminal adjectives", () => {
  for (const adjective of ["forbidden", "prohibited", "disallowed", "banned"]) {
    for (const text of [`Opening a PR is ${adjective}.`, `Publishing is ${adjective}.`, `PRs are ${adjective}.`, `PR creation is ${adjective}.`, `The PR's creation is ${adjective}.`, `PRs’ submission is ${adjective}.`]) {
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
      assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
    }
    assert.equal(ownerDelivery(`PR titles are ${adjective} in empty input fixtures.`), null);
  }
});

test("incomplete restriction prefixes retain scope across lines without inheriting complete constraints", () => {
  for (const prefix of ["Do not", "Never", "Don't", "You must not", "You cannot", "You aren't allowed to", "We are not permitted to", "Do not allow the agent to", "No more", "Do not under any circumstances", "Never in any case", "Don't for any reason whatsoever", "You must not at any time", "Do not ever under any circumstances"]) {
    for (const separator of ["\n", "\n\n", "\r\n"]) {
      const text = `Implement export. ${prefix}${separator}Open a PR.`;
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
      assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
    }
  }
  assert.throws(() => ownerDelivery("Do not\nopening a PR."), { code: "TASK_DELIVERY_SCOPE" });
  for (const text of ["Do not change API\nOpen a PR for review.", "Implement export. Do not merge.\nOpen a PR.", "Never log credentials\nOpen a PR.", "Do not under any circumstances change API\nOpen a PR."])
    assert.equal(validateOwnerDelivery(ownerDelivery(text)).version, 5, text);
  // Fresh checks do not reinterpret a record approved before this restriction
  // check. Its exact source/ownership still replay under the saved grammar.
  const source = "Implement export. Do not\nOpen a PR.", split = source.indexOf("Open");
  const prior = { version: 5, offsets: "utf16", source, spans: [
    { start: 0, end: split, owner: "implementation" },
    { start: split, end: source.length, owner: "coordinator", kind: "pull_request" },
  ] };
  assert.equal(validateOwnerDelivery(prior), prior);
});

test("qualified restrictions use the same action lead while data merges require a named object", () => {
  for (const qualifier of ["under any circumstances", "in any case", "at any time", "for any reason whatsoever", "by any means"])
    for (const action of ["push changes", "commit changes", "create branches"]) {
      const text = `Do not ${qualifier} ${action}.`;
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
      assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
    }
  for (const text of ["Merge.", "Merge all.", "Merge now please.", "Merge privately please.", "Merge invoices and the PR.", "Tell the agent to merge files and the approved PR."])
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
});

test("prohibition leads protect all workflow actions and unknown first application verbs", () => {
  for (const prefix of ["Refrain from", "I forbid you from", "We prohibit the agent from", "Prevent the worker from", "You are banned from", "I forbid you to", "I forbid the agent to"])
    for (const action of ["pushing changes", "committing changes", "creating branches"]) {
      const text = `${prefix} ${action}.`;
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
      assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
    }
  for (const text of ["Do not even push changes.", "Do not even once commit changes.", "Do not log API keys or commit changes.", "Do not fetch credentials and create branches."])
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
  for (const text of ["Refrain from committing the database transaction before validation.", "I forbid you from creating duplicate users.", "Do not even publish duplicate events to Kafka.", "Do not log API keys or commit the database transaction before validation.", "Do not log API keys while creating branches."])
    assert.equal(ownerDelivery(text), null, text);
});

test("application merge evidence cannot reclassify branch refs or revision targets", () => {
  for (const target of ["main", "master", "develop", "staging", "dev", "release", "HEAD", "origin/main", "feature/foo", "refs/heads/topic", "HEAD~1", "main^", "deadbeef", "v1.2.3", "untyped-target"]) {
    for (const text of [`Merge ${target}.`, `Tell the agent to merge ${target}.`, `Merge ${target} into release.`]) {
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
      assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
    }
  }
  for (const ref of ["SHA-deadbeef", "OID-deadbeef", "hash-deadbeef", "changeset-deadbeef", "SHA-1-deadbeef"])
    for (const lead of ["Merge invoices", "Tell the agent to merge files"]) {
      const text = `${lead} using ${ref}.`;
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
      assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
    }
  for (const qualifier of ["SHA", "SHA-1", "SHA-256", "SHA‐1", "SHA‑1", "SHA‒1", "SHA–1", "SHA—1", "SHA―1", "SHA‐256", "SHA‑256", "SHA‒256", "SHA–256", "SHA—256", "SHA―256", "OID", "hash", "changeset"])
    for (const separator of [" ", ":", "=", "-", "‐", "‑", "‒", "–", "—", "―"])
      for (const hash of ["abcd", "abcde", "abcdef", "deadbeef"])
        for (const lead of ["Merge invoices", "Tell the agent to merge files"]) {
          const text = `${lead} using ${qualifier}${separator}${hash}.`;
          assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
          assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
        }
  for (const qualifier of ["tag", "ref", "branch", "revision", "head"])
    for (const separator of [":", ": ", "=", " = ", "-", "‐", "‑", "‒", "–", "—", "―"])
      for (const lead of ["Merge invoices", "Tell the agent to merge files"]) {
        const text = `${lead} from ${qualifier}${separator}main.`;
        assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
        assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
      }
  for (const qualifier of ["tag", "ref", "branch", "revision", "head"])
    for (const wording of ["named", "called", "known as", "identified as", "with the name"])
      for (const lead of ["Merge invoices", "Tell the agent to merge files"]) {
        const text = `${lead} from a ${qualifier} ${wording} main.`;
        assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
        assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
      }
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"]])
    for (const ref of ["main", "HEAD", "the main", "tag metadata", "revision metrics", "SHA deadbeef"])
      for (const lead of ["Merge invoices", "Tell the agent to merge files"]) {
        const text = `${lead} from ${open}${ref}${close}.`;
        assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
        assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
      }
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"]])
    for (const qualifier of ["tag", "ref", "branch", "revision", "head"])
      for (const lead of ["Merge invoices", "Tell the agent to merge files"]) {
        const text = `${lead} from ${qualifier}${open}main${close}.`;
        assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
        assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
      }
  for (const direction of ["from", "to", "into", "onto", "on", "via", "through", "using", "in", "at", "for", "with", "against"])
    for (const target of ["main", "origin/main", "feature/foo", "the PR", "HEAD~1", "revision HEAD~1", "tag v1.2.3", "the branch topic", "Git ref refs/heads/topic", "remote branch custom", "commit deadbeef", "tag metadata", "revision metrics", "branch records", "head feature/foo", "head HEAD~1", "head refs/heads/topic", "SHA deadbeef", "OID deadbeef", "SHA-1 deadbeef", "hash deadbeef", "changeset deadbeef", "selected source deadbeef", "selected source feature/foo", "selected source (deadbeef)", "selected source [deadbeef]", "selected source {deadbeef}", "selected source <deadbeef>", "SHA(deadbeef)", "OID[deadbeef]", "hash{deadbeef}", "changeset<deadbeef>", "SHA:deadbeef", "OID=deadbeef"])
      for (const lead of ["Merge invoices", "Tell the agent to merge files"]) {
        const text = `${lead} ${direction} ${target}.`;
        assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
        assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
      }
  for (const text of ["Merge invoices from the main table.", "Tell the agent to merge files from the archive directory.", "Merge head counts into the database.", "Merge invoices with tag metadata records.", "Merge files from revision metadata tables.", "Merge hash maps into the database.", "Merge hash tables before saving.", "Merge changeset records into the database.", "Merge arrays and validate them."]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  for (const id of ["123e4567-e89b-12d3-a456-426614174000", "INV-deadbeef-US", "INV_deadbeef_US", "invoiceDeadbeefRecord"])
    for (const lead of ["Merge invoices", "Tell the agent to merge files"]) {
      const text = `${lead} using UUID ${id}.`;
      assert.equal(ownerDelivery(text), null, text);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
    }
  for (const qualifier of ["MongoDB ObjectId", "ObjectId", "checksum", "digest", "ObjectId:", "checksum="])
    for (const lead of ["Merge invoices", "Tell the agent to merge files"]) {
      const text = `${lead} using ${qualifier} 507f1f77bcf86cd799439011.`;
      assert.equal(ownerDelivery(text), null, text);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
      assert.throws(() => ownerDelivery(`${text} Merge invoices from tag main.`), { code: "TASK_DELIVERY_SCOPE" });
    }
  for (const connector of ["and", "or", "nor", ",", "as well as", "along with", "plus"])
    for (const operand of ["tag main", "also tag main", "another tag main", "one more tag main", "one additional tag main", "two extra tag main", "three further tag main", "2 additional tag main", "also the branch topic", "the other tag main", "an additional ref HEAD", "revision HEAD~1", "SHA abcd"])
      for (const lead of ["Merge invoices", "Tell the agent to merge files"]) {
        const text = `${lead} using MongoDB ObjectId 507f1f77bcf86cd799439011 ${connector} ${operand}.`;
        assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
        assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
      }
  for (const location of ["/tmp/input.json", "./input.json", "../input.json", "~/input.json", "https://example.com/input.json", "file:///tmp/input.json", "s3://bucket/input.json", "C:\\input.json", "(/tmp/input.json)", "<https://example.com/input.json>", "[~/input.json]", "{s3://bucket/input.json}"])
    for (const lead of ["Merge JSON files", "Tell the agent to merge JSON files"]) {
      const text = `${lead} from ${location}.`;
      assert.equal(ownerDelivery(text), null, text);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
    }
  for (const text of ["Merge invoices into the main table.", "Tell the agent to merge database rows before saving.", "Merge custom widgets.", "Merge configuration.", "I forbid you to commit the database transaction before validation.", "I forbid the agent to merge the PR."]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
});

test("publication quantifiers cannot conceal PR restrictions or authorize multiple deliveries", () => {
  for (const verb of ["open", "create", "raise", "submit", "send", "prepare", "make", "generate", "produce", "start", "begin", "file", "issue", "publish", "deliver", "draft"]) {
    for (const quantifier of ["any", "any new", "any more", "all", "each", "every", "some", "multiple", "several", "additional", "further", "more", "other", "no", "zero", "two", "3", "even one", "up any", "any GitHub", "automated", "an experimental review", "confidential", "any of these experimental", "one of the review"]) {
      for (const object of ["PR", "PRs", "pull request", "pull requests"]) {
        const text = `Do not ${verb} ${quantifier} ${object}.`;
        assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
        assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
      }
    }
  }
  for (const text of ["Open any PR.", "Create multiple pull requests.", "Submit 2 PRs."])
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
  for (const text of ["Do not open any PR templates.", "Don't submit any pull request descriptions.", "Do not create any more PR forms."]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
});

test("publication verbs retain titles and related feature metadata without masking later controls", () => {
  for (const verb of ["Generate", "Produce", "Make", "Draft", "Prepare", "Create"]) {
    for (const object of ["a PR title", "PR titles", "a pull request body", "PR bodies", "PR labels", "PR comments", "PR discussions", "PR reviews", "PR feedback", "PR diffs", "PR checks", "PR status", "PR statuses", "a pull request's title", "the PR's body", "the PR’s title", "the PRs' bodies", "the pull requests’ titles", "a commit's message", "the branches' reports", "a PR-title template", "a pull-request-body template", "a report about the PR", "reports referencing the PR", "a summary of the PR", "a document describing the PR"]) {
      for (const text of [`${verb} ${object} from the change summary.`, `Do not ${verb.toLowerCase()} ${object} for empty input.`]) {
        assert.equal(ownerDelivery(text), null, text);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
        const controlled = text + " Do not push changes.";
        assert.throws(() => ownerDelivery(controlled), { code: "TASK_DELIVERY_SCOPE" }, controlled);
        assert.throws(() => assertDeliveryAnswer({}, controlled), { code: "TASK_DELIVERY_SCOPE" }, controlled);
      }
    }
  }
});

test("publication gerund prohibitions refuse without classifying descriptive gerunds as commands", () => {
  for (const lead of ["You are forbidden from", "We are prohibited from", "Refrain from", "Abstain from", "Avoid", "Never allow", "Do not permit", "Stop", "Skip", "Without", "I forbid you from", "We prohibit the agent from", "Prevent the agent from", "Policy forbids the worker from", "You must prevent the coding agent from"])
    for (const action of ["opening", "creating", "raising", "submitting", "sending", "preparing", "making", "generating", "producing", "starting", "beginning", "filing", "issuing", "publishing", "delivering", "drafting"])
      for (const object of ["a PR", "any GitHub PRs"]) {
        const text = `${lead} ${action} ${object}.`;
        assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
        assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
      }
  for (const text of ["Avoid the automatic opening of any GitHub PRs.", "You are forbidden from the opening of a PR."]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const text of ["Document the procedure for opening a PR.", "Add help for creating a PR.", "Do not log API keys while opening a PR.", "Avoid the automatic opening of the PR-title editor."]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
});

test("explicit PR fixtures remain data without exempting real Git or PR objects", () => {
  for (const text of ["Generate a synthetic GitHub PR fixture for tests.", "Create a mock pull request object for parser tests.", "Produce a normalized PR record for the API.", "Do not create mock PR objects for invalid input.", "Generate a serialized PR payload.", "Create a PR example for the guide."]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  for (const text of ["Do not create commit objects.", "Do not generate branch objects.", "Do not create PR objects.", "Do not create non-mock PR objects.", "Generate a mock fixture. Do not create PR objects.", "Generate a mock fixture and do not create PR objects.", "Create a mock PR object, but do not push changes."]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
});

test("application noun phrases share destinations without qualifying workflow objects", () => {
  for (const connector of ["and", "or", "nor", "as well as", "along with", "together with", "in addition to", "not to mention", "besides", "plus"]) {
    const text = `Do not publish metrics ${connector} regional traces to S3.`;
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
    const workflow = `Do not publish the solution ${connector} upload reports to S3.`;
    assert.throws(() => ownerDelivery(workflow), { code: "TASK_DELIVERY_SCOPE" }, workflow);
    assert.throws(() => assertDeliveryAnswer({}, workflow), { code: "TASK_DELIVERY_SCOPE" }, workflow);
  }
  for (const text of ["Generate pull request models for the API.", "Produce PR records for the database.", "Create a PR schema for reporting."]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
});

test("unknown coordinated actions cannot borrow a later destination", () => {
  for (const connector of ["and", "or", "nor", "as well as", "along with", "together with", "in addition to", "not to mention", "besides", "plus"]) {
    for (const action of ["forward reports", "relay records", "dispatch receipts", "route documents", "mirror snapshots", "transmit records", "frobnicate widgets", "carefully forward reports", "you forwarded reports", "please relay reports", "never relay reports", "forward", "duplicate reports", "signal events", "parallel transfers", "mimic records", "derive reports", "supply records", "multiply records", "embed records", "feed records", "bleed records", "give reports", "apply records", "seal reports", "seed records", "frobnical reports", "frobnive records", "frobned reports", "frobnly records", "comment", "process", "bypass", "email"]) {
      const text = `Do not publish the document ${connector} ${action} to S3.`;
      for (const source of [text, `Implement export. ${text} Open a PR for review.`])
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
    }
  }
  // The conservative shared-destination grammar does not restrict direct
  // application objects, including domain compounds or unfamiliar mass nouns.
  for (const text of ["Do not publish widget latency to S3.", "Do not publish customer telemetry to S3.", "Do not publish widgets and the gizmo to S3.", "Do not publish duplicate reports to S3.", "Do not publish metrics and the duplicate reports to S3.", "Do not publish metrics plus the parallel transfers to S3.", "Do not publish metrics and the email to S3.", "Do not publish email to S3."]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
});

test("coordinated transfer verbs cannot lend destinations to earlier workflow prohibitions", () => {
  const verbs = ["upload", "uploading", "copy", "copying", "store", "storing", "save", "saving", "move", "moving", "write", "writing", "send", "sending", "fetch", "fetching", "download", "downloading", "sync", "syncing", "synchronize", "synchronizing", "transfer", "transferring", "persist", "persisting", "record", "recording", "emit", "emitting", "export", "exporting", "import", "importing", "archive", "archiving", "collect", "collecting", "back up", "backing up", "log", "logging", "ship", "shipping"];
  for (const connector of ["and", "plus", "in addition to"]) for (const verb of verbs) {
    const text = `Do not publish the artifact ${connector} ${verb} reports to S3.`;
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const lead of ["please", "you need to", "you must not", "you aren't allowed to", "never", "avoid", "prevent", "without", "skip", "do not", "don't", "cannot"]) {
    const text = `Do not publish the document and ${lead} upload reports to S3.`;
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const object of ["archived reports", "uploaded files", "downloaded receipts", "stored logs", "copied records", "sent messages", "the log entries", "the download links", "the upload URLs"]) {
    const text = `Do not publish metrics plus ${object} to S3.`;
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  for (const action of ["please download links", "never log entries", "avoid uploading files", "download links", "log entries", "upload URLs"]) {
    const text = `Do not publish the document and ${action} to S3.`;
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const object of ["log entries", "download links", "upload URLs", "email"]) {
    const text = `Do not publish metrics plus ${object} to S3.`;
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const noun of ["task", "solution", "deliverable", "fix", "update", "modification", "revision", "feature", "work item", "output", "result", "code", "patch", "branch", "PR"]) {
    const text = `Do not publish the ${noun} and metrics to S3.`;
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
});

test("saved v1/v2 ownership spans remain exact under later delivery-control grammar", () => {
  for (const instruction of [
    "Please merge it.", "Do not create a branch.", "Require user consent before delivering changes.",
    "Require user consent before committing the database transaction and creating a branch.",
    "Do not publish events or changes.", "Do not deliver notifications or the changes.",
    "Do not publish notifications to GitHub.", "Do not publish changes for review and deliver reports to S3.",
    "A PR can't be created.", "Do not publish monthly tasks to S3.",
    "Require user consent before publishing duplicate events and please push changes.",
    "Do not publish the document and forward reports to S3.",
    "Do not publish the document and duplicate reports to S3.",
    "Do not publish the document and give reports to S3.",
    "Do not publish the document and email to S3.",
    "Do not publish metrics plus log entries to S3.",
    "Do not publish metrics plus download links to S3.",
    "Do not open any pull requests.",
    "Don't submit any PRs.",
    "Do not make any PRs.",
    "Never generate additional pull requests.",
    "Do not open any GitHub PRs.",
    "Do not create automated pull requests.",
    "You are forbidden from opening a PR.",
    "Refrain from opening a pull request.",
    "I forbid you from opening a PR.",
    "We prohibit the agent from opening any GitHub PRs.",
    "I require you to merge the PR.",
    "Opening a PR is prohibited.",
    "PR creation is prohibited.",
    "The PR's creation is banned.",
  ]) {
    const source = "Implement export. Open a PR for review. " + instruction;
    const start = source.indexOf("Open"), end = source.indexOf(" " + instruction);
    for (const version of [1, 2]) {
      const saved = { version, offsets: "utf16", source, spans: [
        { start: 0, end: start, owner: "implementation" },
        { start, end, owner: "coordinator", kind: "pull_request" },
        { start: end, end: source.length, owner: "implementation" },
      ] };
      const before = structuredClone(saved);
      assert.equal(validateOwnerDelivery(saved), saved, instruction);
      assert.deepEqual(saved, before);
    }
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, instruction);
  }
});

test("v3/v4 saved spans preserve historical controls but refuse publication contradictions", () => {
  for (const version of [3, 4]) {
    for (const clause of [
      "Open a single new PR for review.",
      "Opens a PR for review.",
      "Opening a PR for review.",
      "Makes another new PR for review.",
    ]) {
      const source = `Implement export. ${clause}`, start = source.indexOf(clause);
      const saved = { version, offsets: "utf16", source, spans: [
        { start: 0, end: start, owner: "implementation" },
        { start, end: source.length, owner: "coordinator", kind: "pull_request" },
      ] };
      assert.equal(validateOwnerDelivery(saved), saved, `historical v${version}: ${clause}`);
    }
    for (const instruction of ["Please merge it.", "Do not create a branch.", "Require user consent before delivering changes.", "Do not publish monthly tasks to S3."]) {
      const source = `Implement export. Open a PR for review. ${instruction}`, start = source.indexOf("Open"), end = source.indexOf(` ${instruction}`);
      const saved = { version, offsets: "utf16", source, spans: [
        { start: 0, end: start, owner: "implementation" },
        { start, end, owner: "coordinator", kind: "pull_request" },
        { start: end, end: source.length, owner: "implementation" },
      ] };
      assert.equal(validateOwnerDelivery(saved), saved, `historical v${version}: ${instruction}`);
    }
    const source = "Implement export. Do not generate a PR. Open a PR for review.", start = source.lastIndexOf("Open");
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end: source.length, owner: "coordinator", kind: "pull_request" },
    ] };
    assert.throws(() => validateOwnerDelivery(saved), { code: "TASK_DELIVERY_SCOPE" }, `historical v${version} contradiction`);
    const many = "Implement export. Make one hundred and six PRs. Open a PR for review.", publication = many.lastIndexOf("Open");
    assert.throws(() => validateOwnerDelivery({ version, offsets: "utf16", source: many, spans: [
      { start: 0, end: publication, owner: "implementation" },
      { start: publication, end: many.length, owner: "coordinator", kind: "pull_request" },
    ] }), { code: "TASK_DELIVERY_SCOPE" }, `historical v${version} quantified contradiction`);
  }
});

test("ownership partitions exact Unicode source and removes only affirmative publication", () => {
  for (const source of [
    "Improve the café greeting, test it, and open one pull request for review; do not merge or add dependencies.",
    "Implement CSV and JSON export. Test both. Open a PR for review. Do not release.",
  ]) {
    const contract = ownerDelivery(source);
    assert.equal(contract.source, source); assert.equal(contract.offsets, "utf16");
    assert.equal(contract.spans.map(s => source.slice(s.start, s.end)).join(""), source);
    assert.equal(contract.spans[0].start, 0); assert.equal(contract.spans.at(-1).end, source.length);
    for (let i = 1; i < contract.spans.length; i++) assert.equal(contract.spans[i - 1].end, contract.spans[i].start);
    assert.doesNotMatch(ownerImplementation(contract).join(""), /open (?:one pull request|a PR)/i);
    assert.match(ownerImplementation(contract).join(""), /do not (?:merge|release)/i);
    const forged = structuredClone(contract); forged.spans[0].end--;
    assert.throws(() => validateOwnerDelivery(forged), { code: "TASK_DELIVERY_SCOPE" });
  }
});

test("quoted/code examples never create publication authority", () => {
  for (const source of ['Render "Open one pull request for review" in help.', "Render `Open a PR` in help.", "Show 'Open a PR' in the example.", "Document this example:\n```\nOpen a PR\n```"])
    assert.equal(ownerDelivery(source), null);
});

test("publish feature subjects and paired typographic examples remain implementation scope", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const source of ["Add a publish button.", "Add a command to publish docs.", "Render “Open a PR” in help.", "Document ‘Do not push’.", "Document ‘the user’s Open a PR instruction’.", "Preserve the user’s publish option."]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, source), source);
    const text = "😀 " + source + " Open a PR for review.", contract = ownerDelivery(text);
    assert.equal(contract.spans.map(span => text.slice(span.start, span.end)).join(""), text);
    assert.equal(ownerImplementation(contract).join(""), "😀 " + source + " ");
  }
  for (const source of ["Publish the changes.", "Please publish the changes.", "Please automatically publish changes.", "Implement export, then publish it.", "Do not publish anything.", "Do not ever publish anything.", "Never automatically publish changes.", "Only publish after approval.", "Render “Open a PR” in help. Do not push.", "Render “Open a PR\" in help.", "Document ‘Do not push.", "Don’t publish anything."]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer(task, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
});

test("quoted contractions and supported exclamation boundaries preserve exact owner scope", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const source of ["Document 'We're waiting; do not push' in help.", "Document ‘We're waiting; do not push’ in help."]) {
    assert.equal(ownerDelivery(source), null);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, source));
    assert.throws(() => ownerDelivery(source + " Do not push."), { code: "TASK_DELIVERY_SCOPE" });
  }
  for (const source of ["Implement CSV export! Open a PR for review.", "Implement CSV export. Open a PR for review! Do not merge.", "Implement CSV export! and open a PR for review! Do not merge."]) {
    const contract = ownerDelivery(source);
    assert.equal(contract.spans.map(span => source.slice(span.start, span.end)).join(""), source);
    assert.equal(validateOwnerDelivery(contract), contract);
    assert.match(ownerImplementation(contract).join(""), /Implement CSV export/);
    assert.doesNotMatch(ownerImplementation(contract).join(""), /open a PR/i);
  }
  const savedSource = "Implement CSV export! and open a PR for review!";
  for (const version of [1, 2]) {
    const split = savedSource.indexOf(version === 1 ? "open" : " and");
    const saved = { version, offsets: "utf16", source: savedSource, spans: [
      { start: 0, end: split, owner: "implementation" },
      { start: split, end: savedSource.length, owner: "coordinator", kind: "pull_request" },
    ] };
    assert.equal(validateOwnerDelivery(saved), saved, "previously supported connector spans stay immutable");
  }
  for (const source of ["Use JSON! Publish the changes.", "Implement CSV! Do not ever publish changes.", "Implement CSV! Only after my approval.", "Implement CSV! Open a PR only if I approve."])
    for (const action of [() => ownerDelivery(source), () => assertDeliveryAnswer(task, source)]) assert.throws(action, { code: "TASK_DELIVERY_SCOPE" }, source);
});

test("unclosed literal delimiters cannot hide workflow restrictions", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const delimiter of ["'", '"', "`", "```", "‘", "“"]) {
    const text = "Implement export. " + delimiter + "Do not push.";
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer(task, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const text of ["Document 'We\'re waiting; do not push' in help.", "Document `Do not push` in help.", "Document this code:\n```\nRender `Do not push` in help.\n```", 'Document "Do not push" in help.']) {
    assert.equal(ownerDelivery(text), null);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, text));
  }
});

test("saved unclosed-literal ownership remains exact while fresh requests refuse", () => {
  for (const suffix of [" 'Do not push.", " `Open a PR."]) {
    const source = "Implement export. Open a PR." + suffix;
    const start = source.indexOf("Open"), end = source.indexOf(suffix);
    for (const version of [1, 2]) {
      const saved = { version, offsets: "utf16", source, spans: [
        { start: 0, end: start, owner: "implementation" },
        { start, end, owner: "coordinator", kind: "pull_request" },
        { start: end, end: source.length, owner: "implementation" },
      ] };
      const before = structuredClone(saved);
      assert.equal(validateOwnerDelivery(saved), saved);
      assert.deepEqual(saved, before);
    }
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" });
  }
});

test("historical malformed mixed backticks refuse without changing saved records", () => {
  // Produced and accepted by 2bf8268: its single-character scanner exposed the
  // apparent publication after the unmatched mixed delimiter run.
  const source = "Implement export. ` code ``` Open a PR. ";
  const saved = { version: 2, offsets: "utf16", source, spans: [
    { start: 0, end: 29, owner: "implementation" },
    { start: 29, end: 39, owner: "coordinator", kind: "pull_request" },
    { start: 39, end: 40, owner: "implementation" },
  ] };
  const before = structuredClone(saved);
  assert.throws(() => validateOwnerDelivery(saved), { code: "TASK_DELIVERY_SCOPE" });
  assert.deepEqual(saved, before);
  assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" });
});

test("technical feature objects and application consent are not delivery controls", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const text of [
    "Create a PR template for this repository.", "Open a PR details dialog.", "Submit a PR review form.",
    "Create a pull request status component.", "Do not commit the database transaction when validation fails.",
    "Avoid pushing duplicate items onto the queue.", "Never push an item onto the stack twice.",
    "Require user confirmation before deleting an account.", "Ask for user permission before accessing the camera.", "User consent is required before deleting an account.", "Require confirmation before deleting an account.", "Require user confirmation before creating a PR template.", "Require user confirmation before committing the database transaction.", "Do not commit the database transaction or push duplicate items onto the queue.", "Do not silently commit the database transaction.",
    "Do not generate reports and commit them to the database.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, text), text);
    const source = text + " Open a PR for review.", contract = ownerDelivery(source);
    assert.equal(ownerImplementation(contract).join(""), text + " ");
    assert.equal(contract.spans.map(span => source.slice(span.start, span.end)).join(""), source);
    for (const restriction of ["Do not push.", "Wait for my approval.", "Publication only after approval."])
      for (const act of [() => ownerDelivery(text + " " + restriction), () => assertDeliveryAnswer(task, text + " " + restriction)])
        assert.throws(act, { code: "TASK_DELIVERY_SCOPE" }, text + " " + restriction);
  }
  for (const text of ["Create a PR tomorrow.", "Open a PR against release.", "Submit a PR when I approve.", "Do not commit the changes.", "Never automatically push changes.", "Do not silently commit changes.", "Do not commit the database transaction or silently push changes.", "Avoid pushing commits to the remote.", "Never run git push.", "Require my confirmation before proceeding.", "Ask for user permission before publishing.", "Require user confirmation before git push.", "Require user permission before running git push.", "Do not commit the database transaction or push any changes.", "Avoid pushing duplicate items onto the queue and committing changes.", "Do not generate reports and commit them to GitHub."])
    for (const act of [() => ownerDelivery(text), () => assertDeliveryAnswer(task, text)]) assert.throws(act, { code: "TASK_DELIVERY_SCOPE" }, text);
});

test("negative coordination retains nor, correlative and comma-list Git restrictions", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const connector of [" nor ", ", nor ", ", ", " but "]) {
    const rejected = "Do not commit the database transaction" + connector + "push changes.";
    const technical = "Do not commit the database transaction" + connector + "push duplicate items onto the queue.";
    for (const act of [() => ownerDelivery("Implement export. " + rejected), () => assertDeliveryAnswer(task, rejected)])
      assert.throws(act, { code: "TASK_DELIVERY_SCOPE" }, rejected);
    assert.equal(ownerDelivery(technical), null);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, technical));
  }
  for (const text of ["Neither commit the database transaction nor push changes.", "Neither commit the database transaction nor run git push.", "Do not commit the database transaction nor silently push changes."])
    for (const act of [() => ownerDelivery(text), () => assertDeliveryAnswer(task, text)]) assert.throws(act, { code: "TASK_DELIVERY_SCOPE" }, text);
  const text = "Neither commit the database transaction nor push duplicate items onto the queue.";
  assert.equal(ownerDelivery(text), null); assert.doesNotThrow(() => assertDeliveryAnswer(task, text));
});

test("independent statement restrictions do not qualify later publication", () => {
  for (const separator of ["; ", "\n", ". ", "! "]) {
    const source = "Implement export" + separator + "do not change the API" + separator + "open a PR for review.";
    const contract = ownerDelivery(source);
    assert.equal(contract.spans.map(span => source.slice(span.start, span.end)).join(""), source);
    assert.match(ownerImplementation(contract).join(""), /do not change the API/);
    assert.doesNotMatch(ownerImplementation(contract).join(""), /open a PR/);
  }
  for (const source of ["Implement export; do not: open a PR.", "Implement export; do not:\nopen a PR.", "Implement export; do not:\n\nopen a PR.", "Implement export; only if tests pass:\n\nopen a PR.", "Implement export; only if tests pass:\nopen a PR.", "Implement export; do not merge, open a PR.", "Implement export; only after approval open a PR.", "Implement export; wait for my approval; open a PR."])
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
});

test("negative coordination retains workflow restrictions without rejecting technical operations", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  const restrictions = [
    "Do not commit the database transaction nor push changes.",
    "Do not commit the database transaction, nor silently run git push.",
    "Do not commit the database transaction, nor should you push changes.",
    "Do not commit the database transaction, nor may we automatically publish changes.",
    "Do not commit the database transaction, nor should you silently run git push.",
    "Avoid pushing duplicate items onto the queue nor committing changes.",
    "Do not commit the database transaction nor push duplicate items onto the queue nor push changes.",
    "Neither commit the database transaction nor push changes.",
    "Do not commit the database transaction nor publish changes.",
    "Neither publish changes nor push them.",
    "Do not commit the database transaction; nor push changes.",
    "Require user confirmation before committing the database transaction nor pushing changes.",
  ];
  for (const text of restrictions) {
    for (const prefix of ["Implement export. ", "Implement export. Open a PR for review. "])
      assert.throws(() => ownerDelivery(prefix + text), { code: "TASK_DELIVERY_SCOPE" }, prefix + text);
    assert.throws(() => assertDeliveryAnswer(task, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const text of [
    "Do not commit the database transaction nor push duplicate items onto the queue.",
    "Neither commit the database transaction nor push duplicate items onto the queue.",
    "Do not commit the database transaction, nor should you push duplicate items onto the queue.",
    "Do not commit the database transaction and the push button should remain disabled.",
    "Do not commit the database transaction nor push duplicate items onto the queue nor commit the SQL transaction.",
    "Require user confirmation before committing the database transaction nor pushing duplicate items onto the queue.",
    'Document "Do not commit the database transaction nor push changes" in help.',
    "Document ‘Neither commit nor push changes’ in help.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, text), text);
    const source = text + " Open a PR for review.", contract = ownerDelivery(source);
    assert.equal(ownerImplementation(contract).join(""), text + " ");
    assert.equal(contract.spans.map(span => source.slice(span.start, span.end)).join(""), source);
  }
});

test("initial requests cannot contradict the default publication workflow", () => {
  for (const instruction of ["Keep the change local", "Do not push", "Don't commit", "Return a patch only", "Show diff only", "Wait for my review", "Pause the task", "Withhold the changes"]) {
    for (const source of ["Implement export. " + instruction + ".", "Implement export, " + instruction + ", and open a PR for review."])
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  assert.equal(ownerDelivery('Render the literal labels "local", "patch" and "review".'), null);
  assert.ok(ownerDelivery('Render "Keep the change local". Open a PR for review.'));
});

test("publication preferences and fresh legacy answers cannot waive delivery restrictions", () => {
  for (const text of ["I don't want a PR.", "We don't need a pull request.", "I do not want a PR.", "We have no need for a PR.", "I don’t require a pull request."]) {
    assert.throws(() => ownerDelivery("Implement export. " + text), { code: "TASK_DELIVERY_SCOPE" }, text);
    for (const task of [{}, { completion: { version: 1, target: "delivery_ready" } }])
      assert.throws(() => assertDeliveryAnswer(task, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  for (const text of ["Do not push.", "Keep the change local.", "Wait for my confirmation."])
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  for (const text of ['Document "I don’t want a PR" in help.', "We don't need a pull request template."])
    assert.equal(ownerDelivery(text), null);
  const source = "Implement export. Open a PR for review. I don't want a PR.";
  for (const version of [1, 2]) {
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: source.indexOf("Open"), owner: "implementation" },
      { start: source.indexOf("Open"), end: source.indexOf(" I don't"), owner: "coordinator", kind: "pull_request" },
      { start: source.indexOf(" I don't"), end: source.length, owner: "implementation" },
    ] };
    assert.equal(validateOwnerDelivery(saved), saved, "historical ownership stays canonical");
  }
  assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" });
});

test("negative implementation requirements remain authoritative without a positive lead sentence", () => {
  for (const text of ["Do not log API keys in error responses.", "Never expose credentials in diagnostics.", "No API keys in logs."]) {
    const source = text + " Open a PR for review.", contract = ownerDelivery(source);
    assert.equal(ownerImplementation(contract).join(""), text + " ");
    assert.equal(contract.spans.map(span => source.slice(span.start, span.end)).join(""), source);
  }
  for (const source of ["Open a PR; do not merge or release.", "Open a PR. Please do not merge.", "Open a PR. And do not merge or deploy."])
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" });
  // Previously accepted technical scope and contraction-only records retain
  // their canonical spans; relaxing negative requirements cannot invalidate them.
  for (const source of ["Scope: Do not commit the database transaction. Open a PR for review.", "Open a PR; don't merge."]) {
    const separator = source.indexOf("; "), end = separator < 0 ? source.length : separator + 1;
    const start = source.indexOf("Open");
    for (const version of [1, 2]) {
      const saved = { version, offsets: "utf16", source, spans: [
        ...(start ? [{ start: 0, end: start, owner: "implementation" }] : []),
        { start, end, owner: "coordinator", kind: "pull_request" },
        ...(end < source.length ? [{ start: end, end: source.length, owner: "implementation" }] : []),
      ] };
      assert.equal(validateOwnerDelivery(saved), saved);
    }
  }
});

test("implementation nouns are not lifecycle instructions in initial requests or answers", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const source of ["Add local storage.", "Keep local storage working.", "Add a review dashboard.", "Display commit SHA in diagnostics.", "Fix the diff viewer.", "Add branch selection.", "Implement export. Scope: aporthq/task-delivery-onboarding-qualification only."]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, source), source);
    assert.ok(ownerDelivery(source.replace(/ Scope:.*$/, "") + " Open a PR for review."), source);
  }
});

test("publication subjects and technical conditions remain implementation scope", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const source of ["Add a PR status badge.", "Build a pull-request dashboard.", "Update the pull request template to require changelog entries.", "Fix parsing of PR titles.", "Add a list of published articles.", "Use local time for display.", "Preserve branch sorting order.", "Commit the database transaction after validation."]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, source), source);
  }
  const text = "If name is empty, return friend. Open a PR for review.";
  assert.equal(ownerImplementation(ownerDelivery(text)).join("").trim(), "If name is empty, return friend.");
  for (const source of ["Wait for my approval. Open a PR for review.", "Implement export. Do not proceed until I approve.", "Implement export. My approval is required.", "Implement export. My approval is required. Open a PR.", "Implement export. Publish the changes.", "Implement export. Send a PR for review.", "Implement export. Open a pull-request.", "Implement export. Only if tests pass open a PR."]) assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
  for (const answer of ["Wait for my approval.", "Do not proceed until I approve.", "My confirmation is required.", "Skip publication.", "No PR should be created.", "Send it for review."]) assert.throws(() => assertDeliveryAnswer(task, answer), { code: "TASK_DELIVERY_SCOPE" }, answer);
});

test("publication-subject conditions and standalone gates remain owner controls", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const clause of ["Publication only after tests pass.", "PR only after approval.", "Publishing requires approval.", "Only after tests pass.", "Keep changes only local."]) {
    assert.throws(() => ownerDelivery("Implement export. " + clause), { code: "TASK_DELIVERY_SCOPE" }, clause);
    assert.throws(() => ownerDelivery("Implement export. Open a PR. " + clause), { code: "TASK_DELIVERY_SCOPE" }, clause);
    assert.throws(() => assertDeliveryAnswer(task, clause), { code: "TASK_DELIVERY_SCOPE" }, clause);
  }
});

test("product publication behavior stays inside its clause and parentheticals cannot hide controls", () => {
  const task = { completion: { version: 1, target: "delivery_ready" } };
  for (const source of [
    "The webhook handler, when invoked, creates a PR after validation.",
    "The application, once configured, opens a PR when the command runs.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer(task, source), source);
  }
  for (const source of [
    "The webhook handler, although PRs must not be published, creates a PR after validation.",
    "The webhook handler, while opening PRs is forbidden, creates a PR after validation.",
    "The webhook handler creates a PR when invoked, yet PRs must not be published.",
    "The button creates a PR after tests pass, while opening pull requests is forbidden.",
    "The webhook handler creates a PR when invoked, although PRs are not allowed.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer(task, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
});

test("ambiguous, conditional, qualified and delivery-only requests refuse before planning", () => {
  for (const source of [
    "Please open one pull request for review.", "Open a PR.", "Open a PR; do not merge or release.",
    "Implement export. Do not: open a PR.", "Implement export. Do not merge, open a PR.",
    "Implement export. No PR should be created.", "Implement export. Do not publish anything.",
    "Implement export. Only if tests pass open a PR.",
    "Wait for my explicit confirmation before proceeding. Open a PR for review.",
    "Implement export. Open a PR for review. Wait for my permission first.",
    "Implement export. Open a PR against release.", "Implement export. Open a PR in other/repo.",
    "Implement export. Open a PR and release it.", "Implement export. Explain how to open a PR.",
    "Implement export. Open a PR. Open another PR.",
    "Implement export. Publish the changes for review.", "Implement export. Send a PR for review.", "Implement export. Open a pull-request.",
  ]) assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
});

test("unsupported positive publication forms require clarification instead of provider criteria", () => {
  for (const clause of ["Publish the changes for review", "Send a PR for review", "Open a pull-request", "Publish the changes", "Prepare the PR", "Open pull-requests"])
    assert.throws(() => ownerDelivery(`Implement export. ${clause}.`), { code: "TASK_DELIVERY_SCOPE" }, clause);
  assert.equal(ownerDelivery('Render "Publish the changes for review" and `Open a pull-request` in help.'), null);
  assert.throws(() => assertDeliveryAnswer({}, "Open a pull-request"), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, "Do not publish publicly."), { code: "TASK_DELIVERY_SCOPE" });
});

test("initial delivery restrictions cannot become implementation criteria under the default review target", () => {
  for (const restriction of ["Keep the change local", "Keep this local", "Keep changes local-only", "Leave these edits uncommitted", "Do not push", "Don't run git push", "Never commit",
    "Return a patch only", "Show only a diff", "Only return a patch", "Just return a diff", "Do not send it for review", "Pause delivery", "Hold the change for my approval", "Wait for my approval"]) {
    for (const text of [`Implement CSV export. ${restriction}.`, `Implement CSV export. Open a PR for review. ${restriction}.`])
      assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({ completion: { version: 1, target: "delivery_ready" } }, restriction), { code: "TASK_DELIVERY_SCOPE" });
  }
  for (const text of ['Document "Keep the change local", "Do not push" and `Return a patch only`.',
    "Implement branch sorting. Update the patch renderer. Cache local timezone offsets."])
    assert.equal(ownerDelivery(text), null);
  assert.ok(ownerDelivery("Implement branch sorting. Update the patch renderer. Open a PR for review."));
});

test("new-request delivery restrictions do not reinterpret exact saved ownership versions", () => {
  const source = "Implement CSV export. Open a PR for review. Keep the change local.";
  const start = source.indexOf("Open"), end = source.indexOf(" Keep");
  for (const version of [1, 2]) {
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end, owner: "coordinator", kind: "pull_request" },
      { start: end, end: source.length, owner: "implementation" },
    ] };
    const before = structuredClone(saved);
    assert.equal(validateOwnerDelivery(saved), saved);
    assert.deepEqual(saved, before);
  }
  assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" });
});

test("new answers cannot silently override existing publication ownership", () => {
  const task = { ownerDelivery: ownerDelivery("Implement export. Open a PR for review.") };
  for (const answer of ["Do not open a PR until I approve the change", "Wait for my confirmation first.", "Only publish after permission.", "Do not publish anything", "Skip publication", "Keep the change local", "Do not send it for review", "Show diff only", "Do not push", "Return a patch without publishing", "Hold the change for my approval"])
    assert.throws(() => assertDeliveryAnswer(task, answer), { code: "TASK_DELIVERY_SCOPE" });
  assert.doesNotThrow(() => assertDeliveryAnswer(task, "Use CSV and preserve the existing dependency declarations."));
  assert.doesNotThrow(() => assertDeliveryAnswer(task, 'The label is "Open a PR".'));
  assert.throws(() => assertDeliveryAnswer({ completion: { version: 1, target: "delivery_ready" } }, "Keep the change local"), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => assertDeliveryAnswer({}, "Keep the change local"), { code: "TASK_DELIVERY_SCOPE" }, "new legacy answers obey the actual review-PR workflow");
});

test("publication owns its terminator and courtesy prefix, never a punctuation-only provider requirement", () => {
  for (const source of ["Implement export. Open a PR for review.", "Implement export. Open a PR; do not merge.", "Implement export.\nPlease open a PR for review.\nDo not merge."]) {
    const contract = ownerDelivery(source), implementation = ownerImplementation(contract);
    assert.equal(contract.spans.map(s => source.slice(s.start, s.end)).join(""), source);
    assert.ok(implementation.every(s => !s.trim() || /[\p{L}\p{N}]/u.test(s)), JSON.stringify(implementation));
    assert.ok(implementation.every(s => !/^[.;]/.test(s.trim())), JSON.stringify(implementation));
    assert.ok(implementation.every(s => !/\bPlease\s*$/i.test(s.trim())), JSON.stringify(implementation));
  }
});

test("publication owns recognized connectors without changing implementation text or exact source coverage", () => {
  for (const connector of [", and ", ", and then ", ", then ", ", ", " and ", " and then ", " then ", ", AND THEN "]) {
    const implementation = 'Implement CSV and JSON export for the café label "and then"';
    const source = `${implementation}${connector}open a PR for review; do not merge or add dependencies.`;
    const contract = ownerDelivery(source);
    assert.deepEqual(ownerImplementation(contract), [implementation, " do not merge or add dependencies."], connector);
    assert.equal(contract.version, 5);
    assert.equal(contract.spans.map(span => source.slice(span.start, span.end)).join(""), source);
    assert.equal(contract.spans.find(span => span.owner === "coordinator").start, implementation.length);
    assert.equal(validateOwnerDelivery(contract), contract);
  }
  for (const source of ["Implement export only if approved, and open a PR.", "Do not merge, and then open a PR.", "Implement export, and open a PR after approval.",
    'Implement export, "preserve CSV headers" open a PR for review.', 'Implement export and "literal" open a PR for review.',
    "Implement export,\nand open a PR for review.", "Implement export, and\nopen a PR for review.", "Implement export, and then\nPlease open a PR for review."])
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" });
});

test("saved version-one ownership remains exact and cannot authorize forged connector ranges", () => {
  const source = "Implement CSV export, and open a PR for review.";
  const split = source.indexOf("open");
  const legacy = { version: 1, offsets: "utf16", source, spans: [
    { start: 0, end: split, owner: "implementation" },
    { start: split, end: source.length, owner: "coordinator", kind: "pull_request" },
  ] };
  const before = structuredClone(legacy);
  assert.equal(validateOwnerDelivery(legacy), legacy);
  assert.deepEqual(ownerImplementation(legacy), ["Implement CSV export, and "]);
  assert.deepEqual(legacy, before);
  const corrected = ownerDelivery(source);
  assert.deepEqual(ownerImplementation(corrected), ["Implement CSV export"]);
  for (const value of [{ ...corrected, version: 1 }, { ...legacy, version: 2 }, { ...corrected, version: 99 }])
    assert.throws(() => validateOwnerDelivery(value), { code: "TASK_DELIVERY_SCOPE" });
  for (const original of [legacy, corrected]) {
    const forged = structuredClone(original); forged.spans[0].end--; forged.spans[1].start--;
    assert.throws(() => validateOwnerDelivery(forged), { code: "TASK_DELIVERY_SCOPE" });
  }
  for (const version of [1, 2]) {
    const source = "Implement export. Do not Open a PR.", start = source.indexOf("Open a PR");
    const forged = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end: source.length, owner: "coordinator", kind: "pull_request" },
    ] };
    assert.throws(() => validateOwnerDelivery(forged), { code: "TASK_DELIVERY_SCOPE" }, `v${version} cannot split a prohibition from its PR directive`);
  }
  for (const version of [1, 2]) {
    const source = "Implement export. Open a PR after my approval.", start = source.indexOf("Open a PR"), end = start + "Open a PR".length;
    const forged = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end, owner: "coordinator", kind: "pull_request" },
      { start: end, end: source.length, owner: "implementation" },
    ] };
    assert.throws(() => validateOwnerDelivery(forged), { code: "TASK_DELIVERY_SCOPE" }, `v${version} cannot leave an approval qualifier outside the coordinator span`);
  }
  for (const version of [1, 2]) for (const source of ["Implement export. After CI passes, Open a PR.", "Implement export. Only after CI passes open a PR.", "Implement export. Tomorrow open a PR.", "Implement export. When tests pass, open a PR."]) {
    const directive = source.search(/\bopen a PR/i), start = version === 2 && source[directive - 2] === "," ? directive - 2 : directive;
    const forged = { version, offsets: "utf16", source, spans: [
      { start: 0, end: start, owner: "implementation" },
      { start, end: source.length, owner: "coordinator", kind: "pull_request" },
    ] };
    assert.throws(() => validateOwnerDelivery(forged), { code: "TASK_DELIVERY_SCOPE" }, `v${version} cannot leave a governing condition before the coordinator span: ${source}`);
  }
  const priorApprovalSource = "Build the widget after I approved it, and Open a PR for review.", priorApprovalStart = priorApprovalSource.indexOf("Open a PR");
  const priorApproval = { version: 1, offsets: "utf16", source: priorApprovalSource, spans: [
    { start: 0, end: priorApprovalStart, owner: "implementation" },
    { start: priorApprovalStart, end: priorApprovalSource.length, owner: "coordinator", kind: "pull_request" },
  ] };
  assert.equal(validateOwnerDelivery(priorApproval), priorApproval, "an approval gate on historical implementation text stays in its original scope");
  for (const source of ['Implement export, "preserve CSV headers" open a PR for review.', "Implement export,\nand open a PR for review.", "Implement export, and\nopen a PR for review."]) {
    const split = source.indexOf("open");
    const prior = { version: 1, offsets: "utf16", source, spans: [
      { start: 0, end: split, owner: "implementation" },
      { start: split, end: source.length, owner: "coordinator", kind: "pull_request" },
    ] };
    assert.equal(validateOwnerDelivery(prior), prior);
    assert.deepEqual(ownerImplementation(prior), [source.slice(0, split)]);
  }
});

test("historical coordinator spans require a complete governing clause", () => {
  for (const version of [1, 2]) {
    for (const source of [
      "Implement export. Refuse to Open a PR.",
      "Implement export. Refuse to, Open a PR.",
      "Implement export, after CI passes, Open a PR.",
      "Implement export, when tests pass, Open a PR.",
      "Implement export, only after approval, Open a PR.",
    ]) {
      const action = source.lastIndexOf("Open a PR");
      const connector = source.slice(0, action).match(/,\s*(?:and\s*)?$/i);
      const start = version === 2 && connector ? action - connector[0].length : action;
      const saved = { version, offsets: "utf16", source, spans: [
        { start: 0, end: start, owner: "implementation" },
        { start, end: source.length, owner: "coordinator", kind: "pull_request" },
      ] };
      assert.throws(() => validateOwnerDelivery(saved), { code: "TASK_DELIVERY_SCOPE" }, `v${version}: ${source}`);
    }
    for (const source of [
      "Implement export. Open a PR for review.",
      "Implement export, and Open a PR for review.",
      "Build the widget after I approved it, and Open a PR for review.",
    ]) {
      const action = source.lastIndexOf("Open a PR");
      const connector = source.slice(0, action).match(/,\s*(?:and\s*)?$/i);
      const start = version === 2 && connector ? action - connector[0].length : action;
      const saved = { version, offsets: "utf16", source, spans: [
        { start: 0, end: start, owner: "implementation" },
        { start, end: source.length, owner: "coordinator", kind: "pull_request" },
      ] };
      assert.equal(validateOwnerDelivery(saved), saved, `v${version}: ${source}`);
    }
  }
});

test("elisions retain following requirements without changing historical literal spans", () => {
  for (const text of ["Support '90s date formats.", "Preserve 'tis and 'em in the sample.", "Preserve '90s and 'tis in the sample."]) {
    const source = text + " Open a PR for review.", contract = ownerDelivery(source);
    assert.equal(contract.version, 5);
    assert.deepEqual(ownerImplementation(contract), [text + " "]);
    assert.throws(() => ownerDelivery(text + " Do not push."), { code: "TASK_DELIVERY_SCOPE" });
    assert.throws(() => assertDeliveryAnswer({}, text + " Please merge it."), { code: "TASK_DELIVERY_SCOPE" });
  }
  for (const text of ['Document "\'90s do not push" in help.', 'Document "\'tis time; do not push" in help.'])
    assert.equal(ownerDelivery(text), null, "complete quotations remain literal examples");
  const source = "Implement export. Open a PR. Preserve 'tis in the sample.";
  for (const version of [1, 2]) {
    const saved = { version, offsets: "utf16", source, spans: [
      { start: 0, end: 18, owner: "implementation" },
      { start: 18, end: 28, owner: "coordinator", kind: "pull_request" },
      { start: 28, end: source.length, owner: "implementation" },
    ] };
    assert.equal(validateOwnerDelivery(saved), saved);
  }
  const elisionAndPolicy = "'cause we should not create a PR, label the button 'Ready'.";
  assert.throws(() => ownerDelivery(elisionAndPolicy), { code: "TASK_DELIVERY_SCOPE" }, elisionAndPolicy);
  assert.throws(() => assertDeliveryAnswer({}, elisionAndPolicy), { code: "TASK_DELIVERY_SCOPE" }, elisionAndPolicy);
  const possessiveElision = "'cause we should not create a PR for users' safety.";
  assert.throws(() => ownerDelivery(possessiveElision), { code: "TASK_DELIVERY_SCOPE" }, possessiveElision);
  assert.throws(() => assertDeliveryAnswer({}, possessiveElision), { code: "TASK_DELIVERY_SCOPE" }, possessiveElision);
  const smartPossessiveElision = "‘cause we should not create a PR for users’ safety.";
  assert.throws(() => ownerDelivery(smartPossessiveElision), { code: "TASK_DELIVERY_SCOPE" }, smartPossessiveElision);
  assert.throws(() => assertDeliveryAnswer({}, smartPossessiveElision), { code: "TASK_DELIVERY_SCOPE" }, smartPossessiveElision);
  for (const source of [
    "'cause we should not create a PR for customers' and admins' safety.",
    "‘cause we should not create a PR for customers’ and admins’ safety.",
    "'cause we should not create a PR for users' as well as administrators' safety.",
    "‘cause we should not create a PR for users’ plus administrators’ safety.",
  ]) {
    assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
    assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
  }
  const repeatedElisions = `${"'cause ".repeat(4500)}we should not create a PR.`;
  assert.throws(() => ownerDelivery(repeatedElisions), { code: "TASK_DELIVERY_SCOPE" }, "repeated unclosed elisions cannot hide a trailing prohibition");
  assert.throws(() => assertDeliveryAnswer({}, repeatedElisions), { code: "TASK_DELIVERY_SCOPE" }, "answer validation preserves the trailing prohibition after repeated elisions");
  const quotedElision = "Add a validation test for the exact string 'cause we should not create a PR'.";
  assert.equal(ownerDelivery(quotedElision), null);
  assert.doesNotThrow(() => assertDeliveryAnswer({}, quotedElision));
  const quotedElisionWithTail = "Add a validation test for the exact string 'cause we should not create a PR' in the help text.";
  assert.equal(ownerDelivery(quotedElisionWithTail), null);
  assert.equal(ownerDelivery("Add a validation test for the exact string ‘cause we should not create a PR’ in the help text."), null);
  const priorSource = "Add '90s support. Open a PR. Respect users' approval. Implement export. Open a PR for review.";
  const start = priorSource.lastIndexOf("Open");
  const v3 = { version: 3, offsets: "utf16", source: priorSource, spans: [
    { start: 0, end: start, owner: "implementation" },
    { start, end: priorSource.length, owner: "coordinator", kind: "pull_request" },
  ] };
  assert.equal(validateOwnerDelivery(v3), v3, "version-three accepted spans retain the old elision interpretation");
  assert.throws(() => ownerDelivery(priorSource), { code: "TASK_DELIVERY_SCOPE" });
});

test("version-five feature boundaries cannot hide another line's publication and preserve saved version four", () => {
  for (const separator of ["\n", "\r\n", "\r"]) for (const text of [`Do not create a PR${separator}body.`, `Generate mock data${separator}Do not create PR objects.`]) {
    assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
    assert.throws(() => assertDeliveryAnswer({}, text), { code: "TASK_DELIVERY_SCOPE" }, text);
  }
  const source = "Implement export. Open a PR\nTitle output.", current = ownerDelivery(source);
  assert.equal(current.version, 5);
  assert.equal(validateOwnerDelivery(current), current);
  assert.deepEqual(ownerImplementation(current), ["Implement export. ", "\nTitle output."]);
  assert.throws(() => validateOwnerDelivery({ ...current, version: 4 }), { code: "TASK_DELIVERY_SCOPE" });
  // Pinned against the previous module: its feature matcher consumed the first
  // PR across a newline and assigned only the final PR to the coordinator.
  const priorSource = "Implement export. Open a PR\nTitle output. Open a PR for review.";
  const split = priorSource.lastIndexOf("Open"), prior = { version: 4, offsets: "utf16", source: priorSource, spans: [
    { start: 0, end: split, owner: "implementation" },
    { start: split, end: priorSource.length, owner: "coordinator", kind: "pull_request" },
  ] };
  assert.equal(validateOwnerDelivery(prior), prior);
  assert.throws(() => ownerDelivery(priorSource), { code: "TASK_DELIVERY_SCOPE" });
  assert.throws(() => validateOwnerDelivery({ ...prior, version: 5 }), { code: "TASK_DELIVERY_SCOPE" });
});

test("publication owns only its recognized coordinating connector and delimiter", () => {
  for (const connector of [", and ", ", and then ", " and ", " and then ", ", then ", " then ", ", "]) {
    const source = "Implement CSV export and test both formats" + connector + "open a PR for review.";
    const contract = ownerDelivery(source);
    assert.equal(ownerImplementation(contract).join(""), "Implement CSV export and test both formats", connector);
    assert.equal(contract.spans.map(s => source.slice(s.start, s.end)).join(""), source);
    assert.equal(source.slice(contract.spans.at(-1).start), connector + "open a PR for review.", connector);
  }
});

test("typed ownership is validated and included in the ongoing PRD fingerprint; legacy contract is unchanged", () => {
  const contract = ownerDelivery("Implement export. Open a PR for review.");
  const section = `\n## Coordinator delivery contract\n\n\`\`\`json\n${JSON.stringify(contract)}\n\`\`\`\n`;
  const legacy = parsePrd(GOOD_PRD, "docs/prds/example.md"), current = parsePrd(GOOD_PRD + section, "docs/prds/example.md");
  assert.equal(Object.hasOwn(contractOf(legacy), "ownerDelivery"), false);
  assert.deepEqual(ownerDeliveryFromPrd(current), contract);
  assert.deepEqual(ownerDeliveryFromPrd(parsePrd((GOOD_PRD + section).replace(/\n/g, "\r\n"), "docs/prds/example.md")), contract);
  assert.notEqual(prdFingerprint(current), prdFingerprint(legacy));
  assert.notEqual(prdFingerprint(current), prdFingerprint(parsePrd(GOOD_PRD + section.replace('"pull_request"', '"merge"'), 'docs/prds/example.md')));
  assert.throws(() => ownerDeliveryFromPrd(parsePrd(GOOD_PRD + section + section, "docs/prds/example.md")), { code: "TASK_DELIVERY_SCOPE" });
});

test("CRLF preserves ownership validation and fingerprint without weakening malformed-contract checks", () => {
  const contract = ownerDelivery('Preserve the café greeting.\r\nOpen a PR for review.');
  const section = `\n## Coordinator delivery contract\n\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n`;
  const lf = GOOD_PRD + section, crlf = lf.replaceAll("\n", "\r\n");
  const parsed = parsePrd(crlf, "docs/prds/example.md"), original = parsePrd(lf, parsed.path);
  assert.deepEqual(ownerDeliveryFromPrd(parsed), contract);
  assert.equal(check(parsed).ok, true);
  assert.equal(prdFingerprint(parsed), prdFingerprint(original));
  assert.deepEqual(contractDiff(original, parsed), []);
  // Formatting normalization must not change the original request's escaped bytes.
  const changedSource = parsePrd(lf.replace('\\r\\n', '\\n'), parsed.path);
  assert.notEqual(prdFingerprint(changedSource), prdFingerprint(original));
  for (const malformed of [crlf + section.replaceAll("\n", "\r\n"), crlf + "Unexpected trailing text", crlf.replace('"pull_request"', '"merge"')])
    assert.throws(() => ownerDeliveryFromPrd(parsePrd(malformed, parsed.path)), { code: "TASK_DELIVERY_SCOPE" });
});

test("publication is fulfilled only by matching canonical delivery proof, never provider output", () => {
  const owner = ownerDelivery("Implement export. Open a PR for review.");
  const entry = { repo: "owner/repo", pr: 4, base: "main", state: "ready-for-human", cursor: { fixed_sha: "abc" },
    task: { completion: { version: 1, target: "delivery_ready" }, ownerDelivery: owner },
    completionEvidence: { delivery: { repository: "owner/repo", pr: 4, base: "main", head: "abc", gate: { allow: true }, observedAt: "2026-10-14T12:00:00Z" } } };
  assert.equal(completionView(null, entry).obligations[0].status, "fulfilled");
  for (const patch of [{ repository: "other/repo" }, { pr: 5 }, { head: "stale" }, { base: "release" }, { gate: { allow: false } }, { invalidatedAt: "2026-10-14T12:01:00Z" }]) {
    const changed = structuredClone(entry); Object.assign(changed.completionEvidence.delivery, patch);
    assert.notEqual(completionView(null, changed).status, "fulfilled");
    assert.equal(completionView(null, changed).obligations[0].status, "pending");
  }
  assert.equal(completionView({ target: "delivery_ready" }, { ...entry, state: "pr-open", completionEvidence: {}, result: { acceptance_criteria: [{ met: true, evidence: "I opened a PR" }] } }).obligations[0].status, "pending");
});

test("qualified actor objects cannot hide a publication after product behavior", () => {
  for (const connector of ["and", "after that", "once that is done", "as a result"])
    for (const qualifier of ["experimental", "API", "new experimental review", "draft-ready"])
      for (const actor of ["the agent", "our senior developer", "Alice King"])
        for (const product of ["a PR", "an experimental PR"]) {
          const source = `The button creates ${product} after tests pass, ${connector} ${actor} opens another ${qualifier} PR.`;
          assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
          assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
        }
});

test("long fixture titles cannot hide live destinations or later review references", () => {
  for (const length of [96, 512, 4096]) {
    const prefix = `For tests, create a fake PR with the title "${"Example title ".repeat(Math.ceil(length / 14))}"`;
    for (const tail of [" on GitHub.", " for review.", " and send it for code review.", " and send that PR to origin."])
      for (const check of [source => ownerDelivery(source), source => assertDeliveryAnswer({}, source)])
        assert.throws(() => check(prefix + tail), { code: "TASK_DELIVERY_SCOPE" }, prefix + tail);
    for (const tail of [".", " and upload logs to GitHub.", " and upload logs for review."]) {
      const source = prefix + tail;
      assert.equal(ownerDelivery(source), null, source);
      assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      const original = source + " Open a PR for review.", contract = ownerDelivery(original);
      assert.equal(validateOwnerDelivery(contract), contract);
      assert.equal(ownerImplementation(contract).join(""), source + " ");
    }
  }
});

test("PR data representations remain implementation scope after product conditions", () => {
  for (const representation of ["record", "payload", "schema", "model", "representation"])
    for (const connector of ["and", "after that", "as a result"])
      for (const subject of ["the agent", "Alice King"]){
        const source = `The button creates a PR after tests pass ${connector} ${subject} creates a PR ${representation}.`;
        assert.equal(ownerDelivery(source), null, source);
        assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
      }
});

test("pending business continuations validate their own action and preserve nominal data", () => {
  for (const connector of ["pending", "awaiting", "PENDING", "AWAITING"])
    for (const action of ["your proofreading the invoice", "Alice King proofreading the invoice", "the invoice being proofread"]) {
      const source = `If I approve the invoice, email the customer ${connector} ${action}.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of [
    "If I approve the invoice, email the customer pending the payment.",
    "If I approve the invoice, email the customer awaiting the receipt.",
    "If I approve the invoice, email the customer pending the invoice being paid.",
    "If I approve the invoice, email the customer pending your emailing the receipt.",
  ]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("qualified publication policy objects retain their command and negation", () => {
  for (const lead of ["a new", "another experimental", "the public review", "a draft-ready"])
    for (const verb of ["create", "generate", "draft"])
      for (const negative of ["", "Do not "]){
        const source = `${negative}${verb} ${lead} PR visible to anyone.`;
        assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
        assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
      }
  for (const source of ["Make the new PR visible to users.", "Make PRs visible in the dashboard.", 'Show "Do not create a new PR visible to anyone" in help.']) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});
test("qualified fixture destination noun phrases cannot hide live targets", () => {
  for (const target of ["the public GitHub repository", "our private GitLab repository", "the configured upstream repository", "the shared remote repository", "a public https://forge.example.org/acme/app"])
    for (const relation of ["on", "to", "via"]) {
      const source=`For tests, create a fake PR ${relation} ${target}.`;
      assert.throws(() => ownerDelivery(source), { code: "TASK_DELIVERY_SCOPE" }, source);
      assert.throws(() => assertDeliveryAnswer({}, source), { code: "TASK_DELIVERY_SCOPE" }, source);
    }
  for (const source of ["For tests, create a fake PR fixture in the local directory.", 'For tests, create a fake PR with the title "on the public GitHub repository".', "For tests, create a fake PR fixture and upload logs to the public GitHub repository."]) {
    assert.equal(ownerDelivery(source), null, source);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, source), source);
  }
});

test("courtesy and actor control prefixes cannot hide publication restrictions", () => {
  for(const prefix of ["Please do not", "Please never", "The agent must not", "Our senior developer should not", "Jane Doe cannot"])
    for(const object of ["a PR", "a new experimental PR"]){
      const source=`${prefix} create ${object} visible to anyone.`;
      assert.throws(()=>ownerDelivery(source),{code:"TASK_DELIVERY_SCOPE"},source);
      assert.throws(()=>assertDeliveryAnswer({},source),{code:"TASK_DELIVERY_SCOPE"},source);
    }
  for(const source of ["Please do not create a PR visible field.", "The agent must not create a PR configurable setting.", "The service must not create a PR visible to anyone.", "Please make PRs visible in the dashboard.", 'Show "Please do not create a PR visible to anyone" in help.']) {
    assert.equal(ownerDelivery(source),null,source);
    assert.doesNotThrow(()=>assertDeliveryAnswer({},source),source);
  }
});
