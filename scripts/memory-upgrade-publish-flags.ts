/**
 * Allowed flags for publish subcommand (TECH-8191).
 */

export const BOOLEAN_PUBLISH_FLAGS = new Set([
  "--prod",
  "-h",
  "--help",
  "--dry-run",
]);

export const ALLOWED_PUBLISH_FLAGS = new Set([
  ...BOOLEAN_PUBLISH_FLAGS,
  "--database-url",
  "--control-plane-url",
  "--company",
  "--confirm",
  "--table",
  "--batch-sources",
  "--max-rows",
  "--page-size",
  "--pause-when-active-runs",
  "--active-run-poll-ms",
  "--max-pause-seconds",
  "--output",
  "--out",
  "--format",
]);
