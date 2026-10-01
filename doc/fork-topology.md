# Paperclip fork/branch topology

Snapshot as of 2026-08-10, reflecting the state after PR #10's Argus review loop
and the two follow-up fixes (#12 lockfile, #13 OpenAPI, #14 test assertions) merged.

```mermaid
flowchart TB
    subgraph upstream["paperclipai/paperclip (upstream, OSS)"]
        upstream_main["main"]
        pr11068["#11068 lockfile refresh (merged 2026-08-07)<br/>-- silently dropped by our fork's snapshot-style sync"]
        pr11144["#11144 (open, mergeable: UNKNOWN)<br/>mirrors our fork PR #10 (connection grants)"]
        pr11162["#11162 (open, MERGEABLE)<br/>mirrors our fork PRs #2/#5/#6 (agent ownership)<br/>blocked on openapi-routes.test.ts -- TECH-5039"]
        upstream_main -.merged.-> pr11068
        upstream_main --> pr11144
        upstream_main --> pr11162
    end

    subgraph fork["redesignhealth/paperclip (our fork)"]
        fork_master["master"]
        pr8["#8 chore: sync upstream into fork<br/>(single-parent snapshot copy -- root cause<br/>of the lockfile drift bug)"]
        pr2_5_6["#2 #5 #6 agent ownership + roles<br/>(TECH-4929 / TECH-4930, merged)"]
        pr10["#10 per-user connection grants<br/>(TECH-4994) -- 9-round Argus loop, merged"]
        pr12["#12 fix pnpm-lock.yaml drift (merged)"]
        pr13["#13 fix OpenAPI agent-ownership routes (merged)"]
        pr14["#14 fix agent-permissions/skills<br/>ownership-arg test assertions (merged)"]
        pr9_stale["#9 (OPEN, likely stale/superseded by #10 -- not yet closed)"]
        pr11["#11 feat(sso): universal SSO/OIDC (TECH-4916)<br/>OPEN -- Argus review loop starting next"]
        sso_upstream_fixes["topic/sso-upstream-fixes<br/>(nizepart's SSO hardening, staged,<br/>blocked on #11 landing first)"]

        fork_master --> pr2_5_6 --> pr8
        pr8 --> pr10 --> pr12 --> pr13 --> pr14
        fork_master -.still open, unmerged.-> pr9_stale
        fork_master --> pr11
        fork_master -.not yet merged.-> sso_upstream_fixes
    end

    subgraph nizepart["nizepart/paperclip (third-party fork)"]
        nize_branch["nizepart/feat/universal-sso-oidc-support"]
        nize_pr1["#1 Harden SSO dev setup +<br/>instance-settings typing (OPEN)"]
        nize_branch --> nize_pr1
    end

    subgraph infra["Deployment/infra repos"]
        rh_paperclip["redesignhealth/rh-paperclip<br/>Terraform (ECS Fargate + Tailscale),<br/>image-build CI pinned to upstream releases,<br/>org config, plugins/skills.<br/>Carries only the SSO patch."]
    end

    subgraph linear["Linear tickets (handoff tracking)"]
        tech5039["TECH-5039: unblock #11162<br/>(cherry-pick #13's fix)"]
        tech5040["TECH-5040: resolve #11144 conflicts<br/>against upstream main"]
    end

    upstream_main ==sync (currently lossy snapshot;<br/>should become a real merge<br/>-- see task #31, deprioritized)==> fork_master
    pr10 -.mirrors.-> pr11144
    pr2_5_6 -.mirrors.-> pr11162
    fork --> rh_paperclip
    nize_pr1 -.rebase onto fork master after #11 merges.-> sso_upstream_fixes
    tech5039 -.fixes.-> pr11162
    tech5040 -.fixes.-> pr11144

    style pr9_stale fill:#fff3cd,stroke:#b8860b
    style pr8 fill:#f8d7da,stroke:#c0392b
    style pr11 fill:#d4edda,stroke:#2e7d32
```

## Notes

- **Fork sync is currently lossy.** `#8` (the fork's most recent "sync upstream" commit) has a single parent, meaning it's a snapshot copy of upstream's tree rather than a real `git merge` preserving upstream's commit graph. This is why `#11068` (an upstream lockfile fix that merged *before* `#8`'s sync commit) never actually landed in the fork -- confirmed by `git merge-base --is-ancestor`. See task/ticket for a future fix (deprioritized for now -- see conversation).
- **`#9` looks stale.** It's an earlier, unmerged draft of the same connection-grants work that shipped as `#10`. Never closed. Worth closing manually to avoid confusion.
- **Two upstream mirror PRs are open and blocked**, each with its own fix identified and ticketed for another agent to pick up (`TECH-5039`, `TECH-5040`) rather than resolved directly in this session.
- **`nizepart/paperclip#1`** is deliberately sequenced *after* `#11` (our own SSO PR) lands, to avoid wasted rebase conflicts on the same code.
- **`rh-paperclip`** is a separate deployment/infra repo (Terraform + image-build CI), not a code fork -- it only carries the SSO patch reference, no app code fork of its own.
