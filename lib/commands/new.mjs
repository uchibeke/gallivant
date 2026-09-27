// `gallivant new <name>`: write a starting PRD into the repository you are standing in.
//
// The command exists because the documented alternative did not work from anywhere. Every quickstart said
// `cp templates/prd.md path/to/repo/docs/prds/your-prd.md`, which resolves only inside a Gallivant clone, so an
// operator who installed the tool and then walked into their own repository had nothing to copy. The template ships
// inside the package, and only the package knows where that is, so finding it is the tool's job rather than the
// reader's.
//
// It writes a file and nothing else: no registry entry, no git operation, no network. `ready` is the next step, and
// it will refuse this file until the placeholders are replaced, which is the point of starting from a template that
// fails the contract loudly rather than one that passes it vacuously.
import { join, resolve, relative, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readText, writeText, contract } from "../fs.mjs";

/** The packaged template, resolved from this module so it is found wherever the package is installed. */
export const templatePath = name => fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

/** `docs/prds/<id>.md` is the contract's `path` rule, so the id has to survive it. */
export const prdId = name => basename(String(name || ""), ".md").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Where a new PRD goes: `docs/prds/<id>.md` under the repository root, wherever the operator is standing inside it.
 * `git rev-parse --show-toplevel` is asked rather than the cwd assumed, so running this from a subdirectory writes
 * to the same place as running it from the root.
 */
export async function newPrd(ctx, { name, harness = null, dir = null }) {
  const { git, config, log } = ctx;
  const id = prdId(name);
  if (!id) throw new Error(`"${name}" has no letters or digits in it; a PRD id is lowercase letters, digits and dashes`);

  const root = dir ? resolve(dir) : await git.toplevel(process.cwd()).catch(() => {
    throw new Error(`${process.cwd()} is not inside a git repository. Run this in the repo the work belongs to, or pass --dir <repo>`);
  });
  const abs = join(root, "docs", "prds", `${id}.md`);
  if (existsSync(abs)) throw new Error(`${contract(abs)} already exists; pick another name or edit that file`);

  const template = readText(templatePath("prd.md"));
  if (template === null) throw new Error(`the packaged PRD template is missing from ${contract(templatePath("prd.md"))}`);

  // The harness the operator will actually run. A template naming one they have not configured would fail `start`
  // after they had written the whole brief, so the default is whatever their config offers.
  const configured = Object.keys(config?.harness || {});
  const chosen = harness || configured[0] || "claude";
  if (harness && configured.length && !configured.includes(harness)) throw new Error(`harness "${harness}" is not configured; you have ${configured.join(", ")}`);
  const text = template.replace(/^harness:.*$/m, `harness: ${chosen}`);

  // 0o644/0o755: a PRD is a file in the operator's repository that they will edit and commit, not daemon state.
  writeText(abs, text, 0o644, 0o755);
  log?.info(`${id}: wrote ${contract(abs)}`);
  return { id, path: abs, rel: relative(process.cwd(), abs) || basename(abs), root, harness: chosen, dir: dirname(abs) };
}
