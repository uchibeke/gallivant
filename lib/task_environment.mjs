// Preparation receives a deliberately small environment. Native provider profiles
// remain available, without granting the operator's HOME or shared XDG roots.
import { homedir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { existsSync, lstatSync, realpathSync, rmSync, statSync, readdirSync, copyFileSync, chmodSync, mkdtempSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { adapterFor } from "./harness.mjs";
import { ensureDir } from "./fs.mjs";
import { isInside } from "./config.mjs";
import { runEnv } from "./git.mjs";
import { taskError } from "./task_store.mjs";

const BASICS = ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];
const AWS_AUTH = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN"];
const GOOGLE_AUTH = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID"];
const FOUNDRY_AUTH = ["ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN"];
const GOOSE_AUTH = {
  openai: ["OPENAI_API_KEY", "OPENAI_HOST"], anthropic: ["ANTHROPIC_API_KEY"], google: ["GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"], xai: ["XAI_API_KEY"], deepseek: ["DEEPSEEK_API_KEY"], mistral: ["MISTRAL_API_KEY"],
  meta: ["META_MODEL_API_KEY"], alibaba: ["DASHSCOPE_API_KEY"], azure_openai: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"], bedrock: [],
};
const pick = (source, keys) => Object.fromEntries(keys.filter(k => typeof source[k] === "string").map(k => [k, source[k]]));
const AWS_KEYS = new Set(["aws_access_key_id", "aws_secret_access_key", "aws_session_token"]);
const AWS_SETTINGS = new Set(["region", "output", "retry_mode", "max_attempts", "defaults_mode", "sts_regional_endpoints", "use_fips_endpoint", "use_dualstack_endpoint"]);
const AWS_CHAINS = new Set(["source_profile", "credential_source", "credential_process", "role_arn", "role_session_name", "external_id", "mfa_serial", "duration_seconds", "web_identity_token_file", "sso_session", "sso_start_url", "sso_region", "sso_account_id", "sso_role_name"]);
const awsFailure = () => taskError("TASK_PREPARATION_ENV", "selected AWS profile cannot be isolated; provide temporary AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY credentials and AWS_REGION, or a dedicated static profile in AWS_CONFIG_FILE/AWS_SHARED_CREDENTIALS_FILE; credential chains and shared caches are not carried");

// AWS files can contain credentials for many accounts. Render only the selected
// flat profile, never comments, other profiles, caches or unneeded auth settings.
function awsProfile(text, section, config, direct) {
  const values = new Map(); let selected = false, seen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    const header = line.match(/^\[([^\]]+)\]\s*(?:[#;].*)?$/);
    if (header) {
      selected = header[1].trim() === section;
      if (selected && seen) throw awsFailure();
      seen ||= selected; continue;
    }
    if (!selected) continue;
    const setting = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!setting || setting[2].includes("\0")) throw awsFailure();
    const [, key, value] = setting;
    if (direct && (AWS_KEYS.has(key) || AWS_CHAINS.has(key))) continue;
    if (!AWS_KEYS.has(key) && !(config && AWS_SETTINGS.has(key))) throw awsFailure();
    if (values.has(key)) throw awsFailure();
    values.set(key, value);
  }
  return values;
}

// Read only the native provider selector, leaving models and config bytes intact.
// Complex YAML needs an explicit environment override rather than a guessed
// provider that might expose the wrong credentials. Goose gives that override
// precedence, then the current active_provider key, then its legacy flat key.
function gooseProvider(text) {
  const fail = () => taskError("TASK_PREPARATION_ENV", "Goose provider selection cannot be resolved from its config; set GOOSE_PROVIDER explicitly to the configured provider before preparation");
  const lines = []; let header = false, ended = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "---" && !header && !lines.length) { header = true; continue; }
    if (line === "..." && !ended) { ended = true; continue; }
    if (ended || line === "---" || /[\t\0]/.test(raw)) throw fail();
    lines.push(raw);
  }
  const indent = Math.min(...lines.map(line => line.length - line.trimStart().length));
  const providers = new Map();
  for (const raw of lines) {
    if (raw.length - raw.trimStart().length !== indent) continue;
    const setting = raw.trim().match(/^([\w-]+|"[\w-]+"|'[\w-]+') *:(?:\s+(.*)|$)/);
    if (!setting) throw fail();
    const key = setting[1].replace(/^["']|["']$/g, "");
    if (!["active_provider", "GOOSE_PROVIDER"].includes(key)) continue;
    const value = (setting[2] || "").match(/^([a-zA-Z][\w-]*|"[a-zA-Z][\w-]*"|'[a-zA-Z][\w-]*')\s*(?:#.*)?$/);
    if (!value || providers.has(key)) throw fail();
    providers.set(key, value[1].replace(/^["']|["']$/g, ""));
  }
  return providers.get("active_provider") ?? providers.get("GOOSE_PROVIDER");
}

export function preparationEnvironment(harness, cwd, adapterEnv, source = process.env, callerCwd = process.cwd()) {
  const providerPath = path => resolve(callerCwd, path);
  const nativeHome = providerPath(source.HOME || homedir());
  const nativeConfig = providerPath(source.XDG_CONFIG_HOME || join(nativeHome, ".config"));
  const nativeData = providerPath(source.XDG_DATA_HOME || join(nativeHome, ".local/share"));
  const nativeState = providerPath(source.XDG_STATE_HOME || join(nativeHome, ".local/state"));
  const home = ensureDir(join(cwd, "home"));
  const config = ensureDir(join(home, ".config")), data = ensureDir(join(home, ".local/share")), state = ensureDir(join(home, ".local/state"));
  const env = { ...pick(source, BASICS), ...pick(source, adapterFor(harness).preparationEnv), ...adapterEnv,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_STATE_HOME: state, XDG_CACHE_HOME: ensureDir(join(home, ".cache")),
    TMPDIR: ensureDir(join(cwd, "tmp")), TMP: join(cwd, "tmp"), TEMP: join(cwd, "tmp"),
    ...runEnv(), GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_SSH_COMMAND: "false", GH_CONFIG_DIR: "/dev/null", GH_PROMPT_DISABLED: "1" };
  // All selected files and directories are private snapshots. Native links would
  // permit writes to operator files or traversal into their parents. Materialize
  // internal resource links, refuse escaping ones, and publish only complete copies.
  const snapshot = (root, to) => {
    const temporary = mkdtempSync(join(dirname(to), ".profile-copy-"));
    const entry = join(temporary, "entry");
    const ancestors = new Set();
    const copy = (from, target) => {
      let resolved;
      try { resolved = realpathSync(from); }
      catch { throw taskError("TASK_PREPARATION_ENV", "provider resource cannot be resolved; check permissions and remove broken or cyclic links before preparation"); }
      if (!isInside(resolved, root)) throw taskError("TASK_PREPARATION_ENV", "provider resource link leaves its selected directory; move the linked resource inside that directory");
      const info = statSync(resolved);
      if (info.isDirectory()) {
        if (ancestors.has(resolved)) throw taskError("TASK_PREPARATION_ENV", "provider resource contains a directory link cycle; remove the cycle before preparation");
        ancestors.add(resolved); ensureDir(target);
        try { for (const name of readdirSync(resolved)) copy(join(resolved, name), join(target, name)); }
        finally { ancestors.delete(resolved); }
      } else if (info.isFile()) {
        copyFileSync(resolved, target); chmodSync(target, info.mode & 0o777);
      } else throw taskError("TASK_PREPARATION_ENV", "provider resource contains a special file; use only regular files and directories");
    };
    try { copy(root, entry); renameSync(entry, to); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  };
  const selectedResource = from => {
    let entry;
    try { entry = lstatSync(from); }
    catch (error) {
      if (error.code !== "ENOENT") throw taskError("TASK_PREPARATION_ENV", "provider resource cannot be read; check its permissions before preparation");
      return null;
    }
    // Resolve nested links only after the selected entry has established its own
    // boundary. An entry alias could otherwise select unrelated native secrets.
    if (entry.isSymbolicLink()) throw taskError("TASK_PREPARATION_ENV", "selected provider entry is a symbolic link; replace it with a regular file or directory before preparation");
    const root = realpathSync(from);
    if (isInside(realpathSync(nativeHome), root)) throw taskError("TASK_PREPARATION_ENV", "provider profile contains the operator home; configure a dedicated provider profile directory");
    if (isInside(root, realpathSync(home))) throw taskError("TASK_PREPARATION_ENV", "provider profile overlaps the private preparation home; configure a provider profile outside the draft workspace");
    return root;
  };
  const carry = (from, to) => {
    const root = selectedResource(from);
    if (!root) { rmSync(to, { recursive: true, force: true }); return; }
    ensureDir(dirname(to)); rmSync(to, { recursive: true, force: true });
    snapshot(root, to);
  };
  const clearAws = () => {
    rmSync(join(home, ".aws"), { recursive: true, force: true });
    for (const key of ["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE"]) rmSync(join(home, ".provider-files", key), { recursive: true, force: true });
  };
  const aws = () => {
    // Remove old material even if validation stops this rebuilt turn.
    clearAws();
    Object.assign(env, pick(source, AWS_AUTH));
    const name = env.AWS_PROFILE || "default";
    if (!/^[\w.-]+$/.test(name)) throw awsFailure();
    const staticEnv = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
    const direct = staticEnv || Boolean(env.AWS_ROLE_ARN && env.AWS_WEB_IDENTITY_TOKEN_FILE);
    if (staticEnv) { delete env.AWS_ROLE_ARN; delete env.AWS_WEB_IDENTITY_TOKEN_FILE; }
    const nativeAws = join(nativeHome, ".aws");
    const needsConfig = Boolean(env.AWS_CONFIG_FILE || !direct || !(env.AWS_REGION || env.AWS_DEFAULT_REGION));
    // Inspect the default directory boundary too; file-level checks alone would
    // otherwise resolve an alias of the whole native AWS directory.
    if (needsConfig && !env.AWS_CONFIG_FILE || !direct && !env.AWS_SHARED_CREDENTIALS_FILE) {
      const root = selectedResource(nativeAws);
      if (root && !statSync(root).isDirectory()) throw awsFailure();
    }
    const read = (key, filename, configFile) => {
      const from = providerPath(env[key] || join(nativeAws, filename));
      const root = selectedResource(from);
      if (!root) { if (env[key]) throw taskError("TASK_PREPARATION_ENV", `selected provider file ${key} must name a readable regular file`); return new Map(); }
      if (!statSync(root).isFile()) throw taskError("TASK_PREPARATION_ENV", `selected provider file ${key} must name a readable regular file`);
      return awsProfile(readFileSync(root, "utf8"), configFile && name !== "default" ? `profile ${name}` : name, configFile, direct);
    };
    const settings = needsConfig ? read("AWS_CONFIG_FILE", "config", true) : new Map();
    // SDKs that prioritize AWS_PROFILE must still resolve the same explicit
    // environment identity, without reading an additional native account.
    const credentials = staticEnv && env.AWS_PROFILE ? new Map([...AWS_KEYS].flatMap(key => {
      const value = env[key.toUpperCase()]; return value ? [[key, value]] : [];
    })) : direct ? new Map() : read("AWS_SHARED_CREDENTIALS_FILE", "credentials", false);
    const combined = new Map([...settings, ...credentials]);
    if (!direct && !(combined.get("aws_access_key_id") && combined.get("aws_secret_access_key"))) throw awsFailure();
    if (credentials.get("aws_access_key_id") && credentials.get("aws_secret_access_key")) {
      // The credentials file wins over config credentials for this profile.
      // Do not expose an older identity that the selected SDK will not need.
      for (const key of credentials.keys()) settings.delete(key);
    }
    if (env.AWS_WEB_IDENTITY_TOKEN_FILE) {
      const root = selectedResource(providerPath(env.AWS_WEB_IDENTITY_TOKEN_FILE));
      if (!root || !statSync(root).isFile()) throw taskError("TASK_PREPARATION_ENV", "selected provider file AWS_WEB_IDENTITY_TOKEN_FILE must name a readable regular file");
    }
    // Only validated selected material is published. Remove pre-fix directory
    // snapshots and explicit-file copies, including caches and other profiles.
    const target = ensureDir(join(home, ".aws"));
    for (const [key, filename, values, section] of [["AWS_CONFIG_FILE", "config", settings, name === "default" ? name : `profile ${name}`], ["AWS_SHARED_CREDENTIALS_FILE", "credentials", credentials, name]]) {
      env[key] = join(target, filename);
      writeFileSync(env[key], values.size ? `[${section}]\n${[...values].map(([k, v]) => `${k} = ${v}`).join("\n")}\n` : "", { mode: 0o600 });
    }
  };
  const profile = (from, to, names) => {
    ensureDir(to);
    for (const name of names) carry(join(from, name), join(to, name));
  };
  const googleAdc = () => carry(join(nativeConfig, "gcloud/application_default_credentials.json"), join(config, "gcloud/application_default_credentials.json"));
  if (harness === "codex") {
    env.CODEX_HOME = join(home, ".codex");
    profile(providerPath(source.CODEX_HOME || join(nativeHome, ".codex")), env.CODEX_HOME, ["auth.json", "config.toml", "managed_config.toml", "requirements.toml", "hooks.json", "rules", "plugins", "skills"]);
  } else if (harness === "claude") {
    env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    profile(providerPath(source.CLAUDE_CONFIG_DIR || join(nativeHome, ".claude")), env.CLAUDE_CONFIG_DIR, ["settings.json", ".credentials.json", "plugins", "rules", "skills", "agents"]);
    carry(join(nativeHome, ".claude.json"), join(home, ".claude.json"));
    if (source.CLAUDE_CODE_USE_BEDROCK === "1") aws();
    if (source.CLAUDE_CODE_USE_VERTEX === "1") {
      Object.assign(env, pick(source, GOOGLE_AUTH)); googleAdc();
    }
    if (/^(?:1|true|yes|on)$/i.test(env.CLAUDE_CODE_USE_FOUNDRY || "")) Object.assign(env, pick(source, FOUNDRY_AUTH));
  } else if (harness === "gemini") {
    profile(join(nativeHome, ".gemini"), join(home, ".gemini"), ["settings.json", "oauth_creds.json", "google_accounts.json", "policies", "policy_integrity.json", "extensions", "skills", "agents", "commands"]);
    if (source.GOOGLE_GENAI_USE_VERTEXAI === "true") googleAdc();
  } else if (harness === "opencode") {
    profile(providerPath(source.OPENCODE_CONFIG_DIR || join(nativeConfig, "opencode")), join(config, "opencode"), ["opencode.json", "opencode.jsonc", "config.json", "package.json", "node_modules", "agents", "commands", "plugins", "skills", "tools"]);
    env.OPENCODE_CONFIG_DIR = join(config, "opencode");
    carry(join(nativeData, "opencode/auth.json"), join(data, "opencode/auth.json"));
    carry(join(nativeState, "opencode/model.json"), join(state, "opencode/model.json"));
  } else if (harness === "goose") {
    // Rebuilding a turn must not retain AWS files from an earlier selection,
    // including when the new config cannot safely identify its provider.
    clearAws();
    // A shared secrets file/keyring may contain every provider's credentials.
    // Never copy it, including legacy snapshots in a reopened private profile.
    rmSync(join(config, "goose/secrets.yaml"), { recursive: true, force: true });
    profile(join(nativeConfig, "goose"), join(config, "goose"), ["config.yaml"]);
    const file = join(config, "goose/config.yaml");
    const provider = env.GOOSE_PROVIDER ?? (existsSync(file) ? gooseProvider(readFileSync(file, "utf8")) : undefined);
    if (!Object.hasOwn(GOOSE_AUTH, provider)) throw taskError("TASK_PREPARATION_ENV", "Goose provider is missing or unsupported for isolated authentication; set GOOSE_PROVIDER to the configured supported provider and export only its credentials before preparation");
    Object.assign(env, pick(source, GOOSE_AUTH[provider]));
    env.GOOSE_DISABLE_KEYRING = "1";
    if (provider !== "bedrock" && !env[GOOSE_AUTH[provider][0]] && existsSync(join(nativeConfig, "goose/secrets.yaml"))) {
      throw taskError("TASK_PREPARATION_ENV", `Goose shared secret storage is not carried; export ${GOOSE_AUTH[provider][0]} for the selected provider before preparation`);
    }
    if (provider === "bedrock") aws();
  }
  // Explicit provider file settings must use the same detached bytes as native
  // profile files; forwarding their native paths would retain writable aliases.
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "AWS_WEB_IDENTITY_TOKEN_FILE", "OPENCODE_CONFIG"]) {
    if (!env[key]) continue;
    const from = providerPath(env[key]);
    if (!existsSync(from) || !statSync(from).isFile()) throw taskError("TASK_PREPARATION_ENV", `selected provider file ${key} must name a readable regular file`);
    const to = join(home, ".provider-files", key, basename(from));
    carry(from, to);
    env[key] = to;
  }
  return env;
}
