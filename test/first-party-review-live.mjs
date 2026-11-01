// Explicitly opt-in. Uses the selected configured executable/model/provider.
// No host writes, nested author task, fixture provider or permissions downgrade.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeContext } from "../lib/context.mjs";
import { createReviewService } from "../lib/first_party_review.mjs";
if (process.env.REVIEW_LIVE !== "1") throw new Error("Set REVIEW_LIVE=1 only after authorizing a separate model call and review allowance; native qualification must not bypass a refusal");
const ctx=makeContext();
const root=mkdtempSync(join(tmpdir(),"first-party-review-live-"));
const repo=join(root,"repository"); mkdirSync(repo);
execFileSync("git",["init",repo],{stdio:"ignore"});
writeFileSync(join(repo,"README.md"),"Disposable reviewer qualification repository. No remote or secrets.\n");
// Preserve normal provider config; use separate coordinator evidence storage.
const service=createReviewService({...ctx,home:root});
const deadline=Date.now()+900_000;
let result;
do {
  result=await service.qualify("local/disposable",{run:true});
  if (result.qualified || ["failed","incomplete"].includes(result.status)) break;
  await new Promise(resolve=>setTimeout(resolve,1000));
} while(Date.now()<deadline);
writeFileSync(join(root,"qualification.json"),JSON.stringify(result,null,2));
console.log(JSON.stringify({repository:repo,evidence:join(root,"qualification.json"),...result},null,2));
if (!result.qualified) process.exitCode=1;
