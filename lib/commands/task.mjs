// Thin CLI adapter. Structured clients use createTaskService directly; question
// IDs, revision checks and transitions are owned by that same implementation.
import { createTaskService, TASK_VERSION } from "../tasks.mjs";
import { MAX_INPUT_BYTES } from "../task_contract.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireTaskMutation } from "../daemon.mjs";
import { taskError } from "../task_store.mjs";

export async function readTaskStdin(stream = process.stdin, timeoutMs = 5000) {
  if (stream.isTTY) throw taskError("TASK_INPUT", "pipe task text to stdin or pass it as an argument; preparation never opens an interactive prompt");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => { clearTimeout(timer); stream.removeListener("data", data); stream.removeListener("end", end); stream.removeListener("error", error); stream.pause(); };
    const error = e => { cleanup(); reject(e); };
    const data = chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_INPUT_BYTES) return error(taskError("TASK_INPUT", `stdin exceeds ${MAX_INPUT_BYTES} bytes`));
      chunks.push(Buffer.from(chunk));
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const timer = setTimeout(() => error(taskError("TASK_INPUT", "stdin did not finish within five seconds; pipe a complete request or pass text explicitly")), timeoutMs);
    stream.on("data", data).once("end", end).once("error", error);
    stream.resume();
  });
}

export async function taskCommand(ctx, { args, values, service = createTaskService(ctx), stdin = readTaskStdin }) {
  const [first, id] = args;
  const operation = ["prepare", "answer", "resume", "validate", "start", "inspect", "list"].includes(first) ? first : "prepare";
  const expectedRevision = values.revision === undefined ? undefined : Number(values.revision);
  const shared = { taskId: id, expectedRevision, noDaemon: values["no-daemon"] };
  if (values.context !== undefined && !["prepare", "answer"].includes(operation)) throw taskError("TASK_INPUT", "--context is supported by task prepare and task answer");
  if (operation === "list") return service.list();
  if (operation === "inspect") return service.inspect(shared);
  const owner = acquireTaskMutation(ctx.home);
  try {
    if (existsSync(join(ctx.home, "runtime-pin.json"))) throw taskError("TASK_RUNTIME_PIN", "Use the manifest-aware task delivery adapter for this pinned namespace; CLI task mutations require an unpinned local home");
    if (operation === "resume") return await service.resume(shared);
    if (operation === "validate") return await service.validate(shared);
    if (operation === "start") return await service.start({ ...shared, run: values.run });
    if (operation === "answer") {
      const answers = Object.create(null);
      for (const value of values.answer || []) {
        const split = value.indexOf("=");
        if (split < 1) throw taskError("TASK_INPUT", "--answer takes question-id=text");
        const key = value.slice(0, split), text = value.slice(split + 1);
        if (Object.hasOwn(answers, key)) throw taskError("TASK_INPUT", `duplicate answer identifier ${key}`);
        answers[key] = text;
      }
      return await service.answer({ ...shared, answers, operationId: values["request-id"], context: values.context || [], verifyCommands: values.verify || [] });
    }
    const textArgs = first === "prepare" ? args.slice(1) : args;
    if (values.stdin && textArgs.length) throw taskError("TASK_INPUT", "use text or --stdin, not both");
    const text = textArgs.length ? textArgs.join(" ") : await stdin();
    return await service.prepare({ text, dir: values.dir, repo: values.repo, base: values.base, harness: values.harness, context: values.context || [], requestId: values["request-id"], run: values.run, noDaemon: values["no-daemon"], verifyCommands: values.verify || [] });
  } finally { owner.release(); }
}

export function renderTask(result) {
  if (result.tasks) return result.tasks.map(t => `${t.taskId}: ${t.status} (revision ${t.revision})`).join("\n") || "No saved tasks.";
  return [
    `${result.taskId}: ${result.status} (revision ${result.revision}, contract v${TASK_VERSION})`,
    result.draft && `Draft: ${result.draft.path}`,
    ...result.questions.map(q => `${q.id}: ${q.text}`),
    ...result.failures,
    result.dispatchRecovery && `Dispatch recovery: inspect the clone at ${result.dispatchRecovery.worktree}; start ownership is retained`,
    result.implementation && `Implementation: ${result.implementation.id} (run ${result.implementation.run})`,
    result.daemonError,
    `Next: ${result.nextAction}`,
  ].filter(Boolean).join("\n");
}
