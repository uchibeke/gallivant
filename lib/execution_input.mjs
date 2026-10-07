import { agentsInput } from "./openai_agents_input.mjs";
import { cloudInput } from "./codex_cloud_input.mjs";
export const remoteInput = (ctx, id, entry, input, contextPaths) => entry.harness === "codex-cloud"
  ? cloudInput(ctx, id, entry, input, contextPaths) : agentsInput(ctx, id, entry, input, contextPaths);
