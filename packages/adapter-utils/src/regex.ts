/**
 * Escapes special regular expression characters in a string so it can be safely
 * interpolated into a RegExp constructor.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
