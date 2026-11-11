/**
 * Allowed flags for flip subcommand (TECH-8191).
 */

export const BOOLEAN_FLIP_FLAGS = new Set([
  "--prod",
  "--help",
  "-h",
  "--dry-run",
  "--ack-agent-scope-flag",
]);

export const ALLOWED_FLIP_FLAGS = new Set([
  ...BOOLEAN_FLIP_FLAGS,
  "--database-url",
  "--control-plane-url",
  "--company",
  "--confirm",
  "--table",
  "--mode",
  "--probe-limit",
  "--output",
  "--out",
  "--format",
]);
