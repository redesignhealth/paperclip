/**
 * Allowed flags for rollback subcommand (TECH-8191).
 */

export const BOOLEAN_ROLLBACK_FLAGS = new Set([
  "--prod",
  "--help",
  "-h",
  "--dry-run",
]);

export const ALLOWED_ROLLBACK_FLAGS = new Set([
  ...BOOLEAN_ROLLBACK_FLAGS,
  "--database-url",
  "--control-plane-url",
  "--company",
  "--confirm",
  "--table",
  "--output",
  "--out",
  "--format",
]);
