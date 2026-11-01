import { readFileSync } from "node:fs";
import { evaluateReviews } from "../lib/review_evaluation.mjs";
const [results,baseline]=process.argv.slice(2);
if (!results) throw new Error("Usage: node scripts/review-evaluation.mjs captured-results.json [independent-baseline.json]");
const read=path=>JSON.parse(readFileSync(path,"utf8"));
process.stdout.write(JSON.stringify(evaluateReviews(read(new URL("../test/fixtures/review-held-out.json",import.meta.url)),read(results),baseline?read(baseline):null),null,2) + "\n");
