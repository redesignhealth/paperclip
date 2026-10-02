/**
 * Server process self-check (TECH-7095).
 *
 * Agent children run as the same OS user as the server. On Linux a same-user process can read
 * /proc/<server-pid>/environ (database URL, auth secret, provider keys) unless the kernel marks the
 * server non-dumpable. The production image starts the server from an exec-only copy of node
 * (root-owned, mode 0111), which makes the kernel mark it non-dumpable and its /proc entries
 * root-owned. This probe checks that from the outside, the way an agent would: a same-user child
 * tries to read the server's environ. It logs the outcome and, when
 * PAPERCLIP_REQUIRE_NONDUMPABLE=true, lets startup fail closed.
 *
 * It never reads or logs the environ contents; only whether the open succeeded.
 */
import { execFile } from "node:child_process";
import { buildAgentChildBaseEnv } from "@paperclipai/adapter-utils/agent-child-env";

export const REQUIRE_NONDUMPABLE_ENV = "PAPERCLIP_REQUIRE_NONDUMPABLE";

export type ServerProcessInspectability = "inspectable" | "protected" | "unknown";

export type ProbeExec = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ code: number | null; stderr: string; spawnError: boolean }>;

const defaultExec: ProbeExec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, _stdout, stderr) => {
      if (!error) return resolve({ code: 0, stderr: String(stderr ?? ""), spawnError: false });
      const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
        ? ((error as { code: number }).code)
        : null;
      resolve({ code, stderr: String(stderr ?? ""), spawnError: code === null });
    });
  });

/** Same-user child tries to open (1 byte of) this process's /proc/<pid>/environ. */
export async function probeServerProcessInspectability(input: {
  pid?: number;
  platform?: NodeJS.Platform;
  exec?: ProbeExec;
} = {}): Promise<ServerProcessInspectability> {
  const platform = input.platform ?? process.platform;
  if (platform !== "linux") return "unknown";
  const pid = input.pid ?? process.pid;
  const result = await (input.exec ?? defaultExec)("head", ["-c", "1", `/proc/${pid}/environ`], {
    // LC_ALL=C so the denial text is English whatever the host locale; the classification below reads it.
    env: { ...buildAgentChildBaseEnv(process.env), LC_ALL: "C", LANG: "C" },
    timeout: 5000,
  });
  if (result.spawnError) return "unknown";
  if (result.code === 0) return "inspectable";
  return /permission denied|operation not permitted/i.test(result.stderr) ? "protected" : "unknown";
}

export const NONDUMPABLE_REQUIRED_MESSAGE =
  `${REQUIRE_NONDUMPABLE_ENV}=true but a same-user child process can read this server's /proc environment. ` +
  "Start the server from the exec-only node binary (see doc/HOSTED-AGENT-CONTAINMENT.md) or unset the requirement.";

export function nonDumpableRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[REQUIRE_NONDUMPABLE_ENV]?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

/**
 * Probe, log, and enforce. Returns the result. Throws a static, value-free error when the
 * requirement is set and the server is inspectable. `unknown` (non-Linux, no `head`) never fails
 * startup: the requirement is about a confirmed exposure.
 */
export async function checkServerProcessHardening(input: {
  deploymentMode: string;
  env?: NodeJS.ProcessEnv;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  probe?: () => Promise<ServerProcessInspectability>;
}): Promise<ServerProcessInspectability> {
  const env = input.env ?? process.env;
  const required = nonDumpableRequired(env);
  if (input.deploymentMode !== "authenticated" && !required) return "unknown";
  const result = await (input.probe ?? probeServerProcessInspectability)();
  if (result === "protected") {
    input.log.info({ inspectability: result }, "server process is not inspectable by same-user children");
  } else if (result === "inspectable") {
    input.log.warn(
      { inspectability: result, required },
      "a same-user child process can read this server's /proc environment (database URL, auth secret, provider keys); " +
        "start the server from the exec-only node binary to close this (doc/HOSTED-AGENT-CONTAINMENT.md)",
    );
    if (required) throw new Error(NONDUMPABLE_REQUIRED_MESSAGE);
  } else if (required) {
    input.log.warn({ inspectability: result }, "could not determine whether the server /proc environment is inspectable");
  }
  return result;
}
