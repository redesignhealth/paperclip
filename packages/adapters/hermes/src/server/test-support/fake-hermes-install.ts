/**
 * TECH-7895 test support: build real, minimal Hermes Python installations so the Ramp Router registry
 * probe is exercised across its true process boundary (launcher → shebang interpreter → imports).
 *
 * Layouts:
 *  - "launcher-dir": `providers`/`hermes_cli` sit next to the console launcher (found via sys.path[0]).
 *  - "venv-editable": a real `python -m venv --without-pip` venv with an editable-style `.pth`
 *    pointing at a separate source root (like /opt/hermes/bin + /opt/hermes-src in production).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const UPSTREAM_ROUTER_PROFILE: Record<string, unknown> = {
  name: "router",
  auth_type: "api_key",
  api_mode: "codex_responses",
  env_vars: ["RAMP_ROUTER_API_KEY", "ROUTER_API_KEY"],
  base_url: "https://api.router.com/v1",
};

export const UPSTREAM_ROUTER_AUTH: Record<string, unknown> = {
  id: "router",
  auth_type: "api_key",
  api_key_env_vars: ["RAMP_ROUTER_API_KEY", "ROUTER_API_KEY"],
  base_url_env_var: "RAMP_ROUTER_BASE_URL",
  inference_base_url: "https://api.router.com/v1",
};

/** Mirrors upstream `hermes chat --help`: deliberately no provider choices, never lists router. */
export const UPSTREAM_CHAT_HELP =
  "usage: hermes chat [-h] [-q QUERY] [-Q] [-m MODEL] [--provider PROVIDER]\n" +
  "  --provider PROVIDER  Inference provider (default: auto)";

let cachedPython: string | null = null;

/** The real interpreter behind `python3` (pyenv shims are shell scripts). */
export function realPython(): string {
  if (!cachedPython) {
    cachedPython = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  }
  return cachedPython;
}

export function consoleLauncher(shebang: string): string {
  return [
    `#!${shebang}`,
    "# -*- coding: utf-8 -*-",
    "import re",
    "import sys",
    "from hermes_cli.main import main",
    "if __name__ == '__main__':",
    "    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])",
    "    sys.exit(main())",
    "",
  ].join("\n");
}

const pyString = (value: unknown) => JSON.stringify(JSON.stringify(value));

export async function writeHermesPackages(
  srcRoot: string,
  options: { profile?: Record<string, unknown> | null; auth?: Record<string, unknown> | null; providersExtra?: string },
): Promise<void> {
  const profile = options.profile === undefined ? UPSTREAM_ROUTER_PROFILE : options.profile;
  const auth = options.auth === undefined ? UPSTREAM_ROUTER_AUTH : options.auth;
  await fs.mkdir(path.join(srcRoot, "providers"), { recursive: true });
  await fs.mkdir(path.join(srcRoot, "hermes_cli"), { recursive: true });
  await fs.writeFile(
    path.join(srcRoot, "providers", "__init__.py"),
    [
      "import json, types",
      `_P = json.loads(${pyString(profile)})`,
      "def get_provider_profile(name):",
      "    if name != 'router' or _P is None:",
      "        return None",
      "    return types.SimpleNamespace(**_P)",
      options.providersExtra ?? "",
      "",
    ].join("\n"),
  );
  await fs.writeFile(path.join(srcRoot, "hermes_cli", "__init__.py"), "");
  await fs.writeFile(
    path.join(srcRoot, "hermes_cli", "auth.py"),
    [
      "import json, types",
      `_C = json.loads(${pyString(auth)})`,
      "PROVIDER_REGISTRY = {} if _C is None else {'router': types.SimpleNamespace(**_C)}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(srcRoot, "hermes_cli", "main.py"),
    [
      "import os, sys",
      // Proves the probe never imports the CLI entrypoint module.
      "open(os.path.join(os.path.dirname(__file__), '.main-imported'), 'w').close()",
      "def main():",
      "    if sys.argv[1:3] == ['chat', '--help']:",
      `        print(${JSON.stringify(UPSTREAM_CHAT_HELP)})`,
      "        return 0",
      "    return 0",
      "",
    ].join("\n"),
  );
}

export interface FakeHermesInstall {
  /** Launcher path to configure as the agent's Hermes command. */
  command: string;
  binDir: string;
  srcRoot: string;
  /** Interpreter named in the launcher shebang (venv python for venv layouts). */
  python: string;
}

export async function createFakeHermesInstall(
  root: string,
  options: {
    layout?: "launcher-dir" | "venv-editable";
    profile?: Record<string, unknown> | null;
    auth?: Record<string, unknown> | null;
    providersExtra?: string;
    /** "absolute" (default) or "env" (`#!/usr/bin/env python3`). */
    shebang?: "absolute" | "env";
  } = {},
): Promise<FakeHermesInstall> {
  const layout = options.layout ?? "launcher-dir";
  await fs.mkdir(root, { recursive: true });
  if (layout === "launcher-dir") {
    const binDir = path.join(root, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await writeHermesPackages(binDir, options);
    const python = realPython();
    const command = path.join(binDir, "hermes");
    await fs.writeFile(command, consoleLauncher(options.shebang === "env" ? "/usr/bin/env python3" : python), {
      mode: 0o755,
    });
    return { command, binDir, srcRoot: binDir, python };
  }
  const venv = path.join(root, "venv");
  execFileSync(realPython(), ["-m", "venv", "--without-pip", venv]);
  const srcRoot = path.join(root, "hermes-src");
  await writeHermesPackages(srcRoot, options);
  const version = execFileSync(path.join(venv, "bin", "python"), ["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"], {
    encoding: "utf8",
  }).trim();
  const sitePackages = path.join(venv, "lib", `python${version}`, "site-packages");
  await fs.writeFile(path.join(sitePackages, "__editable__hermes_src.pth"), `${srcRoot}\n`);
  const binDir = path.join(venv, "bin");
  const python = path.join(binDir, "python");
  const command = path.join(binDir, "hermes");
  await fs.writeFile(command, consoleLauncher(options.shebang === "env" ? "/usr/bin/env python3" : python), {
    mode: 0o755,
  });
  return { command, binDir, srcRoot, python };
}
