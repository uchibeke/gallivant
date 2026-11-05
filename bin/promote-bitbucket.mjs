#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { makeContext } from "../lib/context.mjs";
import { promote } from "../lib/promotion.mjs";
import { makePromotionTransfer } from "../lib/promotion_git.mjs";

const help = `Usage: npm run promote:bitbucket -- --github-pr URL --bitbucket-repo bitbucket.org/workspace/repo [--bitbucket-pr N] [--base main] [--branch name] [--out plan.json]
Default: read-only dry run. Inspect the plan, then add --apply --expected-plan DIGEST.
To promote after GitHub merge, retain the accepted pre-merge --out plan.json and pass --accepted-plan plan.json.
No force push, merge or deployment. See docs/bitbucket-promotion.md.`;
let transfer;
try {
  const { values } = parseArgs({ options: {
    "github-pr": { type: "string" }, "bitbucket-repo": { type: "string" }, "bitbucket-pr": { type: "string" },
    base: { type: "string" }, branch: { type: "string" }, out: { type: "string" }, "accepted-plan": { type: "string" },
    apply: { type: "boolean", default: false }, "expected-plan": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) console.log(help);
  else {
    if (!values["github-pr"] || !values["bitbucket-repo"]) throw new Error(help);
    if (values.apply && values.out) throw new Error("--out saves a dry-run plan only; omit it when applying");
    let acceptedPlan;
    if (values["accepted-plan"]) {
      const text = await readFile(values["accepted-plan"], "utf8");
      if (Buffer.byteLength(text) > 1_048_576) throw new Error("Accepted plan is oversized");
      acceptedPlan = JSON.parse(text);
    }
    const ctx = makeContext({ readOnly: true });
    transfer = await makePromotionTransfer(ctx);
    const result = await promote(ctx, {
      githubPr: values["github-pr"], bitbucketRepo: values["bitbucket-repo"],
      ...(values["bitbucket-pr"] !== undefined ? { bitbucketPr: Number(values["bitbucket-pr"]) } : {}),
      branch: values.branch, base: values.base, acceptedPlan, apply: values.apply, expectedPlan: values["expected-plan"],
    }, transfer);
    if (values.out) await writeFile(values.out, `${JSON.stringify(result.plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await transfer?.close(); }
