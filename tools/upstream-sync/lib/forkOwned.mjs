import fs from "node:fs";

// FORK_OWNED.md: after the start marker, every bullet that contains a backticked pattern is a fork-owned path.
//   `path/to/file.ts`     exact file
//   `path/to/dir/`        everything under dir
//   `path/**/*.ts`        glob (** crosses dirs, * does not)
const START_MARKER = "<!-- fork-owned:start -->";

export function parseForkOwned(markdown) {
  const patterns = [];
  const start = markdown.indexOf(START_MARKER);
  if (start < 0) throw new Error(`FORK_OWNED.md is missing the ${START_MARKER} marker`);
  for (const line of markdown.slice(start).split("\n")) {
    if (!/^\s*[-*]\s/.test(line)) continue;
    const m = line.match(/`([^`]+)`/);
    if (m) patterns.push(m[1].trim());
  }
  return patterns;
}

function globToRegExp(glob) {
  if (glob.endsWith("/")) glob += "**";
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function buildForkOwnedMatcher(patterns) {
  const compiled = patterns.map((p) => ({ p, re: globToRegExp(p) }));
  return (file) => compiled.some(({ re }) => re.test(file));
}

export function loadForkOwnedMatcher(file) {
  const md = fs.readFileSync(file, "utf8");
  const patterns = parseForkOwned(md);
  if (patterns.length === 0) throw new Error(`No fork-owned patterns found in ${file}`);
  return { patterns, matches: buildForkOwnedMatcher(patterns) };
}

// Drizzle migrations / schema always take the human-gated path (migration numbering
// collides with fork migrations 0371-0378+).
const MIGRATION_RE = /^packages\/db\/src\/(migrations\/|schema\/)/;
export const touchesMigrations = (files) => files.some((f) => MIGRATION_RE.test(f));
