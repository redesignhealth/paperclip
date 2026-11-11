/**
 * Allowed flags for drain subcommand (TECH-8191).
 */

export const BOOLEAN_DRAIN_FLAGS = new Set([
  "--prod",
  "--help",
  "-h",
  "--dry-run",
  "--once",
]);

export const ALLOWED_DRAIN_FLAGS = new Set([
  ...BOOLEAN_DRAIN_FLAGS,
  "--database-url",
  "--control-plane-url",
  "--company",
  "--confirm",
  "--table",
  "--max-drain-hours",
  "--probe-interval-minutes",
  "--probe-limit",
  "--blocking-run-limit",
  "--output",
  "--out",
  "--format",
]);
