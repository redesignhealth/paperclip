import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSlackFileContent } from "./slack-file-content.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/slack-files/${name}`, import.meta.url));
const PDF = "application/pdf";
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function slackFile(bytes: Uint8Array | null, extra: Record<string, unknown> = {}) {
  return {
    id: "F1",
    mimetype: PDF,
    filetype: "pdf",
    size: bytes?.length ?? 0,
    url_private_download: "https://files.slack.com/files-pri/T1-F1/resume.pdf",
    ...extra,
  };
}
const serve = (bytes: Uint8Array) =>
  vi.fn(async () => new Response(bytes as BodyInit)) as unknown as typeof fetch;

afterEach(() => vi.useRealTimers());

describe("readSlackFileContent with the real converter", () => {
  it("extracts the text of a PDF", async () => {
    const bytes = fixture("resume.pdf");
    const fetchImpl = serve(bytes);
    const result = await readSlackFileContent(slackFile(bytes), "xoxb-test", fetchImpl);
    expect(result.limitation).toBeNull();
    expect(result.content).toContain("Jane Example");
    expect(result.content).toContain("Acme Health");
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "files.slack.com" }),
      expect.objectContaining({
        redirect: "error",
        headers: { authorization: "Bearer xoxb-test" },
      }),
    );
  });

  it("extracts the text of a Word document", async () => {
    const bytes = fixture("resume.docx");
    const result = await readSlackFileContent(
      slackFile(bytes, { mimetype: DOCX, filetype: "docx" }),
      "xoxb-test",
      serve(bytes),
    );
    expect(result.limitation).toBeNull();
    expect(result.content).toContain("Example University");
  });

  it("reports a scanned PDF as metadata only instead of failing", async () => {
    const bytes = fixture("scanned.pdf");
    const result = await readSlackFileContent(slackFile(bytes), "xoxb-test", serve(bytes));
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(/no text layer \(scanned\)/);
    expect(result.limitation).toMatch(/do not claim to have read/);
  });

  it("reports bytes that are not the advertised document as metadata only", async () => {
    const bytes = Buffer.from("this is not a pdf");
    const result = await readSlackFileContent(slackFile(bytes), "xoxb-test", serve(bytes));
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(/could not be converted/);
  });
});

describe("readSlackFileContent conversion limits", () => {
  const bytes = Buffer.from("%PDF-1.4 stand-in");

  it.each([
    ["needsOcr", /no text layer/],
    ["encrypted", /encrypted or password-protected/],
    ["resourceLimit", /could not be converted/],
    ["malformed", /could not be converted/],
  ])("maps the %s conversion error to a metadata-only result", async (code, pattern) => {
    const convert = vi.fn().mockRejectedValue(Object.assign(new Error("detail"), { code }));
    const result = await readSlackFileContent(slackFile(bytes), "t", serve(bytes), convert);
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(pattern);
    expect(result.limitation).not.toContain("detail");
  });

  it("treats a converter that cannot load as metadata only", async () => {
    const convert = vi.fn().mockRejectedValue(new Error("native binary missing"));
    const result = await readSlackFileContent(slackFile(bytes), "t", serve(bytes), convert);
    expect(result).toEqual({
      content: null,
      limitation: expect.stringContaining("could not be converted"),
    });
  });

  it("reports a document with no extractable text", async () => {
    const result = await readSlackFileContent(
      slackFile(bytes),
      "t",
      serve(bytes),
      async () => "  \n",
    );
    expect(result.limitation).toMatch(/no extractable text/);
  });

  it("truncates very long text and says so", async () => {
    const result = await readSlackFileContent(
      slackFile(bytes),
      "t",
      serve(bytes),
      async () => "x".repeat(250_000),
    );
    expect(result.content).toHaveLength(200_000);
    expect(result.limitation).toBe("Text truncated at 200000 characters.");
  });

  it("stops waiting for a conversion that does not finish", async () => {
    vi.useFakeTimers();
    const pending = readSlackFileContent(
      slackFile(bytes),
      "t",
      serve(bytes),
      () => new Promise<string>(() => {}),
    );
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(pending).resolves.toEqual({
      content: null,
      limitation: expect.stringContaining("took too long"),
    });
  });

  it("does not download a document over the size limit", async () => {
    const fetchImpl = serve(bytes);
    const convert = vi.fn();
    const result = await readSlackFileContent(
      slackFile(bytes, { size: 6 * 1024 * 1024 }),
      "t",
      fetchImpl,
      convert,
    );
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(/over the 5 MB read limit/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it("rejects a download larger than the limit even when Slack reports a small size", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    await expect(
      readSlackFileContent(slackFile(bytes), "t", serve(big), vi.fn()),
    ).rejects.toThrow("Slack file exceeds the read limit");
  });
});

describe("readSlackFileContent download rules", () => {
  it("still returns small text files as text", async () => {
    const bytes = Buffer.from("hello notes");
    const convert = vi.fn();
    const result = await readSlackFileContent(
      slackFile(bytes, { mimetype: "text/plain", filetype: "text" }),
      "t",
      serve(bytes),
      convert,
    );
    expect(result).toEqual({ content: "hello notes", limitation: null });
    expect(convert).not.toHaveBeenCalled();
  });

  it("returns metadata only for other file types without downloading", async () => {
    const fetchImpl = serve(Buffer.from("x"));
    const result = await readSlackFileContent(
      slackFile(Buffer.from("x"), { mimetype: "image/png", filetype: "png" }),
      "t",
      fetchImpl,
    );
    expect(result.content).toBeNull();
    expect(result.limitation).toMatch(/^Metadata only\./);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "http://files.slack.com/f.pdf",
    "https://evil.example.com/f.pdf",
    "https://files.slack.com:8443/f.pdf",
    "https://user:pw@files.slack.com/f.pdf",
  ])("refuses to download from %s", async (url) => {
    const fetchImpl = serve(Buffer.from("x"));
    await expect(
      readSlackFileContent(
        slackFile(Buffer.from("x"), { url_private_download: url }),
        "t",
        fetchImpl,
        vi.fn(),
      ),
    ).rejects.toThrow("Unsupported Slack file download destination");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when Slack refuses the download", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(
      readSlackFileContent(slackFile(Buffer.from("x")), "t", fetchImpl, vi.fn()),
    ).rejects.toThrow("Slack file content is unavailable");
  });
});
