import { isAbsolute } from "node:path";
import { executionError } from "./execution_io.mjs";

export const CLOUD_VERSION = "0.160.0";
export const CLOUD_DISPATCH_UNAVAILABLE = Object.freeze({
  detail: "CLOUD_ENVIRONMENT_REPOSITORY",
  reason: `Codex Cloud ${CLOUD_VERSION} cannot verify the selected environment's connected repository; new dispatch is unavailable`,
  fix: "Qualify and implement a supported documented environment-to-repository check before enabling Cloud dispatch; see docs/codex-cloud.md",
});
export function validateCloudConfig(config) {
  const fail = message => { throw executionError("CLOUD_CONFIG", message); };
  if (!config || typeof config.bin !== "string" || !isAbsolute(config.bin) || /[\x00-\x1f]/.test(config.bin)) fail("codex-cloud requires an explicit absolute Codex executable path");
  if (config.account !== "operator" || config.authentication !== "operator-chatgpt" || config.mode !== "trusted-worker") fail("Cloud supports the authorized operator ChatGPT identity on a trusted worker; delegated public authentication is unqualified");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.environment || "") || !/^[\w.-]+\/[\w.-]+$/.test(config.repository || "")) fail("select a published Cloud environment ID and its connected repository explicitly");
  if (config.continuation !== "successor-task" || config.billing_source !== "chatgpt-account") fail("configure successor-task continuity and chatgpt-account billing; native resume/cancel and per-task spend are unavailable");
  if (config.model != null || config.attempts != null && config.attempts !== 1) fail("Cloud preserves account model defaults and supports exactly one attempt; model overrides and best-of-N are unsupported");
  if (!Number.isFinite(config.allowance?.remainingUsd) || !Number.isFinite(config.allowance?.reservedUsd) || config.allowance.reservedUsd <= 0 || config.allowance.remainingUsd < config.allowance.reservedUsd) throw executionError("EXECUTION_ALLOWANCE", "Cloud requires a positive reservation and remaining account allowance; this is not a provider billing cap");
  if (config.mandatory_policy?.length || config.context_paths?.length) throw executionError("EXECUTION_POLICY", "Cloud cannot enforce mandatory local policy or private read-only context; use a capable backend");
  return config;
}
