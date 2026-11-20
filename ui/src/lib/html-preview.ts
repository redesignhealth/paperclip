/** HTML previews are documents, never nodes in the Paperclip DOM. */
export function isHtmlPreview(contentType: string | null | undefined, filename: string | null | undefined) {
  const type = contentType?.toLowerCase().split(";")[0].trim();
  return type === "text/html" || type === "application/xhtml+xml" || /\.html?$/i.test(filename ?? "");
}

// Inline scripts support self-contained reports/charts. No origin privileges,
// external scripts, API calls, forms, embeds, or remote subresources are granted.
// Multiple CSPs intersect; artifact markup cannot loosen this first policy.
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function htmlPreviewDocument(html: string) {
  // Install the policy before ANY untrusted markup is parsed. Do not parse the
  // artifact in the host document (even detached DOMs can load resources).
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}

/**
 * Issue documents are stored as "markdown" and their keys cannot carry an
 * extension, so detect HTML documents by their leading markup: a doctype or a
 * root <html> element (optionally after whitespace, a BOM, or HTML comments).
 */
export function isHtmlDocumentBody(body: string | null | undefined) {
  if (!body) return false;
  const head = body.replace(/^\uFEFF/, "").replace(/^(?:\s|<!--[\s\S]*?-->)+/, "");
  return /^<!doctype\s+html[\s>]/i.test(head) || /^<html[\s>]/i.test(head);
}
