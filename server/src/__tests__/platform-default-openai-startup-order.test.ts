import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("platform-default-openai startup capture order (M1 regression)", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const serverRoot = path.join(repoRoot, "server");
  const tsxCliCandidates = [
    path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs"),
    path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
    path.join(serverRoot, "node_modules/tsx/dist/cli.mjs"),
  ];
  const tsxCli = tsxCliCandidates.find((c) => existsSync(c)) ?? tsxCliCandidates[0];

  it("server/src/index.ts imports bootstrap-platform-default-key before other imports", () => {
    const indexPath = path.join(serverRoot, "src/index.ts");
    const content = readFileSync(indexPath, "utf8");
    const lines = content.split("\n");
    const nonCommentLines = lines.filter((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("///"));
    expect(nonCommentLines[0]).toBe('import "./bootstrap-platform-default-key.js";');
  });

  it("first bootstrap capture wins: deployment key is captured, and .env file cannot override or adopt", () => {
    const tmpDir = path.join(os.tmpdir(), `pcp-test-dotenv-startup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    const dotenvPath = path.join(tmpDir, ".env");

    const DEPLOYMENT_KEY = "sk-deployment-key-valid-ascii-length-1234567890";
    const FILE_KEY = "sk-file-key-from-dotenv-should-never-win-1234567890";

    // Write file key to .env
    writeFileSync(dotenvPath, `PAPERCLIP_DEFAULT_OPENAI_API_KEY=${FILE_KEY}\n`);

    const script = `
      import "${path.join(serverRoot, "src/bootstrap-platform-default-key.ts")}";
      import { readPlatformDefaultOpenAiKey, PAPERCLIP_DEFAULT_OPENAI_API_KEY } from "${path.join(serverRoot, "src/secrets/platform-default-openai-key.ts")}";
      import "${path.join(serverRoot, "src/config.ts")}";

      const captured = readPlatformDefaultOpenAiKey();
      const inEnv = process.env[PAPERCLIP_DEFAULT_OPENAI_API_KEY];

      console.log(JSON.stringify({ captured, inEnv }));
    `;

    try {
      const output = execFileSync(process.execPath, [tsxCli, "--input-type=module", "-e", script], {
        cwd: tmpDir,
        env: {
          ...process.env,
          PATH: process.env.PATH,
          HOME: tmpDir,
          PAPERCLIP_DEFAULT_OPENAI_API_KEY: DEPLOYMENT_KEY,
        },
        encoding: "utf8",
      });

      const result = JSON.parse(output.trim().split("\n").pop()!);
      // The initial deployment key was captured, NOT the file key
      expect(result.captured).toBe(DEPLOYMENT_KEY);
      expect(result.captured).not.toBe(FILE_KEY);
      // The raw env var is deleted from process.env
      expect(result.inEnv).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("file-sourced key is rejected when deployment key is absent (no late adoption)", () => {
    const tmpDir = path.join(os.tmpdir(), `pcp-test-dotenv-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    const dotenvPath = path.join(tmpDir, ".env");

    const FILE_KEY = "sk-file-key-attempting-late-adoption-1234567890";
    writeFileSync(dotenvPath, `PAPERCLIP_DEFAULT_OPENAI_API_KEY=${FILE_KEY}\n`);

    const script = `
      import "${path.join(serverRoot, "src/bootstrap-platform-default-key.ts")}";
      import { readPlatformDefaultOpenAiKey, PAPERCLIP_DEFAULT_OPENAI_API_KEY } from "${path.join(serverRoot, "src/secrets/platform-default-openai-key.ts")}";
      import "${path.join(serverRoot, "src/config.ts")}";

      const captured = readPlatformDefaultOpenAiKey();
      const inEnv = process.env[PAPERCLIP_DEFAULT_OPENAI_API_KEY];

      console.log(JSON.stringify({ captured, inEnv }));
    `;

    try {
      // Run with PAPERCLIP_DEFAULT_OPENAI_API_KEY absent from process.env
      const cleanEnv = { ...process.env, PATH: process.env.PATH, HOME: tmpDir };
      delete cleanEnv.PAPERCLIP_DEFAULT_OPENAI_API_KEY;

      const output = execFileSync(process.execPath, [tsxCli, "--input-type=module", "-e", script], {
        cwd: tmpDir,
        env: cleanEnv,
        encoding: "utf8",
      });

      const result = JSON.parse(output.trim().split("\n").pop()!);
      // Captured must remain null (not configured), NOT adopted from .env
      expect(result.captured).toBeNull();
      // And the key must be scrubbed from process.env
      expect(result.inEnv).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
