import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePiGuardPolicy, type PiGuardPolicy } from "./guard-policy.js";
import { PI_MEMORY_TOOL_NAMES } from "./memory-extension.js";

// TECH-9797: the Pi `tool_call` guard for headless builders. Policy lives in guard-policy.ts; this module turns it
// into a self-contained extension file (embedded policy plus the evaluator below) that is staged to the pod like the
// attribution extension. The evaluator is written with String.raw so regexes keep their backslashes; it must not
// contain a backtick or a dollar-brace sequence.
export const PI_GUARD_PROFILE_ENV = "PAPERCLIP_PI_GUARD_PROFILE";
export const PI_GUARD_EXTENSION_FILE = "paperclip-guard.mjs";
/**
 * After this many blocked calls IN A ROW the run is aborted instead of letting the agent keep retrying. An allowed
 * call resets the count, so a long productive session is not stopped by a few unrelated refusals (TECH-10085).
 */
export const PI_GUARD_MAX_BLOCKS = 3;

export const PI_GUARD_EVALUATOR_SOURCE = String.raw`
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BT = String.fromCharCode(96);
const SECRET_PATHS = POLICY.secretPathPatterns.map((source) => new RegExp(source, "i"));
const DENY_RAW = POLICY.denyCommandPatterns.map((entry) => ({ re: new RegExp(entry.pattern, entry.flags || ""), why: entry.why }));
const SECRET_NAMES = new Set(POLICY.secretEnvNames);
const SAFE_NAMES = new Set(POLICY.safeEnvNames);
const SECRET_SUFFIX = new RegExp(POLICY.secretEnvSuffixPattern);
const ALLOWED = new Set(POLICY.allowedCommands);
const ALLOWED_GIT = new Set(POLICY.allowedGit);
const ALLOWED_TF = new Set(POLICY.allowedTerraform);
const DEFAULT_BRANCHES = new Set(POLICY.defaultBranches);
const MCP_DENY = POLICY.denyMcpToolPatterns;
const MCP_SHELL_HINT = "BLOCKED by the Paperclip guard: mcp is a Pi tool, not a shell command, so it cannot be run from bash. Nothing in this command ran. If an mcp tool is listed among your tools, call it directly instead (for example the mcp tool with search set to argus, then call the tool it finds) and re-run the rest of the command without the mcp part. If no mcp tool is available in this run, say so on your issue. Either way this is not an approval problem: do not ask for approval for the shell command.";
const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "nice", "timeout", "xargs", "env", "stdbuf"]);
const SKIP_COMMANDS = new Set(["done", "fi", "esac", "for", "select", "case", "function", "in"]);
const SHIFT_KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!"]);
const INTERPRETERS = new Set(["python", "python3", "node", "tsx", "ruby", "perl", "bash", "sh", "zsh", "bun"]);
const ENV_READ = /\benviron\b|process\.env|\bgetenv\b|\bprintenv\b|\bENV\b/;

function deny(why, hint) { return { kind: "deny", why, hint }; }
function unlisted(what) { return { kind: "unlisted", what }; }

function isSecretVar(name) {
  return !SAFE_NAMES.has(name) && (SECRET_NAMES.has(name) || SECRET_SUFFIX.test(name));
}

function secretVarIn(text) {
  const re = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (isSecretVar(match[1])) return match[1];
  }
  return null;
}

function secretPathIn(text) {
  for (const re of SECRET_PATHS) if (re.test(text)) return true;
  return false;
}

function readParen(src, open) {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j === -1 ? src.length : j + 1; continue; }
    if (c === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') { if (src[j] === "\\") j++; j++; } i = j + 1; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return { inner: src.slice(open + 1, i), next: i + 1 }; }
    i++;
  }
  return { inner: src.slice(open + 1), next: src.length };
}

// Command substitutions inside text the shell would expand (unquoted heredoc bodies, parameter defaults).
function scanSubst(text, nested) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$" && text[i + 1] === "(") { const r = readParen(text, i + 1); nested.push(r.inner); i = r.next; continue; }
    if (text[i] === BT) { const j = text.indexOf(BT, i + 1); const end = j === -1 ? text.length : j; nested.push(text.slice(i + 1, end)); i = end + 1; continue; }
    i++;
  }
}

// A small shell reader: simple commands as word lists, plus the text of every nested command substitution.
export function parseShell(src) {
  const commands = [];
  const nested = [];
  let words = [];
  let cur = "";
  let has = false;
  let i = 0;
  const n = src.length;
  let redirectNext = false;
  const heredocs = [];
  const pushWord = () => {
    if (has) { if (redirectNext) redirectNext = false; else words.push(cur); }
    cur = ""; has = false;
  };
  const pushCommand = () => { pushWord(); if (words.length > 0) commands.push(words); words = []; };
  while (i < n) {
    const c = src[i];
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (c === "\\") { if (i + 1 < n) { cur += src[i + 1]; has = true; } i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); const end = j === -1 ? n : j; cur += src.slice(i + 1, end); has = true; i = end + 1; continue; }
    if (c === '"') {
      i++; has = true;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) { cur += src[i + 1]; i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "(") { const r = readParen(src, i + 1); nested.push(r.inner); cur += "$()"; i = r.next; continue; }
        if (src[i] === BT) { const j = src.indexOf(BT, i + 1); const end = j === -1 ? n : j; nested.push(src.slice(i + 1, end)); cur += "$()"; i = end + 1; continue; }
        cur += src[i]; i++;
      }
      i++; continue;
    }
    if (c === "$" && src[i + 1] === "(") { const r = readParen(src, i + 1); nested.push(r.inner); cur += "$()"; has = true; i = r.next; continue; }
    if (c === "$" && src[i + 1] === "{") { const j = src.indexOf("}", i); const end = j === -1 ? n : j + 1; const braced = src.slice(i, end); scanSubst(braced, nested); cur += braced; has = true; i = end; continue; }
    if (c === BT) { const j = src.indexOf(BT, i + 1); const end = j === -1 ? n : j; nested.push(src.slice(i + 1, end)); cur += "$()"; has = true; i = end + 1; continue; }
    if ((c === "<" || c === ">") && src[i + 1] === "(") { const r = readParen(src, i + 1); nested.push(r.inner); i = r.next; continue; }
    if (c === "#" && !has) { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "\n") {
      pushCommand(); i++;
      while (heredocs.length > 0) {
        const heredoc = heredocs.shift();
        while (i < n) {
          const end = src.indexOf("\n", i);
          const line = src.slice(i, end === -1 ? n : end);
          i = end === -1 ? n : end + 1;
          if (line.trim() === heredoc.delimiter) break;
          if (!heredoc.quoted) scanSubst(line, nested);
        }
      }
      continue;
    }
    if (c === ";" || c === "|" || c === "(" || c === ")" || c === "{" || c === "}") { pushCommand(); i++; continue; }
    if (c === "&" && src[i + 1] !== ">") { pushCommand(); i++; continue; }
    if (c === "<" || c === ">" || c === "&") {
      if (has && /^[0-9]+$/.test(cur)) { cur = ""; has = false; } else pushWord();
      let j = i;
      while (j < n && (src[j] === "<" || src[j] === ">" || src[j] === "&" || src[j] === "-")) j++;
      const op = src.slice(i, j);
      i = j;
      if (op.startsWith("<<") && !op.startsWith("<<<")) {
        let k = i;
        while (k < n && src[k] === " ") k++;
        const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(src.slice(k));
        if (m) { heredocs.push({ delimiter: m[2], quoted: m[1] !== "" }); i = k + m[0].length; }
        continue;
      }
      if (op.includes("&") && /^[0-9-]/.test(src[i] || "")) { while (i < n && /[0-9-]/.test(src[i])) i++; continue; }
      redirectNext = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") { pushWord(); i++; continue; }
    cur += c; has = true; i++;
  }
  pushCommand();
  return { commands, nested };
}

// Git finds the repository from any subdirectory, so look for .git in the directory and each parent. Only "not there" keeps
// the walk going; any other error (unreadable) fails closed. exactOnly checks the directory itself: used when an earlier
// part of the command may have created a repository that does not exist yet (clone, init, worktree add).
function findGitEntry(cwd, exactOnly) {
  let dir = path.resolve(cwd);
  if (dir === path.join(path.sep, "paperclip-unknown-directory") || dir.startsWith(path.join(path.sep, "paperclip-unknown-directory") + path.sep)) return null;
  for (let depth = 0; depth < 64; depth++) {
    const candidate = path.join(dir, ".git");
    try { return { dir, gitPath: candidate, stat: fs.statSync(candidate) }; } catch (error) {
      if (!error || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) return null;
    }
    if (exactOnly) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readCurrentBranch(cwd, exactOnly) {
  try {
    const found = findGitEntry(cwd, exactOnly);
    if (!found) return null;
    let gitDir = found.gitPath;
    if (found.stat.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"));
      if (!pointer) return null;
      gitDir = path.resolve(found.dir, pointer[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : null;
  } catch { return null; }
}

function checkGitPush(args, cwd, state) {
  let remote = null;
  const refspecs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-f" || arg === "--force" || arg.startsWith("--force-with-lease") || arg === "--force-if-includes" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) return deny("force-pushing");
    if (arg === "--all" || arg === "--branches" || arg === "--repo" || arg.startsWith("--repo=")) return deny("a push that is not limited to one named non-default branch (" + arg + ")");
    if (arg === "--mirror" || arg === "--delete" || arg === "-d" || arg === "--prune") return deny("a destructive push (" + arg + ")");
    if (arg === "-o" || arg === "--push-option" || arg === "--receive-pack" || arg === "--exec") { i++; continue; }
    if (arg.startsWith("-")) continue;
    if (remote === null) remote = arg; else refspecs.push(arg);
  }
  const current = readCurrentBranch(cwd, state.mayCreateRepo === true);
  const targets = [];
  if (refspecs.length === 0) targets.push(current === null ? "?" : current);
  for (const spec of refspecs) {
    if (spec.startsWith("+")) return deny("force-pushing");
    const colon = spec.indexOf(":");
    if (colon === 0) return deny("deleting a remote branch");
    let dest = colon === -1 ? spec : spec.slice(colon + 1);
    dest = dest.replace(/^refs\/heads\//, "");
    if (dest === "HEAD") dest = current === null ? "?" : current;
    targets.push(dest);
  }
  for (const target of targets) {
    if (target === "?") return deny("pushing when the target branch cannot be verified; name the branch explicitly");
    if (DEFAULT_BRANCHES.has(target)) return deny("pushing to the default branch " + target);
  }
  if (state.onDefaultBranch) return deny("pushing after switching to a default branch");
  return null;
}

function checkGit(words, cwd, state) {
  let i = 1;
  let dir = cwd;
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-C") { dir = path.resolve(dir, words[i + 1] || "."); i += 2; continue; }
    if (/^-c.+/.test(w) && /^-c(core\.(sshcommand|pager|editor|fsmonitor|hookspath|askpass)|alias\.|credential\.|protocol\.|url\.|http\.|include)/i.test(w)) return deny("git -c with a setting that can run commands or redirect credentials");
    if (w === "-c") {
      if (/^(core\.(sshcommand|pager|editor|fsmonitor|hookspath|askpass)|alias\.|credential\.|protocol\.|url\.|http\.|include)/i.test(words[i + 1] || "")) return deny("git -c with a setting that can run commands or redirect credentials");
      i += 2; continue;
    }
    if (w === "--exec-path" || w.startsWith("--exec-path=") || w.startsWith("--config-env")) return deny("git options that can run other programs");
    if (w === "--namespace") { i += 2; continue; }
    i++;
  }
  const sub = words[i];
  if (!sub) return null;
  const args = words.slice(i + 1);
  if (!ALLOWED_GIT.has(sub)) return unlisted("git " + sub);
  if (sub === "clone" || sub === "init" || sub === "worktree" || sub === "submodule") state.mayCreateRepo = true;
  if (sub === "push") return checkGitPush(args, dir, state);
  if (sub === "checkout" || sub === "switch") {
    for (const a of args) if (DEFAULT_BRANCHES.has(a)) state.onDefaultBranch = true;
  }
  return null;
}

// Builders may not dismiss their own Argus findings: a /dismiss in PR or issue comment text or a review body is refused.
// Only the dismissal command is matched; every other comment is allowed.
const DISMISS_RE = /\/dismiss/i;
const DISMISS_HINT = "BLOCKED by the Paperclip guard: builders may not dismiss Argus findings, so a comment or review containing /dismiss is never allowed in this run. Fix the finding in the code, or ask on your Paperclip issue. Do not retry it or look for a workaround.";
function denyDismiss() { return deny("posting a /dismiss comment (builders may not dismiss Argus findings)", DISMISS_HINT); }
function denyUnreadableBody(flag) {
  return deny("a comment body read from a file the guard cannot read (" + flag + ")", "BLOCKED by the Paperclip guard: the guard cannot read the file given to " + flag + ", and builders may not dismiss Argus findings, so it cannot confirm the comment has no /dismiss. Post the comment with --body and the text inline instead. Do not retry it or look for a workaround.");
}

function readBodyFile(file, state) {
  if (!file || file === "-") return null;
  try {
    // Only a regular file: a FIFO, /dev/stdin or /dev/zero could block or exhaust memory inside the guard.
    const target = path.resolve(state.cwd, file);
    if (!fs.statSync(target).isFile()) return null;
    return fs.readFileSync(target, "utf8");
  } catch { return null; }
}

// Literal text is matched directly. Text built by the shell ($VAR, $(...)) cannot be read, so the whole command text is matched instead.
function checkBodyText(text, state) {
  if (DISMISS_RE.test(text)) return denyDismiss();
  if ((text.includes("$") || text.includes(BT)) && DISMISS_RE.test(state.raw)) return denyDismiss();
  return null;
}

function checkBodyFile(file, flag, state) {
  const text = readBodyFile(file, state);
  if (text === null) return denyUnreadableBody(flag);
  if (DISMISS_RE.test(text) || DISMISS_RE.test(state.raw)) return denyDismiss();
  return null;
}

function checkCommentBody(words, from, state) {
  for (let i = from; i < words.length; i++) {
    const w = words[i];
    let m;
    if (w === "--body" || w === "-b") { const r = checkBodyText(words[++i] || "", state); if (r) return r; continue; }
    if ((m = /^--body=([\s\S]*)$/.exec(w)) || (m = /^-b([\s\S]+)$/.exec(w))) { const r = checkBodyText(m[1], state); if (r) return r; continue; }
    if (w === "--body-file" || w === "-F") { const r = checkBodyFile(words[++i], w, state); if (r) return r; continue; }
    if ((m = /^--body-file=([\s\S]*)$/.exec(w)) || (m = /^-F([\s\S]+)$/.exec(w))) { const r = checkBodyFile(m[1], "--body-file", state); if (r) return r; continue; }
  }
  return null;
}

function checkApiComment(words, from, state) {
  const targets = words.slice(from).filter((w) => !w.startsWith("-"));
  const graphql = targets.some((w) => /(^|\/)graphql$/.test(w));
  const commentEndpoint = targets.some((w) => /(^|\/)(comments|reviews|replies)(\/|\?|$)/.test(w));
  if (!graphql && !commentEndpoint) return null;
  for (let i = from; i < words.length; i++) {
    const w = words[i];
    let m;
    let field = null;
    let fileFlag = false;
    if (w === "-f" || w === "--raw-field") field = words[++i] || "";
    else if (w === "-F" || w === "--field") { field = words[++i] || ""; fileFlag = true; }
    else if ((m = /^--(raw-field|field)=([\s\S]*)$/.exec(w))) { field = m[2]; fileFlag = m[1] === "field"; }
    else if ((m = /^-([fF])([\s\S]+)$/.exec(w))) { field = m[2]; fileFlag = m[1] === "F"; }
    else if (w === "--input") { const r = checkBodyFile(words[++i], "--input", state); if (r) return r; continue; }
    else if ((m = /^--input=([\s\S]*)$/.exec(w))) { const r = checkBodyFile(m[1], "--input", state); if (r) return r; continue; }
    if (field === null) continue;
    const eq = field.indexOf("=");
    const key = eq === -1 ? field : field.slice(0, eq);
    const value = eq === -1 ? "" : field.slice(eq + 1);
    if (!graphql && key !== "body") continue;
    if (fileFlag && value.startsWith("@")) { const r = checkBodyFile(value.slice(1), "-F " + key, state); if (r) return r; continue; }
    const r = checkBodyText(value, state);
    if (r) return r;
  }
  return null;
}

function checkGh(words, state) {
  const group = words.slice(1).find((w) => !w.startsWith("-"));
  const idx = group ? words.indexOf(group) : -1;
  if (!group) return null;
  const action = words.slice(idx + 1).find((w) => !w.startsWith("-"));
  if (group === "pr" && action === "merge") return deny("merging a pull request");
  if ((group === "pr" && (action === "comment" || action === "review")) || (group === "issue" && action === "comment")) {
    const dismissed = checkCommentBody(words, idx + 1, state);
    if (dismissed) return dismissed;
  }
  if (group === "api") {
    const dismissed = checkApiComment(words, idx + 1, state);
    if (dismissed) return dismissed;
  }
  if (group === "auth" || group === "secret" || group === "variable" || group === "ssh-key" || group === "gpg-key") return deny("gh " + group + " (credentials)");
  if (group === "repo" && action === "clone") state.mayCreateRepo = true;
  if (group === "repo" && (action === "delete" || action === "edit" || action === "archive")) return deny("changing or deleting a repository");
  if (group === "release" || group === "workflow") return unlisted("gh " + group);
  if (group === "api") {
    for (let i = idx + 1; i < words.length; i++) {
      const w = words[i];
      const inline = /^-X(.+)$/.exec(w) || /^--method=(.+)$/.exec(w);
      if ((inline && !/^get$/i.test(inline[1])) || ((w === "-X" || w === "--method") && !/^get$/i.test(words[i + 1] || ""))) {
        if (/merge/.test(words.join(" "))) return deny("merging a pull request");
        return unlisted("gh api with a write method");
      }
      if (/^(-f|-F|--field|--raw-field|--input)(=|$)|^-[fF]./.test(w)) return unlisted("gh api with a request body");
    }
  }
  const allowedActions = POLICY.allowedGh[group];
  if (!allowedActions) return unlisted("gh " + group);
  if (allowedActions.includes("*")) return null;
  if (!action || !allowedActions.includes(action)) return unlisted("gh " + group + " " + (action || ""));
  return null;
}

function checkTerraform(words) {
  const sub = words.slice(1).find((w) => !w.startsWith("-"));
  if (!sub) return null;
  if (/^(apply|destroy|import|taint|untaint|force-unlock|refresh)$/.test(sub)) return deny("terraform " + sub);
  if (sub === "state" || sub === "workspace") return deny("terraform " + sub + " changes shared state");
  if (!ALLOWED_TF.has(sub)) return unlisted("terraform " + sub);
  return null;
}

function checkRm(words) {
  const flags = words.slice(1).filter((w) => w.startsWith("-")).join("");
  const targets = words.slice(1).filter((w) => !w.startsWith("-"));
  if (/[rR]/.test(flags) || flags.includes("recursive")) {
    for (const t of targets) {
      if (t === "/" || t === "/*" || t === "~" || t === "~/" || t === "." || t === ".." || t === "*" || /^\$\{?HOME\}?/.test(t) || t.startsWith("/") && t.split("/").filter(Boolean).length < 2) return deny("a recursive delete of " + t);
    }
  }
  return null;
}

// Skills are staged into the pod at an absolute path under the runtime root; their scripts are the agent's own tools.
function stagedSkillScript(word) {
  return /\/\.paperclip-runtime\/pi\/skills\/[^\s]+$/.test(word) && !word.split("/").includes("..");
}

function relativeScript(word) {
  if (stagedSkillScript(word)) return true;
  return !path.isAbsolute(word) && !word.startsWith("~") && !word.split("/").includes("..") && (word.startsWith("./") || word.includes("/"));
}

function checkSimple(input, _cwd, state) {
  const cwd = state.cwd;
  let words = input.slice();
  for (let guard = 0; guard < 20 && words.length > 0; guard++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words.shift(); continue; }
    if (SHIFT_KEYWORDS.has(words[0])) { words.shift(); continue; }
    break;
  }
  if (words.length === 0) return null;
  if (SKIP_COMMANDS.has(words[0])) return null;
  const first = words[0];
  const base = first.includes("/") && !relativeScript(first) ? path.basename(first) : first;
  if (base === "cd" || base === "pushd") {
    const target = words.slice(1).find((w) => !w.startsWith("-"));
    // An unknown or computed directory means later branch lookups cannot be trusted, so they fail closed.
    state.cwd = target && !/[$~]|\$\(/.test(target) ? path.resolve(state.cwd, target) : path.join(path.sep, "paperclip-unknown-directory");
    return null;
  }
  // mcp is a Pi tool, not a shell command. Run in bash it is not a binary in the pod, and the generic "unlisted" reply would
  // tell the builder to stop and ask for approval, so it gets its own reply that points at the tool. Only the command word
  // matches: paths, filenames, arguments and grep patterns that contain "mcp" are untouched.
  if (base === "mcp") return deny("running mcp as a shell command", MCP_SHELL_HINT);
  if (base === "sudo" || base === "su" || base === "doas") return deny("privilege escalation");
  if (WRAPPERS.has(base)) {
    let rest = words.slice(1);
    if (base === "env") {
      while (rest.length > 0 && (rest[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) rest.shift();
      if (rest.length === 0) return deny("printing the process environment");
    } else if (base === "timeout") {
      while (rest.length > 0 && rest[0].startsWith("-")) rest.shift();
      rest.shift();
    } else if (base === "xargs") {
      while (rest.length > 0 && rest[0].startsWith("-")) { const flag = rest.shift(); if (/^-[IndPEL]$/.test(flag)) rest.shift(); }
    } else {
      while (rest.length > 0 && rest[0].startsWith("-")) rest.shift();
    }
    return checkSimple(rest, cwd, state);
  }
  if (base === "printenv") return deny("printing the process environment");
  if ((base === "set" || base === "declare" || base === "typeset") && words.length === 1) return deny("printing the process environment");
  if ((base === "declare" || base === "typeset") && words.slice(1).some((w) => /^-[a-zA-Z]*[xp]/.test(w))) return deny("printing the process environment");
  if (base === "compgen" && words.slice(1).some((w) => /^-[a-zA-Z]*[ev]/.test(w))) return deny("printing the process environment");
  if (base === "export" && (words.length === 1 || words[1] === "-p")) return deny("printing the process environment");
  if (base === "export" || base === "unset" || base === "set") return null;
  if (INTERPRETERS.has(base)) {
    const idx = words.findIndex((w, k) => k > 0 && /^(-c|-e|-p|--eval|--print|-pe|-lc|-ic)$/.test(w));
    if (idx !== -1) {
      const code = words.slice(idx + 1).join(" ");
      if (ENV_READ.test(code)) return deny("reading the process environment from inline code");
      if ((base === "bash" || base === "sh" || base === "zsh") && words[idx + 1]) return { kind: "recurse", source: words[idx + 1] };
    }
  }
  if ((base === "bash" || base === "sh" || base === "zsh") && !(words[1] && relativeScript(words[1]))) {
    if (!words.slice(1).some((w) => /^(-c|-lc|-ic)$/.test(w))) return unlisted(base + " without a script in the workspace");
    return null;
  }
  if ((base === "bash" || base === "sh" || base === "zsh") && words[1] && relativeScript(words[1])) return null;
  if (base === "rm") { const r = checkRm(words); if (r) return r; }
  if (base === "git") { const r = checkGit(words, cwd, state); if (r) return r; return null; }
  if (base === "gh") { const r = checkGh(words, state); if (r) return r; return null; }
  if (base === "terraform" || base === "tofu") { if (!ALLOWED.has(base)) return unlisted(base); return checkTerraform(words); }
  if (base === "chmod" && words.slice(1).some((w) => /^[0-7]*7[0-7]7$|^a\+rwx$/.test(w))) return deny("making files world-writable");
  if (ALLOWED.has(base)) return null;
  if (/^paperclip-[a-z0-9-]+$/.test(base)) return null;
  if (relativeScript(first)) return null;
  return unlisted(base);
}

function evaluateBashSource(source, cwd, state, depth) {
  if (depth > 6) return unlisted("deeply nested shell");
  const { commands, nested } = parseShell(source);
  for (const words of commands) {
    const result = checkSimple(words, cwd, state);
    if (result && result.kind === "recurse") {
      const inner = evaluateBashSource(result.source, cwd, state, depth + 1);
      if (inner) return inner;
    } else if (result) return result;
  }
  for (const inner of nested) {
    const result = evaluateBashSource(inner, cwd, state, depth + 1);
    if (result) return result;
  }
  return null;
}

export function evaluateBash(command, cwd) {
  if (typeof command !== "string" || command.trim() === "") return unlisted("an empty command");
  const secretVar = secretVarIn(command);
  if (secretVar) return deny("reading the secret environment variable " + secretVar);
  if (secretPathIn(command)) return deny("touching a secret path or credential file");
  for (const entry of DENY_RAW) if (entry.re.test(command)) return deny(entry.why);
  return evaluateBashSource(command, cwd, { onDefaultBranch: false, cwd, raw: command }, 0);
}

function insideAllowedWriteRoot(target, cwd) {
  const resolved = path.resolve(cwd, target);
  const roots = [cwd, os.tmpdir(), ...POLICY.writeRoots].map((root) => path.resolve(root));
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

export function evaluateToolCall(toolName, input, cwd) {
  const args = input && typeof input === "object" ? input : {};
  switch (toolName) {
    case "bash": return evaluateBash(args.command, cwd);
    case "read": case "grep": case "find": case "ls": {
      const target = typeof args.path === "string" ? args.path : "";
      if (target && secretPathIn(target)) return deny("reading a secret path or credential file");
      return null;
    }
    case "edit": case "write": {
      const target = typeof args.path === "string" ? args.path : "";
      if (target && secretPathIn(target)) return deny("writing a secret path or credential file");
      if (!target || !insideAllowedWriteRoot(target, cwd)) return unlisted(toolName + " outside the workspace");
      return null;
    }
    case "mcp": {
      const text = JSON.stringify(args).toLowerCase();
      for (const pattern of MCP_DENY) if (text.includes(pattern)) return deny("the MCP tool call (" + pattern + ")");
      return null;
    }
    default:
      // The memory extension's own tools (the names it registers). They reach only the agent's own memory scope through
      // the server relay, so they need no approval.
      if (MEMORY_TOOLS.has(toolName)) return null;
      return unlisted("the tool " + toolName);
  }
}

export function blockMessage(result) {
  if (result.kind === "deny" && result.hint) return result.hint;
  if (result.kind === "deny") {
    return "BLOCKED by the Paperclip guard: " + result.why + " is never allowed in this run and will not be approved. Do not retry it or look for a workaround. If this is needed, post a comment on your Paperclip issue saying what and why, set the issue to blocked, and end your turn.";
  }
  return "BLOCKED by the Paperclip guard: " + result.what + " is not on the pre-approved list and nobody is attached to approve it. Do not retry or rephrase it. Post a question on your Paperclip issue saying what you need to run and why, set the issue to blocked, and end your turn.";
}

export default function paperclipGuard(pi) {
  let blocks = 0;
  pi.on("tool_call", async (event, ctx) => {
    let result;
    try {
      result = evaluateToolCall(event.toolName, event.input, ctx && ctx.cwd ? ctx.cwd : process.cwd());
    } catch (error) {
      result = deny("a guard error (" + (error && error.message ? error.message : "unknown") + "); failing closed");
    }
    if (!result) {
      blocks = 0;
      return undefined;
    }
    blocks++;
    const reason = blockMessage(result);
    console.error("[paperclip-guard] blocked " + event.toolName + ": " + (result.why || result.what));
    if (blocks >= MAX_BLOCKS) {
      console.error("[paperclip-guard] stopping run: " + blocks + " consecutive blocked tool calls (last: " + (result.why || result.what) + ")");
      try { ctx.abort(); } catch { /* best effort */ }
      return { block: true, reason: reason + " Repeated blocked calls: this run is being stopped.", terminate: true };
    }
    return { block: true, reason };
  });
}
`;

export function piGuardExtensionSource(policy: PiGuardPolicy): string {
  return `const POLICY = ${JSON.stringify(policy)};\nconst MEMORY_TOOLS = new Set(${JSON.stringify(PI_MEMORY_TOOL_NAMES)});\nconst MAX_BLOCKS = ${PI_GUARD_MAX_BLOCKS};\n${PI_GUARD_EVALUATOR_SOURCE}`;
}

export function readPiGuardProfile(envConfig: Record<string, unknown> | null | undefined): string {
  const raw = envConfig?.[PI_GUARD_PROFILE_ENV];
  const value = raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw;
  if (value === undefined || value === null || value === "") return "";
  // A binding or any other non-string value is not a profile name: resolve to the stricter policy.
  return typeof value === "string" ? value : "invalid";
}

export async function preparePiGuardExtension(profile: string | null | undefined) {
  const policy = resolvePiGuardPolicy(profile);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-guard-"));
  const extensionPath = path.join(directory, PI_GUARD_EXTENSION_FILE);
  try {
    await fs.writeFile(extensionPath, piGuardExtensionSource(policy), "utf8");
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, extensionPath, policy, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
