// Preparation receives a deliberately small environment. Native provider profiles
// remain available, without granting the operator's HOME or shared XDG roots.
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { existsSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { adapterFor } from "./harness.mjs";
import { ensureDir } from "./fs.mjs";
import { isInside } from "./config.mjs";
import { runEnv } from "./git.mjs";
import { taskError } from "./task_store.mjs";

const BASICS = ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];
const AWS_AUTH = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN"];
const GOOGLE_AUTH = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID"];
const pick = (source, keys) => Object.fromEntries(keys.filter(k => typeof source[k] === "string").map(k => [k, source[k]]));

export function preparationEnvironment(harness, cwd, adapterEnv, source = process.env) {
  const nativeHome = resolve(source.HOME || homedir());
  const nativeConfig = resolve(source.XDG_CONFIG_HOME || join(nativeHome, ".config"));
  const nativeData = resolve(source.XDG_DATA_HOME || join(nativeHome, ".local/share"));
  const nativeState = resolve(source.XDG_STATE_HOME || join(nativeHome, ".local/state"));
  const home = ensureDir(join(cwd, "home"));
  const config = ensureDir(join(home, ".config")), data = ensureDir(join(home, ".local/share")), state = ensureDir(join(home, ".local/state"));
  const env = { ...pick(source, BASICS), ...pick(source, adapterFor(harness).preparationEnv), ...adapterEnv,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_STATE_HOME: state, XDG_CACHE_HOME: ensureDir(join(home, ".cache")),
    TMPDIR: ensureDir(join(cwd, "tmp")), TMP: join(cwd, "tmp"), TEMP: join(cwd, "tmp"),
    ...runEnv(), GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_SSH_COMMAND: "false", GH_CONFIG_DIR: "/dev/null", GH_PROMPT_DISABLED: "1" };
  // Link only the selected adapter's native authentication/settings. OpenCode's
  // session/log data is deliberately excluded; only auth and model selection travel.
  const link = (from, to) => {
    if (!existsSync(from)) return;
    const root = realpathSync(from);
    if (isInside(realpathSync(nativeHome), root)) throw taskError("TASK_PREPARATION_ENV", "provider profile contains the operator home; configure a dedicated provider profile directory");
    ensureDir(dirname(to)); rmSync(to, { force: true }); symlinkSync(root, to);
  };
  const profile = (from, to, names) => {
    ensureDir(to);
    for (const name of names) link(join(from, name), join(to, name));
  };
  const googleAdc = () => link(join(nativeConfig, "gcloud/application_default_credentials.json"), join(config, "gcloud/application_default_credentials.json"));
  if (harness === "codex") {
    env.CODEX_HOME = join(home, ".codex");
    profile(resolve(source.CODEX_HOME || join(nativeHome, ".codex")), env.CODEX_HOME, ["auth.json", "config.toml", "managed_config.toml", "requirements.toml", "hooks.json", "rules", "plugins", "skills"]);
  } else if (harness === "claude") {
    env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    profile(resolve(source.CLAUDE_CONFIG_DIR || join(nativeHome, ".claude")), env.CLAUDE_CONFIG_DIR, ["settings.json", ".credentials.json", "plugins", "rules", "skills", "agents"]);
    link(join(nativeHome, ".claude.json"), join(home, ".claude.json"));
    if (source.CLAUDE_CODE_USE_BEDROCK === "1") {
      Object.assign(env, pick(source, AWS_AUTH)); link(join(nativeHome, ".aws"), join(home, ".aws"));
    }
    if (source.CLAUDE_CODE_USE_VERTEX === "1") {
      Object.assign(env, pick(source, GOOGLE_AUTH)); googleAdc();
    }
  } else if (harness === "gemini") {
    profile(join(nativeHome, ".gemini"), join(home, ".gemini"), ["settings.json", "oauth_creds.json", "google_accounts.json", "policies", "policy_integrity.json", "extensions", "skills", "agents", "commands"]);
    if (source.GOOGLE_GENAI_USE_VERTEXAI === "true") googleAdc();
  } else if (harness === "opencode") {
    profile(resolve(source.OPENCODE_CONFIG_DIR || join(nativeConfig, "opencode")), join(config, "opencode"), ["opencode.json", "opencode.jsonc", "config.json", "package.json", "node_modules", "agents", "commands", "plugins", "skills", "tools"]);
    env.OPENCODE_CONFIG_DIR = join(config, "opencode");
    link(join(nativeData, "opencode/auth.json"), join(data, "opencode/auth.json"));
    link(join(nativeState, "opencode/model.json"), join(state, "opencode/model.json"));
  } else if (harness === "goose") {
    profile(join(nativeConfig, "goose"), join(config, "goose"), ["config.yaml", "secrets.yaml"]);
    if (source.GOOSE_PROVIDER === "bedrock") {
      Object.assign(env, pick(source, AWS_AUTH)); link(join(nativeHome, ".aws"), join(home, ".aws"));
    }
  }
  return env;
}
