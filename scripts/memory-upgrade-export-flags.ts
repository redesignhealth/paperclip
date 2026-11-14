/**
 * Allowed flags for export subcommand (TECH-8573).
 */

export const BOOLEAN_EXPORT_FLAGS = new Set([
  "--prod",
  "--help",
  "-h",
]);

export const ALLOWED_EXPORT_FLAGS = new Set([
  ...BOOLEAN_EXPORT_FLAGS,
  "--database-url",
  "--control-plane-url",
  "--company",
  "--agent",
  "--upgrade-id",
  "--output-dir",
  "--confirm",
  "--format",
  "--table",
]);
