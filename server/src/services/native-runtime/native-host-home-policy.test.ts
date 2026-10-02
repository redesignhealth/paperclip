import { describe, expect, it } from "vitest";
import {
  nativeManagedSourceCodexHome,
  withoutHostHomeUnderManagedOnly,
} from "./native-host-home-policy.js";

const HOST = {
  PATH: "/usr/bin",
  HOME: "/Users/server",
  USERPROFILE: "/Users/server",
  CODEX_HOME: "/Users/server/.codex",
  CLAUDE_CONFIG_DIR: "/Users/server/.claude",
  XDG_CONFIG_HOME: "/Users/server/.config",
  XDG_RUNTIME_DIR: "/run/user/501",
  TMPDIR: "/tmp",
};

describe("native host home policy (TECH-7095)", () => {
  it("strips host home/config locations under managed_only", () => {
    expect(withoutHostHomeUnderManagedOnly(HOST, "managed_only")).toEqual({
      PATH: "/usr/bin",
      TMPDIR: "/tmp",
    });
  });

  it("keeps the legacy host projection outside the enforced policy", () => {
    expect(withoutHostHomeUnderManagedOnly(HOST, "host_fallback")).toBe(HOST);
    expect(withoutHostHomeUnderManagedOnly(HOST, "managed_only_report")).toBe(HOST);
  });

  it("only an explicit run-env CODEX_HOME seeds the runner; never $HOME/.codex", () => {
    expect(nativeManagedSourceCodexHome({ HOME: "/Users/server" })).toBeNull();
    expect(nativeManagedSourceCodexHome(undefined)).toBeNull();
    expect(nativeManagedSourceCodexHome({ CODEX_HOME: " /tmp/run/provider " })).toBe("/tmp/run/provider");
  });
});
