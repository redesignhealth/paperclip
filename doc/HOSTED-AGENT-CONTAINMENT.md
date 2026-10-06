# Hosted agent containment (TECH-7095)

Scope: what stops an AI agent running on a **hosted** Paperclip server (ECS Fargate, `authenticated`
deployment) from reaching the server's secrets or other agents' data. This document says what is
closed, what is only mitigated, and what is **not** solved. Do not read more into it than it says.

## 1. Threat model

**Attacker.** An LLM agent with a terminal or tool that can run arbitrary commands, steered by prompt
injection, malicious repository content, or a poisoned tool result. It runs as a child process of the
server, as the **same OS user** (`node`, uid 1000), in the **same container** (same mount, PID and
network namespaces) as the server. It starts with no root, no extra capabilities, no AWS credentials
and no run token for any other run.

**Assets.**

| Asset | Where it lives (hosted dev) |
|---|---|
| Database URL, auth secret (also signs agent JWTs), secrets master key, SSO provider config (Okta client secret), provider API keys the server holds | The server's process environment |
| Task-role credentials | The ECS credential endpoint `169.254.170.2`; the per-task path is in the server's environment |
| Decision-signing key | A file on the shared EFS volume unless `PAPERCLIP_DECISION_SIGNING_SECRET` is set |
| Other agents'/companies' workspaces, provider logins, run logs, transcripts, attachments, **database backups** | The shared EFS volume mounted at `/paperclip` |
| The server's own code | `/app` |

**Threats.**

- **T1. Same-user `/proc` inspection.** Any same-user process can read `/proc/<server-pid>/environ`
  and so every secret in the server's environment. This is total compromise: the auth secret mints
  JWTs for any company, the database URL reaches every tenant, the master key decrypts stored
  secrets.
- **T2. Shared `/paperclip`.** Every agent can read (and write) every other agent's and company's
  files, the decision-signing key and the database backups, because they share one uid and one mount.
- **T3. ECS task-role endpoint.** The credential endpoint is reachable from every process in the task.
  An agent that obtains the per-task path can fetch the task role's credentials.
- **T4 (found during research). Writable server code.** `/app` was owned by `node`, so an agent could
  rewrite modules the server loads later.

## 2. What this change does

| Threat | Change | Status |
|---|---|---|
| T1 | The server starts from `/usr/local/libexec/paperclip-node`, a **root-owned, exec-only (mode 0111) copy of node**. The kernel marks a process that exec'd a binary its user cannot read as non-dumpable, so `/proc/<pid>/environ`, `fd` and `mem` become root-owned and unreadable to the agent. Agents keep the normal `/usr/local/bin/node`, so they are unaffected. | **Closed for the server process** (not for siblings, see §3) |
| T3 | The per-task credential path lives in the server's environment. With T1 closed the agent cannot read it, and the strict child environment (TECH-7076) already keeps it out of the agent's own environment. | **Mitigated**, not closed: the endpoint itself stays reachable and its path is an unguessable id, not a secret protected by the network |
| T4 | `/app` is root-owned and read-only to `node`. | **Closed** (runtime state is under `/paperclip` and the temp directory) |
| T1 (helpers) | `tar` helpers (`ssh.ts`, `sandbox-managed-runtime.ts`) get the strict allowlisted base environment instead of the server's full environment. `pg_dump` takes the database URL from libpq environment variables instead of `--dbname=<url>` on argv (argv is world-readable through `/proc/<pid>/cmdline`) and gets a reduced environment. | **Closed** for those helpers |
| Verification | At startup an authenticated server probes itself the way an agent would (a same-user child tries to open the server's `/proc/<pid>/environ`) and logs the result. `PAPERCLIP_REQUIRE_NONDUMPABLE=true` makes startup fail for either an inspectable or undeterminable result; unset remains warn-only for inspectable results and non-failing for undeterminable results. | Guard, not a control |

### Side effects of the exec-only node

- The server cannot read its **own** `/proc/self/environ` or its own binary. Nothing in `server/src`
  does. The server's `/proc/self/fd/<dirfd>/<name>` file opening (`runner-api-files.ts`,
  `native-runner-file-handoff.ts`) still works (covered by a test).
- Children the server starts with `process.execPath` (plugin workers, the worktree seed CLI) are also
  non-dumpable. That is wanted. Children started through other binaries (`git`, `sh`, agent CLIs) are
  dumpable again, as before.
- The image carries a second copy of node (about 120 MB).

The comms-board provisioner captures its two control-plane tokens and two endpoint URLs at the first
bootstrap import. All four must be in the initial process environment before the server or Paperclip CLI
starts. The CLI deliberately skips these four variables when loading its env file. The tokens are
removed from the live environment after bootstrap and later dotenv/config loads, while captured URLs
remain available there. This prevents default-environment children and late dotenv values from using the
control-plane credentials, but it is not the T1 control: protection of the server's initial environment
still relies on the existing root-owned, exec-only node binary and the resulting non-dumpable process.

## 3. What is NOT solved (do not claim it is)

- **Sibling agents.** Agent processes are the same uid and dumpable, so one agent can still read
  another agent's `/proc/<pid>/environ` (run token, managed provider key). Closing this needs agents in
  separate PID namespaces or separate tasks.
- **Shared `/paperclip`.** All agents still share one volume and one uid. The EFS access point's
  `posix_user` (uid 1000) is applied to **every** NFS request, so a second OS user inside the task
  would still have uid-1000 rights under `/paperclip`. File separation needs per-agent/per-run access
  points or agents running outside the server's task.
- **Task-role endpoint reachability.** Not blocked. Blocking it needs `NET_ADMIN` (unavailable on
  Fargate) or running agents in a task without a task role.
- **The worktree seed CLI** (`routes/execution-workspaces.ts`) still receives the server's full
  environment. It runs through `process.execPath`, so it is non-dumpable, but any grandchildren it
  starts through other binaries inherit that environment while they run. Narrowing it needs knowledge
  of what the seed CLI reads.
- Kernel behaviour on **Fargate** (Yama scope, `suid_dumpable`, seccomp, user namespaces) is
  **unverified**; tested only in a Docker VM (Linux 6.12). The startup self-check exists to confirm it
  on the real platform. The bubblewrap lane (`filesystemScope`) has never been run inside a container
  and bubblewrap is not in the image.
- The broader authority of other `PAPERCLIP_*` values loaded from `.env` is out of scope for this
  four-key guard (TECH-7219). This change closes the comms provisioner token and URL mixed-source path,
  but does not make the whole server environment trust-safe.

The structural fix for sibling agents, the shared volume and the endpoint together is to run agent
execution **outside the server's task** (a separate ECS task/service without the server's task role and
volume, or an existing sandbox provider such as the Kubernetes one). There is no ECS provider today.
That is a separate decision and is not part of this change.

## 4. Infrastructure spec (rh-paperclip; not applied by this change)

Written for the owner of the deployment repo. Nothing here is done by the Paperclip code change.

1. Set `PAPERCLIP_DECISION_SIGNING_SECRET` from a secret so the signing key is not a file on EFS.
2. Move database backups off the shared volume, or disable them (`PAPERCLIP_DB_BACKUP_ENABLED=false`, or `database.backup.enabled` in `config.json`; the default is on);
   they are readable by every agent and, with the master key, expose every tenant's secrets.
3. Keep the **task role least-privilege** and enable the permissions boundary. Today it allows only
   `ssmmessages:*Channel` and EFS `ClientMount/ClientWrite`; any future grant (Bedrock, S3, Secrets
   Manager) becomes agent-stealable until agents run outside this task.
4. Do not enable ECS Exec in production (it adds the `ssmmessages` statement and an interactive path).
5. Add an `aws_efs_file_system_policy` that requires the access point and TLS; the Tailscale state file
   system currently has no access point and no policy and is reachable from the task security group.
6. A later deployment change may set `PAPERCLIP_REQUIRE_NONDUMPABLE=true` once the self-check has
   confirmed `protected` on Fargate, so a regression fails the deployment instead of only logging.
   This code change does not apply that production flag or change the deployment image pin.
7. Longer term: run agents outside the server task (see §3).

## 5. How to verify

- Unit/contract tests: `server/src/__tests__/server-process-hardening.test.ts` (the real-kernel cases
  run on Linux as a non-root user and are skipped elsewhere), `server/src/__tests__/docker-hermes-cli.test.ts`
  ("hosted agent containment"), `packages/db/src/backup-pg-dump-invocation.test.ts`.
- In a built image, as the runtime user:

  ```bash
  # the server (exec-only node) must NOT be readable by a same-user child
  docker run --rm --user node --entrypoint sh <image> -c \
    '/usr/local/libexec/paperclip-node -e "setInterval(()=>{},1000)" & sleep 1; \
     head -c 1 /proc/$!/environ >/dev/null && echo INSPECTABLE || echo PROTECTED'
  ```

- At runtime: look for `server process is not inspectable by same-user children` in the startup log.
