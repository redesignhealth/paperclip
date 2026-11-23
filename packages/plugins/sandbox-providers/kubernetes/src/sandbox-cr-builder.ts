/**
 * Builds a kubernetes-sigs/agent-sandbox Sandbox CR manifest.
 *
 * The Sandbox CR creates a long-lived pod (sleep infinity entrypoint) into
 * which paperclip-server can exec arbitrary commands. This solves the
 * architectural mismatch with the batch/v1 Job backend, which only supports
 * a single one-shot entrypoint — not the multi-command adapter-install pattern
 * used by paperclip-server.
 *
 * Security baseline is identical to buildJobManifest (pod-spec-builder.ts):
 * non-root, drop ALL caps, read-only rootFS, Tini PID 1, seccomp
 * RuntimeDefault, fsGroupChangePolicy OnRootMismatch, automountSAToken=false.
 *
 * NOTE: paperclip-server runs OUTSIDE the cluster, so we cannot set ownerReferences
 * on the Sandbox CR (the owner would need to be an in-cluster resource). The
 * release path is explicit delete via sandboxCrOrchestrator.release().
 */

/**
 * Dependency cache that survives the between-turn scrub (TECH-9789).
 *
 * The scrub (pod-scrub.ts) empties home, `.cache` and `/tmp` and every cold
 * install repeats: 13-70 s at 2 CPU versus 0.4-4 s warm. `/deps` is a fifth
 * emptyDir the scrub never touches, so it lives as long as the reused pod. It is
 * outside `/workspace`, so it is never synced to the server. It holds only
 * public package downloads: no credential is written here, because the per-run
 * secrets reach the container only as env vars. Sized above the measured
 * 700-773 MB uv cache per service, with room for several services and pnpm/npm.
 */
export const DEPS_MOUNT_PATH = "/deps";
export const DEPS_VOLUME_SIZE_LIMIT = "4Gi";

/** Non-secret env pointing the package managers at the persisted volume. */
export const DEPS_CACHE_ENV: ReadonlyArray<{ name: string; value: string }> = [
  { name: "UV_CACHE_DIR", value: `${DEPS_MOUNT_PATH}/uv` },
  { name: "npm_config_cache", value: `${DEPS_MOUNT_PATH}/npm` },
  { name: "PIP_CACHE_DIR", value: `${DEPS_MOUNT_PATH}/pip` },
];

export interface BuildSandboxCrManifestInput {
  namespace: string;
  sandboxName: string;
  adapterType: string;
  image: string;
  envSecretName: string;
  serviceAccountName: string;
  labels: Record<string, string>;
  resources: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  runtimeClassName?: string;
  imagePullSecrets?: string[];
}

export function buildSandboxCrManifest(
  input: BuildSandboxCrManifestInput,
): Record<string, unknown> {
  const podLabels: Record<string, string> = {
    ...input.labels,
    "paperclip.io/role": "agent",
  };
  return {
    apiVersion: "agents.x-k8s.io/v1alpha1",
    kind: "Sandbox",
    metadata: {
      name: input.sandboxName,
      namespace: input.namespace,
      labels: { ...input.labels },
      // No ownerReferences: paperclip-server is out-of-cluster. Release is
      // explicit delete.
    },
    spec: {
      podTemplate: {
        metadata: {
          labels: podLabels,
        },
        spec: {
          serviceAccountName: input.serviceAccountName,
          // Agent containers call back to paperclip-server via HTTPS egress;
          // they never call the Kubernetes API, so mounting an SA token is
          // unnecessary attack surface.
          automountServiceAccountToken: false,
          // Sandbox controller requires restartPolicy: Always so the pod
          // stays running between exec calls.
          restartPolicy: "Always",
          ...(input.runtimeClassName
            ? { runtimeClassName: input.runtimeClassName }
            : {}),
          ...(input.imagePullSecrets && input.imagePullSecrets.length > 0
            ? {
                imagePullSecrets: input.imagePullSecrets.map((name) => ({
                  name,
                })),
              }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "agent",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              // sleep infinity keeps the pod running; paperclip-server execs
              // commands into it via Kubernetes exec API. Tini as PID 1 for
              // proper signal forwarding and zombie reaping.
              command: [
                "/usr/bin/tini",
                "--",
                "/bin/sh",
                "-c",
                "sleep infinity",
              ],
              // HOME must point at a writable mount; the image's default
               // HOME=/home/node is inside the readOnly root filesystem.
               // Claude (and most agent runtimes) silently exit with code 0
               // and no output when HOME is unwritable, so set this explicitly.
              env: [
                { name: "HOME", value: "/home/paperclip" },
                ...DEPS_CACHE_ENV,
              ],
              envFrom: [{ secretRef: { name: input.envSecretName } }],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: input.resources.requests ?? {
                  cpu: "250m",
                  memory: "512Mi",
                },
                limits: input.resources.limits ?? {
                  cpu: "2",
                  memory: "4Gi",
                },
              },
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "home", mountPath: "/home/paperclip" },
                { name: "cache", mountPath: "/home/paperclip/.cache" },
                { name: "tmp", mountPath: "/tmp" },
                { name: "deps", mountPath: DEPS_MOUNT_PATH },
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: { sizeLimit: "8Gi" } },
            { name: "home", emptyDir: { sizeLimit: "1Gi" } },
            { name: "cache", emptyDir: { sizeLimit: "1Gi" } },
            { name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
            { name: "deps", emptyDir: { sizeLimit: DEPS_VOLUME_SIZE_LIMIT } },
          ],
        },
      },
    },
  };
}
