import { describe, expect, it } from "vitest";

import { checkPython, evaluatePythonVersion } from "./test.js";

describe("Hermes adapter checkPython version enforcement", () => {
  it("rejects Python 3.10 with hermes_python_old", () => {
    const result = evaluatePythonVersion("Python 3.10.12");
    expect(result).not.toBeNull();
    expect(result?.level).toBe("error");
    expect(result?.code).toBe("hermes_python_old");
    expect(result?.message).toContain("requires Python >=3.11,<3.14");
  });

  it("accepts Python 3.11", () => {
    const result = evaluatePythonVersion("Python 3.11.9");
    expect(result).toBeNull();
  });

  it("accepts Python 3.13 (Docker production version)", () => {
    const result = evaluatePythonVersion("Python 3.13.5");
    expect(result).toBeNull();
  });

  it("rejects Python 3.14 with hermes_python_unsupported", () => {
    const result = evaluatePythonVersion("Python 3.14.0a1");
    expect(result).not.toBeNull();
    expect(result?.level).toBe("error");
    expect(result?.code).toBe("hermes_python_unsupported");
    expect(result?.message).toContain("requires Python >=3.11,<3.14");
  });

  it("rejects malformed output with hermes_python_malformed", () => {
    const emptyResult = evaluatePythonVersion("");
    expect(emptyResult).not.toBeNull();
    expect(emptyResult?.level).toBe("error");
    expect(emptyResult?.code).toBe("hermes_python_malformed");

    const nonVersionResult = evaluatePythonVersion("not a python binary or version string");
    expect(nonVersionResult).not.toBeNull();
    expect(nonVersionResult?.level).toBe("error");
    expect(nonVersionResult?.code).toBe("hermes_python_malformed");

    const prefixedResult = evaluatePythonVersion("WARNING: Python 3.13.2");
    expect(prefixedResult?.code).toBe("hermes_python_malformed");

    const suffixedResult = evaluatePythonVersion("Python 3.13.2 trailing-invalid-token");
    expect(suffixedResult?.code).toBe("hermes_python_malformed");
  });

  it("rejects Python 2.x and Python 4.x appropriately", () => {
    const py2Result = evaluatePythonVersion("Python 2.7.18");
    expect(py2Result?.code).toBe("hermes_python_old");

    const py4Result = evaluatePythonVersion("Python 4.0.0");
    expect(py4Result?.code).toBe("hermes_python_unsupported");
  });

  it("handles version emitted on stderr when stdout is empty", async () => {
    const stderrExec = async () => ({ stdout: "", stderr: "Python 3.13.2\n" });
    const result = await checkPython("python3", stderrExec as any);
    expect(result).toBeNull();
  });

  it("distinguishes missing command (ENOENT) from spawn failure (non-ENOENT)", async () => {
    const missingExec = async () => {
      const err = new Error("ENOENT");
      (err as any).code = "ENOENT";
      throw err;
    };
    const missingResult = await checkPython("nonexistent_python", missingExec as any);
    expect(missingResult?.code).toBe("hermes_python_missing");
    expect(missingResult?.level).toBe("error");

    const spawnFailExec = async () => {
      const err = new Error("Permission denied");
      (err as any).code = "EACCES";
      throw err;
    };
    const spawnFailResult = await checkPython("restricted_python", spawnFailExec as any);
    expect(spawnFailResult?.code).toBe("hermes_python_spawn_failed");
    expect(spawnFailResult?.level).toBe("error");
  });
});
