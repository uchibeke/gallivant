# Published onboarding and documentation audit

Date: 2026-10-19. Source revision audited: `main` at `0e42f5c` (the base of the
change that carries this record). Package state at audit time:
`@uchibeke/gallivant` 0.2.0 published to the npm registry on 2026-10-19
(`npm view @uchibeke/gallivant time` lists `0.2.0` at 03:36 UTC and a
`0.0.0-stage` placeholder from the staged-publishing bootstrap).

This is a dated record of what the documentation claimed, what two other
projects' READMEs do well, what was changed and what remains. It is excluded from
the npm distribution with the other audit files.

## Reference READMEs

Both were read from their default branches on 2026-10-19. The commit named is the
head of `main` at that time; later edits to either project are not reflected here.

| Project | Link | Revision read |
| --- | --- | --- |
| APort Agent Guardrails | <https://github.com/aporthq/aport-agent-guardrails#readme> | `327538b7c0da9ee9c1a48518f7f0e8522731b7b2` (2026-10-03) |
| Vibetime | <https://github.com/iamnotstatic/vibetime#readme> | `f4bb030730e43482ed9179c004bcd48adfa6406a` (2026-10-15) |

### Patterns worth using

- **One visible command near the top.** APort opens with "Protect a GitHub
  repository in 60 seconds" and a single `npx @aporthq/aport-agent-guardrails github`
  line; Vibetime shows `npm install -g vibetime-cli` and then `vibe` with nothing
  after it. Neither asks the reader to clone anything first.
- **A one-sentence value statement under the title.** Vibetime: "Track what you
  actually ship with AI." APort: "Deterministic pre-action authorization for AI
  agents." The reader knows in one line whether to keep reading.
- **Show the outcome, not just the command.** Vibetime prints the session card
  the user will actually see. APort's "Example outcomes" table contrasts the same
  scenario with and without the product.
- **Say what re-running does.** Vibetime: "re-running it is always safe." APort
  explains that re-running the installer reuses the existing passport and does
  not create a new one. This answers the question a cautious operator has before
  typing the command a second time.
- **Progressive links.** Both keep the top of the page short and push detail into
  per-topic documents: APort's "Fast path by persona" list and framework table,
  Vibetime's "Commands" and "Privacy" sections at the end.
- **Boundaries stated plainly.** Vibetime's privacy section says what is read,
  what is never read and what leaves the machine. APort's "What the shell policy
  sees" lists what the policy does not see.

### Patterns deliberately not copied

- Badges, mascots and benchmark tables. Gallivant has no measured latency or
  adversarial-test figures to show, and a badge row would add claims the docs
  cannot back.
- "No config, no daemon, no account" (Vibetime). Gallivant needs a config file, a
  daemon on the operator's machine, a GitHub login and a signed-in harness. The
  README states each of those rather than minimizing them.
- A setup command that writes global hooks (both projects do this, with care).
  Gallivant's `init` writes only its own config directory and the worktrees
  directory; harness hooks, rulesets and reviewer installation stay with the
  operator, and the README says so.
- Claims copied from either product about its own security properties. Gallivant
  documents its own controls and their limits in `docs/guardrails.md`.

## Discrepancies found in Gallivant's documentation

Checked: `README.md`, `CONTRIBUTING.md`, `SECURITY.md` and every `docs/*.md`
operator guide, for package names, release claims, install commands, capability
claims, broken links and conflicting setup steps.

| Where | Claim at `0e42f5c` | Finding |
| --- | --- | --- |
| `README.md` Install | "Once a version is available, install it with `npm install -g`. If the package is not published yet, install from source" and a `git clone` block | Stale: 0.2.0 is published. The first instruction moved a new user out of their own repository. |
| `README.md` Set up | `gallivant init --harness codex` then `gallivant doctor` as separate steps | `init` neither recorded the repository nor ran the checks; a second repository required editing `repos` by hand. |
| `docs/install.md` §1 | Same registry-check-then-clone instruction; `npm link` as the primary path | Stale release state; source install presented as the default. |
| `docs/install.md` §2 | "Existing configs are never overwritten. If `init` reports an existing config, continue with `doctor`" and "Add the target repository to `repos`" | Described the refusal as the feature. Repeating setup was impossible without hand edits. |
| `docs/agent-setup.md` prompt and §2 | "If Gallivant is not yet published on npm, use the documented source installation"; "`npm install -g` is only an option after the package is published" | Stale; an agent following it would clone the repository. |
| `docs/releasing.md` | "An absent package is expected before the first publication"; "remove the first-release-pending notes (including this page)" | Written before the release and not updated after it. |
| `docs/launch.md` | "do not advertise npm installation before publication" | Same. |
| `docs/commands.md` `init` | "Existing configs are refused, never replaced" | Accurate for 0.2.0, but the behavior itself was the problem. |
| `docs/prd.md` → `config.md#files-a-brief-carries-sources` | Anchor | Resolves (the heading is "Files a brief carries: `sources`"); flagged by a first draft of the link checker that stripped inline code from headings, then confirmed correct. |
| `docs/execution.md`, `docs/openai-agents.md`, `docs/preparation.md`, `docs/task-delivery.md` | Links to `aporthq/agent-passport` pull requests #414 and #417 | The repository returns 404 to an anonymous reader. The references are evidence pointers the owner can follow; they are now marked "not publicly readable" rather than removed. |
| `SPEC.md` line 178 | "`npx gallivant` needs nothing beyond `gh`, `jq` and the harness CLIs" | Unscoped name in the original specification. Left as written: `SPEC.md` is the historical design document, not an operator guide, and is not packaged. |
| `docs/prds/gallivant-init.md` | Draft brief for a `--from` installer and a `gallivant try` command | Never implemented. Left as a draft requirement document; nothing in the guides cites it as shipped. |

External links in the operator guides were fetched on 2026-10-19 with `curl`.
Every link returned 200 or a redirect except: the two `agent-passport` pull
requests above (404); `https://www.npmjs.com/package/@uchibeke/gallivant` (403
to a non-browser client; `npm view` confirms the package); and example origins
such as `https://api.anthropic.com` and `https://github.com/acme/api/pull/31`,
which are illustrations rather than references.

## What was changed

- `gallivant init` now resolves the repository from the checkout it runs in,
  checks every prerequisite before writing anything (Git checkout with a
  github.com `origin`, `gh` signed in, selected harness installed at a supported
  version and signed in, push permission on the repository), writes or preserves
  the config, records the repository once, and ends with doctor's report and exit
  code. Re-running it is safe; an existing config keeps every key as written.
  When started by `npx` it says what `npx` did and prints both the next `npx`
  command and the optional `npm install -g @uchibeke/gallivant`.
- `README.md` leads with the one `npx` command, a prerequisite table with the
  check and the fix for each row, what setup leaves to the operator (reviewer,
  ruleset, harness hooks, spend), a first task with its expected outcome, and a
  short description of the review loop. The clone-first instruction is gone; the
  source install moved to `docs/install.md#install-from-source` for contributors.
- `docs/install.md` was reordered around the command: prerequisites, the
  command, what `init` does and leaves to you, reading the report, then the
  optional GitHub token, ruleset, notifications, APort and first-task sections.
- `docs/agent-setup.md`, `docs/commands.md`, `docs/config.md`,
  `docs/releasing.md`, `docs/launch.md` and `docs/README.md` now use the scoped
  package name and describe the published state.
- `test/install-package.mjs` runs the README command through `npx` against the
  freshly packed tarball from a fixture repository with a throwaway HOME, npm
  cache and Gallivant home, and checks the binary that ran, permissions,
  repository registration, repeat safety and the printed next steps.
  `test/init.test.mjs` covers the refusals and preservation rules;
  `test/docs-links.test.mjs` checks every relative link and anchor in the guides.

## What remains

- **Release.** The published 0.2.0 `init` creates the config only. This change
  raises `package.json` to 0.2.1 so that the merge carries a releasable version
  with the repository registration, prerequisite refusals and doctor report the
  README describes. Until 0.2.1 is tagged, published and `latest`,
  `npx --yes @uchibeke/gallivant init` runs the 0.2.0 behavior, and a 0.2.0 user
  still adds `repos` by hand and runs `doctor` separately. Publishing is the
  maintainer's step; see `docs/releasing.md`.
- **Live validation.** The installed-package test uses fixture `gh` and `codex`
  commands. A run with a real GitHub login, a real signed-in harness and a real
  repository was not performed in this audit and is manual validation, as the
  README's first-task section says.
- **Open pull requests #20 and #21** were open and unmerged when this record was
  written. If either merges first, the README, `bin/gallivant.mjs`,
  `lib/config.mjs`, `package.json` and the task-intake tests need reconciling
  against the new base.
