#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { makeBitbucketReviewProducer } from "../lib/hosts/bitbucket_review_producer.mjs";
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(["config", "url", "input", "result"].map(key => [key, { type: "string" }])) });
  if (positionals.length !== 1 || !["prepare", "publish"].includes(positionals[0]) || !values.config || !values.url) throw new Error("Use task-review prepare|publish --config <private-reviewer-config> --url <exact-PR-URL> [--input <prepared-json> --result <verdict-json>]");
  const json = path => JSON.parse(readFileSync(path, "utf8"));
  const producer = makeBitbucketReviewProducer({ config: json(values.config) });
  const result = positionals[0] === "prepare" ? await producer.prepare(values.url) : await producer.publish(values.url, json(values.input), json(values.result));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
