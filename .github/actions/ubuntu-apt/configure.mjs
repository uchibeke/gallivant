import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, renameSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The runner image's mirror+file list currently prefers an intermittently
// unresolvable Azure mirror. Change only Ubuntu transport URLs, retaining
// suites, components, architectures and archive signing keys verbatim.
export function officialUbuntuSources(text) {
  return text
    .replaceAll("mirror+file:/etc/apt/apt-mirrors-security.txt", "https://security.ubuntu.com/ubuntu")
    .replaceAll("mirror+file:/etc/apt/apt-mirrors.txt", "https://archive.ubuntu.com/ubuntu")
    .replace(/https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?/g, "https://archive.ubuntu.com/ubuntu/");
}

export function configureUbuntuApt(root = "/") {
  if (!/^ID=(?:ubuntu|"ubuntu")\s*$/m.test(readFileSync(join(root, "etc/os-release"), "utf8"))) throw new Error("Ubuntu APT setup requires an Ubuntu runner");
  const changed = [];
  const write = (path, text) => {
    const stat = existsSync(path) ? lstatSync(path) : null;
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("APT configuration must be a regular file");
    mkdirSync(dirname(path), { recursive: true });
    const pending = `${path}.pending-${process.pid}`;
    try {
      writeFileSync(pending, text, { flag: "wx", mode: stat ? stat.mode & 0o777 : 0o644 });
      renameSync(pending, path);
    } finally { rmSync(pending, { force: true }); }
  };
  for (const rel of ["etc/apt/sources.list.d/ubuntu.sources", "etc/apt/sources.list", "etc/apt/apt-mirrors.txt", "etc/apt/apt-mirrors-security.txt"]) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, "utf8"), after = officialUbuntuSources(before);
    if (after !== before) { write(path, after); changed.push(rel); }
  }
  const network = join(root, "etc/apt/apt.conf.d/80-ci-network");
  const config = 'Acquire::Retries "2";\nAcquire::http::Timeout "15";\nAcquire::https::Timeout "15";\nAPT::Update::Error-Mode "any";\n';
  if (!existsSync(network) || readFileSync(network, "utf8") !== config) write(network, config);
  return { changed, network: "etc/apt/apt.conf.d/80-ci-network" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(configureUbuntuApt()));
