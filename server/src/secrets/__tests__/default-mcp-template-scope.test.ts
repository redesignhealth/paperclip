import { beforeEach, describe, expect, it } from "vitest";
import * as sharedEnv from "@paperclipai/shared/default-mcp-template-env";
import {
  DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
  __resetDefaultMcpTemplateScopeForTests,
  captureDefaultMcpTemplateScope,
  isCompanyInDefaultMcpTemplateScope,
  parseDefaultMcpTemplateScope,
  readDefaultMcpTemplateScope,
} from "../default-mcp-template-scope.js";

const A = "0b2c7c1e-4f0a-4a4e-9b3e-0d6f0a3c9a11";
const B = "1c3d8d2f-5a1b-4b5f-8c4f-1e7a1b4d0b22";

describe("default MCP template rollout scope (TECH-7271)", () => {
  beforeEach(() => __resetDefaultMcpTemplateScopeForTests());

  it("unset means every company; empty means none (staged)", () => {
    expect(parseDefaultMcpTemplateScope(undefined)).toEqual({ mode: "all" });
    expect(parseDefaultMcpTemplateScope(null)).toEqual({ mode: "all" });
    expect(parseDefaultMcpTemplateScope("")).toEqual({ mode: "none" });
    expect(parseDefaultMcpTemplateScope("   ")).toEqual({ mode: "none" });
  });

  it("a closed UUID list is an allowlist: trimmed, lowercased, de-duplicated", () => {
    const scope = parseDefaultMcpTemplateScope(` ${A.toUpperCase()} , ${B},${A} `);
    expect(scope).toEqual({ mode: "allowlist", companyIds: [A, B] });
    expect(isCompanyInDefaultMcpTemplateScope(scope, A.toUpperCase())).toBe(true);
    expect(isCompanyInDefaultMcpTemplateScope(scope, "2d4e9e30-6b2c-4c60-9d50-2f8b2c5e1c33")).toBe(false);
    expect(isCompanyInDefaultMcpTemplateScope({ mode: "all" }, A)).toBe(true);
    expect(isCompanyInDefaultMcpTemplateScope({ mode: "none" }, A)).toBe(false);
  });

  it.each(["*", "all", "ALL", "true", "1", "not-a-uuid", `${A},*`, `${A},`, `,${A}`, `${A},,${B}`, `${A} ${B}`, `${A};${B}`, `${A},nope`])(
    "malformed %j fails closed to NONE and never widens",
    (raw) => {
      expect(parseDefaultMcpTemplateScope(raw)).toEqual({ mode: "none" });
    },
  );

  it("the first capture is the only source: later environment changes are ignored and nothing reads process.env live", () => {
    expect(readDefaultMcpTemplateScope()).toEqual({ mode: "none" }); // before any capture: fail closed
    expect(captureDefaultMcpTemplateScope({})).toEqual({ mode: "all" });
    expect(captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: A })).toEqual({ mode: "all" });
    const previous = process.env[DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV];
    process.env[DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV] = "";
    try {
      expect(readDefaultMcpTemplateScope()).toEqual({ mode: "all" });
    } finally {
      if (previous === undefined) delete process.env[DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV];
      else process.env[DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV] = previous;
    }
    __resetDefaultMcpTemplateScopeForTests();
    expect(captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: `${A},${B}` })).toEqual({ mode: "allowlist", companyIds: [A, B] });
    expect(Object.isFrozen(readDefaultMcpTemplateScope())).toBe(true);
  });

  it("the canonical env name is the shared constant the CLI reserves", () => {
    expect(DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV).toBe(sharedEnv.DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV);
    expect(DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV).toBe("PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS");
    expect([...sharedEnv.DEFAULT_MCP_TEMPLATE_ENV_KEYS]).toEqual([DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]);
    expect(Object.isFrozen(sharedEnv.DEFAULT_MCP_TEMPLATE_ENV_KEYS)).toBe(true);
  });
});
