/**
 * Allowed flags for status subcommand (TECH-8191).
 */

export const BOOLEAN_STATUS_FLAGS = new Set([
  "--prod",
  "--help",
  "-h",
  "--probe",
]);

export const ALLOWED_STATUS_FLAGS = new Set([
  ...BOOLEAN_STATUS_FLAGS,
  "--control-plane-url",
  "--database-url",
  "--company",
  "--confirm",
  "--table",
  "--blocking-run-limit",
  "--output",
  "--out",
  "--format",
]);
