/**
 * TECH-7895: Ramp Router readiness, exercised against real Python Hermes installations so the
 * registry probe is tested across its actual process boundary (launcher → interpreter → imports).
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isRemoteExecutionTarget,
  isRouterEndpointOverrideEnvName,
  isRouterProvider,
  normalizeRouterLaunchPath,
  probeHermesRouterSupport,
  readRouterApiKey,
  resolveHermesPythonLauncher,
  resolveRouterLaunchPlan,
  routerEnvNamesToStrip,
} from "./router-readiness.js";
import {
  UPSTREAM_ROUTER_AUTH,
  UPSTREAM_ROUTER_PROFILE,
  consoleLauncher,
  createFakeHermesInstall,
  realPython,
  writeHermesPackages,
} from "./test-support/fake-hermes-install.js";

const execFileAsync = promisify(execFile);
let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-router-probe-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const launchEnv = (extra: Record<string, string> = {}) => ({ PATH: "/usr/bin:/bin", ...extra });

async function fakeInterpreter(name: string, body: string): Promise<string> {
  const binDir = path.join(dir, `interp-${name}`);
  await fs.mkdir(binDir, { recursive: true });
  const python = path.join(binDir, "python3");
  await fs.writeFile(python, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const command = path.join(binDir, "hermes");
  await fs.writeFile(command, consoleLauncher(python), { mode: 0o755 });
  return command;
}

describe("probeHermesRouterSupport (registry probe)", () => {
  it("verifies the native Router provider for an upstream-shaped installation (legacy alias allowed)", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "ok"));
    await expect(probeHermesRouterSupport({ command: install.command, env: launchEnv() })).resolves.toEqual({
      supported: true,
    });
  });

  it("never imports hermes_cli.main", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "ok"));
    await probeHermesRouterSupport({ command: install.command, env: launchEnv() });
    await expect(fs.access(path.join(install.srcRoot, "hermes_cli", ".main-imported"))).rejects.toThrow();
  });

  it("does not use help output: identical upstream help, different registries, different results", async () => {
    const good = await createFakeHermesInstall(path.join(dir, "good"));
    const old = await createFakeHermesInstall(path.join(dir, "old"), { profile: null, auth: null });
    const goodHelp = (await execFileAsync(good.command, ["chat", "--help"])).stdout;
    const oldHelp = (await execFileAsync(old.command, ["chat", "--help"])).stdout;
    expect(goodHelp).toBe(oldHelp);
    expect(goodHelp).not.toMatch(/\brouter\b/);
    await expect(probeHermesRouterSupport({ command: good.command, env: launchEnv() })).resolves.toEqual({ supported: true });
    await expect(probeHermesRouterSupport({ command: old.command, env: launchEnv() })).resolves.toMatchObject({
      supported: false,
      reason: "unsupported",
    });
  });

  it("accepts the canonical endpoint with one trailing slash", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "slash"), {
      profile: { ...UPSTREAM_ROUTER_PROFILE, base_url: "https://api.router.com/v1/" },
      auth: { ...UPSTREAM_ROUTER_AUTH, inference_base_url: "https://api.router.com/v1/" },
    });
    await expect(probeHermesRouterSupport({ command: install.command, env: launchEnv() })).resolves.toEqual({
      supported: true,
    });
  });

  const profileWrong: Record<string, unknown> = {
    name: "ramp",
    auth_type: "oauth",
    api_mode: "chat_completions",
    env_vars: ["ROUTER_API_KEY"],
    base_url: "https://api.router.com/v1//",
  };
  const authWrong: Record<string, unknown> = {
    id: "ramp",
    auth_type: "oauth",
    api_key_env_vars: ["ROUTER_API_KEY"],
    base_url_env_var: "ROUTER_BASE_URL",
    inference_base_url: "https://proxy.example/v1",
  };

  for (const field of Object.keys(UPSTREAM_ROUTER_PROFILE)) {
    for (const mode of ["missing", "wrong"] as const) {
      it(`reports unsupported when the provider profile ${field} is ${mode}`, async () => {
        const profile = { ...UPSTREAM_ROUTER_PROFILE };
        if (mode === "missing") delete profile[field];
        else profile[field] = profileWrong[field];
        const install = await createFakeHermesInstall(path.join(dir, `p-${field}-${mode}`), { profile });
        const result = await probeHermesRouterSupport({ command: install.command, env: launchEnv() });
        expect(result).toMatchObject({ supported: false, reason: "unsupported" });
        expect(result.supported === false && result.message).toContain(`profile_${field}`);
      });
    }
  }

  for (const field of Object.keys(UPSTREAM_ROUTER_AUTH)) {
    for (const mode of ["missing", "wrong"] as const) {
      it(`reports unsupported when the auth registry ${field} is ${mode}`, async () => {
        const auth = { ...UPSTREAM_ROUTER_AUTH };
        if (mode === "missing") delete auth[field];
        else auth[field] = authWrong[field];
        const install = await createFakeHermesInstall(path.join(dir, `a-${field}-${mode}`), { auth });
        const result = await probeHermesRouterSupport({ command: install.command, env: launchEnv() });
        expect(result).toMatchObject({ supported: false, reason: "unsupported" });
        expect(result.supported === false && result.message).toContain(`auth_${field}`);
      });
    }
  }

  it("reports unsupported when the profile exists but the auth registry has no router entry", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "noauth"), { auth: null });
    const result = await probeHermesRouterSupport({ command: install.command, env: launchEnv() });
    expect(result).toMatchObject({ supported: false, reason: "unsupported" });
    expect(result.supported === false && result.message).toMatch(/Upgrade/);
  });

  it("reports unsupported when the installation has no providers package at all", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "noproviders"));
    await fs.rm(path.join(install.srcRoot, "providers"), { recursive: true });
    await expect(probeHermesRouterSupport({ command: install.command, env: launchEnv() })).resolves.toMatchObject({
      supported: false,
      reason: "unsupported",
    });
  });

  it("follows the run's venv interpreter and editable source root without resolving the venv python", async () => {
    // The venv python is a symlink to the base interpreter; resolving it would lose the venv's .pth
    // and the editable source root, so Router support would wrongly look missing.
    const install = await createFakeHermesInstall(path.join(dir, "venv"), { layout: "venv-editable" });
    expect(await fs.realpath(install.python)).not.toBe(install.python);
    await expect(probeHermesRouterSupport({ command: install.command, env: launchEnv() })).resolves.toEqual({
      supported: true,
    });
  });

  it("resolves a symlinked launcher to the real console script", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "venv"), { layout: "venv-editable" });
    const links = path.join(dir, "links");
    await fs.mkdir(links);
    await fs.symlink(install.command, path.join(links, "hermes"));
    const resolution = resolveHermesPythonLauncher("hermes", `${links}:/usr/bin:/bin`);
    expect(resolution).toMatchObject({ ok: true, launcherPath: install.command, interpreter: install.python });
    await expect(probeHermesRouterSupport({ command: "hermes", env: launchEnv({ PATH: `${links}:/usr/bin:/bin` }) })).resolves.toEqual({
      supported: true,
    });
  });

  it("resolves a `/usr/bin/env python3` shebang through the run's PATH, not the server's", async () => {
    const good = await createFakeHermesInstall(path.join(dir, "goodvenv"), { layout: "venv-editable" });
    const old = await createFakeHermesInstall(path.join(dir, "oldvenv"), { layout: "venv-editable", profile: null, auth: null });
    const launcherDir = path.join(dir, "launcher");
    await fs.mkdir(launcherDir);
    const command = path.join(launcherDir, "hermes");
    await fs.writeFile(command, consoleLauncher("/usr/bin/env python3"), { mode: 0o755 });
    await expect(
      probeHermesRouterSupport({ command, env: launchEnv({ PATH: `${good.binDir}:${old.binDir}:/usr/bin:/bin` }) }),
    ).resolves.toEqual({ supported: true });
    await expect(
      probeHermesRouterSupport({ command, env: launchEnv({ PATH: `${old.binDir}:${good.binDir}:/usr/bin:/bin` }) }),
    ).resolves.toMatchObject({ supported: false, reason: "unsupported" });
  });

  it("is bound to the run's command: a bare name resolves through the run's PATH", async () => {
    const good = await createFakeHermesInstall(path.join(dir, "g"));
    const old = await createFakeHermesInstall(path.join(dir, "o"), { profile: null });
    await expect(
      probeHermesRouterSupport({ command: "hermes", env: launchEnv({ PATH: `${good.binDir}:${old.binDir}` }) }),
    ).resolves.toEqual({ supported: true });
    await expect(
      probeHermesRouterSupport({ command: "hermes", env: launchEnv({ PATH: `${old.binDir}:${good.binDir}` }) }),
    ).resolves.toMatchObject({ supported: false, reason: "unsupported" });
  });

  it("resolves a relative command against the run's cwd, not the server process cwd", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "relative"));
    const runCwd = path.join(dir, "workspace");
    await fs.mkdir(path.join(runCwd, ".venv", "bin"), { recursive: true });
    const relativeCommand = path.join(".venv", "bin", "hermes");
    await fs.symlink(install.command, path.join(runCwd, relativeCommand));

    const resolution = resolveHermesPythonLauncher(relativeCommand, undefined, runCwd);
    expect(resolution).toMatchObject({ ok: true, launcherPath: install.command });
    await expect(
      probeHermesRouterSupport({ command: relativeCommand, env: launchEnv(), cwd: runCwd }),
    ).resolves.toEqual({ supported: true });
  });

  it("rejects a relative command containing a separator when no cwd is supplied", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "relative-nocwd"));
    const runCwd = path.join(dir, "workspace-nocwd");
    await fs.mkdir(path.join(runCwd, ".venv", "bin"), { recursive: true });
    const relativeCommand = path.join(".venv", "bin", "hermes");
    await fs.symlink(install.command, path.join(runCwd, relativeCommand));

    // Even when the same relative path exists under the server process cwd, guessing would verify a
    // different file than the run executes.
    const serverCwd = process.cwd();
    process.chdir(runCwd);
    try {
      expect(resolveHermesPythonLauncher(relativeCommand, undefined)).toMatchObject({ ok: false, reason: "error" });
      await expect(probeHermesRouterSupport({ command: relativeCommand, env: launchEnv() })).resolves.toMatchObject({
        supported: false,
        reason: "error",
      });
    } finally {
      process.chdir(serverCwd);
    }
  });

  it("treats a shell wrapper as unverifiable without ever executing it", async () => {
    const marker = path.join(dir, "wrapper-ran");
    const command = path.join(dir, "hermes-wrapper");
    await fs.writeFile(command, `#!/bin/sh\ntouch "${marker}"\nexec python3 -m hermes_cli.main "$@"\n`, { mode: 0o755 });
    const result = await probeHermesRouterSupport({ command, env: launchEnv() });
    expect(result).toMatchObject({ supported: false, reason: "unknown" });
    expect(result.supported === false && result.message).toMatch(/console entrypoint/);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it.each([
    ["an `env -S` shebang", "#!/usr/bin/env -S python3 -E"],
    ["a non-python interpreter", "#!/usr/bin/perl"],
    ["a relative interpreter", "#!python3"],
  ])("treats %s as unverifiable", async (_label, shebang) => {
    const command = path.join(dir, "hermes");
    await fs.writeFile(command, consoleLauncher(shebang.slice(2)), { mode: 0o755 });
    await expect(probeHermesRouterSupport({ command, env: launchEnv() })).resolves.toMatchObject({
      supported: false,
      reason: "unknown",
    });
  });

  it("treats an unrecognized Python launcher body as unverifiable", async () => {
    const command = path.join(dir, "hermes");
    await fs.writeFile(command, `#!${realPython()}\nimport os\nos.system('touch /tmp/x')\n`, { mode: 0o755 });
    await expect(probeHermesRouterSupport({ command, env: launchEnv() })).resolves.toMatchObject({
      supported: false,
      reason: "unknown",
    });
  });

  it("cannot be shadowed by a workspace providers module via PYTHONPATH or the caller's cwd", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "old"), { profile: null, auth: null });
    const shadow = path.join(dir, "workspace");
    await writeHermesPackages(shadow, {});
    const result = await probeHermesRouterSupport({
      command: install.command,
      env: launchEnv({ PYTHONPATH: shadow, PYTHONHOME: "/nonexistent" }),
    });
    expect(result).toMatchObject({ supported: false, reason: "unsupported" });
  });

  it("refuses an installation whose providers and hermes_cli come from different roots", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "venv"), { layout: "venv-editable" });
    // A `providers` package beside the launcher (sys.path[0]) would shadow the installed one.
    await writeHermesPackages(path.join(dir, "shadow"), {});
    await fs.cp(path.join(dir, "shadow", "providers"), path.join(install.binDir, "providers"), { recursive: true });
    await expect(probeHermesRouterSupport({ command: install.command, env: launchEnv() })).resolves.toMatchObject({
      supported: false,
      reason: "unknown",
    });
  });

  it("re-probes every time: a module change under an unchanged launcher is detected", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "ok"));
    await expect(probeHermesRouterSupport({ command: install.command, env: launchEnv() })).resolves.toEqual({ supported: true });
    await writeHermesPackages(install.srcRoot, { profile: null });
    await expect(probeHermesRouterSupport({ command: install.command, env: launchEnv() })).resolves.toMatchObject({
      supported: false,
      reason: "unsupported",
    });
  });

  it("gives the probe no secrets, a fresh home outside any profiles tree, and cleans it up", async () => {
    const capture = path.join(dir, "probe-env.json");
    const hostHome = path.join(dir, "host-home");
    await fs.mkdir(path.join(hostHome, ".hermes", "profiles", "work"), { recursive: true });
    await fs.writeFile(path.join(hostHome, ".hermes", ".env"), "RAMP_ROUTER_API_KEY=host-dotenv-secret\n");
    await fs.writeFile(path.join(hostHome, ".hermes", "auth.json"), '{"pool":"host-auth-secret"}');
    const install = await createFakeHermesInstall(path.join(dir, "ok"), {
      providersExtra: [
        "import os as _os",
        "_home = _os.environ.get('HERMES_HOME', '')",
        `open(${JSON.stringify(capture)}, 'w').write(json.dumps({'env': dict(_os.environ), 'cwd': _os.getcwd(),`,
        "  'hermes_home_entries': sorted(_os.listdir(_home)) if _os.path.isdir(_home) else None}))",
      ].join("\n"),
    });
    const result = await probeHermesRouterSupport({
      command: install.command,
      env: launchEnv({
        HOME: hostHome,
        HERMES_HOME: path.join(hostHome, ".hermes"),
        RAMP_ROUTER_API_KEY: "agent-env-secret",
        OPENAI_API_KEY: "other-provider-secret",
        PAPERCLIP_API_KEY: "paperclip-run-token-secret",
        PYTHONPATH: "/somewhere",
      }),
    });
    expect(result).toEqual({ supported: true });
    const seen = JSON.parse(await fs.readFile(capture, "utf8")) as {
      env: Record<string, string>;
      cwd: string;
      hermes_home_entries: string[] | null;
    };
    const text = JSON.stringify(seen);
    for (const secret of ["agent-env-secret", "other-provider-secret", "paperclip-run-token-secret", "host-dotenv-secret", "host-auth-secret"]) {
      expect(text).not.toContain(secret);
    }
    expect(seen.env.PYTHONPATH).toBeUndefined();
    expect(seen.env.PYTHONHOME).toBeUndefined();
    expect(seen.env.HERMES_DISABLE_LAZY_INSTALLS).toBe("1");
    expect(seen.env.PYTHONDONTWRITEBYTECODE).toBe("1");
    for (const key of ["HOME", "HERMES_HOME", "XDG_CONFIG_HOME", "TMPDIR"]) {
      expect(seen.env[key].startsWith(hostHome), key).toBe(false);
      expect(seen.env[key], key).not.toContain(`${path.sep}profiles${path.sep}`);
    }
    expect(seen.hermes_home_entries).toEqual([]);
    // The probe runs from an empty work dir inside its own probe root, never the caller's cwd.
    expect(path.basename(seen.cwd)).toBe("work");
    expect(path.basename(path.dirname(seen.cwd))).toBe(path.basename(path.dirname(seen.env.HOME)));
    expect(path.basename(path.dirname(seen.cwd))).toMatch(/^paperclip-router-probe-/);
    // The probe home is removed afterwards; the host Hermes dir is untouched.
    await expect(fs.access(seen.env.HOME)).rejects.toThrow();
    expect(await fs.readFile(path.join(hostHome, ".hermes", "auth.json"), "utf8")).toBe('{"pool":"host-auth-secret"}');
  });

  it("keeps a launch-pinned PYTHONNOUSERSITE so the probe matches the run's import context", async () => {
    const capture = path.join(dir, "nousersite.txt");
    const install = await createFakeHermesInstall(path.join(dir, "ok"), {
      providersExtra: `import os as _os\nopen(${JSON.stringify(capture)}, 'w').write(_os.environ.get('PYTHONNOUSERSITE', '-'))`,
    });
    await probeHermesRouterSupport({ command: install.command, env: launchEnv({ PYTHONNOUSERSITE: "1" }) });
    expect(await fs.readFile(capture, "utf8")).toBe("1");
  });

  it("strips exactly the Python module-resolution names a Router run strips", async () => {
    // The probe must verify the same hermes_cli/providers import set the run will load. Both sides
    // consume ROUTER_RUN_STRIPPED_PYTHON_ENV_NAMES (execute.ts applies it to the child env), so this
    // asserts the probe's observed environment carries none of them while PYTHONNOUSERSITE is passed
    // through unchanged in both directions.
    const capture = path.join(dir, "python-env.json");
    const install = await createFakeHermesInstall(path.join(dir, "ok"), {
      providersExtra:
        "import os as _os\n" +
        `open(${JSON.stringify(capture)}, 'w').write(json.dumps({k: _os.environ.get(k) for k in ` +
        "['PYTHONPATH','PYTHONHOME','PYTHONUSERBASE','PYTHONNOUSERSITE']}))",
    });

    await probeHermesRouterSupport({
      command: install.command,
      env: launchEnv({ PYTHONPATH: "/shadowed", PYTHONHOME: "/nonexistent", PYTHONUSERBASE: "/shadow-user-site" }),
    });
    expect(JSON.parse(await fs.readFile(capture, "utf8"))).toEqual({
      PYTHONPATH: null,
      PYTHONHOME: null,
      PYTHONUSERBASE: null,
      PYTHONNOUSERSITE: null,
    });

    await probeHermesRouterSupport({
      command: install.command,
      env: launchEnv({ PYTHONPATH: "/shadowed", PYTHONHOME: "/nonexistent", PYTHONUSERBASE: "/shadow-user-site", PYTHONNOUSERSITE: "1" }),
    });
    expect(JSON.parse(await fs.readFile(capture, "utf8"))).toEqual({
      PYTHONPATH: null,
      PYTHONHOME: null,
      PYTHONUSERBASE: null,
      PYTHONNOUSERSITE: "1",
    });
  });

  it("blocks network/DNS during the probe and reports it as unverifiable", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "net"), {
      providersExtra: "try:\n    import socket\n    socket.getaddrinfo('example.invalid', 443)\nexcept Exception:\n    pass",
    });
    const result = await probeHermesRouterSupport({ command: install.command, env: launchEnv() });
    expect(result).toMatchObject({ supported: false, reason: "unknown" });
    expect(result.supported === false && result.message).toMatch(/network or process access/);
  });

  it("blocks process launches during the probe (the command never runs)", async () => {
    const marker = path.join(dir, "spawned");
    const install = await createFakeHermesInstall(path.join(dir, "proc"), {
      providersExtra: `try:\n    import subprocess\n    subprocess.run(['/usr/bin/touch', ${JSON.stringify(marker)}])\nexcept Exception:\n    pass`,
    });
    const result = await probeHermesRouterSupport({ command: install.command, env: launchEnv() });
    expect(result).toMatchObject({ supported: false, reason: "unknown" });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("reports an import failure as unverifiable without leaking exception text", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "boom"), {
      providersExtra: "raise RuntimeError('secret-exception-detail-7895')",
    });
    const result = await probeHermesRouterSupport({ command: install.command, env: launchEnv() });
    expect(result).toMatchObject({ supported: false, reason: "unknown" });
    expect(JSON.stringify(result)).not.toContain("secret-exception-detail-7895");
  });

  it("is bounded: a hung interpreter times out and fails closed", async () => {
    const command = await fakeInterpreter("hang", "sleep 5");
    const started = Date.now();
    const result = await probeHermesRouterSupport({ command, env: launchEnv(), timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result).toMatchObject({ supported: false, reason: "timeout" });
  });

  it("is bounded even when a descendant keeps the stdio pipes open", async () => {
    // A plain SIGKILL of the child alone leaves this `sleep` holding the pipes, so the probe would
    // hang until it exits. The deadline must be a hard limit: the whole process group is killed.
    const marker = path.join(dir, "grandchild-survived");
    const command = await fakeInterpreter(
      "grandchild",
      `sh -c 'sleep 4; touch "${marker}"' &\nsleep 5`,
    );
    const started = Date.now();
    const result = await probeHermesRouterSupport({ command, env: launchEnv(), timeoutMs: 300 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4000);
    expect(result).toMatchObject({ supported: false, reason: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it.each([
    ["malformed output", "echo not-json"],
    ["a success payload with a nonzero exit", `echo '{"v":1,"code":"ok"}'; exit 1`],
    ["an unknown protocol version", `echo '{"v":2,"code":"ok"}'`],
    ["extra payload fields", `echo '{"v":1,"code":"ok","url":"https://x"}'`],
    ["an unknown field name", `echo '{"v":1,"code":"incompatible","field":"api_key"}'`],
    ["output overflow", "head -c 5000 /dev/zero | tr '\\\\0' a"],
  ])("fails closed on %s", async (_label, body) => {
    const command = await fakeInterpreter(_label.replace(/\W+/g, "-"), body);
    await expect(probeHermesRouterSupport({ command, env: launchEnv() })).resolves.toMatchObject({
      supported: false,
      reason: "unknown",
    });
  });

  it("fails closed when the command or its interpreter does not exist", async () => {
    await expect(
      probeHermesRouterSupport({ command: path.join(dir, "missing-hermes"), env: launchEnv() }),
    ).resolves.toMatchObject({ supported: false, reason: "error" });
    const command = path.join(dir, "hermes");
    await fs.writeFile(command, consoleLauncher(path.join(dir, "no-such", "python3")), { mode: 0o755 });
    await expect(probeHermesRouterSupport({ command, env: launchEnv() })).resolves.toMatchObject({
      supported: false,
      reason: "error",
    });
  });
});

describe("Router launch plan (bind once, probe and execute the same file)", () => {
  it("normalizes PATH against the execution cwd: relative and empty components keep their order", () => {
    const cwd = path.join(dir, "run");
    expect(normalizeRouterLaunchPath(":/usr/bin", cwd)).toBe(`${cwd}:/usr/bin`);
    expect(normalizeRouterLaunchPath("/usr/bin::bin", cwd)).toBe(`/usr/bin:${cwd}:${path.join(cwd, "bin")}`);
    expect(normalizeRouterLaunchPath("/usr/bin:", cwd)).toBe(`/usr/bin:${cwd}`);
    expect(normalizeRouterLaunchPath(".venv/bin:../shared/bin", cwd)).toBe(
      `${path.join(cwd, ".venv", "bin")}:${path.join(dir, "shared", "bin")}`,
    );
    expect(normalizeRouterLaunchPath("", cwd)).toBe("");
    expect(normalizeRouterLaunchPath(undefined, cwd)).toBe("");
  });

  async function relativeAndAbsoluteInstalls(relativeSupported: boolean) {
    const runCwd = path.join(dir, "run-cwd");
    const rel = await createFakeHermesInstall(
      path.join(runCwd, "rel"),
      relativeSupported ? {} : { profile: null, auth: null },
    );
    const abs = await createFakeHermesInstall(
      path.join(dir, "abs"),
      relativeSupported ? { profile: null, auth: null } : {},
    );
    // The server process cwd is somewhere else entirely and has no installation.
    const serverCwd = path.join(dir, "server-cwd");
    await fs.mkdir(serverCwd, { recursive: true });
    return { runCwd, rel, abs, serverCwd, pathEnv: `rel/bin:${abs.binDir}:/usr/bin:/bin` };
  }

  for (const relativeSupported of [true, false]) {
    it(`binds a relative first PATH entry from the run cwd over an absolute fallback (relative ${relativeSupported ? "supported" : "unsupported"})`, async () => {
      const { runCwd, rel, serverCwd, pathEnv } = await relativeAndAbsoluteInstalls(relativeSupported);
      const previous = process.cwd();
      process.chdir(serverCwd);
      try {
        const bound = resolveRouterLaunchPlan({ command: "hermes", pathEnv, cwd: runCwd });
        expect(bound).toMatchObject({ ok: true, plan: { executable: rel.command, cwd: runCwd } });
        if (!bound.ok) return;
        expect(bound.plan.path.split(":")[0]).toBe(rel.binDir);
        const result = await probeHermesRouterSupport({ command: "hermes", env: launchEnv({ PATH: pathEnv }), launch: bound.plan });
        if (relativeSupported) expect(result).toEqual({ supported: true });
        else expect(result).toMatchObject({ supported: false, reason: "unsupported" });
        // The cwd-bound form of the probe agrees with the plan.
        await expect(
          probeHermesRouterSupport({ command: "hermes", env: launchEnv({ PATH: pathEnv }), cwd: runCwd }),
        ).resolves.toEqual(result);
      } finally {
        process.chdir(previous);
      }
    });
  }

  it("treats leading, interior and trailing empty PATH components as the run cwd", async () => {
    const runCwd = path.join(dir, "empties");
    const install = await createFakeHermesInstall(path.join(runCwd, "inst"));
    // Put the launcher directly in the run cwd via a symlink.
    await fs.symlink(install.command, path.join(runCwd, "hermes"));
    for (const pathEnv of [":/usr/bin", "/usr/bin::/bin", "/usr/bin:"]) {
      const bound = resolveRouterLaunchPlan({ command: "hermes", pathEnv, cwd: runCwd });
      expect(bound, pathEnv).toMatchObject({ ok: true, plan: { executable: install.command } });
    }
  });

  it("never falls back to an ambient PATH when the run's PATH is wholly empty", async () => {
    const install = await createFakeHermesInstall(path.join(dir, "ambient"));
    const previous = process.env.PATH;
    process.env.PATH = `${install.binDir}:${previous ?? ""}`;
    try {
      expect(resolveRouterLaunchPlan({ command: "hermes", pathEnv: "", cwd: dir })).toMatchObject({ ok: false, reason: "error" });
      expect(resolveRouterLaunchPlan({ command: "hermes", pathEnv: undefined, cwd: dir })).toMatchObject({ ok: false, reason: "error" });
      // An absolute launcher with an absolute shebang needs no lookup and still binds.
      expect(resolveRouterLaunchPlan({ command: install.command, pathEnv: "", cwd: dir })).toMatchObject({ ok: true });
    } finally {
      process.env.PATH = previous;
    }
  });

  it("resolves a relative explicit command against the run cwd, not the server cwd", async () => {
    const runCwd = path.join(dir, "explicit-run");
    const install = await createFakeHermesInstall(path.join(runCwd, "tool"));
    const decoyCwd = path.join(dir, "explicit-server");
    await createFakeHermesInstall(path.join(decoyCwd, "tool"), { profile: null, auth: null });
    const previous = process.cwd();
    process.chdir(decoyCwd);
    try {
      const bound = resolveRouterLaunchPlan({ command: "tool/bin/hermes", pathEnv: "/usr/bin:/bin", cwd: runCwd });
      expect(bound).toMatchObject({ ok: true, plan: { executable: install.command } });
      if (!bound.ok) return;
      await expect(
        probeHermesRouterSupport({ command: "tool/bin/hermes", env: launchEnv(), launch: bound.plan }),
      ).resolves.toEqual({ supported: true });
    } finally {
      process.chdir(previous);
    }
  });

  it("looks up a `/usr/bin/env python3` interpreter through the normalized PATH, keeping the venv path", async () => {
    const runCwd = path.join(dir, "envpy");
    const good = await createFakeHermesInstall(path.join(runCwd, "goodvenv"), { layout: "venv-editable" });
    const old = await createFakeHermesInstall(path.join(dir, "oldvenv"), { layout: "venv-editable", profile: null, auth: null });
    const launcherDir = path.join(dir, "envpy-launcher");
    await fs.mkdir(launcherDir);
    const command = path.join(launcherDir, "hermes");
    await fs.writeFile(command, consoleLauncher("/usr/bin/env python3"), { mode: 0o755 });
    const relGood = path.relative(runCwd, good.binDir);

    const first = resolveRouterLaunchPlan({ command, pathEnv: `${relGood}:${old.binDir}:/usr/bin:/bin`, cwd: runCwd });
    expect(first).toMatchObject({ ok: true, plan: { interpreter: path.join(good.binDir, "python3") } });
    if (!first.ok) return;
    // Not realpath'd: the venv interpreter keeps its venv identity.
    expect(await fs.realpath(first.plan.interpreter)).not.toBe(first.plan.interpreter);
    await expect(probeHermesRouterSupport({ command, env: launchEnv(), launch: first.plan })).resolves.toEqual({ supported: true });

    const second = resolveRouterLaunchPlan({ command, pathEnv: `${old.binDir}:${relGood}:/usr/bin:/bin`, cwd: runCwd });
    expect(second).toMatchObject({ ok: true, plan: { interpreter: path.join(old.binDir, "python3") } });
    if (!second.ok) return;
    await expect(probeHermesRouterSupport({ command, env: launchEnv(), launch: second.plan })).resolves.toMatchObject({
      supported: false,
      reason: "unsupported",
    });
  });

  it("probes the bound descriptor as-is, with the plan's normalized PATH", async () => {
    const capture = path.join(dir, "plan-path.txt");
    const runCwd = path.join(dir, "bound");
    const install = await createFakeHermesInstall(path.join(runCwd, "inst"), {
      providersExtra: `import os as _os\nopen(${JSON.stringify(capture)}, 'w').write(_os.environ.get('PATH', '-'))`,
    });
    const bound = resolveRouterLaunchPlan({ command: "hermes", pathEnv: "inst/bin:", cwd: runCwd });
    expect(bound).toMatchObject({ ok: true, plan: { executable: install.command } });
    if (!bound.ok) return;
    // The command string is only a label once bound: it is never resolved again.
    await expect(
      probeHermesRouterSupport({ command: "no-such-hermes", env: launchEnv({ PATH: "inst/bin:" }), launch: bound.plan }),
    ).resolves.toEqual({ supported: true });
    expect(await fs.readFile(capture, "utf8")).toBe(`${install.binDir}:${runCwd}`);
  });
});

describe("Router env helpers", () => {
  it("classifies endpoint overrides and aliases but never the canonical key", () => {
    for (const name of ["RAMP_ROUTER_BASE_URL", "RAMP_ROUTER_API_BASE", "RAMP_ROUTER_ANYTHING", "ROUTER_API_KEY", "ROUTER_BASE_URL"]) {
      expect(isRouterEndpointOverrideEnvName(name), name).toBe(true);
    }
    for (const name of ["RAMP_ROUTER_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "OPENAI_BASE_URL"]) {
      expect(isRouterEndpointOverrideEnvName(name), name).toBe(false);
    }
  });

  it("strips SDK endpoint variables only from Router runs", () => {
    const env = { RAMP_ROUTER_BASE_URL: "x", OPENAI_BASE_URL: "y", RAMP_ROUTER_API_KEY: "k" };
    expect(routerEnvNamesToStrip(env, true)).toEqual(expect.arrayContaining(["RAMP_ROUTER_BASE_URL", "OPENAI_BASE_URL"]));
    expect(routerEnvNamesToStrip(env, false)).toContain("RAMP_ROUTER_BASE_URL");
    expect(routerEnvNamesToStrip(env, false)).not.toContain("OPENAI_BASE_URL");
    expect(routerEnvNamesToStrip(env, true)).not.toContain("RAMP_ROUTER_API_KEY");
  });

  it("reads only a non-blank canonical key", () => {
    expect(readRouterApiKey({ RAMP_ROUTER_API_KEY: " k " })).toBe("k");
    expect(readRouterApiKey({ RAMP_ROUTER_API_KEY: "   " })).toBeUndefined();
    expect(readRouterApiKey({ ROUTER_API_KEY: "legacy" })).toBeUndefined();
    expect(readRouterApiKey({ OPENAI_API_KEY: "other" })).toBeUndefined();
    expect(readRouterApiKey(undefined)).toBeUndefined();
  });

  it("matches only the router provider, ignoring case and surrounding whitespace", () => {
    expect(isRouterProvider("router")).toBe(true);
    expect(isRouterProvider(" Router ")).toBe(true);
    for (const provider of ["openrouter", "auto", "", null, undefined]) {
      expect(isRouterProvider(provider), String(provider)).toBe(false);
    }
  });

  it("detects remote execution targets from either contract", () => {
    expect(isRemoteExecutionTarget({ executionTarget: { kind: "remote" } })).toBe(true);
    expect(isRemoteExecutionTarget({ executionTransport: { remoteExecution: { host: "x" } } })).toBe(true);
    expect(isRemoteExecutionTarget({ executionTarget: { kind: "local" } })).toBe(false);
    expect(isRemoteExecutionTarget({})).toBe(false);
  });
});
