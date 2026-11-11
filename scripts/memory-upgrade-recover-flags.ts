/**
 * Allowed flags for recover subcommand (TECH-8191).
 */

export const BOOLEAN_RECOVER_FLAGS = new Set([
  "--prod",
  "--help",
  "-h",
  "--dry-run",
]);

export const ALLOWED_RECOVER_FLAGS = new Set([
  ...BOOLEAN_RECOVER_FLAGS,
  "--control-plane-url",
  "--company",
  "--confirm",
  "--output",
  "--out",
  "--format",
]);
