import { ApiError } from "@/api/client";

const GENERIC_MESSAGE = "Couldn't start sign in. Please try again.";

// Keyed by the typed `OAuthHandoffError.code`. Matched by error name rather than imported so this leaf stays
// independent of the handoff module.
const HANDOFF_MESSAGES: Record<string, string> = {
  expired: "This sign-in expired. Start the connection again.",
  forbidden: "Paperclip Cloud could not authorize this connection for your account.",
  invalid_handoff: "Couldn't open the sign-in page. Please try again.",
  unavailable: "Couldn't open the sign-in page. Please try again.",
};

/**
 * User-facing text for a failed OAuth start. Output is always one of a fixed set of static strings chosen from the
 * typed error code or HTTP status: no `error.message`, URL, query token, header, body or stack text is ever
 * forwarded, because any of those can carry client secrets, state or internal details.
 */
export function oauthStartFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return GENERIC_MESSAGE;
  if (error.name === "OAuthHandoffError") {
    const code = (error as Error & { code?: unknown }).code;
    // Own-property check: a plain-object lookup would resolve inherited keys ("constructor", "__proto__", ...) to
    // non-string values, so anything outside the four declared codes falls back to the fixed message.
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(HANDOFF_MESSAGES, code)
      ? HANDOFF_MESSAGES[code]
      : HANDOFF_MESSAGES.unavailable;
  }
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has expired. Sign in to Paperclip and try again.";
    if (error.status === 403) return "You don't have permission to connect this app.";
    if (error.status === 404) return "This app is no longer available to connect.";
    if (error.status === 409) return "This app can't be connected right now. Refresh the page and try again.";
    if (error.status === 429) return "Too many attempts. Wait a moment and try again.";
    if (error.status >= 500) return "Paperclip couldn't start sign in. Please try again.";
  }
  return GENERIC_MESSAGE;
}
