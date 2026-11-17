import { forbidden } from "../../errors.js";
import type { SlackObject } from "./slack-client.js";

const TEXT_MAX_BYTES = 256 * 1024;
/** Resumes and similar documents are small; this bounds the native conversion's work. */
const CONVERTIBLE_MAX_BYTES = 5 * 1024 * 1024;
const CONVERTED_MAX_CHARS = 200_000;
const CONVERT_TIMEOUT_MS = 20_000;

const METADATA_ONLY =
  "Metadata only. This file type or size is not available as inline text; do not claim to have read its contents.";

const CONVERTIBLE = [
  { mimetype: "application/pdf", filetype: "pdf", label: "PDF" },
  {
    mimetype:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filetype: "docx",
    label: "Word document",
  },
];

/** Converts document bytes to Markdown; rejects with an Error carrying `code`. */
export type SlackFileConverter = (bytes: Uint8Array) => Promise<string>;

// Imported on first use so a platform without the native binary degrades to
// metadata-only reads instead of failing server startup. OCR stays rejected:
// anydoc's hosted mode would send the document to a third party.
const anydocConverter: SlackFileConverter = async (bytes) => {
  const { toMarkdownBytes } = await import("@firecrawl/anydoc");
  return toMarkdownBytes(bytes, null, { ocr: "reject" });
};

function convertible(file: SlackObject) {
  return CONVERTIBLE.find(
    (kind) => file.mimetype === kind.mimetype || file.filetype === kind.filetype,
  );
}

async function download(
  file: SlackObject,
  botToken: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
) {
  const url = new URL(String(file.url_private_download));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.slack.com" ||
    url.username ||
    url.password ||
    url.port
  )
    throw forbidden("Unsupported Slack file download destination");
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${botToken}` },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw forbidden("Slack file content is unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxBytes) throw forbidden("Slack file exceeds the read limit");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

const CONVERSION_FAILURES: Record<string, string> = {
  needsOcr: "has pages with no text layer (scanned) and OCR is not available",
  empty: "contains no extractable text",
  encrypted: "is encrypted or password-protected",
  timeout: "took too long to convert",
};

function conversionLimitation(label: string, code: unknown) {
  const reason =
    (typeof code === "string" && CONVERSION_FAILURES[code]) ||
    "could not be converted";
  return `Metadata only. This ${label} ${reason}; do not claim to have read its contents.`;
}

async function extractText(
  bytes: Uint8Array,
  label: string,
  convert: SlackFileConverter,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    // The native conversion cannot be cancelled once started; the download cap
    // bounds how long it can keep running after this stops waiting.
    const markdown = await Promise.race([
      convert(bytes),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("timeout"), { code: "timeout" })),
          CONVERT_TIMEOUT_MS,
        );
      }),
    ]);
    if (markdown.trim() === "")
      return { content: null, limitation: conversionLimitation(label, "empty") };
    return markdown.length > CONVERTED_MAX_CHARS
      ? {
          content: markdown.slice(0, CONVERTED_MAX_CHARS),
          limitation: `Text truncated at ${CONVERTED_MAX_CHARS} characters.`,
        }
      : { content: markdown, limitation: null };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code: unknown }).code
        : undefined;
    return { content: null, limitation: conversionLimitation(label, code) };
  } finally {
    clearTimeout(timer);
  }
}

/** Inline content for a Slack file: text files as-is, PDF and Word documents as extracted Markdown. */
export async function readSlackFileContent(
  file: SlackObject,
  botToken: string,
  fetchImpl: typeof fetch,
  convert: SlackFileConverter = anydocConverter,
): Promise<{ content: string | null; limitation: string | null }> {
  const metadataOnly = { content: null, limitation: METADATA_ONLY };
  if (typeof file.url_private_download !== "string" || typeof file.size !== "number")
    return metadataOnly;
  const textual =
    typeof file.mimetype === "string" &&
    /^(text\/|application\/(json|xml|vnd\.slack-docs))/.test(file.mimetype);
  if (textual && file.size <= TEXT_MAX_BYTES) {
    const bytes = await download(file, botToken, fetchImpl, TEXT_MAX_BYTES);
    return bytes
      ? { content: bytes.toString("utf8"), limitation: null }
      : metadataOnly;
  }
  const kind = convertible(file);
  if (!kind) return metadataOnly;
  if (file.size > CONVERTIBLE_MAX_BYTES)
    return {
      content: null,
      limitation: `Metadata only. This ${kind.label} is over the ${CONVERTIBLE_MAX_BYTES / 1024 / 1024} MB read limit; do not claim to have read its contents.`,
    };
  const bytes = await download(file, botToken, fetchImpl, CONVERTIBLE_MAX_BYTES);
  return bytes ? extractText(bytes, kind.label, convert) : metadataOnly;
}
