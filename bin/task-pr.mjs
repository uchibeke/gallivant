#!/usr/bin/env node
import { prOperation } from "../lib/pr_operation.mjs";
try {
  const result = await prOperation(process.argv.slice(2));
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
