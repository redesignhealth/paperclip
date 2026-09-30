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
  });

  it("rejects Python 2.x and Python 4.x appropriately", () => {
    const py2Result = evaluatePythonVersion("Python 2.7.18");
    expect(py2Result?.code).toBe("hermes_python_old");

    const py4Result = evaluatePythonVersion("Python 4.0.0");
    expect(py4Result?.code).toBe("hermes_python_unsupported");
  });

  it("checkPython executes command and parses version", async () => {
    const fakeExec = async () => ({ stdout: "Python 3.13.2\n", stderr: "" });
    const result = await checkPython("python3", fakeExec as any);
    expect(result).toBeNull();

    const oldExec = async () => ({ stdout: "Python 3.10.8\n", stderr: "" });
    const oldResult = await checkPython("python3", oldExec as any);
    expect(oldResult?.code).toBe("hermes_python_old");

    const failExec = async () => {
      const err = new Error("ENOENT");
      (err as any).code = "ENOENT";
      throw err;
    };
    const missingResult = await checkPython("nonexistent_python", failExec as any);
    expect(missingResult?.code).toBe("hermes_python_missing");
  });
});
