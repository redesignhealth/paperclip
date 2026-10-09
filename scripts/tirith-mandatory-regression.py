#!/usr/bin/env python3
"""TECH-7355 independent security regression: mandatory Hermes command scan (Python side).

Run contract (matches the reviewer operating constraints):
    PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/tirith-mandatory-regression.py
    HERMES_UPSTREAM_TARBALL=<path to verified hermes-agent 0.21.3 source tarball>

Frozen-baseline reproduction mode (immune to in-flight production edits):
    ... scripts/tirith-mandatory-regression.py --from-commit 1c59ac5bb682cf24f5dbb3c62a3c530ae96f5d55
    Sources docker/hermes/patches.lock AND the patch file from that COMMIT via the git
    object DB (never the working tree), verifies their mutual sha256 pins, and runs the
    SAME suite against that committed state. Tests that encode the repaired contract
    FAIL there — that failure set IS the frozen, executed reproduction of the committed
    material failures (see the class docstrings). Repairs are later validated through
    these same files in default (working-tree) mode.

The suite is fully offline. It NEVER executes any command text under test — command
strings are DATA passed to guard/scanner functions only. The only subprocesses it
spawns are (a) `git apply`/`git show` on this repo's own locked artifacts, (b) a
benign, self-generated scanner STUB (a python script that records its argv/env/cwd
and prints a controlled JSON verdict, or floods/sleeps on purpose) plus short-lived
`python3 -c` workers for import-time isolation. No network, no tirith download,
no pip, no real user data, no credentials.

Supply chain: the upstream tarball sha256 and the patch sha256 are read from
docker/hermes/patches.lock (working tree, or the pinned commit in --from-commit mode)
and verified BEFORE anything is imported; the patch is applied to a private extraction
under a controlled temp dir (the immutable reference tree is never touched). Any hash
drift between lock and artifacts, or a patch that fails to apply to the verified
upstream source, FAILS the suite — never a silent skip.

Deliberately NOT duplicated from tests/tools/test_tirith_mandatory.py inside the
patch (which CI does not run): the unique value here is (1) the lock-verified patch
actually applying and importing, (2) guard-ORDERING instrumentation against every
permissive path, (3) the real-subprocess scanner argv/env/cwd/stdin contract via a
safe stub, (4) import-time frozen-state and real import-failure behavior, (5)
circuit-breaker half-open races under concurrency, (6) the timings_ms/urls/policy-path
typed-validation branches, signal/crash accounting, and the bounded-streaming
contract — each of which doubles as a frozen repro of a committed-baseline failure.

Exit codes: 0 = all pass, 1 = failures, 77 = honest SKIP (no upstream tarball
found; set HERMES_UPSTREAM_TARBALL). Skips are reported explicitly, never passes.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import platform
import shutil
import stat as stat_mod
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import threading
import time
import types
import unittest
from unittest import mock

# ── Mode selection (--from-commit <ref>) — must precede lock parsing ───────────────
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _extract_arg(flag: str) -> str | None:
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 >= len(sys.argv):
            raise SystemExit(f"usage: {flag} <git-ref>")
        value = sys.argv[i + 1]
        del sys.argv[i:i + 2]
        return value
    return None


FROM_COMMIT = _extract_arg("--from-commit")
DEFAULT_BASELINE_REF = "1c59ac5bb682cf24f5dbb3c62a3c530ae96f5d55"  # PR #69 as published


def _git_show(ref: str, path: str) -> bytes:
    out = subprocess.run(
        ["git", "-C", REPO_ROOT, "show", f"{ref}:{path}"], capture_output=True
    )
    if out.returncode != 0:
        raise RuntimeError(f"git show {ref}:{path} failed: {out.stderr.decode(errors='replace')}")
    return out.stdout


LOCK_REL = "docker/hermes/patches.lock"
PATCH_REL = "docker/hermes/patches/0001-require-command-scan.patch"
POSTPATCH_MARKER = "TECH-7355-MANDATORY-COMMAND-SCAN"
UPSTREAM_VERSION = "0.21.3"

if FROM_COMMIT:
    _lock_text = _git_show(FROM_COMMIT, LOCK_REL).decode("utf-8")
    LOCK: dict = {}
    for _line in _lock_text.splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            LOCK[_k.strip()] = _v.strip()
    PATCH_PATH = os.path.join(tempfile.gettempdir(), f"tirith-regression-baseline-{os.getpid()}.patch")
    with open(PATCH_PATH, "wb") as _f:
        _f.write(_git_show(FROM_COMMIT, PATCH_REL))
    sys.stderr.write(f"[tirith-mandatory-regression] FROZEN BASELINE mode: ref={FROM_COMMIT}\n")
else:
    LOCK_PATH = os.path.join(REPO_ROOT, LOCK_REL)
    with open(LOCK_PATH, encoding="utf-8") as _f:
        LOCK: dict = {}
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                LOCK[_k.strip()] = _v.strip()
    PATCH_PATH = os.path.join(REPO_ROOT, PATCH_REL)

UPSTREAM_SHA256 = LOCK["upstream_sha256"]
PATCH_SHA256 = LOCK["patch_sha256"]


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _find_tarball() -> str | None:
    env = os.environ.get("HERMES_UPSTREAM_TARBALL")
    if env and os.path.isfile(env):
        return env
    return None


TARBALL = _find_tarball()

CONTROL_BASE = tempfile.mkdtemp(prefix="tirith-mandatory-regression-")
CONTROL_HOME = os.path.join(CONTROL_BASE, "home")
CONTROL_TMP = os.path.join(CONTROL_BASE, "tmp")
os.makedirs(CONTROL_HOME, exist_ok=True)
os.makedirs(CONTROL_TMP, exist_ok=True)

# Controlled, sanitized process environment BEFORE importing any patched Hermes
# module: no HERMES_*/TIRITH_*/PAPERCLIP_* or provider/loader keys may influence the
# modules under test, and HOME/TMPDIR never point at a real user home.
_DROP_PREFIXES = (
    "HERMES_", "TIRITH_", "PAPERCLIP_", "ANTHROPIC_", "OPENAI_", "GEMINI_",
    "GOOGLE_", "AWS_", "SLACK", "LD_", "XDG_",
)
_DROP_EXACT = (
    "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONUSERBASE", "PYTHONNOUSERSITE",
    "HERMES_YOLO_MODE", "HERMES_REQUIRE_COMMAND_SCAN", "HERMES_COMMAND_SCANNER",
)
for _k in list(os.environ):
    if _k in _DROP_EXACT or any(_k.upper().startswith(_p) for _p in _DROP_PREFIXES):
        del os.environ[_k]
os.environ["HOME"] = CONTROL_HOME
os.environ["TMPDIR"] = CONTROL_TMP
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
_REAL_HOME = CONTROL_HOME  # retained for the "scanner HOME != user HOME" assertion


def _prepare_patched_tree() -> str:
    """Extract the hash-verified upstream source into a private tree and apply the
    hash-verified locked patch. Raises on any drift; never touches the reference tree."""
    if _sha256_file(TARBALL) != UPSTREAM_SHA256:
        raise RuntimeError(
            f"upstream tarball sha256 mismatch: {_sha256_file(TARBALL)} != {UPSTREAM_SHA256}"
        )
    if _sha256_file(PATCH_PATH) != PATCH_SHA256:
        raise RuntimeError(
            f"patch sha256 mismatch: {_sha256_file(PATCH_PATH)} != {PATCH_SHA256} (patches.lock drift)"
        )
    staging = os.path.join(CONTROL_BASE, "staging")
    os.makedirs(staging, exist_ok=True)
    with tarfile.open(TARBALL, "r:gz") as tf:
        tf.extractall(staging, filter="data")
    entries = [e for e in os.listdir(staging) if not e.startswith(".")]
    if len(entries) == 1 and os.path.isdir(os.path.join(staging, entries[0])):
        src = os.path.join(staging, entries[0])  # strip the single top-level dir
    else:
        src = staging
    with open(os.path.join(src, "pyproject.toml"), encoding="utf-8") as f:
        if f'version = "{UPSTREAM_VERSION}"' not in f.read():
            raise RuntimeError("extracted source is not hermes-agent 0.21.3")
    check = subprocess.run(
        ["git", "apply", "--check", PATCH_PATH], cwd=src, capture_output=True, text=True
    )
    if check.returncode != 0:
        raise RuntimeError(f"locked patch does not apply to verified upstream source: {check.stderr}")
    applied = subprocess.run(
        ["git", "apply", PATCH_PATH], cwd=src, capture_output=True, text=True
    )
    if applied.returncode != 0:
        raise RuntimeError(f"git apply failed: {applied.stderr}")
    with open(os.path.join(src, "tools", "tirith_security.py"), encoding="utf-8") as f:
        if POSTPATCH_MARKER not in f.read():
            raise RuntimeError("postpatch marker missing from patched tirith_security.py")
    return src


if TARBALL is None:
    # Honest skip: nothing fabricated, nothing passed.
    sys.stderr.write(
        "SKIP: no upstream tarball found. Set HERMES_UPSTREAM_TARBALL to the verified "
        "hermes-agent 0.21.3 source tarball (sha256 " + UPSTREAM_SHA256 + ").\n"
    )
    sys.exit(77)

SRCDIR = _prepare_patched_tree()
sys.path.insert(0, SRCDIR)

# Import the REAL patched Hermes modules (no stubbing of the code under test).
# Only symbols present in BOTH the committed baseline and the repaired tree are
# imported directly; repaired-only seams (_run_scanner_bounded) are accessed via
# the module so the frozen baseline runs the same tests and FAILS at the exact
# missing/broken behavior instead of erroring at import.
from tools import approval as approval_mod  # noqa: E402
from tools import approval_context  # noqa: E402
from tools import terminal_tool as terminal_mod  # noqa: E402
from tools import tirith_security  # noqa: E402
from tools.tirith_security import (  # noqa: E402
    _MandatoryCircuitBreaker,
    _get_mandatory_timeout,
    check_command_mandatory,
    ensure_installed,
    get_mandatory_scanner_path,
    is_mandatory_scan_mode,
)
import hermes_cli._parser as parser_mod  # noqa: E402


# ── Shared helpers ──────────────────────────────────────────────────────────────────
class _FakeStat:
    def __init__(self, mode: int, uid: int = 0):
        self.st_mode = mode
        self.st_uid = uid


def _scanner_stub_path() -> str:
    return os.path.join(CONTROL_BASE, "stub-scanner", "tirith-stub")


@contextlib.contextmanager
def linux_x86_scanner_env(scanner_path: str, file_mode: int | None = None):
    """Pretend we are Linux x86_64 with a root-owned 0755 scanner and root-owned,
    non-group/world-writable parent directories — without touching the real fs."""
    if file_mode is None:
        file_mode = stat_mod.S_IFREG | 0o755
    dir_mode = stat_mod.S_IFDIR | 0o755
    real_lstat = os.lstat
    scanner = os.path.normpath(scanner_path)
    parent = os.path.dirname(scanner)

    def fake_lstat(p, **kw):
        np = os.path.normpath(p)
        if np == scanner:
            return _FakeStat(file_mode, 0)
        if np == "/" or np == parent or parent.startswith(np + os.sep):
            return _FakeStat(dir_mode, 0)
        return real_lstat(p, **kw)

    with mock.patch.object(platform, "system", lambda: "Linux"), \
         mock.patch.object(platform, "machine", lambda: "x86_64"), \
         mock.patch.object(os, "lstat", fake_lstat):
        yield


def verdict_bytes(action: str = "allow", findings=None, **overrides) -> bytes:
    payload = {
        "action": action,
        "schema_version": 3,
        "findings": findings if findings is not None else [],
        "bypass_requested": False,
        "bypass_honored": False,
        "interactive_detected": False,
        "policy_path_used": None,
        "tier_reached": 1,
        "timings_ms": {"tier0_ms": 1.0, "total_ms": 2.0},
        "urls_extracted_count": 0,
    }
    payload.update(overrides)
    return json.dumps(payload).encode("utf-8")


def make_finding(**overrides) -> dict:
    f = {
        "rule_id": "plain_http",
        "severity": "HIGH",
        "title": "Plain HTTP",
        "description": "unencrypted http",
        "remediation": "Use HTTPS",
        "evidence": [],
    }
    f.update(overrides)
    return f


def mandatory_env(scanner: str) -> dict:
    return {"HERMES_REQUIRE_COMMAND_SCAN": "1", "HERMES_COMMAND_SCANNER": scanner}


class RegressionBase(unittest.TestCase):
    def setUp(self):
        tirith_security._mandatory_circuit_breaker.reset()
        os.environ.pop("HERMES_REQUIRE_COMMAND_SCAN", None)
        os.environ.pop("HERMES_COMMAND_SCANNER", None)
        os.environ.pop("HERMES_YOLO_MODE", None)
        os.environ.pop("HERMES_COMMAND_SCAN_TIMEOUT", None)

    def run_mandatory_with(self, stdout: bytes, returncode: int, command: str = "ls",
                           scanner: str | None = None, failure=None):
        """check_command_mandatory with a faked scanner result at whichever seam the
        tree under test exposes: the repaired code's _run_scanner_bounded, or the
        committed baseline's subprocess.run. Same verdict semantics both ways."""
        scanner = scanner or _scanner_stub_path()
        if hasattr(tirith_security, "_run_scanner_bounded"):
            seam = mock.patch.object(
                tirith_security, "_run_scanner_bounded",
                lambda *a, **k: (returncode, stdout, b"", failure),
            )
        else:
            proc = mock.MagicMock()
            proc.returncode = returncode
            proc.stdout = stdout
            seam = mock.patch.object(subprocess, "run", lambda *a, **k: proc)
        with seam, linux_x86_scanner_env(scanner), \
             mock.patch.dict(os.environ, mandatory_env(scanner)):
            return check_command_mandatory(command)

    def crash_count(self) -> int:
        return tirith_security._mandatory_circuit_breaker._crash_count


# ── Supply chain ────────────────────────────────────────────────────────────────────
class TestLockedSupplyChain(unittest.TestCase):
    def test_patched_tree_matches_lock(self):
        self.assertTrue(os.path.isfile(os.path.join(SRCDIR, "tools", "tirith_security.py")))
        with open(os.path.join(SRCDIR, "tools", "tirith_security.py"), encoding="utf-8") as f:
            content = f.read()
        self.assertIn(POSTPATCH_MARKER, content)
        self.assertIn("0.21.3+tech7355.1", content)
        # The bounded runner and strict verdict matrix the lock's patch must carry.
        self.assertIn("def _run_scanner_bounded", content)
        self.assertIn("scanner_circuit_open", content)

    def test_patch_file_hash_is_pinned(self):
        self.assertEqual(_sha256_file(PATCH_PATH), PATCH_SHA256)
        self.assertEqual(LOCK["postpatch_marker"], POSTPATCH_MARKER)
        self.assertEqual(LOCK["upstream_version"], UPSTREAM_VERSION)


# ── Guard ordering in the patched approval flow (tools/approval.py) ────────────────
class TestGuardOrdering(RegressionBase):
    """The mandatory scan must run BEFORE every permissive path: approval mode 'off',
    the permanent allowlist, unattended auto-approve, and the container fast-path."""

    def test_scan_runs_before_approval_mode_off(self):
        order = []
        scan_allow = {"allowed": True, "reason": "", "findings": []}
        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}), \
             mock.patch.object(tirith_security, "check_command_mandatory", lambda c: order.append("scan") or scan_allow), \
             mock.patch.object(approval_context, "_get_approval_mode", lambda: order.append("approval_mode") or "off"), \
             mock.patch.object(approval_mod, "_yolo_active", lambda: order.append("yolo") or False):
            res = approval_mod.check_all_command_guards("git status", env_type="local")
        self.assertEqual(res["approved"], True)
        self.assertLess(order.index("scan"), order.index("approval_mode"))

    def test_scan_runs_before_permanent_allowlist(self):
        order = []
        scan_allow = {"allowed": True, "reason": "", "findings": []}
        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}), \
             mock.patch.object(tirith_security, "check_command_mandatory", lambda c: order.append("scan") or scan_allow), \
             mock.patch.object(approval_mod, "_yolo_active", lambda: order.append("yolo") or False), \
             mock.patch.object(approval_context, "_get_approval_mode", lambda: order.append("approval_mode") or "default"), \
             mock.patch.object(approval_mod, "_command_matches_permanent_allowlist", lambda c: order.append("allowlist") or True):
            res = approval_mod.check_all_command_guards("curl example.com", env_type="local")
        self.assertEqual(res["approved"], True)
        self.assertLess(order.index("scan"), order.index("allowlist"))

    def test_scan_runs_before_unattended_auto_approve(self):
        order = []
        scan_allow = {"allowed": True, "reason": "", "findings": []}
        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}), \
             mock.patch.object(tirith_security, "check_command_mandatory", lambda c: order.append("scan") or scan_allow), \
             mock.patch.object(approval_mod, "_yolo_active", lambda: order.append("yolo") or False), \
             mock.patch.object(approval_context, "_get_approval_mode", lambda: order.append("approval_mode") or "default"), \
             mock.patch.object(approval_mod, "_command_matches_permanent_allowlist", lambda c: order.append("allowlist") or False), \
             mock.patch.object(approval_mod, "_presence", lambda cb=None: order.append("presence") or (None, False, False, False)), \
             mock.patch.object(approval_mod, "_unattended_contexts", lambda: order.append("unattended") or []):
            res = approval_mod.check_all_command_guards("git push", env_type="local")
        self.assertEqual(res["approved"], True)
        self.assertLess(order.index("scan"), order.index("unattended"))

    def test_scan_runs_before_container_fast_path_approve(self):
        order = []
        scan_allow = {"allowed": True, "reason": "", "findings": []}
        real_skip = approval_mod._should_skip_container_guards

        def skip(env_type, has_host_access=False):
            order.append("container_skip")
            return real_skip(env_type, has_host_access=has_host_access)

        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}), \
             mock.patch.object(tirith_security, "check_command_mandatory", lambda c: order.append("scan") or scan_allow), \
             mock.patch.object(approval_mod, "_should_skip_container_guards", skip), \
             mock.patch.object(approval_mod, "_user_deny_block", lambda c: order.append("user_deny") or None):
            res = approval_mod.check_all_command_guards("git status", env_type="docker")
        self.assertEqual(res["approved"], True)
        # Floor-stage skip + user-deny happen first, then the scan, then the approve skip.
        self.assertEqual(order, ["container_skip", "user_deny", "scan", "container_skip"])

    def test_scan_block_stops_every_permissive_path(self):
        order = []
        scan_block = {
            "allowed": False,
            "reason": "scanner_finding_blocked",
            "findings": [make_finding(rule_id="plain_http")],
        }
        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}), \
             mock.patch.object(tirith_security, "check_command_mandatory", lambda c: order.append("scan") or scan_block), \
             mock.patch.object(approval_mod, "_yolo_active", lambda: order.append("yolo") or True), \
             mock.patch.object(approval_context, "_get_approval_mode", lambda: order.append("approval_mode") or "off"), \
             mock.patch.object(approval_mod, "_command_matches_permanent_allowlist", lambda c: order.append("allowlist") or True), \
             mock.patch.object(approval_mod, "_presence", lambda cb=None: order.append("presence") or (None, False, False, False)):
            res = approval_mod.check_all_command_guards("curl http://example.com", env_type="local")
        self.assertEqual(res["approved"], False)
        self.assertEqual(res["status"], "blocked")
        self.assertEqual(res["reason"], "scanner_finding_blocked")
        self.assertIn("Command blocked by security scan", res["message"])
        self.assertEqual(res["findings"][0]["rule_id"], "plain_http")
        self.assertEqual(order, ["scan"])  # nothing permissive was ever consulted

    def test_floor_blocks_before_scanner_sudo_stdin_guard(self):
        order = []
        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}), \
             mock.patch.object(tirith_security, "check_command_mandatory",
                               lambda c: order.append("scan") or {"allowed": True, "reason": "", "findings": []}):
            # Data-only: never executed; the sudo-stdin floor must stop it pre-scanner.
            res = approval_mod.check_all_command_guards(
                "printf '%s' fake-password | sudo -S id", env_type="local")
        self.assertEqual(res["approved"], False)
        self.assertEqual(order, [])  # floor hit before the scanner was invoked


# ── terminal_tool force semantics (tools/terminal_tool.py) ──────────────────────────
class TestForceSemantics(RegressionBase):
    def test_force_with_mandatory_and_clean_scan_still_approved_run(self):
        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}), \
             mock.patch.object(tirith_security, "check_command_mandatory",
                               lambda c: {"allowed": True, "reason": "", "findings": []}):
            verdict = terminal_mod._run_approval_guards(
                "git status", env_type="local", config={}, force=True)
        self.assertTrue(verdict.approved_run)

    def test_force_without_mandatory_skips_guards_entirely(self):
        called = []

        def fail_if_called(*a, **k):
            called.append(1)
            raise AssertionError("guards must be skipped when force and not mandatory")

        # HERMES_REQUIRE_COMMAND_SCAN is absent (sanitized setUp) -> legacy behavior.
        with mock.patch.object(terminal_mod, "_check_all_guards", fail_if_called):
            verdict = terminal_mod._run_approval_guards(
                "git status", env_type="local", config={}, force=True)
        self.assertTrue(verdict.approved_run)
        self.assertEqual(called, [])

    def test_force_with_mandatory_blocked_scan_rejected(self):
        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}), \
             mock.patch.object(tirith_security, "check_command_mandatory",
                               lambda c: {"allowed": False, "reason": "scanner_finding_blocked",
                                          "findings": [make_finding()]}):
            with self.assertRaises(terminal_mod._Rejected) as ctx:
                terminal_mod._run_approval_guards(
                    "curl http://example.com", env_type="local", config={}, force=True)
        self.assertIn("Command blocked by security scan", str(ctx.exception))

    def test_non_import_error_from_scanner_module_fails_closed_in_terminal(self):
        # A corrupt scanner module (any non-ImportError defect) under mandatory mode
        # must fail closed as _Rejected, never run the command.
        real_mod = sys.modules["tools.tirith_security"]
        try:
            poison = types.ModuleType("tools.tirith_security")

            def _boom(name):
                raise RuntimeError("corrupt-scanner-module")

            poison.__getattr__ = _boom  # type: ignore[attr-defined]
            sys.modules["tools.tirith_security"] = poison
            with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}):
                with self.assertRaises(terminal_mod._Rejected) as ctx:
                    terminal_mod._run_approval_guards(
                        "git status", env_type="local", config={}, force=True)
            self.assertIn("Command blocked by security scan", str(ctx.exception))
        finally:
            sys.modules["tools.tirith_security"] = real_mod


# ── Verdict matrix: typed validation + crash accounting (unique branches) ──────────
class TestStrictScannerJson(RegressionBase):
    def test_allow_requires_no_summary_field_and_real_allow_keys(self):
        res = self.run_mandatory_with(verdict_bytes("allow", []), 0)
        self.assertEqual(res, {"allowed": True, "reason": "", "findings": []})
        # Unknown extra keys are tolerated (forward-compat); allow keys stay real.
        res2 = self.run_mandatory_with(verdict_bytes("allow", [], summary="extra"), 0)
        self.assertEqual(res2["allowed"], True)

    def test_real_tirith_shape_with_null_unused_tier_timings_allows(self):
        # The REAL tirith 0.4.2 emits null for unused tier timings (qualified offline
        # against the verified binary); those must stay acceptable.
        out = verdict_bytes("allow", [], timings_ms={"tier0_ms": 2.3, "tier1_ms": 19.6,
                                                     "tier2_ms": None, "tier3_ms": None,
                                                     "total_ms": 89.7})
        res = self.run_mandatory_with(out, 0)
        self.assertEqual(res["allowed"], True)

    def test_negative_timing_rejected(self):
        res = self.run_mandatory_with(verdict_bytes("allow", [], timings_ms={"total_ms": -1.0}), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")
        self.assertEqual(self.crash_count(), 1)

    def test_oversized_timing_rejected(self):
        res = self.run_mandatory_with(verdict_bytes("allow", [], timings_ms={"total_ms": 1e8}), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_bool_timing_rejected(self):
        res = self.run_mandatory_with(verdict_bytes("allow", [], timings_ms={"total_ms": True}), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_negative_urls_extracted_count_rejected(self):
        res = self.run_mandatory_with(verdict_bytes("allow", [], urls_extracted_count=-1), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_float_schema_version_rejected(self):
        res = self.run_mandatory_with(verdict_bytes("allow", [], schema_version=3.0), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_bool_tier_reached_rejected(self):
        res = self.run_mandatory_with(verdict_bytes("allow", [], tier_reached=True), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_top_level_non_dict_rejected(self):
        res = self.run_mandatory_with(b"[1, 2, 3]", 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_missing_bypass_honored_key_rejected(self):
        raw = json.loads(verdict_bytes("allow", []).decode("utf-8"))
        del raw["bypass_honored"]
        res = self.run_mandatory_with(json.dumps(raw).encode("utf-8"), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_policy_path_used_empty_string_rejected(self):
        res = self.run_mandatory_with(verdict_bytes("allow", [], policy_path_used=""), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_missing_policy_path_used_key_rejected(self):
        # Committed-baseline repro: a scanner that simply OMITS policy_path_used
        # validated as if it were the required null (dict.get -> None -> passes),
        # so a policy-override could be silently dropped from the verdict.
        raw = json.loads(verdict_bytes("allow", []).decode("utf-8"))
        del raw["policy_path_used"]
        res = self.run_mandatory_with(json.dumps(raw).encode("utf-8"), 0)
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_infinite_timing_from_numeric_overflow_rejected(self):
        # Committed-baseline repro: JSON number 1e999 parses to float infinity
        # WITHOUT tripping the non-finite-CONSTANT hook (only the Infinity/NaN
        # literals do), and timings_ms values were never checked -> allow.
        raw = verdict_bytes("allow", []).decode("utf-8").replace('"total_ms": 2.0', '"total_ms": 1e999')
        self.assertIn("1e999", raw)
        res = self.run_mandatory_with(raw.encode("utf-8"), 0)
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_signal_killed_scanner_with_block_verdict_counts_as_crash(self):
        # Committed-baseline repro: a signal-killed scanner (negative returncode)
        # whose partial output said "block" was booked as a POLICY verdict, so the
        # circuit breaker never armed no matter how often the scanner crashed.
        res = self.run_mandatory_with(verdict_bytes("block", [make_finding()]), -9)
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_execution_failed")
        self.assertEqual(self.crash_count(), 1)

    def test_findings_wrong_container_type_rejected(self):
        res = self.run_mandatory_with(verdict_bytes("allow", "[]"), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_finding_evidence_wrong_type_rejected(self):
        res = self.run_mandatory_with(verdict_bytes("allow", [make_finding(evidence={})]), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_finding_missing_severity_string_rejected(self):
        res = self.run_mandatory_with(verdict_bytes("allow", [make_finding(severity=None)]), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_action_wrong_type_rejected(self):
        res = self.run_mandatory_with(verdict_bytes(action=123), 0)
        self.assertEqual(res["reason"], "scanner_malformed_output")

    def test_exit_zero_with_findings_contradiction_is_crash_not_policy_block(self):
        res = self.run_mandatory_with(verdict_bytes("allow", [make_finding()]), 0)
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_execution_failed")
        self.assertEqual(self.crash_count(), 1)

    def test_consistent_block_verdict_does_not_count_as_crash(self):
        res = self.run_mandatory_with(verdict_bytes("block", [make_finding()]), 1)
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_finding_blocked")
        self.assertEqual(self.crash_count(), 0)

    def test_consistent_warn_verdict_denies_without_crash(self):
        res = self.run_mandatory_with(verdict_bytes("warn", [make_finding()]), 2)
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_finding_blocked")
        self.assertEqual(self.crash_count(), 0)

    def test_three_contradictory_verdicts_open_the_breaker_without_spawn(self):
        calls = []

        def fake_bounded(*a, **k):
            calls.append(1)
            return 3, verdict_bytes("allow", []), b"", None  # unknown exit code

        scanner = _scanner_stub_path()
        if hasattr(tirith_security, "_run_scanner_bounded"):
            seam = mock.patch.object(tirith_security, "_run_scanner_bounded", fake_bounded)
        else:
            def fake_run(*a, **k):
                calls.append(1)
                proc = mock.MagicMock()
                proc.returncode = 3
                proc.stdout = verdict_bytes("allow", [])
                return proc
            seam = mock.patch.object(subprocess, "run", fake_run)
        with seam, linux_x86_scanner_env(scanner), \
             mock.patch.dict(os.environ, mandatory_env(scanner)):
            for _ in range(3):
                self.assertEqual(check_command_mandatory("ls")["reason"], "scanner_execution_failed")
            self.assertEqual(len(calls), 3)
            fourth = check_command_mandatory("ls")
        self.assertEqual(fourth["reason"], "scanner_circuit_open")
        self.assertEqual(len(calls), 3)  # 4th call denied WITHOUT invoking the scanner


# ── Scanner validation branches ─────────────────────────────────────────────────────
class TestScannerValidation(RegressionBase):
    def test_non_executable_root_binary_rejected(self):
        scanner = _scanner_stub_path()
        with mock.patch.dict(os.environ, mandatory_env(scanner)), \
             linux_x86_scanner_env(scanner, file_mode=stat_mod.S_IFREG | 0o644):
            valid, reason = tirith_security._validate_mandatory_scanner(scanner)
        self.assertFalse(valid)
        self.assertEqual(reason, "scanner_binary_untrusted")

    def test_scanner_not_configured(self):
        valid, reason = tirith_security._validate_mandatory_scanner(None)
        self.assertFalse(valid)
        self.assertEqual(reason, "scanner_not_configured")
        valid, reason = tirith_security._validate_mandatory_scanner("")
        self.assertEqual(reason, "scanner_not_configured")

    def test_missing_scanner_fails_closed_deny(self):
        # Real os.lstat on a genuinely missing path -> OSError -> scanner_unavailable.
        def fail_spawn(*a, **k):
            raise AssertionError("scanner must not be spawned when the binary is missing")

        missing = "/nonexistent/tirith-xyz"
        with mock.patch.dict(os.environ, mandatory_env(missing)), \
             mock.patch.object(platform, "system", lambda: "Linux"), \
             mock.patch.object(platform, "machine", lambda: "x86_64"), \
             mock.patch.object(tirith_security, "_run_scanner_bounded", fail_spawn):
            res = check_command_mandatory("ls")
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_unavailable")

    def test_unsupported_platform_fails_closed_deny(self):
        # No platform patching: on this host (not Linux/x86_64) validation must fail.
        with mock.patch.dict(os.environ, mandatory_env(_scanner_stub_path())):
            res = check_command_mandatory("ls")
        self.assertEqual(res["allowed"], False)
        self.assertIn(res["reason"], ("scanner_unsupported_platform", "scanner_unavailable"))


# ── Circuit breaker: concurrency, cooldown, single half-open probe ─────────────────
class TestCircuitBreakerConcurrency(unittest.TestCase):
    def test_single_half_open_probe_under_concurrent_callers(self):
        cb = _MandatoryCircuitBreaker(crash_limit=3, cooldown=60.0)
        for _ in range(3):
            cb.record_failure(is_probe=False)
        self.assertEqual(cb.can_execute(), (False, False))

        now = 1000.0
        with mock.patch.object(time, "monotonic", lambda: now):
            cb._open_time = now - 61.0  # cooldown elapsed
            n = 8
            barrier = threading.Barrier(n)
            results = []

            def worker():
                barrier.wait()
                results.append(cb.can_execute())

            threads = [threading.Thread(target=worker) for _ in range(n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        probes = [r for r in results if r == (True, True)]
        denied = [r for r in results if r == (False, False)]
        self.assertEqual(len(probes), 1, f"exactly one half-open probe, got {results}")
        self.assertEqual(len(denied), n - 1)

    def test_probe_failure_rearms_cooldown_and_never_allows(self):
        cb = _MandatoryCircuitBreaker(crash_limit=3, cooldown=60.0)
        for _ in range(3):
            cb.record_failure(is_probe=False)
        now = 1000.0
        with mock.patch.object(time, "monotonic", lambda: now):
            cb._open_time = now - 61.0
            self.assertEqual(cb.can_execute(), (True, True))
            # Non-allow probe outcome (policy block) re-opens; it can never allow.
            cb.record_success(is_valid_allow=False, is_probe=True)
            self.assertEqual(cb.can_execute(), (False, False))
            # Still inside the re-armed cooldown.
            cb._open_time = now - 30.0
            self.assertEqual(cb.can_execute(), (False, False))

    def test_only_valid_allow_probe_resets_breaker(self):
        cb = _MandatoryCircuitBreaker(crash_limit=3, cooldown=60.0)
        for _ in range(3):
            cb.record_failure(is_probe=False)
        now = 1000.0
        with mock.patch.object(time, "monotonic", lambda: now):
            cb._open_time = now - 61.0
            self.assertEqual(cb.can_execute(), (True, True))
            cb.record_success(is_valid_allow=True, is_probe=True)
        self.assertEqual(cb._crash_count, 0)
        self.assertFalse(cb._circuit_open)
        self.assertEqual(cb.can_execute(), (True, False))

    def test_policy_blocks_do_not_count_as_execution_failures(self):
        cb = _MandatoryCircuitBreaker(crash_limit=3, cooldown=60.0)
        for _ in range(10):
            cb.record_success(is_valid_allow=False, is_probe=False)
        self.assertEqual(cb.can_execute(), (True, False))


# ── Real-spawn scanner subprocess contract (safe stub scanner) ─────────────────────
class TestScannerSubprocessContract(RegressionBase):
    """Spawn a BENIGN stub scanner through the REAL _run_scanner_bounded runner to
    pin the actual invocation contract of check_command_mandatory: argv, scanner
    env allowlist, HOME redirection, cwd, DEVNULL stdin, and the '--' data-only
    command pass-through. (The patch's own tests mock this seam entirely.)"""

    @classmethod
    def setUpClass(cls):
        cls.stub_dir = os.path.join(CONTROL_BASE, "stub-scanner")
        os.makedirs(cls.stub_dir, exist_ok=True)
        cls.record_path = os.path.join(cls.stub_dir, "record.json")
        cls.sleep_record_path = os.path.join(cls.stub_dir, "sleep-record.json")
        cls.flood_record_path = os.path.join(cls.stub_dir, "flood-record.json")
        cls.stub = _scanner_stub_path()
        allow_verdict = verdict_bytes("allow", []).decode("utf-8")
        with open(cls.stub, "w", encoding="utf-8") as f:
            f.write(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "rec = {'argv': sys.argv, 'env': dict(os.environ), 'cwd': os.getcwd(),\n"
                "       'stdin_mode': None, 'stdin_rdev': None}\n"
                "try:\n"
                "    st = os.fstat(0)\n"
                "    rec['stdin_mode'] = st.st_mode\n"
                "    rec['stdin_rdev'] = st.st_rdev\n"
                "except Exception:\n"
                "    pass\n"
                f"with open({cls.record_path!r}, 'w') as f:\n"
                "    json.dump(rec, f)\n"
                f"print({allow_verdict!r})\n"
            )
        os.chmod(cls.stub, 0o755)
        sleep_stub = os.path.join(cls.stub_dir, "tirith-sleep-stub")
        with open(sleep_stub, "w", encoding="utf-8") as f:
            f.write(
                "#!/usr/bin/env python3\n"
                f"with open({cls.sleep_record_path!r}, 'w') as f:\n"
                "    f.write('spawned')\n"
                "import time; time.sleep(30)\n"
            )
        os.chmod(sleep_stub, 0o755)
        cls.sleep_stub = sleep_stub
        flood_stub = os.path.join(cls.stub_dir, "tirith-flood-stub")
        with open(flood_stub, "w", encoding="utf-8") as f:
            f.write(
                "#!/usr/bin/env python3\n"
                f"with open({cls.flood_record_path!r}, 'w') as f:\n"
                "    f.write('spawned')\n"
                "import sys\n"
                "sys.stdout.write('A' * 70000)\n"
                "sys.stdout.flush()\n"
            )
        os.chmod(flood_stub, 0o755)
        cls.flood_stub = flood_stub

    def _expected_scan_home(self) -> str:
        for cand in ("/usr/local/share/hermes-command-scan/home", "/opt/scan/home"):
            if os.path.isdir(cand):
                return cand
        return "/tmp"

    def test_argv_env_cwd_and_stdin_contract(self):
        command = 'printf \'%s\' "a;b|c"'  # benign, metachar-laden DATA (never executed)
        with mock.patch.dict(os.environ, mandatory_env(self.stub)), \
             linux_x86_scanner_env(self.stub):
            res = check_command_mandatory(command)
        self.assertEqual(res, {"allowed": True, "reason": "", "findings": []})

        with open(self.record_path, encoding="utf-8") as f:
            rec = json.load(f)
        # argv: offline, non-interactive, pinned posix shell mode, command as ONE
        # verbatim data element after the '--' terminator (no shell interpolation).
        self.assertEqual(
            rec["argv"],
            [self.stub, "check", "--offline", "--json", "--non-interactive",
             "--shell", "posix", "--", command],
        )
        # The scanner receives ONLY the constructed allowlist env — never the agent's
        # or the server's environment (no secrets, no HERMES_*/TIRITH_*/PAPERCLIP_*).
        # (macOS posix_spawn injects a few compiler/CF keys host-side; subset, not
        # equality, keeps the assertion portable to Linux where env is exact.)
        mac_host_injected = {"CPATH", "LIBRARY_PATH", "MANPATH", "SDKROOT", "__CF_USER_TEXT_ENCODING"}
        self.assertLessEqual(
            set(rec["env"].keys()),
            {"LANG", "PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
             "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"} | mac_host_injected,
        )
        for forbidden in list(rec["env"].keys()):
            self.assertFalse(
                forbidden.upper().startswith(("HERMES_", "TIRITH_", "PAPERCLIP_", "ANTHROPIC_", "OPENAI_")),
                f"scanner env leaked forbidden key {forbidden}",
            )
        self.assertEqual(rec["env"]["PATH"], "/usr/bin:/bin")
        expected_home = self._expected_scan_home()
        self.assertEqual(rec["env"]["HOME"], expected_home)
        self.assertNotEqual(rec["env"]["HOME"], _REAL_HOME)  # never the mutable user home
        for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
                    "XDG_STATE_HOME", "XDG_RUNTIME_DIR"):
            self.assertEqual(rec["env"][key], expected_home)
        self.assertEqual(rec["cwd"], "/")
        # stdin is /dev/null (DEVNULL): character device with /dev/null's rdev.
        null_st = os.stat("/dev/null")
        self.assertNotEqual(rec["stdin_mode"], None)
        self.assertTrue(stat_mod.S_ISCHR(rec["stdin_mode"]))
        self.assertEqual(rec["stdin_rdev"], null_st.st_rdev)

    def test_timeout_clamped_and_fail_closed(self):
        with mock.patch.dict(os.environ, mandatory_env(self.sleep_stub) | {
                "HERMES_COMMAND_SCAN_TIMEOUT": "1"}), \
             linux_x86_scanner_env(self.sleep_stub):
            res = check_command_mandatory("ls")
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_timeout")
        self.assertEqual(self.crash_count(), 1)  # timeout counts as an execution failure
        self.assertTrue(os.path.exists(self.sleep_record_path))  # stub really spawned

    def test_flood_output_terminates_scanner_and_fails_closed(self):
        # Through the FULL guard (not just the runner): a scanner that floods stdout
        # past the 64KB bound must be terminated and counted as an execution failure.
        with mock.patch.dict(os.environ, mandatory_env(self.flood_stub)), \
             linux_x86_scanner_env(self.flood_stub):
            res = check_command_mandatory("ls")
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_malformed_output")
        self.assertEqual(self.crash_count(), 1)
        self.assertTrue(os.path.exists(self.flood_record_path))

    def test_bounded_runner_caps_buffered_bytes_and_kills_early(self):
        # Committed-baseline repro (stream-unbounded): the baseline buffered the
        # scanner's ENTIRE stdout via subprocess.run(capture_output=True) before any
        # size check — a scanner emitting unbounded output exhausted Hermes memory
        # regardless of the later 64KB verdict rejection, and the child was never
        # killed early. The repaired tree must expose a bounded streaming runner
        # that (a) never buffers more than one chunk past the cap and (b) kills the
        # flooding child BEFORE it finishes (end-marker never written).
        runner = getattr(tirith_security, "_run_scanner_bounded", None)
        if runner is None:
            self.fail(
                "MATERIAL FAILURE (committed baseline): no bounded scanner runner — "
                "check_command_mandatory buffers scanner stdout unboundedly via "
                "subprocess.run(capture_output=True) before the 64KB check"
            )
        kill_probe = os.path.join(self.stub_dir, "kill-probe-end.marker")
        if os.path.exists(kill_probe):
            os.unlink(kill_probe)
        kill_stub = os.path.join(self.stub_dir, "tirith-kill-stub")
        with open(kill_stub, "w", encoding="utf-8") as f:
            f.write(
                "#!/usr/bin/env python3\n"
                "import sys, time\n"
                "sys.stdout.write('A' * 70000)\n"
                "sys.stdout.flush()\n"
                "time.sleep(30)\n"  # parent must kill us here, before the marker
                f"open({kill_probe!r}, 'w').write('end')\n"
            )
        os.chmod(kill_stub, 0o755)
        rc, out, err, fail = runner([kill_stub], {}, 10.0)
        self.assertEqual(fail, "scanner_malformed_output")
        # Never more than one 4096-byte read past the 64KB cap buffered in memory.
        self.assertLessEqual(len(out), 65536 + 4096)
        # The child was killed while still sleeping: the end marker never appears.
        self.assertFalse(os.path.exists(kill_probe), "flooding scanner was not killed early")

    def test_timeout_env_clamping(self):
        cases = {"0": 1, "-5": 1, "999": 30, "1000000": 30, "abc": 5, "2": 2}
        for raw, expected in cases.items():
            with mock.patch.dict(os.environ, {"HERMES_COMMAND_SCAN_TIMEOUT": raw}):
                self.assertEqual(_get_mandatory_timeout(), expected, f"raw={raw!r}")
        os.environ.pop("HERMES_COMMAND_SCAN_TIMEOUT", None)
        self.assertEqual(_get_mandatory_timeout(), 5)

    def test_no_result_field_leaks_scanner_output_or_env(self):
        with mock.patch.dict(os.environ, mandatory_env(self.stub)), \
             linux_x86_scanner_env(self.stub):
            res = check_command_mandatory("git status")
        self.assertEqual(set(res.keys()), {"allowed", "reason", "findings"})
        blob = json.dumps(res)
        for secret in ("HERMES_", "TIRITH_", "PAPERCLIP_", "PATH", "HOME"):
            self.assertNotIn(secret, blob)


# ── Mandatory-mode configuration semantics ─────────────────────────────────────────
class TestMandatoryModeConfig(RegressionBase):
    def test_truthy_canonicalization_strips_and_lowercases(self):
        for val in (" REQUIRED ", "On", "Yes\n", "TRUE", "required"):
            with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": val}):
                self.assertTrue(is_mandatory_scan_mode(), f"val={val!r}")

    def test_falsy_values(self):
        for val in ("", "0", "false", "no", "off", "disabled"):
            with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": val}):
                self.assertFalse(is_mandatory_scan_mode(), f"val={val!r}")

    def test_ensure_installed_never_downloads_in_mandatory_mode(self):
        def fail(*a, **k):
            raise AssertionError("ensure_installed must not load security config or download in mandatory mode")

        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}), \
             mock.patch.object(tirith_security, "_load_security_config", fail):
            self.assertIsNone(ensure_installed())


# ── Import-time isolation (subprocess workers) ─────────────────────────────────────
def _child_env(extra: dict) -> dict:
    env = dict(os.environ)
    env.update(extra)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


class TestFrozenStateAndImportFailure(unittest.TestCase):
    def test_import_time_freeze_cannot_be_disabled_at_runtime(self):
        code = textwrap.dedent(f"""
            import os, sys
            os.environ["HERMES_REQUIRE_COMMAND_SCAN"] = "1"
            os.environ["HERMES_COMMAND_SCANNER"] = "/frozen/scanner"
            sys.path.insert(0, {SRCDIR!r})
            import tools.tirith_security as ts
            # A running agent flips both knobs after import:
            os.environ["HERMES_REQUIRE_COMMAND_SCAN"] = "0"
            os.environ["HERMES_COMMAND_SCANNER"] = "/attacker/tirith"
            print(ts.is_mandatory_scan_mode(), ts.get_mandatory_scanner_path())
        """)
        out = subprocess.run(
            [sys.executable, "-B", "-c", code], capture_output=True, text=True,
            env=_child_env({}), cwd=SRCDIR, timeout=60,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip().split(), ["True", "/frozen/scanner"])

    def test_import_failure_of_scanner_module_fails_closed_in_approval(self):
        code = textwrap.dedent(f"""
            import os, sys, json
            class BlockTirith:
                def find_spec(self, fullname, path=None, target=None):
                    if fullname == "tools.tirith_security":
                        raise ImportError("blocked-for-regression")
                    return None
            sys.meta_path.insert(0, BlockTirith())
            os.environ["HERMES_REQUIRE_COMMAND_SCAN"] = "1"
            sys.path.insert(0, {SRCDIR!r})
            from tools.approval import check_all_command_guards
            r = check_all_command_guards("ls", env_type="local")
            print(json.dumps({{"approved": r["approved"], "reason": r.get("reason", "")}}))
        """)
        out = subprocess.run(
            [sys.executable, "-B", "-c", code], capture_output=True, text=True,
            env=_child_env({}), cwd=SRCDIR, timeout=60,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        payload = json.loads(out.stdout.strip())
        self.assertIs(payload["approved"], False)
        self.assertEqual(payload["reason"], "scanner_import_failed")

    def test_non_import_error_from_scanner_module_crashes_fail_closed(self):
        # Any non-ImportError defect (e.g. a corrupt module) propagates out of the
        # approval guard: the call itself raises, so the command is never executed
        # (fail-closed by crash; terminal_tool additionally converts it to _Rejected).
        code = textwrap.dedent(f"""
            import os, sys
            class BlockTirith:
                def find_spec(self, fullname, path=None, target=None):
                    if fullname == "tools.tirith_security":
                        raise RuntimeError("corrupt-scanner-module")
                    return None
            sys.meta_path.insert(0, BlockTirith())
            os.environ["HERMES_REQUIRE_COMMAND_SCAN"] = "1"
            sys.path.insert(0, {SRCDIR!r})
            from tools.approval import check_all_command_guards
            check_all_command_guards("ls", env_type="local")
            print("RAN")
        """)
        out = subprocess.run(
            [sys.executable, "-B", "-c", code], capture_output=True, text=True,
            env=_child_env({}), cwd=SRCDIR, timeout=60,
        )
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("RAN", out.stdout)


# ── CLI parser: mandatory flag coexists with --yolo (production posture) ───────────
class TestParserCoexistence(unittest.TestCase):
    def test_yolo_and_require_command_scan_both_parse_true(self):
        parser, _, _ = parser_mod.build_top_level_parser()
        args = parser.parse_args(["--yolo", "--require-command-scan"])
        self.assertTrue(args.yolo)
        self.assertTrue(args.require_command_scan)

    def test_require_command_scan_defaults_false(self):
        parser, _, _ = parser_mod.build_top_level_parser()
        args = parser.parse_args([])
        self.assertFalse(args.require_command_scan)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(CONTROL_BASE, ignore_errors=True)
