/**
 * Headless tool policy for Pi builders in a sandbox pod (TECH-9797).
 *
 * Nobody is attached to approve a prompt, so every call is decided here, by a `tool_call` guard extension
 * (guard-extension.ts) that embeds this policy:
 *
 *   1. DENY  - always blocked (force-push, push to a default branch, terraform apply/destroy, secret paths,
 *              env/secret reads, PR merge). The message says it will never be approved.
 *   2. ALLOW - the pre-approved list below.
 *   3. Everything else fails fast: the agent is told to stop, post a question on its Paperclip issue and end
 *      its turn. Nothing is ever auto-approved.
 *
 * This is a second layer. The pod already has an egress allowlist and a read-only root filesystem. These lists are
 * reviewed by a person: changing what a builder may do without asking is a change to this file.
 */

export type PiGuardProfileName = "builder" | "infrastructure";

export interface PiGuardPolicy {
  profile: PiGuardProfileName;
  /** Program names a bash command may start with. */
  allowedCommands: string[];
  /** `git <sub>` subcommands. `push` is further checked against the deny rules. */
  allowedGit: string[];
  /** `gh <group> <action>` pairs; `*` allows every action in the group. `api` is read-only (GET) when listed. */
  allowedGh: Record<string, string[]>;
  /** `terraform <sub>` / `tofu <sub>`. apply/destroy/import/state are always denied, never listed here. */
  allowedTerraform: string[];
  /** Branches a push may never target. */
  defaultBranches: string[];
  /** Regex sources (case-insensitive) for paths that are never read, searched, listed or written. */
  secretPathPatterns: string[];
  /** Env var names that are never expanded or printed. */
  secretEnvNames: string[];
  /** Env var name pattern (regex source) for secrets by convention. */
  secretEnvSuffixPattern: string;
  /** Names matching the suffix pattern that a builder legitimately uses (the run's bridge token). */
  safeEnvNames: string[];
  /** Raw-command regexes that are always blocked. */
  denyCommandPatterns: Array<{ pattern: string; flags?: string; why: string }>;
  /** Substrings of an MCP tool name that are never allowed through the `mcp` proxy. */
  denyMcpToolPatterns: string[];
  /** Absolute directories (besides the workspace) a builder may write to. */
  writeRoots: string[];
}

const SHARED_SECRET_PATHS = [
  String.raw`/proc/[^\s]*/environ`,
  String.raw`(^|[/\s"'=:~])\.ssh(/|$|[\s"'])`,
  String.raw`(^|[/\s"'=:~])\.aws(/|$|[\s"'])`,
  String.raw`(^|[/\s"'=:~])\.kube(/|$|[\s"'])`,
  String.raw`(^|[/\s"'=:~])\.gnupg(/|$|[\s"'])`,
  String.raw`\.config/gh(/|$|[\s"'])`,
  String.raw`\.docker/config\.json`,
  String.raw`(^|[/\s"'=:~])\.(npmrc|netrc|pypirc|git-credentials)($|[\s"'])`,
  // .env and .env.local, but not documentation templates.
  String.raw`(^|[/\s"'=:~])\.env(\.(?!example|sample|template|dist)[A-Za-z0-9_.-]+)?($|[\s"';|&)])`,
  String.raw`(^|/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?($|[\s"'])`,
  String.raw`\.(pem|p12|pfx)($|[\s"'])`,
  String.raw`/var/run/secrets`,
  String.raw`/etc/(shadow|sudoers)`,
  String.raw`(^|/)\.pi/agent/auth\.json`,
  String.raw`(^|/)(auth|credentials)\.json($|[\s"'])`,
];

const SHARED_SECRET_ENV_NAMES = [
  "RAMP_ROUTER_API_KEY",
  "BOOTSTRAP_TOKEN",
  "PAPERCLIP_GITHUB_BROKER_TOKEN",
  "PAPERCLIP_RUNTIME_TOOLS_TOKEN",
  "PAPERCLIP_GIT_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
];

const SHARED_DENY_PATTERNS: PiGuardPolicy["denyCommandPatterns"] = [
  { pattern: String.raw`\|\s*(sudo\s+)?(ba|z|da)?sh\b`, why: "piping a download into a shell" },
  { pattern: String.raw`/pulls/\d+/merge\b`, why: "merging a pull request" },
  { pattern: String.raw`/git/refs/heads/(main|master|trunk|develop|release)\b`, why: "writing a default branch ref through the API" },
];

const BASE_COMMANDS = [
  // inspect and edit files
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "sed", "awk", "grep", "egrep", "fgrep", "rg",
  "find", "fd", "tree", "pwd", "cd", "echo", "printf", "true", "false", "test", "[", "[[", "mkdir", "touch",
  "cp", "mv", "rm", "diff", "patch", "sleep", "date", "which", "command", "type", "basename", "dirname",
  "realpath", "readlink", "stat", "file", "du", "df", "tee", "jq", "yq", "column", "comm", "paste", "xxd",
  "sha256sum", "md5sum", "tar", "gzip", "gunzip", "unzip", "zip", "ln", "chmod", "export", "unset", "read",
  "wait", "exit", "return", "source", ".", "git", "gh", "curl", "wget",
];

const DEV_COMMANDS = [
  "npm", "pnpm", "yarn", "npx", "node", "tsx", "python", "python3", "pip", "pip3", "uv", "uvx", "pytest", "ruff",
  "mypy", "tsc", "vitest", "eslint", "prettier", "make", "cargo", "rustc", "go", "bun", "corepack",
];

const IR_TERRAFORM = ["fmt", "validate", "plan", "init", "version", "show", "output", "providers", "graph"];

export const BUILDER_GUARD_POLICY: PiGuardPolicy = {
  profile: "builder",
  allowedCommands: [...BASE_COMMANDS, ...DEV_COMMANDS, "terraform", "tofu"],
  allowedGit: [
    "status", "diff", "log", "show", "add", "commit", "checkout", "switch", "branch", "fetch", "pull", "clone",
    "push", "rebase", "merge", "stash", "restore", "reset", "rev-parse", "rev-list", "remote", "ls-files",
    "cherry-pick", "apply", "mv", "rm", "blame", "describe", "worktree", "init", "tag", "grep", "shortlog",
    "ls-remote", "show-ref", "merge-base", "name-rev", "version", "--version",
  ],
  allowedGh: {
    pr: ["create", "view", "list", "checks", "diff", "status", "comment", "edit", "ready"],
    issue: ["view", "list", "comment", "status"],
    repo: ["view", "clone"],
    run: ["view", "list", "watch"],
    api: ["*"],
  },
  allowedTerraform: IR_TERRAFORM,
  defaultBranches: ["main", "master", "trunk", "develop", "release"],
  secretPathPatterns: SHARED_SECRET_PATHS,
  secretEnvNames: SHARED_SECRET_ENV_NAMES,
  secretEnvSuffixPattern: String.raw`(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY|_ACCESS_KEY|_JWT)$`,
  safeEnvNames: ["PAPERCLIP_API_KEY"],
  denyCommandPatterns: SHARED_DENY_PATTERNS,
  denyMcpToolPatterns: ["merge_pull", "merge_pr", "delete_repo", "delete_branch", "force_push"],
  writeRoots: ["/tmp"],
};

/** Plan-only infrastructure builder: no package managers, no language runtimes, no downloads. */
export const INFRASTRUCTURE_GUARD_POLICY: PiGuardPolicy = {
  ...BUILDER_GUARD_POLICY,
  allowedGit: [...BUILDER_GUARD_POLICY.allowedGit],
  allowedTerraform: [...IR_TERRAFORM],
  defaultBranches: [...BUILDER_GUARD_POLICY.defaultBranches],
  secretPathPatterns: [...BUILDER_GUARD_POLICY.secretPathPatterns],
  secretEnvNames: [...BUILDER_GUARD_POLICY.secretEnvNames],
  safeEnvNames: [...BUILDER_GUARD_POLICY.safeEnvNames],
  denyCommandPatterns: [...BUILDER_GUARD_POLICY.denyCommandPatterns],
  denyMcpToolPatterns: [...BUILDER_GUARD_POLICY.denyMcpToolPatterns],
  writeRoots: [...BUILDER_GUARD_POLICY.writeRoots],
  profile: "infrastructure",
  allowedCommands: [...BASE_COMMANDS.filter((name) => name !== "curl" && name !== "wget"), "terraform", "tofu"],
  allowedGh: {
    pr: ["create", "view", "list", "checks", "diff", "status", "comment"],
    issue: ["view", "list", "comment"],
    repo: ["view"],
  },
};

/** An unknown profile name selects the stricter policy. */
export function resolvePiGuardPolicy(name: string | null | undefined): PiGuardPolicy {
  const value = (name ?? "").trim().toLowerCase();
  if (value === "" || value === "builder") return BUILDER_GUARD_POLICY;
  return INFRASTRUCTURE_GUARD_POLICY;
}
