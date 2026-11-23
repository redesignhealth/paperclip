// Tiny argument parser: `--flag`, `--key value`, `--key=value`, `--no-flag`. No dependencies.
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv, { boolean = [], number = [] } = {}) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const rawKey = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    if (rawKey.startsWith("no-")) {
      opts[camel(rawKey.slice(3))] = false;
      continue;
    }
    const key = camel(rawKey);
    if (boolean.includes(key)) {
      opts[key] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined) throw new Error(`--${rawKey} needs a value`);
    if (number.includes(key)) {
      opts[key] = Number(value);
      if (!Number.isFinite(opts[key])) throw new Error(`--${rawKey} must be a number`);
    } else opts[key] = value;
  }
  return { opts, rest };
}
