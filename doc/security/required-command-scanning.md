# Required Hermes command scanning

This document describes the command-scanning controls currently implemented for
the Hermes adapter. It is an execution guard for terminal commands, not a
general sandbox or content-inspection system.

## What is shipped

- The image builds Hermes from a checksum-locked, reviewed in-repository source
  and patch set. The verified upstream is Hermes `0.21.3`; the applied extension
  identifies itself as `0.21.3+tech7355.1`. This is a reviewed extension of the
  upstream release, not an unmodified upstream installation.
- The scanner is the pinned RustTirith/Tirith `0.4.2` release, with multi-architecture
  packaging for native `linux/amd64` and `linux/arm64`. Both the
  archive and extracted binary are checksum-verified during the image build for both
  architectures. The scanner is installed as a root-owned, executable regular file
  that is not group- or world-writable, with a root-owned non-writable profile
  directory (`/usr/local/share/hermes-command-scan/home`). The runtime checks
  these trust properties rather than requiring one exact numeric mode.
- The scanner is not installed from a pip package and is not downloaded by a
  floating runtime installer. Hermes's locked source and dependency closure
  are installed separately from the scanner binary.
- The production image sets the parent policy
  `PAPERCLIP_HERMES_COMMAND_SCAN=required`.

## Enforcement

When the parent policy is required, the adapter applies the policy after
runtime profile/provider environment assembly and immediately before spawning
Hermes. It validates the launcher, rejects reserved command-scan bypass flags,
removes scanner, YOLO, Python loader, and dynamic-loader overrides, then
re-pins the scanner path and required Hermes settings. The user's ordinary
`PATH` and unrelated environment values remain available.

Hermes's patched terminal approval path runs the mandatory scan before YOLO,
permissive approval, force/replay, or other auto-approval paths. A clean scan
can therefore allow a command under those modes; those modes cannot skip the
scan. Missing or untrusted scanner binaries, unsupported architecture, timeout,
spawn or execution failures, malformed output, and an open circuit breaker all
deny execution. A schema-valid `allow`, `block`, or `warn` result demonstrates
scanner health for breaker health/reset handling, but only `allow` authorizes
the current command: `block` and `warn` still deny it. Three scanner execution
failures open the breaker; after the cooldown, only one bounded probe may run.

The scan is non-interactive and offline. `--offline` means runtime network
intelligence and cache-backed lookups are unavailable. For example, an
`npm install package` result may contain an `analysis_incomplete` warning and
is denied in mandatory mode, while `npm ci`, HTTPS/git commands, and a benign
`python -c 'print(...)'` command can remain available when the scanner returns
clean. This is a current limitation, not a claim that all legitimate workflows
are unaffected.

The coverage is deliberately limited to terminal-command filtering. It does
not claim coverage for sandbox policy, `execute_code`, MCP calls, file reads or
writes, dependency provenance beyond the scanner's command verdict, or other
execution surfaces.

Direct child processes spawned inside `execute_code` scripts (such as `subprocess.run()` or `os.system()` in Python) do not route through terminal command checking and bypass this scanner layer. Conversely, any `terminal()` tool invocations issued from an agent workflow or script context are strictly routed through mandatory command scanning and will be rejected fail-closed if blocked by the scanner. Furthermore, terminal script execution scans the invocation command string itself (e.g. `python3 script.py`), not the arbitrary file contents of the script on disk. This mechanism is an execution guard for terminal command strings, not a containment sandbox.

Outside an image configured with the parent policy, the adapter helper retains
its existing development behavior when the parent variable is not exactly
`required`. That is a development-mode behavior only; this document does not
provide an operator recipe for disabling scanning in production. There are no
supported exception, weakening, or scanner-silencing flags.

## Qualification

Qualification should remain scoped and disposable:

1. Run the focused Python and TypeScript regression tests for the scanner,
   patched Hermes guard, adapter launch policy, and lock/patch verification.
2. Exercise the actual entrypoint and checker in a disposable offline image as
   UID 1000 with a fresh home. Include clean, blocked, malformed, unavailable,
   timeout, and circuit-breaker cases, including recovery after the single
   half-open probe.
3. Verify all bypass routes: YOLO, force/replay, container/permissive approval,
   reserved CLI flags, launcher substitution, environment overrides, and
   missing or altered scanner state.

These tests should use command strings and mocked or controlled scanner data;
they must not execute malicious commands or use real user commands,
credentials, or production data. A passing scoped test set is not evidence that
the full production image was built or deployed.

## Packaging, Architecture, and Builder Requirements

- **Binary Checksums**: The Dockerfile pins the native Tirith `0.4.2` tarball and binary SHA-256 checksums for both `amd64` and `arm64`. The `docker/hermes/patches.lock` manifest separately pins the patch SHA-256 and upstream Hermes source SHA-256.
- **Architecture Qualification**: Native Tirith `0.4.2` CLI execution and offline scan probes are qualified for both `amd64` and `arm64`. The full candidate production container image has been qualified offline for `linux/amd64`; the full ARM64 image remains pending. A shared development image and the full Paperclip server image are not yet qualified by those results. Do not describe either pending image as deployed or qualified.
- **Docker Builder Requirements**: BuildKit automatically supplies the `TARGETARCH` build argument during multi-platform builds. With a legacy builder, pass an explicit `--build-arg TARGETARCH=amd64` or `--build-arg TARGETARCH=arm64`; the Dockerfile fails fast when it is absent.

## Rollout, Migration, and Operator Known Behaviors

- **Default ON**: `PAPERCLIP_HERMES_COMMAND_SCAN=required` is enabled by default in the candidate production image.
- **Launcher Validation & Resolution**: On Linux in production (`NODE_ENV=production`), the launcher binary must exist on disk and be a root-owned executable regular file that is not group- or world-writable before spawn. The canonical runtime path is the trusted root; parent-directory ancestry hardening remains a future check unless separately verified. In non-production environments without pre-installed local Hermes binaries, the launcher resolves to the canonical path and relies on normal process spawn diagnostics.
- **Legitimate Command Impacts**:
  - Unencrypted HTTP in download/execution contexts (e.g. `curl http://...`) is blocked fail-closed; commands must use HTTPS.
  - Direct shell piping (`curl ... | sh`, `wget ... | bash`) is blocked fail-closed.
  - Ad-hoc `npm install <pkg>` without pre-resolved lockfiles triggers Tirith `analysis_incomplete` warnings in offline mode and is denied. Autonomous workflows should use pre-resolved lockfiles (`npm ci`) or pre-installed dependencies.
  - Commands flagged for human review in interactive/gateway mode that are approved and replayed with `force=True` are permitted if the scanner returns clean allow (and floors pass). Consent, interactive approval, and pending-approval floors do not override the scanner; human approval cannot override scanner block, warn, or error findings.
- **Rollout and Rollback**:
  - Rollback strategy: In case of unexpected production issues, use the exact previously qualified immutable image SHA and verified registry platform digest (for example, `'<previously-qualified-image>@sha256:<verified-platform-manifest>'`). Do not use floating tags such as `:previous`, invent a publisher version tag, or perform an in-place downgrade. Restore through the normal fresh, saved Terraform plan and the full current variable set.
  - The security policy is operator-governed via the server environment (`PAPERCLIP_HERMES_COMMAND_SCAN`); agents cannot disable or alter the policy via CLI flags or child-process environment variables. The production default is `required`. Changing the policy is an explicit, reviewed deployment configuration delta; do not treat an unset variable as a kill switch. The operator may use only values supported by the deployed runtime's `getCommandScanMode` contract; this document does not add or infer values that the runtime does not expose. `block` and `warn` continue to deny the current scan even though schema-valid scanner output can satisfy breaker health/reset handling.
  - Preserves existing MCP configurations, database persistence, and provider profiles.

## Operator response

A blocked run should expose a concise reason such as `scanner_finding_blocked`,
`scanner_malformed_output`, `scanner_timeout`, `scanner_spawn_failed`,
`scanner_circuit_open`, `scanner_unavailable`, or
`scanner_unsupported_platform`. Detailed findings may be available to
diagnostics; handle them as sensitive and do not echo command contents or
secrets into user-facing output.
For a suspected legitimate false positive, preserve the exact command string
and scanner reason, confirm the image architecture and scanner ownership,
profile, checksum, and offline state, then reproduce in the disposable
qualification environment. Review or correct the command/workflow through the
normal change process; do not add bypass flags, alter the scanner environment,
silence the finding, or install an ad hoc replacement.

Live development or production use requires the normal reviewed, locked,
freshly saved plan and current settings, using the same tested artifact. Do not
perform ad hoc live installs or reset global MCP state as a workaround.
