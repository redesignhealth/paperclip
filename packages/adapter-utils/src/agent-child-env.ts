/**
 * Strict base environment for agent child processes (TECH-7076).
 *
 * Agent adapters spawn CLIs (Claude, Codex, Hermes, ...) that can run arbitrary
 * tools, including a terminal that can print its own environment. Anything in the
 * child's environment can therefore reach the model provider as tool output
 * before Paperclip's log redaction ever sees it. The server process environment
 * holds server-only secrets (SSO provider definitions, Better Auth secret,
 * secrets master key, database URLs, cloud credentials, the server's own
 * provider API keys), so the child must NOT inherit it wholesale.
 *
 * Policy: the child base environment is built from an ALLOWLIST of operating
 * system / runtime variables. Everything else in the server environment is
 * dropped. Provider credentials never come from here: they are resolved per run
 * by the managed AI-connection runtime and passed explicitly as adapter env,
 * which callers merge ON TOP of this base.
 *
 * Limits (deliberately not claimed): this does not stop a process running as the
 * same OS user from reading another process's /proc/<pid>/environ or shared
 * files. That needs structural isolation (separate user / container / runner),
 * which is tracked separately.
 */

/** Exact variable names that are safe, non-secret OS/runtime essentials. */
const SAFE_BASE_ENV_NAMES: ReadonlySet<string> = new Set([
  // Core process context
  "PATH",
  "Path",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TERM",
  "COLORTERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Dynamic loader / Windows essentials needed to start processes at all
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "windir",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  // XDG base directories (locations only)
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // Outbound network plumbing (not credentials)
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  // TLS trust roots (file locations, not secrets)
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  // Existing non-secret Paperclip runtime coordinates that children relied on
  "PAPERCLIP_RUNTIME_API_URL",
  "PAPERCLIP_LISTEN_HOST",
  "PAPERCLIP_LISTEN_PORT",
]);

/** Variable-name prefixes that are safe locale settings. */
const SAFE_BASE_ENV_PREFIXES: readonly string[] = ["LC_"];

export function isSafeAgentBaseEnvName(name: string): boolean {
  if (SAFE_BASE_ENV_NAMES.has(name)) return true;
  return SAFE_BASE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Build the strict base environment for an agent child process from the server's
 * environment. Only allowlisted names survive; values are copied verbatim.
 * Explicit per-run adapter env (resolved credentials, run-scoped Paperclip vars)
 * must be merged on top by the caller.
 */
export function buildAgentChildBaseEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSafeAgentBaseEnvName(name)) base[name] = value;
  }
  return base;
}
