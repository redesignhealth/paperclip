# Test and deploy runbook: Paperclip dev (ECS)

Status: sections 2 and 3 (build and local gate) were exercised end to end during TECH-7126. Sections 4 to 6
(push, Terraform, verification, rollback) describe the dev procedure as the orchestrator ran it; they were not
re-run when this was written, and the Terraform root and pinned binary live in the deployment repo, not here.
Scope: getting a merged Paperclip change onto `paperclip-dev` (account 082533342824, us-east-1,
cluster `rh-platform-dev-cluster`, service `paperclip-dev`). Never print or commit secret values.

## 1. Flow at a glance

1. PR: tests, Argus review (`argus-review-loop --auto`) to APPROVE, required CI green.
2. Merge (squash) only on an explicit go from the owner.
3. Build the image from the exact merge commit, `linux/amd64` (the Fargate task is x86_64).
4. Local gate on that exact image (section 3), including the E2E when the change touches runtime behavior.
5. Push to ECR with an immutable tag `sha-<40-char-merge-sha>`; record the digest. Never deploy a mutable tag.
6. Terraform plan, review against the reject list, apply the saved plan.
7. Verify (section 5). Roll back if a stop condition hits (section 6).

## 2. Build

```bash
git fetch origin master && git switch --detach origin/master          # a clean worktree
docker buildx build --platform linux/amd64 --target production \
  --build-arg PAPERCLIP_BUILD_COMMIT=<merge-sha> --load -t paperclip:<merge-sha> .
```

- Building amd64 on an Apple-silicon Mac is emulated and slow. For fast iteration build
  `--platform linux/arm64` first, then run the gate once more on the amd64 image you will push.
- Use `--target production`; the Dockerfile has a later `cloud` stage that would otherwise become the default.
- `docker images` shows the image ID; record it. The image you test must be the image you push.

## 3. Local gate on the built image (before any push)

Smoke (seconds). The default run of `server/src/__tests__/docker-hermes-cli.test.ts` checks the Dockerfile
statically (its live Docker suite needs `PAPERCLIP_RUN_DOCKER_HERMES_TESTS=true`); these commands run the
built image directly:

```bash
I=paperclip:<merge-sha>
docker run --rm --entrypoint sh $I -c 'ls /opt/hermes/.hermes-production-closure && /opt/hermes/bin/python3 -c "import mem0, psycopg, psycopg2; print(\"imports ok\")"'
docker run --rm --entrypoint sh $I -c 'grep -o "datallowconn = true" /app/server/dist/services/company-memory-databases.js | head -1'
docker run --rm --user node --entrypoint sh $I -c '/usr/local/libexec/paperclip-node -e "setInterval(()=>{},1000)" & p=$!; sleep 1; kill -0 $p 2>/dev/null || { echo "probe process died"; exit 1; }; if head -c 1 /proc/$p/environ >/dev/null 2>&1; then echo INSPECTABLE; else echo PROTECTED; fi'
```

Expected: closure file present, `imports ok`, the `datallowconn = true` match, `PROTECTED` (the probe prints
`probe process died` instead of a false `PROTECTED` if node exits early).
`/app` is read-only to the `node` user (TECH-7095); run read-only checks as `--user node`, not root.

Full local E2E on the same image is the required dev-first native memory gate
before any live deploy of runtime, memory, or agent-execution changes. It is a
disposable local Paperclip/Postgres harness; it does not test a remote DEV
endpoint and does not establish hosted authentication readiness:

```bash
IMAGE=<image ref, or a digest ref such as <ecr-repo>@sha256:...> \
E2E_ANTHROPIC_SSM=<ssm param name> E2E_OPENAI_SSM=<ssm param name> AWS_PROFILE=rh \
  scripts/e2e-hosted-memory-local.sh
```

It exits non-zero on any failed check and prints `E2E RESULT: PASS|FAIL`. Other variables: `PORT`
(default 3131, published on 127.0.0.1 only; the one resource two runs cannot share), `E2E_WAIT_RUN_SECONDS`
(per-run timeout, default 600), `E2E_HEALTH_SECONDS` (default 240; raise both for emulated amd64),
`E2E_PG_IMAGE` (default `pgvector/pgvector:pg17`). Needs Docker CLI 20.10+. It creates and deletes its own
containers, volumes and a mode-0700 work dir (set `E2E_KEEP=1` to keep them for debugging; that work dir
then holds credentials, so delete it). Provider keys come from `TEST_ANTHROPIC_API_KEY` /
`TEST_OPENAI_API_KEY` or the SSM parameters above, and are never printed. What it does:

- Postgres 17 + pgvector with TLS, in the AWS-RDS shape (template0 keeps PUBLIC CONNECT but `datallowconn=false`,
  `vector` in `template1`, PUBLIC CONNECT revoked elsewhere, non-superuser memory admin). This deliberately
  leaves template0 as observed on managed RDS, unlike the template0 line in `doc/COMPANY-MEMORY-RUNBOOK.md`
  section 2: the preflight (TECH-7126) ignores databases with `datallowconn=false` because nobody can connect
  to them, and the harness reproduces that state because it is what broke the earlier preflight.
- Paperclip container from the image in `authenticated` mode, memory enabled for one company, bootstrap-ceo
  invite plus sign-up through the image's own CLI.
- Company A: a write agent stores a random marker; a different agent recalls it with no marker in its prompt;
  the Paperclip container is destroyed and recreated on the same volumes and recall is repeated.
- In default `allowlist` mode, Company B is the non-eligible negative control.
  With `E2E_SCOPE=all`, both synthetic companies are eligible lazily and each
  must use its own database/role; neither mode is a backfill.
- Checks the tenant role cannot connect to any other connectable database and is unprivileged, and the TECH-7095
  startup self-check says `protected` in the final container (and no container says `inspectable`).
- Leak scan: the six secret values it generated or read (both provider keys, both database passwords, the auth
  secret and the master key), unmasked DSN passwords and SCRAM verifiers, across every Paperclip container's logs,
  the bootstrap CLI output, the Postgres log, the run logs as served by the API, and the raw on-disk run logs
  (the API redacts secrets, so the raw files are what can actually show a leak). It fails if no raw logs exist.

Things this taught us, so you do not rediscover them:

- Agents are driven by an issue assigned to them. A wakeup with no task fails before the model runs when the
  caller is a signed-in user (the runtime connection tools require a task-bound run), and a wakeup's
  `payload.instruction` is never read by Hermes. New agents cannot set `adapterConfig.promptTemplate`; use the
  issue text or `instructionsBundle`/`AGENTS.md`.
- `PAPERCLIP_API_URL` must be reachable from inside the container; Hermes preflights the runtime MCP endpoint on it.
- Better Auth trusts origins built from `PAPERCLIP_ALLOWED_HOSTNAMES` plus the *listen* port, so a published host
  port must be listed explicitly (`localhost:<port>`).
- Native Hermes memory requires the agent's company-scoped `OPENAI_API_KEY`
  secret reference to resolve into the adapter environment alongside the agent's
  Anthropic credential. A missing key is a readiness failure; the product does
  not silently skip memory or distribute a global provider key.
- On an arm64 host a linux/amd64 image runs under emulation and is slow. Iterate on a native build, then run the
  shipping image once. `grep -q` after a pipe under `set -o pipefail` can fail spuriously; capture output first.

## 4. Push and deploy

Push (profile `rh`):

```bash
export AWS_PROFILE=rh AWS_REGION=us-east-1
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 082533342824.dkr.ecr.us-east-1.amazonaws.com
docker tag paperclip:<merge-sha> 082533342824.dkr.ecr.us-east-1.amazonaws.com/rh-platform-dev/apps/paperclip:sha-<merge-sha>
docker push 082533342824.dkr.ecr.us-east-1.amazonaws.com/rh-platform-dev/apps/paperclip:sha-<merge-sha>
aws ecr describe-images --repository-name rh-platform-dev/apps/paperclip --image-ids imageTag=sha-<merge-sha> --query 'imageDetails[0].imageDigest'
```

Terraform (pinned binary, deployment root of the rh-paperclip repo, `terraform/environments/dev`): pass the exact
existing live variables, changing only `image_tag=sha-<merge-sha>`. Keep `enable_paperclip_role_boundary=false`
until the boundary policy exists. Save the plan (`-out`), review it, apply that saved plan.

Reject the plan if it shows: RDS or EFS replacement/delete, memory disabled (unless you are deliberately using the
kill switch in section 6), a broadened pilot list, a mutable image tag, or anything unrelated to the task definition and service rollout. A task-definition replacement and
service rollout are expected.

After apply, `aws ecs wait services-stable --cluster rh-platform-dev-cluster --services paperclip-dev`, then re-plan with the same variables: it must show no changes.

## 5. Verify the deployment

- Both containers (paperclip, tailscale) healthy; `/api/health` OK on the dev URL.
- New task definition revision references the intended image tag; running task shows the new task ID.
- Startup log: the TECH-7095 self-check line (`server process is not inspectable by same-user children` means
  protected). Do not set `PAPERCLIP_REQUIRE_NONDUMPABLE=true` until this reports protected on Fargate.
- RLS boot check passed as `paperclip_app`; memory flags and allowlist as expected in the task environment.
- Run the live smoke for the change (for memory: write, fresh recall, restart recall, other-company denial).
- Record merge SHA, image digest, task definition revision, run IDs and results on the Linear ticket.

## 6. Stop conditions and rollback

Stop and report on: cross-company access, secret or DSN in logs, a destructive Terraform plan, unrecoverable
state, or an image missing runtime dependencies.

Rollback: re-apply Terraform with the previous known-good `image_tag` (the prior `sha-...`). That is the path to
use. In an emergency you can point the service at the previous task definition revision directly, but that edit
is reverted by the next Terraform apply, so follow it with the Terraform change:

```bash
aws ecs update-service --cluster rh-platform-dev-cluster --service paperclip-dev --task-definition <previous revision>
aws ecs wait services-stable --cluster rh-platform-dev-cluster --services paperclip-dev
```

To turn memory off without an image rollback, set the Terraform variable `memory_tenant_isolation_enabled=false`
in the deployment repo and apply it; that variable is what sets the container's
`PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED` (exact lowercase `false`), so editing the ECS task by hand without
Terraform will be reverted on the next apply. The resulting plan will show memory being disabled; that is the
intended kill-switch diff, not a reason to reject it. Agents then run without memory.

## 7. Known gaps

- Nothing enforces the local gate: no CI job runs it (it makes real model calls) and nothing mechanically blocks a
  deploy that skips it. It is a team rule, so say on the coordination board that it was run and on which digest.
- No CI job builds and pushes the dev ECR image from this repo's master; the push above is manual. Two sessions can race to publish the same immutable tag; check
  `aws ecr describe-images` for the tag before pushing and say on the coordination board who is publishing.
- The E2E uses real provider keys and makes a few small model calls per run.
