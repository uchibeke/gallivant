// In-process command capabilities are never serialized to a prompt, task file
// or control request. The coordinator command ingress owns their creation.
const issued = new WeakMap();
const administration = new WeakMap();

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
