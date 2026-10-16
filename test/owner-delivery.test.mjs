import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerDelivery, ownerImplementation, validateOwnerDelivery, ownerDeliveryFromPrd, assertDeliveryAnswer } from "../lib/owner_delivery.mjs";
import { completionView } from "../lib/task_completion.mjs";
import { parsePrd, prdFingerprint, contractOf, contractDiff, check } from "../lib/prd.mjs";
import { GOOD_PRD } from "./helpers.mjs";
import { workflowRequests, applicationRequests } from "./fixtures/owner-actions.mjs";

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
    "Generate a test PR in the unit test.",
    "Create a synthetic review PR in integration tests.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  for (const text of [
    "Generate a public PR for review in the unit test.",
    "Create a fabricated pull request for review in the test fixture.",
    "Create a PR in the unit test.",
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

test("new publication predicates, actors, adverbs and approval gates fail closed", () => {
  for (const text of [
    "Create a PR ASAP.",
    "Do not create a PR this time.",
    "Make PRs obligatory.",
    "Make PRs compulsory.",
    "Open PRs whenever tests pass.",
    "Create a PR provided that tests pass.",
    "Make PRs so long as tests pass.",
    "Implement export. Created a PR for review.",
    "Implement export. Opened a PR for review.",
    "Implement export. Submitted a PR for review.",
    "The LLM creates a PR when tests pass.",
    "The AI creates a PR after tests pass.",
    "Ensure the team creates a PR for review.",
    "Have John create a PR for review.",
    "Let John create a PR for review.",
    "Ship it after I approve the code.",
    "Implement export after I explicitly approve.",
    "After I personally approve, implement export.",
    "After I have approved, update the service.",
    "After I've approved, update the service.",
    "Once we have approved, continue.",
    "Release it after I approve the implementation.",
    "Package it after I approve the code.",
    "Implement export. Make the team a PR for review.",
    "Create John a pull request for review.",
    "Create a PR and assign me.",
    "Do not create a PR whatsoever.",
    "Do not create a PR going forward.",
  ]) assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
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
    "If I approve the support request, finish the checkout.",
    "Apply the discount after I approve the purchase.",
    "Send the customer an email after I approve the refund.",
    "Show a confirmation page after I approve the purchase.",
    "Send a receipt after I approve the expense.",
    "Notify the user once I approve the loan.",
    "Approve the refund before emailing the customer.",
    "After I have approved the invoice, mark it paid.",
    "When I have approved the comment, display it.",
  ]) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
  for (const text of [
    "If I approve the purchase, continue with implementation.",
    "If we approve a refund, deploy the service.",
    "If I approve the code, send an email.",
    "If I approve the purchase, apply the patch.",
    "If I approve the support request, finish the implementation.",
    "Build the widget after I approve the purchase.",
    "Add tests after I approve the plan.",
    "Fix the bug after I approve the plan.",
  ]) assert.throws(() => ownerDelivery(text), { code: "TASK_DELIVERY_SCOPE" }, text);
});

test("PR-shaped application features stay implementation requirements while real delivery remains visible", () => {
  const features = [
    "The button opens a PR.",
    "Clicking submit creates a pull request.",
    "Make PRs searchable in the dashboard.",
    "Make pull requests visible to administrators.",
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
    "Document whether PRs are optional in settings.",
  ];
  for (const text of features) {
    assert.equal(ownerDelivery(text), null, text);
    assert.doesNotThrow(() => assertDeliveryAnswer({}, text), text);
  }
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
    "Make one hundred and six PRs for review.",
    "Submit 1,024 pull requests for review.",
    "Make dozens of PRs for review.",
    "Make a pair of PRs.",
    "Make a handful of PRs.",
    "Create a series of PRs.",
    "Create a plethora of PRs.",
    "Make a multitude of PRs for review.",
    "Create a truckload of PRs.",
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
  for (const verb of ["Created", "Opened", "Submitted", "Made"]) {
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
  for (const text of ["Merge invoices from the main table.", "Tell the agent to merge files from the archive directory.", "Merge head counts into the database.", "Merge invoices with tag metadata records.", "Merge files from revision metadata tables.", "Merge hash maps into the database.", "Merge hash tables before saving.", "Merge changeset records into the database."]) {
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
  for (const text of ["Do not create commit objects.", "Do not generate branch objects.", "Do not create PR objects.", "Generate a mock fixture. Do not create PR objects.", "Generate a mock fixture and do not create PR objects.", "Create a mock PR object, but do not push changes."]) {
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
  for (const text of ["Create a PR tomorrow.", "Open a PR against release.", "Submit a PR when I approve.", "Do not commit the changes.", "Never automatically push changes.", "Do not silently commit changes.", "Do not commit the database transaction or silently push changes.", "Avoid pushing commits to the remote.", "Never run git push.", "Require my confirmation before proceeding.", "Ask for user permission before publishing.", "Require user confirmation before git push.", "Require user permission before running git push.", "Do not commit the database transaction or push any changes.", "Avoid pushing duplicate items onto the queue and committing changes."])
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
