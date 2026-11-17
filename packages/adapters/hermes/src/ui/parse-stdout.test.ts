import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { parseHermesStdoutLine } from "./parse-stdout.js";

const { parseStdoutLine } = createRequire(import.meta.url)("../../ui-parser.cjs");

const TS = "2026-06-29T12:00:00.000Z";

describe("parseHermesStdoutLine — ANSI stripping", () => {
  it("strips 24-bit foreground + background color CSI sequences", () => {
    const result = parseHermesStdoutLine(
      "\x1b[38;2;255;255;255;48;2;19;87;20m+r = curl(\"POST\", \"/api/issues/d7b08cc5/comments\",\x1b[0m",
      TS,
    );
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      for (const v of Object.values(entry)) {
        if (typeof v === "string") {
          expect(v).not.toMatch(/\x1b\[/);
        }
      }
    }
  });

  it("strips bold yellow CSI sequence from Hermes header", () => {
    const result = parseHermesStdoutLine("\x1b[1;38;2;255;215;0m- Hermes\x1b[0m", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("text", "- Hermes");
  });

  it("strips light text CSI sequence", () => {
    const result = parseHermesStdoutLine(
      "\x1b[38;2;255;248;220mAll done. Now let me verify.\x1b[0m",
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("text", "All done. Now let me verify.");
  });

  it("passes through clean text unchanged", () => {
    const result = parseHermesStdoutLine("Normal text without ANSI", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("text", "Normal text without ANSI");
  });

  it("strips multiple CSI sequences on a single line", () => {
    const result = parseHermesStdoutLine(
      "\x1b[38;2;255;255;255;48;2;19;87;20m+ \"priority\": \"highest\",\x1b[0m \x1b[38;2;255;255;255;48;2;19;87;20m+r = curl(\"PATCH\", ...\x1b[0m",
      TS,
    );
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      for (const v of Object.values(entry)) {
        if (typeof v === "string") {
          expect(v).not.toMatch(/\x1b\[/);
        }
      }
    }
  });

  it("still parses tool completion lines correctly after stripping", () => {
    const result = parseHermesStdoutLine("\u250a \u{1f50d} search \"pattern\" 0.5s", TS);
    expect(result.length).toBeGreaterThanOrEqual(2);
    const toolCall = result.find((e) => e.kind === "tool_call");
    expect(toolCall?.name).toBe("search");
  });

  it("still parses shell tool lines correctly after stripping", () => {
    const result = parseHermesStdoutLine("\u250a $ ls -la 0.3s", TS);
    const toolCall = result.find((e) => e.kind === "tool_call");
    expect(toolCall?.name).toBe("shell");
  });

  it("strips OSC title sequences", () => {
    const result = parseHermesStdoutLine("\x1b]0;Terminal Title\x07Actual content", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("text", "Actual content");
  });

  it("handles empty lines after ANSI stripping", () => {
    const result = parseHermesStdoutLine("\x1b[0m", TS);
    expect(result).toHaveLength(0);
  });
});

describe("parseHermesStdoutLine — tool-name auto-repair notice (TECH-8974)", () => {
  it("drops the Hermes tool-name auto-repair notice instead of rendering it as assistant text", () => {
    expect(
      parseHermesStdoutLine(
        "\u{1F527} Auto-repaired tool name: 'mcp__mem0_search' -> 'mem0_search'",
        TS,
      ),
    ).toEqual([]);
  });

  it("still renders ordinary prose that mentions auto-repair as assistant text", () => {
    const r = parseHermesStdoutLine("I auto-repaired the tool name for you.", TS);
    expect(r).toHaveLength(1);
    expect(r[0]).toHaveProperty("kind", "assistant");
  });

  it("ui-parser.cjs mirrors the TS parser for the auto-repair notice (TECH-8974)", () => {
    const line = "\u{1F527} Auto-repaired tool name: 'mcp__mem0_search' -> 'mem0_search'";
    expect(parseStdoutLine(line, TS)).toEqual([]);
    expect(parseStdoutLine(line, TS)).toEqual(parseHermesStdoutLine(line, TS));
  });
});
