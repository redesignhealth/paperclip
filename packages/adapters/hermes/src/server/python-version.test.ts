import { describe, expect, it } from "vitest";

import { checkPython, evaluatePythonVersion } from "./test.js";

describe("Hermes adapter checkPython version enforcement", () => {
  it("rejects Python 3.10 with hermes_python_old as a warning without duplicate Python prefix", () => {
    const result = evaluatePythonVersion("Python 3.10.12");
    expect(result).not.toBeNull();
    expect(result?.level).toBe("warn");
    expect(result?.code).toBe("hermes_python_old");
    expect(result?.message).toBe("Python 3.10.12 found - Hermes requires Python >=3.11,<3.14");
    expect(result?.message).not.toContain("Python Python");

    // Also rejects two-component Python 3.10
    const twoCompResult = evaluatePythonVersion("Python 3.10");
    expect(twoCompResult?.code).toBe("hermes_python_old");
    expect(twoCompResult?.message).toBe("Python 3.10 found - Hermes requires Python >=3.11,<3.14");
  });

  it("accepts Python 3.11 (both 3-component and 2-component)", () => {
    expect(evaluatePythonVersion("Python 3.11.9")).toBeNull();
    expect(evaluatePythonVersion("Python 3.11")).toBeNull();
  });

  it("accepts Python 3.12 (both 3-component and 2-component)", () => {
    expect(evaluatePythonVersion("Python 3.12.4")).toBeNull();
    expect(evaluatePythonVersion("Python 3.12")).toBeNull();
  });

  it("accepts Python 3.13 (both 3-component and 2-component and prereleases)", () => {
    expect(evaluatePythonVersion("Python 3.13.5")).toBeNull();
    expect(evaluatePythonVersion("Python 3.13")).toBeNull();
    expect(evaluatePythonVersion("Python 3.13.0rc1")).toBeNull();
    expect(evaluatePythonVersion("Python 3.13rc1")).toBeNull();
    expect(evaluatePythonVersion("Python 3.13b2")).toBeNull();
    expect(evaluatePythonVersion("Python 3.13+local")).toBeNull();
  });

  it("rejects Python 3.14 with hermes_python_unsupported as a warning", () => {
    const result = evaluatePythonVersion("Python 3.14.0a1");
    expect(result).not.toBeNull();
    expect(result?.level).toBe("warn");
    expect(result?.code).toBe("hermes_python_unsupported");
    expect(result?.message).toBe("Python 3.14.0a1 found - Hermes requires Python >=3.11,<3.14");
    expect(result?.message).not.toContain("Python Python");

    // Also rejects two-component Python 3.14
    const twoCompResult = evaluatePythonVersion("Python 3.14");
    expect(twoCompResult?.code).toBe("hermes_python_unsupported");
    expect(twoCompResult?.message).toBe("Python 3.14 found - Hermes requires Python >=3.11,<3.14");
  });

  it("rejects malformed output and invalid suffixes like Python 3.12abc with hermes_python_malformed", () => {
    const emptyResult = evaluatePythonVersion("");
    expect(emptyResult).not.toBeNull();
    expect(emptyResult?.level).toBe("warn");
    expect(emptyResult?.code).toBe("hermes_python_malformed");

    const nonVersionResult = evaluatePythonVersion("not a python binary or version string");
    expect(nonVersionResult).not.toBeNull();
    expect(nonVersionResult?.level).toBe("warn");
    expect(nonVersionResult?.code).toBe("hermes_python_malformed");

    const invalidSuffixResult = evaluatePythonVersion("Python 3.12abc");
    expect(invalidSuffixResult).not.toBeNull();
    expect(invalidSuffixResult?.level).toBe("warn");
    expect(invalidSuffixResult?.code).toBe("hermes_python_malformed");

    const prefixedResult = evaluatePythonVersion("WARNING: Python 3.13.2");
    expect(prefixedResult?.code).toBe("hermes_python_malformed");

    const suffixedResult = evaluatePythonVersion("Python 3.13.2 trailing-invalid-token");
    expect(suffixedResult?.code).toBe("hermes_python_malformed");
  });

  it("parses Python version from multi-line output with banners/warnings and selects last matching line", () => {
    const multiLineWithWarnings = [
      "WARNING: could not find platform independent libraries <prefix>",
      "Python 3.13.2",
      "Additional startup banner line",
    ].join("\n");
    expect(evaluatePythonVersion(multiLineWithWarnings)).toBeNull();

    const multiLineMultipleVersions = [
      "Python 3.10.12",
      "Notice: fallback probe executed",
      "Python 3.12.8",
    ].join("\n");
    // Should prefer the last matching line (Python 3.12.8), which is valid and accepted
    expect(evaluatePythonVersion(multiLineMultipleVersions)).toBeNull();
  });

  it("rejects Python 2.x and Python 4.x appropriately with warnings", () => {
    const py2Result = evaluatePythonVersion("Python 2.7.18");
    expect(py2Result?.code).toBe("hermes_python_old");
    expect(py2Result?.level).toBe("warn");

    const py4Result = evaluatePythonVersion("Python 4.0.0");
    expect(py4Result?.code).toBe("hermes_python_unsupported");
    expect(py4Result?.level).toBe("warn");
  });

  it("handles version emitted on stdout primary happy-path", async () => {
    const stdoutExec = async () => ({ stdout: "Python 3.13.5\n", stderr: "" });
    const result = await checkPython("python3", stdoutExec as any);
    expect(result).toBeNull();
  });

  it("handles version emitted on stderr when stdout is empty", async () => {
    const stderrExec = async () => ({ stdout: "", stderr: "Python 3.13.2\n" });
    const result = await checkPython("python3", stderrExec as any);
    expect(result).toBeNull();
  });

  it("distinguishes missing command (ENOENT) from spawn failure (non-ENOENT) with warn level", async () => {
    const missingExec = async () => {
      const err = new Error("ENOENT");
      (err as any).code = "ENOENT";
      throw err;
    };
    const missingResult = await checkPython("nonexistent_python", missingExec as any);
    expect(missingResult?.code).toBe("hermes_python_missing");
    expect(missingResult?.level).toBe("warn");

    const spawnFailExec = async () => {
      const err = new Error("Permission denied");
      (err as any).code = "EACCES";
      throw err;
    };
    const spawnFailResult = await checkPython("restricted_python", spawnFailExec as any);
    expect(spawnFailResult?.code).toBe("hermes_python_spawn_failed");
    expect(spawnFailResult?.level).toBe("warn");
  });
});
