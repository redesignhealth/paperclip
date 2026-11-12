/**
 * Allowed flags for verify subcommand (TECH-8191).
 */

export const BOOLEAN_VERIFY_FLAGS = new Set([
  "--prod",
  "--help",
  "-h",
  "--dry-run",
  "--allow-quarantined",
]);

export const ALLOWED_VERIFY_FLAGS = new Set([
  ...BOOLEAN_VERIFY_FLAGS,
  "--database-url",
  "--control-plane-url",
  "--company",
  "--confirm",
  "--table",
  "--probe-limit",
  "--blocking-run-limit",
  "--output",
  "--out",
  "--format",
]);
