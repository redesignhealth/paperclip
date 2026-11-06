import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    delete process.env.PAPERCLIP_PI_PROVIDERS;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });

  it("does not embed the model catalogue when the configured model is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-pi-models-"));
    const command = join(directory, "pi");
    const modelIds = Array.from({ length: 13 }, (_, index) => `provider/model-${index}`);
    await writeFile(
      command,
      `#!/bin/sh\nprintf 'provider  model\\n';\n${modelIds
        .map((id) => {
          const [provider, model] = id.split("/");
          return `printf '${provider}  ${model}\\n'`;
        })
        .join(";\n")}\n`,
    );
    await chmod(command, 0o755);

    try {
      await expect(
        ensurePiModelConfiguredAndAvailable({
          command,
          model: "provider/missing",
        }),
      ).rejects.toMatchObject({
        message:
          "Configured Pi model is unavailable: provider/missing. 13 models are available; list them with `pi --list-models`.",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("merges, de-duplicates and sorts models from PAPERCLIP_PI_PROVIDERS with discovery output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-pi-models-"));
    const command = join(directory, "pi");
    await writeFile(command, "#!/bin/sh\nprintf 'provider  model\\nramp-router  gpt-6-luna\\nxai  grok-4\\n'\n");
    await chmod(command, 0o755);
    process.env.PAPERCLIP_PI_COMMAND = command;
    process.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify({
      "ramp-router": { models: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }] },
      "ramp-router-anthropic": { models: [{ id: "claude-sonnet-5-5" }] },
      broken: { models: "nope" },
    });
    try {
      expect((await listPiModels()).map((m) => m.id)).toEqual([
        "ramp-router-anthropic/claude-sonnet-5-5",
        "ramp-router/gpt-6-luna",
        "ramp-router/gpt-6.1-sol",
        "xai/grok-4",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lists configured provider models when discovery fails, and ignores invalid provider JSON", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    process.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify({ r: { models: [{ id: "m" }] } });
    expect((await listPiModels()).map((m) => m.id)).toEqual(["r/m"]);
    resetPiModelsCacheForTests();
    process.env.PAPERCLIP_PI_PROVIDERS = "not json";
    await expect(listPiModels()).resolves.toEqual([]);
  });
});
