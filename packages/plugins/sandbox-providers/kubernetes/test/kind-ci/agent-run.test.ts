/**
 * One agent run through the Kubernetes sandbox provider, under the server's real (non-admin)
 * permissions (TECH-9831). Drives the plugin hooks the server calls, in the order it calls them:
 * acquire lease (tenant ensure + Sandbox CR + per-run Secret), execute (pod start, a trivial command),
 * sync in, the stub `pi` agent, sync out, resume with the reusable-lease marker (between-turn scrub),
 * release. The kubeconfig is the group `paperclip-server` identity from kind-ci.sh; the RBAC is the
 * rh-paperclip prod and dev files. A permission the plugin needs and those files do not grant fails here.
 *
 * Needs no model credentials: the pod image's `pi` is a stub (see runtime/pi).
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../../src/plugin.js";

const KUBECONFIG_PATH = process.env.KIND_CI_KUBECONFIG ?? "/tmp/kind-ci/server.kubeconfig";
const ADMIN_CONTEXT = `kind-${process.env.KIND_CI_CLUSTER ?? "paperclip-ci"}`;
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const NAMESPACE = "paperclip-ci";

// Observation only: the admin context reads state the server identity could not.
function admin(args: string[]): string {
  return execFileSync("kubectl", ["--context", ADMIN_CONTEXT, ...args], { encoding: "utf-8" });
}

describe("kubernetes sandbox: one agent run under the real permissions", () => {
  const hostDir = mkdtempSync(join(tmpdir(), "k8s-kind-ci-"));
  afterAll(() => rmSync(hostDir, { recursive: true, force: true }));

  it("acquires, starts the pod, syncs in, runs the stub agent, syncs out, scrubs, releases", async () => {
    const config = {
      inCluster: false,
      kubeconfig: readFileSync(KUBECONFIG_PATH, "utf-8"),
      companySlug: "ci",
      adapterType: "pi_local",
      backend: "sandbox-cr",
      imageAllowList: [] as string[],
      podActivityDeadlineSec: 180,
    };
    const base = { driverKey: "kubernetes", config, companyId: COMPANY_ID, environmentId: "env-kind-ci" };
    const t0 = Date.now();
    const lap = (label: string) => console.log(`[kind-ci] ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // 1. Acquire: tenant ensure (namespace read, SA, Role, RoleBinding, quota, limits, policies),
    //    Sandbox CR, per-run Secret.
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...base, runId: "r-kind-ci" });
    lap("acquire");
    expect(lease.providerLeaseId).toMatch(/^pc-/);
    expect(admin(["get", "sandboxes.agents.x-k8s.io", "-n", NAMESPACE, "-o", "name"])).toContain(lease.providerLeaseId!);
    expect(admin(["get", "secret", "-n", NAMESPACE, "-o", "name"])).toContain(`${lease.providerLeaseId}-env`);
    expect(admin(["get", "networkpolicy", "-n", NAMESPACE, "-o", "name"])).toContain("paperclip-deny-all");

    // 2. Pod start and a trivial command (the first execute waits for the pod to be Ready).
    const hello = await plugin.definition.onEnvironmentExecute!({
      ...base, lease, command: "echo", args: ["hello"], cwd: "/workspace", timeoutMs: 180_000,
    });
    lap("pod start + exec");
    expect(hello.exitCode, `exec failed: ${hello.stderr}`).toBe(0);
    expect(hello.stdout.trim()).toBe("hello");

    // 3. Workspace sync in.
    const inDir = join(hostDir, "in");
    mkdirSync(inDir);
    writeFileSync(join(inDir, "task.txt"), "kind-ci-task\n");
    const syncIn = await plugin.definition.onEnvironmentSyncIn!({
      ...base, lease,
      operations: [{ operationId: "in-1", files: [{ sourcePath: inDir, targetPath: "/workspace", kind: "directory" }] }],
    });
    lap("sync in");
    expect(syncIn.operations[0].filesTransferred).toBeGreaterThanOrEqual(1);

    // 4. The agent run: the stub pi reads the task and writes the result, plus runtime state to scrub.
    const run = await plugin.definition.onEnvironmentExecute!({
      ...base, lease, command: "pi", args: ["run"], cwd: "/workspace", timeoutMs: 60_000,
    });
    lap("agent run");
    expect(run.exitCode, `agent run failed: ${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("pi-stub: finished");

    // 5. Workspace sync out.
    const outDir = join(hostDir, "out");
    mkdirSync(outDir);
    const syncOut = await plugin.definition.onEnvironmentSyncOut!({
      ...base, lease,
      operations: [{ operationId: "out-1", files: [{ sourcePath: "/workspace", targetPath: outDir, kind: "directory" }] }],
    });
    lap("sync out");
    expect(syncOut.operations[0].filesTransferred).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(outDir, "result.txt"), "utf-8").trim()).toBe("pi-stub-done: kind-ci-task");

    // 6. Scrub: resuming a reusable lease kills stray processes and empties runtime state.
    const before = await plugin.definition.onEnvironmentExecute!({
      ...base, lease, command: "sh", args: ["-c", "test -e /workspace/.paperclip-runtime && test -e /tmp/pi-scratch"], timeoutMs: 30_000,
    });
    expect(before.exitCode, `pre-scrub state missing: ${before.stderr}`).toBe(0);
    const resumed = await plugin.definition.onEnvironmentResumeLease!({
      ...base,
      providerLeaseId: lease.providerLeaseId!,
      leaseMetadata: { ...(lease.metadata ?? {}), reusableSandboxLease: { adapterType: "pi_local" } },
    });
    lap("resume + scrub");
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    const after = await plugin.definition.onEnvironmentExecute!({
      ...base, lease: resumed, command: "sh",
      args: ["-c", "test ! -e /workspace/.paperclip-runtime && test ! -e /tmp/pi-scratch && test ! -e /home/paperclip/pi-home-file && test -f /workspace/result.txt"],
      timeoutMs: 30_000,
    });
    expect(after.exitCode, `scrub left state behind: ${after.stderr}`).toBe(0);

    // 7. Release: the Sandbox and its owned Secret go away.
    await plugin.definition.onEnvironmentReleaseLease!({
      ...base, providerLeaseId: lease.providerLeaseId!, leaseMetadata: resumed.metadata,
    });
    lap("release");
    const deadline = Date.now() + 60_000;
    let left = "x";
    while (Date.now() < deadline) {
      left = admin(["get", "sandboxes.agents.x-k8s.io,secrets,pods", "-n", NAMESPACE, "-o", "name"]);
      if (!left.includes(lease.providerLeaseId!)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(left).not.toContain(lease.providerLeaseId!);
    expect(existsSync(join(outDir, "result.txt"))).toBe(true);
  });
});
