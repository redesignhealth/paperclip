import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetPiModelsCacheForTests } from "./models.js";
import { testEnvironment } from "./test.js";

// Lists the model only when the managed models.json exists and the key env var is set.
const FAKE_PI = `#!/bin/sh
if [ "$1" = "--list-models" ]; then
  printf 'provider  model\\n'
  if [ -f "$PI_CODING_AGENT_DIR/models.json" ] && [ -n "$RAMP_ROUTER_API_KEY" ] && grep -q gpt-6-luna "$PI_CODING_AGENT_DIR/models.json"; then
    printf 'ramp-router  gpt-6-luna\\n'
  fi
  exit 0
fi
printf '{"type":"agent_end","success":true,"messages":[{"role":"assistant","content":[{"type":"text","text":"hello"}]}]}\\n'
`;

const providers = JSON.stringify({
  "ramp-router": { baseUrl: "https://api.router.com/v1", api: "openai-responses", apiKey: "RAMP_ROUTER_API_KEY", models: [{ id: "gpt-6-luna" }] },
});

let dir: string | undefined;
afterEach(async () => {
  resetPiModelsCacheForTests();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function run(env: Record<string, string>) {
  dir = await mkdtemp(join(tmpdir(), "paperclip-pi-test-env-"));
  const command = join(dir, "pi");
  await writeFile(command, FAKE_PI);
  await chmod(command, 0o755);
  return testEnvironment({
    companyId: "c",
    adapterType: "pi_local",
    config: { command, cwd: dir, model: "ramp-router/gpt-6-luna", env },
  });
}

const codes = (r: { checks: { code: string }[] }) => r.checks.map((c) => c.code);

describe("pi testEnvironment with PAPERCLIP_PI_PROVIDERS", () => {
  it("finds provider models and passes the hello probe through the managed config", async () => {
    const result = await run({ PAPERCLIP_PI_PROVIDERS: providers, RAMP_ROUTER_API_KEY: "sk-test" });
    expect(codes(result)).toContain("pi_model_configured");
    expect(codes(result)).toContain("pi_hello_probe_passed");
    expect(codes(result)).not.toContain("pi_model_not_found");
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });

  it("warns about the missing key env var by name", async () => {
    const result = await run({ PAPERCLIP_PI_PROVIDERS: providers });
    const check = result.checks.find((c) => c.code === "pi_provider_config" && c.level === "warn");
    expect(check?.message).toContain("RAMP_ROUTER_API_KEY");
    expect(codes(result)).toContain("pi_model_not_found");
  });
});
