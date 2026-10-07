// Local preparation is an execution operation with a smaller adapter authority.
// A private HOME alone never qualifies that authority. Native policy lives in
// the selected capability, not in task drafting/clarification/repair callers.
import { buildPreparationRun, adapterFor, preparationReceipt, assertSafeArgv, assertSafeEnv } from "./harness.mjs";
import { preparationEnvironment } from "./task_environment.mjs";
import { requireHarness } from "./probe.mjs";
import { ensureDir } from "./fs.mjs";
import { MAX_PREPARATION_PROMPT_BYTES } from "./task_contract.mjs";
import { taskError } from "./task_store.mjs";
import { boundedCall } from "./execution_io.mjs";

export async function prepareLocalExecution(provider, capabilities, account, input, build = buildPreparationRun, limits = {}) {
  const receipt = preparationReceipt(provider, capabilities, account);
  const adapter = adapterFor(provider);
  let spec = build({ harness: provider, config: input.config, mode: "start", session: adapter.newSession(), prompt: input.prompt, cwd: input.cwd }, capabilities);
  const check = () => {
    if (spec.boundary !== receipt.boundary) throw taskError("TASK_PREPARATION_BOUNDARY", "preparation builder returned a different authority; no provider call was made");
    assertSafeArgv(spec.args);
    if (typeof spec.args.at(-1) !== "string" || Buffer.byteLength(spec.args.at(-1)) > MAX_PREPARATION_PROMPT_BYTES) throw taskError("TASK_INPUT", `serialized preparation prompt exceeds ${MAX_PREPARATION_PROMPT_BYTES} bytes; select fewer or smaller context files, or prepare a smaller task; saved requirements were retained`);
  };
  check(); // Reject oversized input before a probe or launch intent.
  await requireHarness(provider, input.config, { minimumVersion: spec.minimumVersion });
  ensureDir(input.cwd);
  const env = preparationEnvironment(provider, input.cwd, spec.env, input.sourceEnv, input.callerCwd);
  if (spec.configure) spec = await boundedCall(signal => spec.configure(spec, { cwd: input.cwd, env, signal }), limits);
  check(); // An adapter's final configuration cannot replace its authority.
  assertSafeEnv(env);
  return { receipt, environment: input.environment, spec: { cmd: spec.cmd, args: spec.args, options: { cwd: input.cwd, env, inheritEnv: false } } };
}
