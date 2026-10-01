import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AI_CONNECTION_REQUIRED_CHECK_CODE,
  buildAiConnectionRequiredCheck,
  buildIsolatedProbeEnv,
  hasChildVisibleCredential,
  maybeReportAiConnectionRequired,
  readinessMayUseHostAuth,
  withIsolatedProbeHome,
} from "./readiness-auth.js";

const SENTINEL = "tech7095-readiness-sentinel";

describe("readiness-auth (TECH-7095)", () => {
  it("allows host auth only outside enforced managed_only", () => {
    expect(readinessMayUseHostAuth("managed_only")).toBe(false);
    expect(readinessMayUseHostAuth("managed_only_report")).toBe(true);
    expect(readinessMayUseHostAuth("host_fallback")).toBe(true);
  });

  it("treats a managed connection or an explicit binding as child-visible", () => {
    expect(hasChildVisibleCredential({ managedAiConnection: { method: "api_key" } }, [])).toBe(true);
    expect(hasChildVisibleCredential({ env: { XAI_API_KEY: "k" } }, ["XAI_API_KEY"])).toBe(true);
    expect(hasChildVisibleCredential({ env: { XAI_API_KEY: "" } }, ["XAI_API_KEY"])).toBe(false);
    expect(hasChildVisibleCredential({}, ["XAI_API_KEY"])).toBe(false);
  });

  it("builds a static error check under enforcement and info under report", () => {
    const enforced = buildAiConnectionRequiredCheck("grok_local", "managed_only");
    expect(enforced).toMatchObject({ code: AI_CONNECTION_REQUIRED_CHECK_CODE, level: "error" });
    expect(buildAiConnectionRequiredCheck("grok_local", "managed_only_report").level).toBe("info");
    expect(maybeReportAiConnectionRequired("x", {}, ["K"], "managed_only_report")?.level).toBe("info");
    expect(maybeReportAiConnectionRequired("x", {}, ["K"], "managed_only")).toBeNull();
    expect(maybeReportAiConnectionRequired("x", {}, ["K"], "host_fallback")).toBeNull();
    expect(maybeReportAiConnectionRequired("x", { env: { K: "v" } }, ["K"], "managed_only_report")).toBeNull();
  });

  it("isolated probe env carries only the allowlisted base, the caller env and the probe home", async () => {
    let probeHome = "";
    await withIsolatedProbeHome(async (home) => {
      probeHome = home.path;
      const env = buildIsolatedProbeEnv(
        { EXPLICIT_KEY: "explicit", HOME: "/caller/home" },
        home,
        { PATH: "/usr/bin", HOME: "/host/home", OPENAI_API_KEY: SENTINEL, DATABASE_URL: SENTINEL },
      );
      expect(env.PATH).toBe("/usr/bin");
      expect(env.EXPLICIT_KEY).toBe("explicit");
      expect(env.HOME).toBe(home.path);
      expect(env.XDG_CONFIG_HOME?.startsWith(home.path)).toBe(true);
      expect(JSON.stringify(env)).not.toContain(SENTINEL);
      expect(JSON.stringify(env)).not.toContain("/host/home");
      await expect(stat(home.path)).resolves.toBeTruthy();
    });
    await expect(stat(probeHome)).rejects.toThrow();
  });
});
