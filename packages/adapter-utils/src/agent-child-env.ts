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
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramData",
  "PROGRAMFILES",
  "ProgramFiles",
  "PROGRAMFILES(X86)",
  "ProgramFiles(x86)",
  "PROCESSOR_ARCHITECTURE",
  "OS",
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
  // Toolchain locations the production image sets under HOME=/paperclip (locations only)
  "RUSTUP_HOME",
  "CARGO_HOME",
  "GEMINI_SANDBOX",
  // Existing non-secret Paperclip runtime coordinates that children relied on
  "PAPERCLIP_RUNTIME_API_URL",
  "PAPERCLIP_LISTEN_HOST",
  "PAPERCLIP_LISTEN_PORT",
]);

/** The real POSIX locale category variables. LC_* is NOT accepted as a free-form prefix. */
const SAFE_LOCALE_ENV_NAMES: ReadonlySet<string> = new Set([
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
]);

export function isSafeAgentBaseEnvName(name: string): boolean {
  return SAFE_BASE_ENV_NAMES.has(name) || SAFE_LOCALE_ENV_NAMES.has(name);
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
