// In-process command capabilities are never serialized to a prompt, task file
// or control request. The coordinator command ingress owns their creation.
const issued = new WeakMap();
const administration = new WeakMap();
const planOperators = new WeakMap();
const planIntents = new WeakMap();

// Minted by the coordinator command ingress. Bind one specific transition to
// the registry and expected revision. Serializing the object loses its grant.
export function recoveryAdminIntent(file, action, scope, expected) {
  const token = Object.freeze({ type: "operator-intent" });
  administration.set(token, { file, action, scope, expected });
  return token;
}

export function consumeRecoveryAdminIntent(token, file, action, scope, expected) {
  const grant = administration.get(token);
  if (!grant || grant.file !== file || grant.action !== action || grant.scope !== scope || grant.expected !== expected) {
    throw Object.assign(new Error("An explicit operator request for this recovery administration change is required."), { code: "OPERATOR_INTENT" });
  }
  administration.delete(token);
}

export function operatorIntent(state, id, actions) {
  const entry = state.get(id);
  const token = Object.freeze({ type: "operator-intent" });
  issued.set(token, { state, id, actions, run: entry.last?.run, control: entry.control?.id,
    status: entry.control?.status, hold: entry.hold?.generation, profile: entry.recovery_profile?.digest });
  return token;
}

export function requireOperatorIntent(token, state, id, action) {
  const grant = issued.get(token), entry = state?.get(id);
  if (!grant || grant.state !== state || grant.id !== id || !grant.actions.includes(action) ||
      !entry || entry.dispatch_stopped || entry.repository_disabled || grant.run !== entry.last?.run ||
      grant.control !== entry.control?.id || grant.status !== entry.control?.status ||
      grant.hold !== entry.hold?.generation || grant.profile !== entry.recovery_profile?.digest) {
    throw Object.assign(new Error("A current explicit operator request is required for this action."), { code: "OPERATOR_INTENT" });
  }
}

export function commandFields(options, keys) {
  if (!options || Object.keys(options).some(key => !keys.includes(key))) throw Object.assign(new Error("Unexpected fields in operator command."), { code: "OPERATOR_INTENT" });
}

const reference = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const planAuthorityRequired = () => Object.assign(new Error(
  "Plan admission requires the authenticated operator on a qualified outer boundary. Enclose the registry, coordinator controls and operator ingress outside the exact worker launch, then qualify that deployment."), { code: "PLAN_AUTHORITY" });

// Installed by a protected coordinator ingress, which obtains the current
// principal, grants and launch proof from its actual authority owner. Never
// construct this port from CLI options, config, a request body or a fixture
// probe for a different process. There is no default same-UID authority.
export function bindPlanOperator(file, currentSession) {
  if (typeof currentSession !== "function") throw planAuthorityRequired();
  const handle = Object.freeze({});
  planOperators.set(handle, { file, currentSession });
  return handle;
}

export function planOperator(file, handle) {
  const owner = planOperators.get(handle);
  const session = owner?.file === file ? owner.currentSession() : null;
  const proof = session?.isolation;
  if (!session || !reference.test(session.principal ?? "") || !reference.test(session.tenant ?? "") ||
      typeof session.grant !== "function" || proof?.registry !== file || proof.qualified !== true ||
      proof.workerExcluded !== true || !/^[a-f0-9]{64}$/.test(proof.launchDigest ?? "") ||
      !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= Date.now()) throw planAuthorityRequired();
  return session;
}

export function planAdminIntent(file, handle, action, scope, expected) {
  planOperator(file, handle);
  const intent = recoveryAdminIntent(file, `plan/${action}`, scope, expected);
  planIntents.set(intent, handle);
  return intent;
}

export function consumePlanAdminIntent(file, intent, action, scope, expected) {
  const session = planOperator(file, planIntents.get(intent));
  consumeRecoveryAdminIntent(intent, file, `plan/${action}`, scope, expected);
  planIntents.delete(intent);
  return session;
}
