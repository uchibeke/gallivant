// Fixture entry point: invoked only inside a disposable test PTY. The signer
// itself has no test environment/flag bypass and still reads /dev/tty via OpenSSH.
import { readFileSync } from "node:fs";
import { openSshSigner } from "../lib/learning_signer.mjs";
const [authorityFile, manifestFile] = process.argv.slice(2);
try {
  const signature = openSshSigner().sign(readFileSync(manifestFile, "utf8"), JSON.parse(readFileSync(authorityFile, "utf8")));
  process.stdout.write("SIGNATURE_RESULT:" + Buffer.from(signature).toString("base64") + "\n");
} catch (e) { console.error("SIGNATURE_FAILURE:" + e.code); process.exitCode = 1; }
