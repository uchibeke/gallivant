import { execFile } from "node:child_process";
import { request } from "node:https";

// Explicit operator input only. Never probe destinations copied from task text,
// error messages or repository settings, and never send credentials or redirects.
export function diagnosticOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Network diagnosis requires an HTTPS origin, for example https://api.anthropic.com"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use an HTTPS origin without credentials, a path, query parameters or fragment.");
  }
  return url;
}

const errorCode = error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code || "") ? error.code : "NETWORK_ERROR";

export function systemDns(hostname, timeoutMs = 5000) {
  // dns.lookup uses the OS resolver, matching normal application lookups. Run
  // it in a bounded child because getaddrinfo cannot be cancelled on every OS.
  const source = 'import { lookup } from "node:dns"; lookup(process.argv[1], { all: true }, (e, a) => console.log(JSON.stringify(e ? { ok: false, code: e.code } : { ok: true, families: [...new Set(a.map(x => x.family))] })));';
  return new Promise(resolve => {
    execFile(process.execPath, ["--input-type=module", "-e", source, hostname], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4096, encoding: "utf8" }, (error, stdout) => {
      if (error) return resolve({ ok: false, code: error.killed ? "DNS_TIMEOUT" : errorCode(error) });
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, code: "DNS_RESULT_INVALID" }); }
    });
  });
}

export function httpsReachable(url, timeoutMs = 5000) {
  return new Promise(resolve => {
    let timer;
    const req = request(url, { method: "HEAD", agent: false, rejectUnauthorized: true, headers: { "user-agent": "gallivant-network-diagnostic" } }, response => {
      // Any HTTP response proves DNS/TCP/TLS connectivity, not model access.
      response.resume();
      clearTimeout(timer);
      resolve({ ok: true, status: response.statusCode });
      req.destroy();
    });
    req.on("error", error => { clearTimeout(timer); resolve({ ok: false, code: errorCode(error) }); });
    timer = setTimeout(() => req.destroy(Object.assign(new Error("deadline"), { code: "HTTPS_TIMEOUT" })), timeoutMs);
    req.end();
  });
}

export async function diagnoseNetwork(value, { dns = systemDns, https = httpsReachable, clock = Date, env = process.env } = {}) {
  const url = diagnosticOrigin(value);
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const started = clock.now();
    const [dnsResult, httpsResult] = await Promise.all([dns(url.hostname.replace(/^\[|\]$/g, "")), https(url)]);
    samples.push({ dns: dnsResult, https: httpsResult, elapsed_ms: clock.now() - started });
  }
  return { origin: url.origin, ok: samples.every(s => s.dns.ok && s.https.ok), samples,
    proxyEnvironmentPresent: ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].some(k => Boolean(env[k])),
    scope: "Direct OS DNS and credential-free HTTPS only; no proxy forwarding, model request, authentication check or system configuration change." };
}

export function renderNetworkDiagnostics(result) {
  return [`Network diagnostic: ${result.origin}`, ...result.samples.map((s, i) =>
    `${i + 1}. DNS ${s.dns.ok ? "resolved" : s.dns.code}; HTTPS ${s.https.ok ? `reachable (HTTP ${s.https.status})` : s.https.code}; ${s.elapsed_ms}ms`),
  result.scope,
  ...(result.proxyEnvironmentPresent ? ["Proxy environment detected. This direct test does not qualify the harness's proxy route."] : []),
  result.ok ? "All samples passed. This does not rule out an intermittent failure or prove model access." : "Connectivity failed in at least one sample. Preserve this output and compare on another approved network; see docs/network-recovery.md."].join("\n");
}
