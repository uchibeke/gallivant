// Recovery keys are JSON arrays of scalar references. Keep the native digest
// available in unpacked Node runtimes as well as installed packages.
export { reviewDigest as recoveryDigest } from "./review_policy.mjs";
