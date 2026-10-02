import { describe, expect, it } from "vitest";
import { pickPaperclipLocationEnv } from "./execute.js";

describe("pickPaperclipLocationEnv (TECH-7095)", () => {
  it("keeps only the non-secret instance location variables", () => {
    const picked = pickPaperclipLocationEnv({
      PAPERCLIP_HOME: "/data/paperclip",
      PAPERCLIP_INSTANCE_ID: "default",
      OPENAI_API_KEY: "sk-tech7095-host",
      CODEX_HOME: "/root/.codex",
      DATABASE_URL: "postgres://u:tech7095@h/db",
      HOME: "/root",
    } as NodeJS.ProcessEnv);
    expect(picked).toEqual({ PAPERCLIP_HOME: "/data/paperclip", PAPERCLIP_INSTANCE_ID: "default" });
    expect(JSON.stringify(picked)).not.toContain("tech7095");
  });

  it("omits missing or empty values", () => {
    expect(pickPaperclipLocationEnv({ PAPERCLIP_HOME: "", OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv)).toEqual({});
  });
});
