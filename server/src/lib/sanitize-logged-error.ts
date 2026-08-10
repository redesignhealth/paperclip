// Bounds and cleans an error string before it's persisted to a durable
// audit/activity log. Needed anywhere the message can originate from an
// external system (an OAuth provider's error_description, a hook
// implementation's thrown error) rather than from this codebase's own
// exceptions -- an unbounded or control-character-laden string from such a
// source is a storage-sink and log-injection risk if logged raw.
export function sanitizeLoggedProviderError(message: string): string {
  return message.replace(/[^\x20-\x7e]/g, "").slice(0, 512);
}
