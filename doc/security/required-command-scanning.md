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
  (mode `0755`), with a root-owned non-writable profile directory (`/usr/local/share/hermes-command-scan/home`, mode `0555`).
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
deny execution. Three scanner execution failures open the breaker; after the
cooldown, only one bounded probe may run, and only a valid clean allow closes
it.

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

Packaging qualifies both Linux `amd64` and `arm64` native binaries with checksum
pins in the Dockerfile and patch. The full production candidate container image build
qualification has been completed on `linux/amd64` (deployed fleet), while native ARM64
full production image build remains pending fleet CI verification.

## Rollout, Migration, and Operator Known Behaviors

- **Default ON**: `PAPERCLIP_HERMES_COMMAND_SCAN=required` is enabled by default in the candidate production image.
- **Legitimate Command Impacts**:
  - Unencrypted HTTP in download/execution contexts (e.g. `curl http://...`) is blocked fail-closed; commands must use HTTPS.
  - Direct shell piping (`curl ... | sh`, `wget ... | bash`) is blocked fail-closed.
  - Ad-hoc `npm install <pkg>` without pre-resolved lockfiles triggers Tirith `analysis_incomplete` warnings in offline mode and is denied. Autonomous workflows should use pre-resolved lockfiles (`npm ci`) or pre-installed dependencies.
  - Commands flagged for human review in interactive/gateway mode that are approved and replayed with `force=True` are permitted if the scanner returns clean allow (and floors pass); human approval cannot override scanner block/warn/error findings.
- **Rollout and Rollback**:
  - Rollback strategy: In case of unexpected production issues, roll back to the previously qualified candidate image artifact (`paperclip:previous`) rather than attempting in-place downgrades or disabling security policies via untrusted runtime flags.
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
