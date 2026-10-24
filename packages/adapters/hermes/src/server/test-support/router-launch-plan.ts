/**
 * TECH-7895 test support: a Router launch binder for execute() tests that stub the registry probe.
 *
 * It uses the real binding whenever the configured launcher exists, so tests that run the real probe
 * against a fake installation still bind the real file. Otherwise it binds the configured (fake)
 * command with the real cwd/PATH normalization, so tests need no installed Hermes. A wholly empty
 * or absent PATH is always refused, exactly as the real binder refuses it.
 */
import path from "node:path";

import type * as RouterReadiness from "../router-readiness.js";

export function fakeRouterLaunchPlanResolver(actual: typeof RouterReadiness) {
  return (options: { command: string; pathEnv: string | undefined; cwd: string }): RouterReadiness.RouterLaunchPlanResult => {
    const real = actual.resolveRouterLaunchPlan(options);
    // The empty/absent PATH refusal is part of the contract, never faked away.
    if (real.ok || !options.pathEnv) return real;
    const cwd = path.resolve(options.cwd);
    return {
      ok: true,
      plan: {
        cwd,
        path: actual.normalizeRouterLaunchPath(options.pathEnv, cwd),
        executable: path.resolve(cwd, options.command),
        launcherDir: "/fake-hermes/bin",
        interpreter: "/fake-hermes/bin/python3",
      },
    };
  };
}
