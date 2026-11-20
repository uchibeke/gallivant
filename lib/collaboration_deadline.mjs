const DEFAULT_TIMEOUT_SECONDS = 10;

export function collaborationTimeoutError() {
  return Object.assign(new Error("collaboration request exceeded the configured deadline"), { code: "timeout" });
}

/** Bound optional collaboration I/O even when an adapter promise never settles. */
export async function withCollaborationDeadline(config, operation) {
  const configured = Number(config?.retry?.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS);
  const milliseconds = Math.max(1, (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_SECONDS) * 1000);
  const controller = new AbortController();
  const timeout = collaborationTimeoutError();
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeout);
        reject(timeout);
      }, milliseconds);
      Promise.resolve().then(() => operation(controller.signal)).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}
