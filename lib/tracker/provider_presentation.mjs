import { instant } from "./presentation_time.mjs";

// Capability support, account checks and inference access are separate facts.
// Never classify arbitrary provider prose or expose it as a dashboard diagnostic.
export function providerPresentation(observation, capabilities = {}) {
  const p = observation || {};
  const local = ["local-sign-in", "local-credentials", "local-binary"].includes(p.scope);
  const error = p.error || p;
  const errorCode = error.providerCode || error.code || p.detail;
  let status = "unknown", label = "Provider readiness unknown";
  if (capabilities?.available === false) { status = "unsupported"; label = "Dispatch unsupported"; }
  else if (p.pending === true) { status = "pending"; label = "Readiness refresh pending"; }
  else if (["insufficient_quota", "quota_exhausted", "AGENTS_QUOTA"].includes(errorCode)) { status = "quota-exhausted"; label = "Provider quota exhausted"; }
  else if (["CREDENTIAL_UNAVAILABLE", "AGENTS_CREDENTIAL", "AUTH_REQUIRED", "AGENTS_AUTH", "CLOUD_AUTH", "invalid_api_key"].includes(errorCode)) { status = "credentials-unavailable"; label = "Credentials unavailable"; }
  else if (p.ok === false) { status = "unavailable"; label = "Readiness check unavailable"; }
  else if (p.ok === true && (local || p.apiConnectivity === "unchecked")) {
    status = "api-unchecked";
    label = ({ "local-sign-in": "Signed in; API access unchecked", "local-credentials": "Credentials present; API access unchecked", "local-binary": "Installed; sign-in and API access unchecked" })[p.scope] || "API access unchecked";
  } else if (p.ok === true) { status = "observed"; label = "Readiness check observed; inference access unproven"; }
  return { status, label, inference: "unknown", scope: local ? p.scope : null, observedAt: instant(p.observedAt), source: observation ? "provider-health" : null };
}
