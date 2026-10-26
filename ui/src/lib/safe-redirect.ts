/**
 * Validate a server-supplied redirect URL before handing it to `window.location.href`.
 *
 * The SSO sign-in redirect URL comes from the server response and navigates an
 * unauthenticated page, so a compromised/misbehaving auth backend (or a MITM'd
 * response) must not be able to smuggle a `javascript:` URI or a similarly
 * dangerous scheme into that navigation.
 */
export function isSafeRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
