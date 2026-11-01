import { execFile } from "node:child_process";
import { redact } from "./execution_io.mjs";

/** Credentialed transports must sanitize every diagnostic, including cached stacks. */
export const transportExecutor = execute => async (cmd, args, options = {}) => {
  try { return await execute(cmd, args, options); }
  catch (error) {
    const secrets = Object.entries(options.env ?? {}).filter(([key, value]) => /(?:TOKEN|SECRET|KEY|PASSWORD)/i.test(key) && typeof value === "string" && value.length).map(([, value]) => value);
    if (error && typeof error === "object") for (const field of ["stack", "message", "stderr", "stdout"]) {
      if (typeof error[field] === "string") error[field] = redact(error[field], secrets).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, "$1");
    }
    throw error;
  }
};

/** Bounded subprocess helper shared by transports, without a host dependency. */
export function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, encoding: "utf8", ...opts }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(`${cmd} ${args.slice(0, 3).join(" ")}: ${String(stderr || "").trim() || err.message}`), { stdout, stderr, code: err.code, killed: err.killed }));
      resolve({ stdout, stderr });
    });
  });
}
