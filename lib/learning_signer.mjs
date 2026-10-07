// OpenSSH owns cryptography and passphrase entry. No secret enters Node or its logs.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, lstatSync, mkdtempSync, writeFileSync, rmSync, openSync, closeSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { safePath, inside } from "./learning_store.mjs";
import { hash, canonical, learningError, closed, textField } from "./learning_data.mjs";

export const NAMESPACE = "gallivant-learning-v1";
export const SIGNER_ID = "learning-operator";
export const signingEnvironment = home => ({ PATH: "/usr/bin:/bin", HOME: home, LANG: "C", LC_ALL: "C", SSH_ASKPASS_REQUIRE: "never" });
export function pinnedExecutable(path, forbidden = []) {
  safePath(path, { file: true });
  const s = lstatSync(path);
  if (!(s.mode & 0o111) || (s.mode & 0o022) || forbidden.some(root => inside(path, root))) throw learningError("SIGNER", "ssh-keygen must be an absolute protected executable outside worker writes");
  return { path, digest: hash(readFileSync(path)) };
}
export function encryptedKey(path) {
  safePath(dirname(path), { privateMode: true }); safePath(path, { file: true, privateMode: true });
  if (lstatSync(path).nlink !== 1 || lstatSync(path).size > 32 * 1024) throw learningError("KEY", "unsafe private key file");
  const pem = readFileSync(path, "utf8");
  if (!/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END OPENSSH PRIVATE KEY-----\n?$/.test(pem)) throw learningError("KEY", "expected encrypted OpenSSH key");
  const b = Buffer.from(pem.trim().split("\n").slice(1, -1).join(""), "base64");
  let pos = 15;
  const take = () => { if (pos + 4 > b.length) throw learningError("KEY", "truncated private key"); const n = b.readUInt32BE(pos); pos += 4; if (n > b.length - pos) throw learningError("KEY", "truncated key field"); const v = b.subarray(pos, pos + n); pos += n; return v; };
  if (!b.subarray(0, 15).equals(Buffer.from("openssh-key-v1\0"))) throw learningError("KEY", "unknown private key format");
  const cipher = take().toString(), kdf = take().toString(), options = take();
  if (!["aes256-ctr", "aes256-cbc", "aes256-gcm@openssh.com", "chacha20-poly1305@openssh.com"].includes(cipher) || kdf !== "bcrypt" || options.length < 8) throw learningError("KEY", "private key must be passphrase encrypted with bcrypt");
  const saltLength = options.readUInt32BE(0);
  if (saltLength < 16 || saltLength + 8 !== options.length || options.readUInt32BE(4 + saltLength) < 100) throw learningError("KEY", "private key requires bcrypt rounds >= 100");
  if (pos + 4 > b.length || b.readUInt32BE(pos) !== 1) throw learningError("KEY", "expected one dedicated key"); pos += 4;
  const pub = take();
  if (pub.length !== 51 || pub.readUInt32BE(0) !== 11 || pub.subarray(4, 15).toString() !== "ssh-ed25519" || pub.readUInt32BE(15) !== 32) throw learningError("KEY", "expected Ed25519 key");
  const privatePayload = take();
  if (!privatePayload.length || pos !== b.length) throw learningError("KEY", "invalid encrypted payload");
  return { publicKey: `ssh-ed25519 ${pub.toString("base64")}`, fingerprint: "SHA256:" + Buffer.from(hash(pub), "hex").toString("base64").replace(/=+$/, "") };
}
export function validateAuthority(a) {
  closed(a, ["version", "id", "namespace", "identity", "publicKey", "fingerprint", "signer", "keyPath", "enrollment", "signature"], "authority");
  if (a.version !== 1 || a.namespace !== NAMESPACE || a.identity !== SIGNER_ID || !/^[a-f0-9-]{36}$/.test(a.id) || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(a.publicKey)) throw learningError("TRUST", "invalid enrolled authority");
  const blob = Buffer.from(a.publicKey.split(" ")[1], "base64");
  if (a.fingerprint !== "SHA256:" + Buffer.from(hash(blob), "hex").toString("base64").replace(/=+$/, "")) throw learningError("TRUST", "enrolled key fingerprint differs");
  closed(a.signer, ["path", "digest"], "pinned signer");
  textField(a.fingerprint, "fingerprint", 80);
  return a;
}
export function openSshSigner({ executable = "/usr/bin/ssh-keygen", forbidden = [] } = {}) {
  const pinned = () => pinnedExecutable(executable, forbidden);
  const unchanged = authority => {
    validateAuthority(authority);
    if (canonical(pinned()) !== canonical(authority.signer)) throw learningError("TRUST", "pinned signer changed; requalification required");
  };
  const temporary = fn => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "learning-sshsig-"));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const verify = (bytes, signature, authority) => {
    unchanged(authority);
    if (typeof signature !== "string" || signature.length > 8192 || !signature.startsWith("-----BEGIN SSH SIGNATURE-----\n")) throw learningError("SIGNATURE", "invalid SSHSIG encoding");
    return temporary(dir => {
      const allowed = join(dir, "allowed_signers"), sig = join(dir, "manifest.sig");
      writeFileSync(allowed, `${SIGNER_ID} namespaces="${NAMESPACE}" ${authority.publicKey}\n`, { flag: "wx", mode: 0o600 });
      writeFileSync(sig, signature, { flag: "wx", mode: 0o600 });
      try { execFileSync(executable, ["-Y", "verify", "-f", allowed, "-I", SIGNER_ID, "-n", NAMESPACE, "-s", sig], { env: signingEnvironment(dir), input: bytes, stdio: ["pipe", "pipe", "pipe"], timeout: 10_000, maxBuffer: 8192 }); }
      catch { throw learningError("SIGNATURE", "OpenSSH authorization verification failed"); }
      return true;
    });
  };
  const terminal = () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) throw learningError("TERMINAL", "setup/approval requires the operator's interactive terminal");
    let fd; try { fd = openSync("/dev/tty", "r+"); } catch { throw learningError("TERMINAL", "no controlling operator terminal"); } finally { if (fd !== undefined) closeSync(fd); }
  };
  return {
    pinned, verify, terminal,
    probe() {
      pinned();
      return temporary(dir => {
        const key = join(dir, "disposable"), data = join(dir, "probe");
        const env = signingEnvironment(dir);
        try {
          // Only this capability probe uses a disposable unencrypted key; it is never enrolled.
          execFileSync(executable, ["-q", "-t", "ed25519", "-N", "", "-f", key], { env, timeout: 10_000 });
          writeFileSync(data, "capability-probe", { mode: 0o600 });
          execFileSync(executable, ["-Y", "sign", "-f", key, "-n", NAMESPACE, data], { env, stdio: "pipe", timeout: 10_000 });
          const pub = readFileSync(key + ".pub", "utf8").split(" ").slice(0, 2).join(" ");
          const allowed = join(dir, "allowed"); writeFileSync(allowed, `${SIGNER_ID} ${pub}\n`, { mode: 0o600 });
          execFileSync(executable, ["-Y", "verify", "-f", allowed, "-I", SIGNER_ID, "-n", NAMESPACE, "-s", data + ".sig"], { env, input: "capability-probe", stdio: "pipe", timeout: 10_000 });
          return { sign: true, verify: true, signer: pinned(), platform: process.platform };
        } catch { throw learningError("SIGNER", "OpenSSH -Y sign/verify capability probe failed; install portable OpenSSH with SSHSIG support"); }
      });
    },
    createKey(keyPath) {
      terminal(); pinned(); safePath(dirname(keyPath), { privateMode: true });
      // Refuse every existing target, including dangling links.
      for (const path of [keyPath, keyPath + ".pub"]) { let exists = false; try { lstatSync(path); exists = true; } catch (e) { if (e.code !== "ENOENT") throw e; } if (exists) throw learningError("KEY", "refusing to overwrite key files"); }
      const r = spawnSync(executable, ["-t", "ed25519", "-a", "100", "-f", keyPath, "-C", "dedicated-learning-approval"], { env: signingEnvironment(dirname(keyPath)), stdio: "inherit", timeout: 180_000 });
      if (r.status !== 0) throw learningError("CANCELLED", "key creation cancelled or failed; no enrollment was written");
      return encryptedKey(keyPath);
    },
    sign(bytes, authority) {
      terminal(); unchanged(authority);
      const key = encryptedKey(authority.keyPath);
      if (key.publicKey !== authority.publicKey || key.fingerprint !== authority.fingerprint) throw learningError("TRUST", "private key differs from enrolled signer");
      return temporary(dir => {
        const manifest = join(dir, "manifest"); writeFileSync(manifest, bytes, { flag: "wx", mode: 0o400 });
        const r = spawnSync(executable, ["-Y", "sign", "-f", authority.keyPath, "-n", NAMESPACE, manifest], { env: signingEnvironment(dir), stdio: ["ignore", "inherit", "inherit"], timeout: 120_000 });
        if (r.status !== 0) throw learningError("CANCELLED", "signing cancelled, timed out or failed; active state unchanged");
        if (readFileSync(manifest, "utf8") !== bytes) throw learningError("SIGNATURE", "frozen manifest changed during signing");
        const signature = readFileSync(manifest + ".sig", "utf8"); verify(bytes, signature, authority); return signature;
      });
    },
  };
}


// Resolve only when cryptographic operations are needed: local collection and
// emergency disable must not depend on a working signer installation.
export function storedOpenSshSigner(store, { executable } = {}) {
  let selected;
  const resolveSigner = () => {
    const authority = store.readAuthority();
    if (authority) {
      validateAuthority(authority);
      if (canonical(authority.enrollment?.signer) !== canonical(authority.signer)) throw learningError("TRUST", "enrollment signer differs from trust root");
    }
    const recorded = authority?.signer ?? store.readEnrollment()?.signer;
    if (recorded) closed(recorded, ["path", "digest"], "pinned signer");
    selected ??= openSshSigner({ executable: executable ?? recorded?.path ?? "/usr/bin/ssh-keygen" });
    // Includes doctor/probe and terminal checks, before any selected executable
    // can run. Never silently adopt changed bytes or fall back to another binary.
    if (recorded && canonical(selected.pinned()) !== canonical(recorded)) throw learningError("TRUST", "pinned signer changed; requalification required");
    return selected;
  };
  return Object.fromEntries(["pinned", "verify", "terminal", "probe", "createKey", "sign"].map(name => [name, (...args) => resolveSigner()[name](...args)]));
}
