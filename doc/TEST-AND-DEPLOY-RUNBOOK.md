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

Smoke (seconds), as in `server/src/__tests__/docker-hermes-cli.test.ts`:

```bash
I=paperclip:<merge-sha>
docker run --rm --entrypoint sh $I -c 'ls /opt/hermes/.hermes-production-closure && /opt/hermes/bin/python3 -c "import mem0, psycopg, psycopg2; print(\"imports ok\")"'
docker run --rm --entrypoint sh $I -c 'grep -o "datallowconn = true" /app/server/dist/services/company-memory-databases.js | head -1'
docker run --rm --user node --entrypoint sh $I -c '/usr/local/libexec/paperclip-node -e "setInterval(()=>{},1000)" & sleep 1; head -c 1 /proc/$!/environ >/dev/null 2>&1 && echo INSPECTABLE || echo PROTECTED'
```

Expected: closure file present, `imports ok`, the `datallowconn = true` match, `PROTECTED`.
`/app` is read-only to the `node` user (TECH-7095); run read-only checks as `--user node`, not root.

Full local E2E on the same image (required before a live deploy of anything that touches runtime, memory or
agent execution):

```bash
IMAGE=<image ref, or a digest ref such as <ecr-repo>@sha256:...> \
E2E_ANTHROPIC_SSM=<ssm param name> E2E_OPENAI_SSM=<ssm param name> AWS_PROFILE=rh \
  scripts/e2e-hosted-memory-local.sh
```

It exits non-zero on any failed check and prints `E2E RESULT: PASS|FAIL`. It creates and deletes its own
containers, volumes and a mode-0700 work dir (set `E2E_KEEP=1` to keep them for debugging; that work dir
then holds credentials, so delete it). Provider keys come from `TEST_ANTHROPIC_API_KEY` /
`TEST_OPENAI_API_KEY` or the SSM parameters above, and are never printed. What it does:

- Postgres 17 + pgvector with TLS, in the AWS-RDS shape (template0 keeps PUBLIC CONNECT but `datallowconn=false`,
  `vector` in `template1`, PUBLIC CONNECT revoked elsewhere, non-superuser memory admin).
- Paperclip container from the image in `authenticated` mode, memory enabled for one company, bootstrap-ceo
  invite plus sign-up through the image's own CLI.
- Company A: a write agent stores a random marker; a different agent recalls it with no marker in its prompt;
  the Paperclip container is destroyed and recreated on the same volumes and recall is repeated.
- Company B (not allowlisted): no runtime memory config, no marker, no memory row.
- Checks the tenant role cannot connect to any other connectable database and is unprivileged, the TECH-7095
  startup self-check says `protected`, and no key, password or unmasked DSN is in the server or run logs.

Things this taught us, so you do not rediscover them:

- Agents are driven by an issue assigned to them. A wakeup with no task fails before the model runs when the
  caller is a signed-in user (the runtime connection tools require a task-bound run), and a wakeup's
  `payload.instruction` is never read by Hermes. New agents cannot set `adapterConfig.promptTemplate`; use the
  issue text or `instructionsBundle`/`AGENTS.md`.
- `PAPERCLIP_API_URL` must be reachable from inside the container; Hermes preflights the runtime MCP endpoint on it.
- Better Auth trusts origins built from `PAPERCLIP_ALLOWED_HOSTNAMES` plus the *listen* port, so a published host
  port must be listed explicitly (`localhost:<port>`).
- The memory runtime config is hardcoded to OpenAI for both the LLM and the embedder, so an `OPENAI_API_KEY`
  secret must be bound to the agent next to the Anthropic one.
- On an arm64 host a linux/amd64 image runs under emulation and is slow. Iterate on a native build, then run the
  shipping image once. `grep -q` after a pipe under `set -o pipefail` can fail spuriously; capture output first.

## 4. Push and deploy

Push (profile `rh`):

```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 082533342824.dkr.ecr.us-east-1.amazonaws.com
docker tag paperclip:<merge-sha> 082533342824.dkr.ecr.us-east-1.amazonaws.com/rh-platform-dev/apps/paperclip:sha-<merge-sha>
docker push 082533342824.dkr.ecr.us-east-1.amazonaws.com/rh-platform-dev/apps/paperclip:sha-<merge-sha>
aws ecr describe-images --repository-name rh-platform-dev/apps/paperclip --image-ids imageTag=sha-<merge-sha> --query 'imageDetails[0].imageDigest'
```

Terraform (pinned binary, deployment root of the rh-paperclip repo, `terraform/environments/dev`): pass the exact
existing live variables, changing only `image_tag=sha-<merge-sha>`. Keep `enable_paperclip_role_boundary=false`
until the boundary policy exists. Save the plan (`-out`), review it, apply that saved plan.

Reject the plan if it shows: RDS or EFS replacement/delete, memory disabled, a broadened pilot list, a mutable
image tag, or anything unrelated to the task definition and service rollout. A task-definition replacement and
service rollout are expected.

After apply, `aws ecs wait services-stable`, then re-plan with the same variables: it must show no changes.

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

Rollback: re-apply Terraform with the previous known-good `image_tag` (the prior `sha-...`), or `aws ecs
update-service --task-definition <previous revision>`; wait for `services-stable`. To turn memory off without a
rollback set `memory_tenant_isolation_enabled=false` (exact lowercase), which makes agents run without memory.

## 7. Known gaps

- No CI job builds and pushes the dev ECR image from this repo's master; the push above is manual. Two sessions can race to publish the same immutable tag; check
  `aws ecr describe-images` for the tag before pushing and say on the coordination board who is publishing.
- The E2E uses real provider keys and makes a few small model calls per run.
