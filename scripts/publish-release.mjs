// Registry errors must not be mistaken for an absent version. A rerun succeeds
// only if npm already holds these exact bytes; published versions are immutable.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export async function publishRelease(version, { request = fetch, read = readFileSync, run = execFileSync } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("Invalid release version");
  const packageName = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name;
  // npm treats a bare owner/name-like argument as a GitHub repository spec.
  // Make the tarball an explicit relative file path before passing it to npm.
  const file = `./dist/${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
  const integrity = `sha512-${createHash("sha512").update(read(file)).digest("base64")}`;
  const response = await request(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`, { signal: AbortSignal.timeout(15_000) });
  if (response.ok) {
    const { dist } = await response.json();
    if (dist?.integrity !== integrity) throw new Error("Registry version exists with different bytes; bump the version instead of overwriting it");
    if (!dist.attestations?.provenance?.predicateType || !dist.attestations?.url) throw new Error("Registry version has no provenance metadata; inspect the existing release before proceeding; rerunning cannot add provenance");
    return "Already published with identical bytes";
  }
  if (response.status !== 404) throw new Error(`Cannot check registry release (HTTP ${response.status}); publication refused`);
  run("npm", ["publish", file, "--ignore-scripts", "--access", "public", "--provenance"], { stdio: "inherit", timeout: 180_000 });
  return "Published";
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await publishRelease(process.env.RELEASE_VERSION));
