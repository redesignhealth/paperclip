import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { OAuthHandoffError } from "./oauthHandoff";
import { oauthStartFailureMessage } from "./oauth-start-feedback";

/**
 * TECH-7340 — user-facing text for a failed OAuth start.
 *
 * The output is always one of a fixed set of static strings chosen from the typed
 * error code or HTTP status. No `error.message`, URL, query token, header, body or
 * stack text is ever forwarded: any of those can carry client secrets, state or
 * internal details. This direct unit test performs no HTTP or secret reads; the
 * sentinels below are inert strings.
 */

// The complete closed set of strings the helper may ever return.
const FIXED_MESSAGES = new Set([
  "Couldn't start sign in. Please try again.",
  "This sign-in expired. Start the connection again.",
  "Paperclip Cloud could not authorize this connection for your account.",
  "Couldn't open the sign-in page. Please try again.",
  "Your session has expired. Sign in to Paperclip and try again.",
  "You don't have permission to connect this app.",
  "This app is no longer available to connect.",
  "This app can't be connected right now. Refresh the page and try again.",
  "Too many attempts. Wait a moment and try again.",
  "Paperclip couldn't start sign in. Please try again.",
]);

// Raw material that must never reach the user through the returned message.
const SECRET_SENTINEL = "sk-live-SECRETsentinel77"; // short, bare, no URL
const URL_WITH_QUERY_TOKEN =
  "https://accounts.example.test/authorize?client_secret=tok_abc123&state=x";
const HEADER_SENTINEL = "authorization: Bearer eyJhbGciOiJ9x_SECRET-header";
const BODY_SENTINEL = '{"client_secret":"body-secret-XYZ"}';
const STACK_SENTINEL = "at postCloudHandoff (oauthHandoff.ts:88:11)";

function assertFixedAndClean(message: string): void {
  expect(FIXED_MESSAGES.has(message)).toBe(true);
  for (const forbidden of [
    SECRET_SENTINEL,
    URL_WITH_QUERY_TOKEN,
    HEADER_SENTINEL,
    BODY_SENTINEL,
    STACK_SENTINEL,
    "tok_abc123",
    "client_secret",
    "body-secret",
    "Bearer ",
    "eyJhbGciOiJ9x_SECRET-header",
    "postCloudHandoff",
    "https://",
  ]) {
    expect(message).not.toContain(forbidden);
  }
}

describe("oauthStartFailureMessage", () => {
  it("maps each useful ApiError status to a fixed message", () => {
    expect(oauthStartFailureMessage(new ApiError("nope", 401, null))).toBe(
      "Your session has expired. Sign in to Paperclip and try again.",
    );
    expect(oauthStartFailureMessage(new ApiError("nope", 403, null))).toBe(
      "You don't have permission to connect this app.",
    );
    expect(oauthStartFailureMessage(new ApiError("nope", 404, null))).toBe(
      "This app is no longer available to connect.",
    );
    expect(oauthStartFailureMessage(new ApiError("nope", 409, null))).toBe(
      "This app can't be connected right now. Refresh the page and try again.",
    );
    expect(oauthStartFailureMessage(new ApiError("nope", 429, null))).toBe(
      "Too many attempts. Wait a moment and try again.",
    );
    expect(oauthStartFailureMessage(new ApiError("nope", 500, null))).toBe(
      "Paperclip couldn't start sign in. Please try again.",
    );
    expect(oauthStartFailureMessage(new ApiError("nope", 503, null))).toBe(
      "Paperclip couldn't start sign in. Please try again.",
    );
  });

  it("falls back to the fixed generic message for unmapped statuses, plain Errors, and non-Errors", () => {
    const generic = "Couldn't start sign in. Please try again.";
    // Unmapped statuses (an ApiError whose payload message is a short bare secret sentinel).
    expect(oauthStartFailureMessage(new ApiError(SECRET_SENTINEL, 400, { error: SECRET_SENTINEL }))).toBe(generic);
    expect(oauthStartFailureMessage(new ApiError(SECRET_SENTINEL, 418, null))).toBe(generic);
    // A plain Error whose message is a URL with a query token.
    expect(oauthStartFailureMessage(new Error(`Request failed: ${URL_WITH_QUERY_TOKEN}`))).toBe(generic);
    // Non-Error inputs.
    expect(oauthStartFailureMessage("just a string")).toBe(generic);
    expect(oauthStartFailureMessage({ code: "expired" })).toBe(generic);
    expect(oauthStartFailureMessage(undefined)).toBe(generic);
  });

  it("maps each OAuthHandoffError code (matched by name) to a fixed message, with the unavailable fallback", () => {
    const secretMessage = `handoff session ${SECRET_SENTINEL} rejected`;
    expect(oauthStartFailureMessage(new OAuthHandoffError(secretMessage, "expired"))).toBe(
      "This sign-in expired. Start the connection again.",
    );
    expect(oauthStartFailureMessage(new OAuthHandoffError(secretMessage, "forbidden"))).toBe(
      "Paperclip Cloud could not authorize this connection for your account.",
    );
    expect(oauthStartFailureMessage(new OAuthHandoffError(secretMessage, "invalid_handoff"))).toBe(
      "Couldn't open the sign-in page. Please try again.",
    );
    expect(oauthStartFailureMessage(new OAuthHandoffError(secretMessage, "unavailable"))).toBe(
      "Couldn't open the sign-in page. Please try again.",
    );
    // An unknown code falls back to the unavailable message, never the raw message.
    expect(oauthStartFailureMessage(new OAuthHandoffError(secretMessage, "mystery" as never))).toBe(
      "Couldn't open the sign-in page. Please try again.",
    );

    // A like-shaped error (name + code, not the imported class instance) routes the same way.
    const likeError = new Error(secretMessage) as Error & { code: unknown };
    likeError.name = "OAuthHandoffError";
    likeError.code = "expired";
    expect(oauthStartFailureMessage(likeError)).toBe("This sign-in expired. Start the connection again.");
    // A handoff-named error with a missing/invalid code still fails closed to the fixed fallback.
    const codeless = new Error(secretMessage) as Error & { code?: unknown };
    codeless.name = "OAuthHandoffError";
    codeless.code = 42;
    expect(oauthStartFailureMessage(codeless)).toBe("Couldn't open the sign-in page. Please try again.");

    // Prototype-chain codes on a like-shaped error resolve to the EXACT fixed unavailable
    // fallback (closed set, never the raw message): a plain Record lookup would return the
    // inherited function/object for these keys instead of a string.
    const unavailable = "Couldn't open the sign-in page. Please try again.";
    for (const inheritedKey of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const protoCodeError = new Error(secretMessage) as Error & { code: unknown };
      protoCodeError.name = "OAuthHandoffError";
      protoCodeError.code = inheritedKey;
      const message = oauthStartFailureMessage(protoCodeError);
      expect(message, inheritedKey).toBe(unavailable);
      assertFixedAndClean(message);
    }
  });

  it("never forwards message, url, query token, header, body or stack material", () => {
    const cases: unknown[] = [
      // ApiError whose payload message is a short bare SECRET sentinel (no URL).
      new ApiError(SECRET_SENTINEL, 503, { error: BODY_SENTINEL }),
      // Header-like material in the message.
      new ApiError(HEADER_SENTINEL, 401, null),
      // Stack-like material in the message of a plain Error.
      new Error(`TypeError: cannot read properties of undefined\n  ${STACK_SENTINEL}`),
      // A plain Error whose message is a URL with a query token.
      new Error(`${URL_WITH_QUERY_TOKEN} unreachable`),
      // OAuthHandoffError whose message carries the secret sentinel.
      new OAuthHandoffError(`session ${SECRET_SENTINEL} expired`, "expired"),
      // A like-shaped handoff error with the secret in its message.
      Object.assign(new Error(`session ${SECRET_SENTINEL} forbidden`), {
        name: "OAuthHandoffError",
        code: "forbidden",
      }),
    ];
    for (const error of cases) {
      assertFixedAndClean(oauthStartFailureMessage(error));
    }
  });
});
