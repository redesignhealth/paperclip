import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TECH-7089 G2 driver. Runs the real-Hermes host-isolation test (packages/adapters/hermes/src/server/
 * execute.host-isolation.real-hermes.test.ts) inside an already-built PRODUCTION image, as the
 * unprivileged `node` user. Only the test file is mounted; the code under test is whatever the image
 * contains, so a pass is evidence about the image, not about the working tree.
 *
 * Gated: PAPERCLIP_RUN_DOCKER_HERMES_G2=true and PAPERCLIP_G2_IMAGE=<production image tag>.
 *   docker build --target production -t paperclip:g2 .
 *   PAPERCLIP_RUN_DOCKER_HERMES_G2=true PAPERCLIP_G2_IMAGE=paperclip:g2 pnpm vitest run server/src/__tests__/docker-hermes-isolation.test.ts
 */
const image = process.env.PAPERCLIP_G2_IMAGE;
const enabled = process.env.PAPERCLIP_RUN_DOCKER_HERMES_G2 === "true";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_REL = "packages/adapters/hermes/src/server/execute.host-isolation.real-hermes.test.ts";

describe.skipIf(!enabled)("G2: isolated Hermes in the production image (PAPERCLIP_RUN_DOCKER_HERMES_G2=true)", () => {
  it("keeps ambient host secrets and host ~/.hermes away from a real Hermes run", () => {
    expect(image, "set PAPERCLIP_G2_IMAGE to a production image tag").toBeTruthy();
    const result = spawnSync(
      "docker",
      [
        "run", "--rm", "--entrypoint", "gosu",
        "-v", `${path.join(repoRoot, TEST_REL)}:/app/${TEST_REL}:ro`,
        "-e", "PAPERCLIP_RUN_HERMES_G2=true",
        "-w", "/app/packages/adapters/hermes",
        image!, "node", "/app/node_modules/.bin/vitest", "run", TEST_REL.replace("packages/adapters/hermes/", ""),
      ],
      { encoding: "utf8", timeout: 300_000 },
    );
    expect(result.status, `docker exit status=${result.status} signal=${result.signal} error=${result.error?.message ?? "none"}\n${result.stdout}\n${result.stderr}`).toBe(0);
    // Vitest colours its summary inside the container; strip ANSI before matching.
    const plain = (result.stdout + result.stderr).replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/Tests\s+\d+ passed/);
    expect(plain).not.toMatch(/\d+ (failed|skipped)/);
  }, 320_000);
});
