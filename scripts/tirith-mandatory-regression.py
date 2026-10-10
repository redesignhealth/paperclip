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
ALLOW_SKIP = "--allow-skip" in sys.argv
if ALLOW_SKIP:
    sys.argv.remove("--allow-skip")


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

sys.stderr.write(f"[tirith-mandatory-regression] Python {sys.version}\n")

if not hasattr(tarfile, "data_filter"):
    sys.stderr.write(
        f"ERROR: Python {sys.version.split()[0]} does not provide tarfile data_filter attribute\n"
    )
    sys.exit(1)

# Create private, permission-checked temporary execution base BEFORE fetching source
CONTROL_BASE = tempfile.mkdtemp(prefix="tirith-mandatory-regression-")
try:
    os.chmod(CONTROL_BASE, 0o700)
    _st = os.stat(CONTROL_BASE)
    assert _st.st_uid == os.getuid() and (_st.st_mode & 0o077) == 0, "CONTROL_BASE permissions insecure"
except Exception as _e:
    shutil.rmtree(CONTROL_BASE, ignore_errors=True)
    sys.stderr.write(f"ERROR: failed to secure private test root: {_e}\n")
    sys.exit(1)

import atexit
atexit.register(lambda: shutil.rmtree(CONTROL_BASE, ignore_errors=True))

if FROM_COMMIT:
    _lock_text = _git_show(FROM_COMMIT, LOCK_REL).decode("utf-8")
    LOCK: dict = {}
    for _line in _lock_text.splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            LOCK[_k.strip()] = _v.strip()
    PATCH_PATH = os.path.join(CONTROL_BASE, "baseline.patch")
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


def _copy_and_verify_stream(src_file: str, dst_path: str, expected_sha256: str) -> bool:
    if os.path.exists(dst_path):
        try:
            os.unlink(dst_path)
        except OSError:
            pass
    try:
        fd = os.open(
            dst_path,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
    except OSError:
        return False
    h = hashlib.sha256()
    total_bytes = 0
    try:
        with open(src_file, "rb") as in_f, os.fdopen(fd, "wb") as out_f:
            while True:
                chunk = in_f.read(65536)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > 200 * 1024 * 1024:
                    raise ValueError("archive exceeded 200MB limit")
                h.update(chunk)
                out_f.write(chunk)
    except Exception:
        if os.path.exists(dst_path):
            try:
                os.unlink(dst_path)
            except OSError:
                pass
        return False
    if h.hexdigest() == expected_sha256:
        return True
    if os.path.exists(dst_path):
        try:
            os.unlink(dst_path)
        except OSError:
            pass
    return False


def _resolve_and_verify_tarball() -> str | None:
    target_path = os.path.join(CONTROL_BASE, "upstream.tar.gz")
    env = os.environ.get("HERMES_UPSTREAM_TARBALL")
    if env and os.path.isfile(env):
        if _copy_and_verify_stream(env, target_path, UPSTREAM_SHA256):
            return target_path

    # Download from locked URL into private O_CREAT|O_EXCL|O_NOFOLLOW descriptor
    source_lock_path = os.path.join(REPO_ROOT, "docker", "hermes", "source.lock")
    if os.path.isfile(source_lock_path):
        import urllib.request
        with open(source_lock_path, encoding="utf-8") as f:
            for line in f:
                if line.startswith("url="):
                    url = line.strip().split("=", 1)[1]
                    if not url.startswith("https://github.com/NousResearch/hermes-agent/archive/refs/tags/"):
                        sys.stderr.write(f"ERROR: untrusted upstream download url: {url}\n")
                        return None
                    total_deadline = time.monotonic() + 90.0
                    for _attempt in range(3):
                        remaining_budget = total_deadline - time.monotonic()
                        if remaining_budget <= 0:
                            break
                        socket_timeout = min(30.0, max(1.0, remaining_budget))
                        if os.path.exists(target_path):
                            try:
                                os.unlink(target_path)
                            except OSError:
                                pass
                        fd = None
                        try:
                            req = urllib.request.Request(url, headers={"User-Agent": "paperclip-test-runner/1.0"})
                            resp = urllib.request.urlopen(req, timeout=socket_timeout)
                            with resp:
                                redirect_url = resp.geturl()
                                if not (
                                    redirect_url.startswith("https://github.com/NousResearch/hermes-agent/")
                                    or redirect_url.startswith("https://codeload.github.com/NousResearch/hermes-agent/")
                                ):
                                    sys.stderr.write(f"ERROR: untrusted post-redirect url: {redirect_url}\n")
                                    return None
                                fd = os.open(
                                    target_path,
                                    os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
                                    0o600,
                                )
                                h = hashlib.sha256()
                                total_bytes = 0
                                with os.fdopen(fd, "wb") as out_f:
                                    fd = None  # out_f owns descriptor
                                    while True:
                                        chunk = resp.read(65536)
                                        if not chunk:
                                            break
                                        total_bytes += len(chunk)
                                        if total_bytes > 200 * 1024 * 1024:
                                            raise ValueError("upstream archive exceeded 200MB size limit")
                                        h.update(chunk)
                                        out_f.write(chunk)
                                if h.hexdigest() == UPSTREAM_SHA256:
                                    return target_path
                        except Exception as _err:
                            if fd is not None:
                                try:
                                    os.close(fd)
                                except OSError:
                                    pass
                            if os.path.exists(target_path):
                                try:
                                    os.unlink(target_path)
                                except OSError:
                                    pass
                            time.sleep(1.0)
    return None


TARBALL = _resolve_and_verify_tarball()
if TARBALL is None:
    sys.stderr.write(
        f"ERROR: could not acquire verified hermes-agent {UPSTREAM_VERSION} source (sha256 {UPSTREAM_SHA256}).\n"
    )
    if ALLOW_SKIP:
        sys.exit(77)
    sys.exit(1)

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
        if (
            np == "/"
            or np == parent
            or parent.startswith(np + os.sep)
            or np.startswith("/usr/local/share/hermes-command-scan")
            or "/usr/local/share/hermes-command-scan".startswith(np)
        ):
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
        if hasattr(approval_mod, "_MANDATORY_COMMAND_SCAN_LATCHED"):
            approval_mod._MANDATORY_COMMAND_SCAN_LATCHED = False
        if hasattr(terminal_mod, "_MANDATORY_COMMAND_SCAN_LATCHED"):
            terminal_mod._MANDATORY_COMMAND_SCAN_LATCHED = False

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
        self.assertIn(LOCK["extension_version"], content)
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

    def test_start_required_clear_env_import_failure_denies_normal_and_force(self):
        # Latched required state must survive env clearing; import failure must deny both normal and force
        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}):
            self.assertTrue(terminal_mod._is_mandatory_command_scan_required())

        clean_env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_")}
        real_mod = sys.modules.get("tools.tirith_security")
        try:
            poison = types.ModuleType("tools.tirith_security")

            def _boom(name):
                raise RuntimeError("corrupt-scanner-module")

            poison.__getattr__ = _boom
            sys.modules["tools.tirith_security"] = poison
            with mock.patch.dict(os.environ, clean_env, clear=True):
                # Normal command denied fail-closed
                with self.assertRaises(terminal_mod._Rejected) as ctx_normal:
                    terminal_mod._run_approval_guards("git status", env_type="local", config={}, force=False)
                self.assertIn("Command blocked by security scan", str(ctx_normal.exception))

                # Force command ALSO denied fail-closed
                with self.assertRaises(terminal_mod._Rejected) as ctx_force:
                    terminal_mod._run_approval_guards("git status", env_type="local", config={}, force=True)
                self.assertIn("Command blocked by security scan", str(ctx_force.exception))
        finally:
            if real_mod is not None:
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
        if hasattr(tirith_security, "_run_scanner_bounded"):
            seam = mock.patch.object(tirith_security, "_run_scanner_bounded", fail_spawn)
        else:
            seam = mock.patch.object(subprocess, "run", fail_spawn)
        with mock.patch.dict(os.environ, mandatory_env(missing)), \
             mock.patch.object(platform, "system", lambda: "Linux"), \
             mock.patch.object(platform, "machine", lambda: "x86_64"), \
             seam:
            res = check_command_mandatory("ls")
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_unavailable")

    def test_unsupported_platform_fails_closed_deny(self):
        # Platform check: when platform is not Linux/x86_64 or aarch64, validation must fail closed.
        with mock.patch.dict(os.environ, mandatory_env(_scanner_stub_path())), \
             mock.patch.object(platform, "system", lambda: "FreeBSD"):
            res = check_command_mandatory("ls")
        self.assertEqual(res["allowed"], False)
        self.assertEqual(res["reason"], "scanner_unsupported_platform")


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
                barrier.wait(timeout=10)
                results.append(cb.can_execute())

            threads = [threading.Thread(target=worker) for _ in range(n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10)
                self.assertFalse(t.is_alive())
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
            # Probe failure (or aborted probe) re-arms cooldown
            cb.record_failure(is_probe=True)
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
            cb.record_success(is_probe=True)
        self.assertEqual(cb._crash_count, 0)
        self.assertFalse(cb._circuit_open)
        self.assertEqual(cb.can_execute(), (True, False))

    def test_aborted_probe_rearms_cooldown(self):
        cb = _MandatoryCircuitBreaker(crash_limit=3, cooldown=60.0)
        for _ in range(3):
            cb.record_failure(is_probe=False)
        now = 1000.0
        with mock.patch.object(time, "monotonic", lambda: now):
            cb._open_time = now - 61.0
            self.assertEqual(cb.can_execute(), (True, True))
            # Aborted probe releases probe reservation and re-arms cooldown
            cb.release_probe()
            self.assertEqual(cb.can_execute(), (False, False))
            self.assertFalse(cb._probing)
            self.assertTrue(cb._circuit_open)

    def test_policy_blocks_do_not_count_as_execution_failures(self):
        cb = _MandatoryCircuitBreaker(crash_limit=3, cooldown=60.0)
        for _ in range(10):
            cb.record_success(is_probe=False)
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
        return "/usr/local/share/hermes-command-scan/home"

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
            res = check_all_command_guards("ls", env_type="local")
            assert res["approved"] is False, f"Expected blocked but got {{res}}"
            assert res["reason"] == "scanner_import_failed", f"Expected scanner_import_failed but got {{res}}"
            print("BLOCKED_IMPORT_FAILED")
        """)
        out = subprocess.run(
            [sys.executable, "-B", "-c", code], capture_output=True, text=True,
            env=_child_env({}), cwd=SRCDIR, timeout=60,
        )
        self.assertEqual(out.returncode, 0)
        self.assertIn("BLOCKED_IMPORT_FAILED", out.stdout)


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


# ── R4: EXACT adapter argv parsed through the REAL patched parser (TECH-7355) ───────
class TestAdapterArgvParserParity(RegressionBase):
    """Independent parity between the TS adapter's exact spawn argv
    (packages/adapters/hermes/src/server/execute.ts + command-scan-policy.ts)
    and the REAL patched hermes_cli parser.

    The argv below mirrors the adapter's actual construction, token for token:
      applyCommandScanPolicy prepends "--require-command-scan" at argv[0], then
      ["chat", "-q", <prompt>, "-Q"] + optional ["-m", model] ["--provider", p]
      ["-t", toolsets] ["--max-turns", N] "-w" "--checkpoints" "-v"
      ["--source", "tool"] "--yolo" ["--resume", sessionId] + extraArgs.
    Every case is parsed with the LOCKED, REAL patched top-level parser —
    never a hand-rolled argv scanner — so a parser/adapter drift on either
    side of the language boundary fails here."""

    # Mirror of VALUE_TAKING_OPTIONS in packages/adapters/hermes/src/server/
    # command-scan-policy.ts. Kept in lockstep with that export; the two
    # assertions below prove the mirror matches the REAL parser surface.
    TS_VALUE_TAKING_OPTIONS = {
        "-q", "--query", "--query-file", "-m", "--model", "--provider",
        "--reasoning", "-s", "--skills", "-t", "--toolsets", "--image",
        "-p", "--profile", "--source",
        "--in", "--max-turns", "-r", "--resume", "--run-budget",
    }

    ADAPTER_PROMPT = (
        "Please summarize `git log --stat` for issue #7; note how "
        "--require-command-scan appears in this sentence as DATA"
    )

    def _parse(self, argv):
        parser, _, _ = parser_mod.build_top_level_parser()
        return parser.parse_args(argv)

    def test_adapter_prefix_argv_parses_and_requires_scan(self):
        # The adapter's exact default argv: policy flag at argv[0], chat at
        # argv[1], quiet -q prompt, -Q, --source tool, --yolo (execute.ts).
        ns = self._parse([
            "--require-command-scan", "chat", "-q", self.ADAPTER_PROMPT,
            "-Q", "--source", "tool", "--yolo",
        ])
        self.assertTrue(ns.require_command_scan)
        self.assertEqual(ns.query, self.ADAPTER_PROMPT)  # verbatim data
        self.assertTrue(ns.quiet)
        self.assertEqual(ns.source, "tool")
        self.assertTrue(ns.yolo)

    def test_adapter_maximal_argv_parses_every_optional_flag_verbatim(self):
        ns = self._parse([
            "--require-command-scan", "chat", "-q", self.ADAPTER_PROMPT, "-Q",
            "-m", "anthropic/claude-sonnet-4", "--provider", "openrouter",
            "-t", "terminal,files", "--max-turns", "25", "-w", "--checkpoints",
            "-v", "--source", "tool", "--yolo", "--resume", "sess-abc123",
            "-s", "github",
        ])
        self.assertTrue(ns.require_command_scan)
        self.assertEqual(ns.query, self.ADAPTER_PROMPT)
        self.assertEqual(ns.model, "anthropic/claude-sonnet-4")
        self.assertEqual(ns.provider, "openrouter")
        self.assertEqual(ns.toolsets, "terminal,files")
        self.assertEqual(ns.max_turns, 25)
        self.assertTrue(ns.worktree)
        self.assertTrue(ns.checkpoints)
        self.assertTrue(ns.verbose)
        self.assertEqual(ns.source, "tool")
        self.assertTrue(ns.yolo)
        self.assertEqual(ns.resume, "sess-abc123")
        self.assertEqual(ns.skills, ["github"])  # extraArgs appended verbatim

    def test_require_command_scan_valid_in_both_top_and_chat_positions(self):
        # Guards the committed R3-era adapter form ['chat', '--require-...']:
        # the final patch inherits the flag onto the chat subparser, so BOTH
        # positions parse True; the adapter must keep the prefix position
        # (pinned exactly in execute.command-scan.test.ts).
        ns_prefix = self._parse(["--require-command-scan", "chat", "-q", "hi", "-Q"])
        self.assertTrue(ns_prefix.require_command_scan)
        ns_after_chat = self._parse(["chat", "--require-command-scan", "-q", "hi", "-Q"])
        self.assertTrue(ns_after_chat.require_command_scan)
        ns_bare_top = self._parse(["--require-command-scan"])
        self.assertTrue(ns_bare_top.require_command_scan)

    def test_oneshot_value_semantics_differ_between_top_and_chat_contexts(self):
        # REAL argparse parity for the two oneshot surfaces: the TOP-level
        # -z/--oneshot takes a PROMPT value; the chat-level --oneshot is a
        # store_true flag with a distinct dest (oneshot_exit).
        ns_top = self._parse(["--require-command-scan", "-z", "hello world"])
        self.assertTrue(ns_top.require_command_scan)
        self.assertEqual(ns_top.oneshot, "hello world")
        ns_top_after = self._parse(["-z", "hello world", "--require-command-scan"])
        self.assertTrue(ns_top_after.require_command_scan)
        self.assertEqual(ns_top_after.oneshot, "hello world")
        ns_chat = self._parse(["chat", "--require-command-scan", "--oneshot", "-q", "hi"])
        self.assertTrue(ns_chat.require_command_scan)
        self.assertTrue(ns_chat.oneshot_exit)
        self.assertIsNone(getattr(ns_chat, "oneshot", None))

    def test_prompt_data_with_literal_flag_string_stays_data(self):
        # The prompt is DATA: a sentence containing the literal flag text must
        # never be confused with the control flag, and the control flag must
        # still come from the adapter's argv[0] position.
        ns = self._parse(["--require-command-scan", "chat", "-q",
                          "How do I configure --require-command-scan?", "-Q"])
        self.assertTrue(ns.require_command_scan)
        self.assertEqual(ns.query, "How do I configure --require-command-scan?")
        # Pathological prompt token EXACTLY equal to the flag: real argparse
        # treats it as the -q value being missing (the token parses as the
        # flag) -> SystemExit 2. Fail-closed crash, never a silent treat-as-
        # control or treat-as-data inconsistency.
        with self.assertRaises(SystemExit) as ctx:
            self._parse(["--require-command-scan", "chat", "-q",
                         "--require-command-scan", "-Q"])
        self.assertEqual(ctx.exception.code, 2)

    def test_attached_equals_and_negative_values_parse_as_data(self):
        # Parity with validateHermesArgs' data-skip decisions: attached
        # `=` values and negative-number values are DATA, not control flags.
        ns = self._parse(["chat", "-q=--no-require-command-scan"])
        self.assertEqual(ns.query, "--no-require-command-scan")
        self.assertFalse(getattr(ns, "require_command_scan", False))
        ns2 = self._parse(["chat", "--query=--skip-command-scan"])
        self.assertEqual(ns2.query, "--skip-command-scan")
        ns3 = self._parse(["chat", "-q", "-5", "-Q"])
        self.assertEqual(ns3.query, "-5")

    def test_real_parser_rejects_masking_and_bypass_forms(self):
        # REAL argparse facts paired with the TS validator pins: every form
        # here MUST be a hard parse error (SystemExit 2) in the real parser.
        reject_cases = [
            ["chat", "-q"],                                  # missing value
            ["chat", "-q", "--", "x"],                       # -- is not a value
            ["chat", "--no-require-command-scan"],           # reserved flag
            ["chat", "--require-command-scan=false"],        # store_true takes no value
            ["chat", "-q", "hi", "--query-file", "/q.txt"],  # -q/--query-file exclusive
            ["chat", "--workdir", "/tmp"],                    # INVENTED option (see below)
            ["chat", "--workdir=/tmp"],                       # invented option, '='-attached
            ["chat", "--prompt", "x"],                        # invented option (removed)
        ]
        for argv in reject_cases:
            with self.assertRaises(SystemExit, msg=f"expected parse error for {argv}") as ctx:
                self._parse(argv)
            self.assertEqual(ctx.exception.code, 2, msg=f"argv={argv}")

    def test_top_only_flags_are_rejected_after_the_chat_subcommand(self):
        # REAL argparse context parity: these flags exist ONLY on the top-level
        # parser; after the chat subcommand every one is an unrecognized-
        # arguments error. (The TS validator's VALUE_TAKING list is context-
        # blind — see the mirror test — so these facts pin the real surface.)
        for argv in (
            ["chat", "--version"],
            ["chat", "-V"],
            ["chat", "-z", "hi"],           # top -z/--oneshot takes a PROMPT; chat does not
            ["chat", "--usage-file", "x"],
            ["chat", "--oneshot", "hi"],    # chat --oneshot is store_true: 'hi' is a positional
        ):
            with self.assertRaises(SystemExit, msg=f"expected parse error for {argv}") as ctx:
                self._parse(argv)
            self.assertEqual(ctx.exception.code, 2, msg=f"argv={argv}")

    def test_option_terminator_tokens_become_unrecognized_positionals_in_chat(self):
        # REAL argparse facts for the '--' terminator: the chat subparser has
        # NO positional passthrough, so every token after '--' (including a
        # reserved bypass flag and even a bare trailing '--') is an
        # unrecognized-arguments error. Post-'--' argv can never reach the
        # scanner surface as control in this adapter's form: fail-closed.
        for argv in (
            ["chat", "-q", "hi", "--", "--no-require-command-scan"],
            ["chat", "-q", "hi", "--", "echo", "hello"],
            ["--require-command-scan", "chat", "-q", "hi", "--", "x"],
            ["chat", "-q", "hi", "--"],
        ):
            with self.assertRaises(SystemExit, msg=f"expected parse error for {argv}") as ctx:
                self._parse(argv)
            self.assertEqual(ctx.exception.code, 2, msg=f"argv={argv}")

    def test_value_option_followed_by_flag_token_is_a_missing_value_error(self):
        # REAL argparse single-dash/space logic: a value-taking option whose
        # follower looks like a flag gets "expected one argument" — argparse
        # NEVER consumes a flag-looking token as the value, and NEVER treats
        # the control flag as data. Paired with the TS-side current-behavior
        # pins (the R3 validator also reads the follower as a flag, so it
        # accepts these and the child fails closed at argparse).
        for argv in (
            ["chat", "-q", "-Q"],
            ["chat", "-q", "--yolo"],
            ["chat", "-q", "--require-command-scan"],
        ):
            with self.assertRaises(SystemExit, msg=f"expected parse error for {argv}") as ctx:
                self._parse(argv)
            self.assertEqual(ctx.exception.code, 2, msg=f"argv={argv}")

    def test_ts_value_taking_options_mirror_the_real_parser_surface(self):
        """MATERIAL PARITY: the TS VALUE_TAKING_OPTIONS mirror must match the
        REAL patched parser surface exactly.

        (a) Every mirrored option must be a real value flag of the chat
            subparser (or the pre-argparse -p/--profile pair), so the
            validator never FABRICATES a token skip.
        (b) Every REQUIRED-value chat flag must appear in the mirror, so the
            validator never misses a real "requires a value" contract.
        Optional-value flags (-c/--continue, nargs='?') are exempt: a dash-
        prefixed follower is validated as a flag, which argparse also treats
        as a flag there."""
        parser, _, chat_parser = parser_mod.build_top_level_parser()
        real_chat_required = set()
        for action in chat_parser._actions:
            if not action.option_strings or action.nargs == 0 or action.nargs == "?":
                continue
            real_chat_required.update(action.option_strings)
        pre_argparse = {flag for flag, _ in parser_mod.PRE_ARGPARSE_INHERITED_FLAGS}

        invented = sorted(self.TS_VALUE_TAKING_OPTIONS - real_chat_required - pre_argparse)
        missing = sorted(real_chat_required - self.TS_VALUE_TAKING_OPTIONS)

        self.assertEqual(
            invented, [],
            "MATERIAL (adapter/parser drift): VALUE_TAKING_OPTIONS lists option(s) "
            f"the REAL patched Hermes parser does not define: {invented}. The real "
            "flags are '--in DIR' and '--worktree/-w' (store_true). validateHermesArgs "
            "skips the token after every listed option, so an invented entry "
            "fabricates a skip the real parser never performs (the child fails at "
            "argparse instead of the validator failing first).",
        )
        self.assertEqual(
            missing, [],
            "MATERIAL (adapter/parser drift): VALUE_TAKING_OPTIONS is missing REAL "
            f"required-value chat flag(s): {missing}. A listed-only-elsewhere surface "
            "lets e.g. ['chat','--resume'] pass validateHermesArgs while the real "
            "parser rejects it (fail-closed crash, never validated at the seam).",
        )

    def test_main_pre_scan_finds_flag_in_every_control_position(self):
        """The REAL final _scan_for_require_command_scan_flag (extracted from
        the patched hermes_cli/main.py, never re-implemented here) must see the
        flag in every CONTROL position and must never skip past it behind an
        invented flag. Guards the committed R2-era skip-set bug ('--prompt' /
        '--workdir' were in the skip set and masked the flag)."""
        import ast as ast_mod

        main_py = os.path.join(SRCDIR, "hermes_cli", "main.py")
        with open(main_py, encoding="utf-8") as f:
            tree = ast_mod.parse(f.read(), filename=main_py)
        wanted = {"_KNOWN_VALUE_FLAGS", "_scan_for_require_command_scan_flag"}
        picked = [node for node in tree.body
                  if (isinstance(node, ast_mod.Assign)
                      and any(isinstance(t, ast_mod.Name) and t.id in wanted for t in node.targets))
                  or (isinstance(node, (ast_mod.FunctionDef, ast_mod.AsyncFunctionDef))
                      and node.name in wanted)]
        self.assertEqual(
            {n.name if isinstance(n, (ast_mod.FunctionDef, ast_mod.AsyncFunctionDef))
             else "_KNOWN_VALUE_FLAGS"
             for n in picked}, wanted, "could not extract the real scan helpers from main.py",
        )
        namespace: dict = {}
        exec(compile(ast_mod.Module(body=picked, type_ignores=[]), main_py, "exec"), namespace)
        scan = namespace["_scan_for_require_command_scan_flag"]

        # Control positions: found.
        self.assertTrue(scan(["--require-command-scan", "chat", "-q", "hi"]))       # adapter form
        self.assertTrue(scan(["chat", "--require-command-scan", "-q", "hi"]))      # after chat
        # Data positions: not found (values of real value flags).
        self.assertFalse(scan(["chat", "-q", "How to use --require-command-scan?"]))
        self.assertFalse(scan(["chat", "-q=--require-command-scan", "-Q"]))        # attached '=' data
        self.assertFalse(scan(["chat", "-m", "--require-command-scan"]))           # real value skip
        self.assertFalse(scan(["chat", "--", "--require-command-scan"]))           # terminator
        self.assertFalse(scan([]))
        # R2-era bug guards: INVENTED flags must never be in the skip set —
        # the flag behind them must still be FOUND (it is real argv input).
        self.assertTrue(scan(["chat", "--prompt", "--require-command-scan"]))
        self.assertTrue(scan(["chat", "--workdir", "--require-command-scan"]))


# ── R4: REAL bounded-runner EOF lifecycle (material S1) ─────────────────────────────
class TestBoundedRunnerEofLifecycle(RegressionBase):
    """Material R4 S1 coverage the existing suite does not exercise: a scanner
    child that writes a valid allow JSON, closes fd 1/2, and THEN finishes up
    (sleeps briefly before exit) is a HEALTHY scanner — EOF is not exit. The
    runner must wait for the child within the original deadline and return its
    real exit code; killing the child at EOF books every such scan as a signal
    crash (rc<0) and arms the circuit breaker on healthy scanners."""

    @classmethod
    def setUpClass(cls):
        cls.stub_dir = os.path.join(CONTROL_BASE, "r4-eof-stubs")
        os.makedirs(cls.stub_dir, exist_ok=True)
        allow = verdict_bytes("allow", []).decode("utf-8")
        # EOF-before-exit: verdict, close fd 1/2, brief finalize sleep, exit 0.
        cls.eof_exit_stub = os.path.join(cls.stub_dir, "tirith-eof-exit-stub")
        with open(cls.eof_exit_stub, "w", encoding="utf-8") as f:
            f.write(
                "#!/usr/bin/env python3\n"
                "import os, sys, time\n"
                f"sys.stdout.write({allow!r})\n"
                "sys.stdout.flush()\n"
                "os.close(1)\n"
                "os.close(2)\n"
                "time.sleep(0.3)\n"  # finalize before exit — EOF arrived earlier
            )
        os.chmod(cls.eof_exit_stub, 0o755)
        # EOF-then-hang: verdict, close fd 1/2, hang; late marker only after.
        cls.late_marker = os.path.join(cls.stub_dir, "late.marker")
        cls.eof_hang_stub = os.path.join(cls.stub_dir, "tirith-eof-hang-stub")
        with open(cls.eof_hang_stub, "w", encoding="utf-8") as f:
            f.write(
                "#!/usr/bin/env python3\n"
                "import os, sys, time\n"
                f"sys.stdout.write({allow!r})\n"
                "sys.stdout.flush()\n"
                "os.close(1)\n"
                "os.close(2)\n"
                "time.sleep(30)\n"
                f"open({cls.late_marker!r}, 'w').write('late')\n"
            )
        os.chmod(cls.eof_hang_stub, 0o755)
        # Never writes, hangs: pure deadline case.
        cls.mute_hang_stub = os.path.join(cls.stub_dir, "tirith-mute-hang-stub")
        with open(cls.mute_hang_stub, "w", encoding="utf-8") as f:
            f.write("#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n")
        os.chmod(cls.mute_hang_stub, 0o755)
        # Cancellation: records pid + a started marker, hangs; late marker after.
        cls.pid_record = os.path.join(cls.stub_dir, "cancel.pid")
        cls.started_marker = os.path.join(cls.stub_dir, "cancel-started.marker")
        cls.cancel_late_marker = os.path.join(cls.stub_dir, "cancel-late.marker")
        cls.cancel_stub = os.path.join(cls.stub_dir, "tirith-cancel-stub")
        with open(cls.cancel_stub, "w", encoding="utf-8") as f:
            f.write(
                "#!/usr/bin/env python3\n"
                "import os, time\n"
                f"open({cls.pid_record!r}, 'w').write(str(os.getpid()))\n"
                f"open({cls.started_marker!r}, 'w').write('started')\n"
                "time.sleep(30)\n"
                f"open({cls.cancel_late_marker!r}, 'w').write('late')\n"
            )
        os.chmod(cls.cancel_stub, 0o755)
        # Stderr flood: 70KB on stderr then a valid allow JSON on stdout.
        cls.stderr_flood_stub = os.path.join(cls.stub_dir, "tirith-stderr-flood-stub")
        with open(cls.stderr_flood_stub, "w", encoding="utf-8") as f:
            f.write(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                "sys.stderr.write('B' * 70000)\n"
                "sys.stderr.flush()\n"
                f"sys.stdout.write({allow!r})\n"
                "sys.stdout.flush()\n"
            )
        os.chmod(cls.stderr_flood_stub, 0o755)

    def setUp(self):
        super().setUp()
        for marker in (self.late_marker, self.cancel_late_marker, self.started_marker):
            if os.path.exists(marker):
                os.unlink(marker)

    def test_eof_before_exit_child_completes_normally(self):
        # MATERIAL (current tree fails): the runner must wait for the child
        # within the remaining deadline and return its REAL exit code 0 with
        # the verdict intact — not SIGKILL it at EOF and report rc=-9.
        runner = getattr(tirith_security, "_run_scanner_bounded", None)
        if runner is None:
            self.fail("MATERIAL FAILURE: no bounded scanner runner in the patched tree")
        for i in range(5):
            with self.subTest(iteration=i):
                rc, out, err, fail = runner([self.eof_exit_stub], {}, 5.0)
                self.assertIsNone(fail, f"iter {i}: unexpected failure {fail!r}")
                self.assertEqual(
                    rc, 0,
                    "MATERIAL (R4 S1): EOF-before-exit scanner was killed before exit "
                    f"(rc={rc}); a scanner that closes fd 1/2 and finalizes before exit "
                    "is HEALTHY and must exit with its own code",
                )
                self.assertEqual(out, verdict_bytes("allow", []))

    def test_full_guard_treats_eof_before_exit_scanner_as_healthy_allow(self):
        # MATERIAL (current tree fails): through the FULL guard, three healthy
        # EOF-before-exit allow scans must ALLOW and leave the breaker closed.
        for i in range(3):
            with mock.patch.dict(os.environ, mandatory_env(self.eof_exit_stub)), \
                 linux_x86_scanner_env(self.eof_exit_stub):
                res = check_command_mandatory("git status")
            self.assertEqual(
                res, {"allowed": True, "reason": "", "findings": []},
                f"MATERIAL (R4 S1): healthy EOF-before-exit scanner denied on scan {i}: {res}",
            )
        self.assertEqual(
            self.crash_count(), 0,
            "MATERIAL (R4 S1): healthy EOF-before-exit allow scans were booked as "
            "execution failures; 3 healthy scans would wrongly open the breaker",
        )

    def test_eof_then_hang_times_out_within_original_deadline(self):
        # A scanner that closes its pipes and hangs must be given up on by the
        # ORIGINAL deadline (classified scanner_timeout), killed, and never
        # allowed to reach its late marker. No max(0.5, remaining) overshoot
        # past the deadline plus reap allowance.
        runner = tirith_security._run_scanner_bounded
        timeout = 1.5
        t0 = time.monotonic()
        rc, out, err, fail = runner([self.eof_hang_stub], {}, timeout)
        elapsed = time.monotonic() - t0
        self.assertEqual(
            fail, "scanner_timeout",
            f"MATERIAL (R4 S1): EOF-then-hang scanner misclassified (fail={fail!r}, rc={rc})",
        )
        self.assertLessEqual(
            elapsed, timeout + 1.5,
            f"runner overshot the original deadline: elapsed={elapsed:.2f}s > {timeout + 1.5:.2f}s",
        )
        self.assertFalse(os.path.exists(self.late_marker), "hung scanner was not killed")

    def test_mute_hang_times_out_within_original_deadline(self):
        # No output at all: pure deadline enforcement without any EOF signal.
        runner = tirith_security._run_scanner_bounded
        timeout = 1.0
        t0 = time.monotonic()
        rc, out, err, fail = runner([self.mute_hang_stub], {}, timeout)
        elapsed = time.monotonic() - t0
        self.assertEqual(fail, "scanner_timeout")
        self.assertLessEqual(elapsed, timeout + 1.5,
                             f"elapsed={elapsed:.2f}s overshot the original deadline")

    def test_keyboard_interrupt_reaps_child_and_leaves_no_marker(self):
        # Cancellation while waiting: KeyboardInterrupt must propagate (never
        # be swallowed into a verdict), the child must be reaped, its FDs
        # closed, and the late marker never written. The interrupt is injected
        # only AFTER the child provably started (started marker written), so
        # the cancellation lands mid-wait deterministically.
        import selectors

        started_marker = self.started_marker

        class _InterruptingSelector(selectors.DefaultSelector):
            def select(self, *a, **k):
                give_up = time.monotonic() + 10.0
                while not os.path.exists(started_marker):
                    if time.monotonic() > give_up:
                        raise AssertionError("cancel stub never started")
                    time.sleep(0.01)
                raise KeyboardInterrupt("cancel-scanner-wait")

        runner = tirith_security._run_scanner_bounded
        with mock.patch.object(tirith_security.selectors, "DefaultSelector", _InterruptingSelector):
            with self.assertRaises(KeyboardInterrupt):
                runner([self.cancel_stub], {}, 30.0)
        self.assertTrue(os.path.exists(self.pid_record), "cancellation stub never spawned")
        self.assertTrue(os.path.exists(started_marker), "cancellation interrupted before the child started")
        with open(self.pid_record, encoding="utf-8") as f:
            pid = int(f.read().strip())
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            except PermissionError:
                break  # reaped but not yet waited on by init on some hosts
            time.sleep(0.05)
        else:
            self.fail(f"cancellation did not reap the scanner child pid={pid}")
        self.assertFalse(os.path.exists(self.cancel_late_marker),
                         "cancelled scanner child survived and hit its late marker")
        # The teardown left no lingering selector/FD state: a fresh bounded
        # run returns a verdict afterwards (its exit-code semantics are pinned
        # separately by the EOF tests above).
        rc2, out2, err2, fail2 = tirith_security._run_scanner_bounded(
            [self.eof_exit_stub], {}, 5.0)
        self.assertIsNone(fail2)
        self.assertEqual(out2, verdict_bytes("allow", []))

    def test_stderr_flood_is_capped_and_fail_closed(self):
        # Keep the caps contract: a stderr-flooding scanner is terminated with
        # scanner_malformed_output and never buffers more than one chunk past
        # the 64KB cap on either stream.
        runner = tirith_security._run_scanner_bounded
        rc, out, err, fail = runner([self.stderr_flood_stub], {}, 10.0, max_bytes=65536)
        self.assertEqual(fail, "scanner_malformed_output")
        self.assertLessEqual(len(err), 65536 + 4096)
        self.assertLessEqual(len(out), 65536 + 4096)

    def test_execute_scanner_wrapper_delegates_to_the_single_bounded_runner_seam(self):
        # The patched tree still routes every scan through the wrapper
        # (_execute_scanner -> _run_scanner_bounded). That makes the runner the
        # SINGLE spawn seam: the still-live premature-kill-at-EOF defect (S1)
        # must be repaired INSIDE _run_scanner_bounded, and no second spawn
        # path (e.g. a raw subprocess.run fallback that skips the stream caps,
        # the deadline, and the reap handling) may be bolted onto the wrapper.
        wrapper = getattr(tirith_security, "_execute_scanner", None)
        if wrapper is None:
            self.fail("MATERIAL: no _execute_scanner wrapper in the patched tree")
        sentinel = (0, b'{"seam": "bounded-runner"}', b"", None)

        def fail_run(*a, **k):
            raise AssertionError("wrapper must not fall back to raw subprocess.run")

        with mock.patch.object(tirith_security, "_run_scanner_bounded",
                               lambda *a, **k: sentinel), \
             mock.patch.object(subprocess, "run", fail_run):
            self.assertEqual(wrapper(["/scanner"], {}, 5.0), sentinel)


# ── R4: latch authority across env clearing and REAL import failures ────────────────
class TestLatchAuthorityAndImportFailure(RegressionBase):
    """tools.approval latches the required state at import (env or argv) — the
    authority terminal_tool delegates to. Once latched, clearing the env and
    breaking the scanner import must deny normal runs, force replays, AND the
    direct approval guard, fail-closed, while the not-required legacy path
    stays unchanged."""

    def test_import_latch_survives_env_clearing_import_error_denies_normal_force_and_direct(self):
        code = textwrap.dedent(f"""
            import os, sys, json
            class BlockTirith:
                def find_spec(self, fullname, path=None, target=None):
                    if fullname == "tools.tirith_security":
                        raise ImportError("blocked-for-regression")
                    return None
            os.environ["HERMES_REQUIRE_COMMAND_SCAN"] = "1"
            sys.path.insert(0, {SRCDIR!r})
            sys.meta_path.insert(0, BlockTirith())
            from tools import approval as approval_mod
            from tools import terminal_tool as terminal_mod
            assert approval_mod._MANDATORY_COMMAND_SCAN_LATCHED is True, "latch must arm at import"
            del os.environ["HERMES_REQUIRE_COMMAND_SCAN"]
            out = {{}}
            r = approval_mod.check_all_command_guards("git status", env_type="local")
            out["direct"] = {{"approved": r["approved"], "reason": r.get("reason", "")}}
            from tools.terminal_tool import _Rejected
            try:
                terminal_mod._run_approval_guards("git status", env_type="local", config={{}}, force=False)
                out["normal"] = {{"rejected": False}}
            except _Rejected as e:
                out["normal"] = {{"rejected": True, "msg": str(e)}}
            try:
                terminal_mod._run_approval_guards("git status", env_type="local", config={{}}, force=True)
                out["force"] = {{"rejected": False}}
            except _Rejected as e:
                out["force"] = {{"rejected": True, "msg": str(e)}}
            print(json.dumps(out))
        """)
        out = subprocess.run(
            [sys.executable, "-B", "-c", code], capture_output=True, text=True,
            env=_child_env({}), cwd=SRCDIR, timeout=60,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        res = json.loads(out.stdout.strip())
        self.assertIs(res["direct"]["approved"], False)
        self.assertEqual(res["direct"]["reason"], "scanner_import_failed")
        for lane in ("normal", "force"):
            self.assertTrue(res[lane]["rejected"], f"{lane} must fail closed after env clear")
            self.assertIn("scanner_import_failed", res[lane]["msg"])

    def test_import_latch_with_sys_modules_none_denies_normal_force_and_direct(self):
        code = textwrap.dedent(f"""
            import os, sys, json
            os.environ["HERMES_REQUIRE_COMMAND_SCAN"] = "1"
            sys.path.insert(0, {SRCDIR!r})
            from tools import approval as approval_mod
            from tools import terminal_tool as terminal_mod
            assert approval_mod._MANDATORY_COMMAND_SCAN_LATCHED is True
            del os.environ["HERMES_REQUIRE_COMMAND_SCAN"]
            sys.modules["tools.tirith_security"] = None
            out = {{}}
            r = approval_mod.check_all_command_guards("git status", env_type="local")
            out["direct"] = {{"approved": r["approved"], "reason": r.get("reason", "")}}
            from tools.terminal_tool import _Rejected
            try:
                terminal_mod._run_approval_guards("git status", env_type="local", config={{}}, force=False)
                out["normal"] = {{"rejected": False}}
            except _Rejected as e:
                out["normal"] = {{"rejected": True, "msg": str(e)}}
            try:
                terminal_mod._run_approval_guards("git status", env_type="local", config={{}}, force=True)
                out["force"] = {{"rejected": False}}
            except _Rejected as e:
                out["force"] = {{"rejected": True, "msg": str(e)}}
            print(json.dumps(out))
        """)
        out = subprocess.run(
            [sys.executable, "-B", "-c", code], capture_output=True, text=True,
            env=_child_env({}), cwd=SRCDIR, timeout=60,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        res = json.loads(out.stdout.strip())
        self.assertIs(res["direct"]["approved"], False)
        self.assertEqual(res["direct"]["reason"], "scanner_import_failed")
        for lane in ("normal", "force"):
            self.assertTrue(res[lane]["rejected"])
            self.assertIn("scanner_import_failed", res[lane]["msg"])

    def test_poison_scanner_module_under_latch_denies_and_without_latch_propagates(self):
        # RuntimeError poison is handled SEPARATELY from ImportError but must
        # still deny under a latched authority; without authority it must
        # propagate (fail-closed by crash, never a silent allow). Both the
        # sys.modules entry AND the parent package attribute are poisoned:
        # approval binds the scanner via `from tools import tirith_security`,
        # which prefers the parent package's attribute over sys.modules.
        real_mod = sys.modules["tools.tirith_security"]
        real_pkg_attr = getattr(sys.modules["tools"], "tirith_security", None)
        poison = types.ModuleType("tools.tirith_security")

        def _boom(name):
            raise RuntimeError("corrupt-scanner-module")

        poison.__getattr__ = _boom  # type: ignore[attr-defined]
        try:
            sys.modules["tools.tirith_security"] = poison
            sys.modules["tools"].tirith_security = poison
            with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}):
                # Arm the latch through the authority the guards consult.
                self.assertTrue(approval_mod._is_mandatory_command_scan_required())
                res = approval_mod.check_all_command_guards("git status", env_type="local")
                self.assertIs(res["approved"], False)
                self.assertEqual(res["reason"], "scanner_import_failed")
            # Reset the ACTUAL authority (exactly as RegressionBase.setUp does).
            approval_mod._MANDATORY_COMMAND_SCAN_LATCHED = False
            os.environ.pop("HERMES_REQUIRE_COMMAND_SCAN", None)
            with self.assertRaises(RuntimeError):
                approval_mod.check_all_command_guards("git status", env_type="local")
        finally:
            sys.modules["tools.tirith_security"] = real_mod
            if real_pkg_attr is not None:
                sys.modules["tools"].tirith_security = real_pkg_attr

    def test_scanner_frozen_false_while_authority_required_denies(self):
        # The scanner module imports fine but its OWN frozen state says "not
        # required" (it was imported before the env was set, then the env was
        # cleared). The latched authority must still deny: scanner_not_configured.
        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}):
            self.assertTrue(approval_mod._is_mandatory_command_scan_required())  # latches
        clean_env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_")}
        with mock.patch.dict(os.environ, clean_env, clear=True):
            self.assertFalse(tirith_security.is_mandatory_scan_mode())  # frozen False
            res = approval_mod.check_all_command_guards("git status", env_type="local")
            self.assertIs(res["approved"], False)
            self.assertEqual(res["reason"], "scanner_not_configured")
            with self.assertRaises(terminal_mod._Rejected) as ctx:
                terminal_mod._run_approval_guards(
                    "git status", env_type="local", config={}, force=True)
            self.assertIn("scanner_not_configured", str(ctx.exception))

    def test_not_required_import_error_preserves_legacy_approval_path(self):
        # Generic, not-required + ImportError: the pre-TECH-7355 behavior is
        # preserved — the scan is skipped and the legacy approval flow runs.
        # `from tools import tirith_security` binds the parent package's
        # attribute when present, so the attr is removed too to force the
        # REAL ImportError branch.
        pkg = sys.modules["tools"]
        had_attr = hasattr(pkg, "tirith_security")
        real_mod = sys.modules.get("tools.tirith_security")
        try:
            if had_attr:
                del pkg.tirith_security
            sys.modules["tools.tirith_security"] = None
            with mock.patch.dict(os.environ, {"HERMES_YOLO_MODE": "1"}):
                os.environ.pop("HERMES_REQUIRE_COMMAND_SCAN", None)
                res = approval_mod.check_all_command_guards("git status", env_type="local")
        finally:
            del sys.modules["tools.tirith_security"]
            if real_mod is not None:
                sys.modules["tools.tirith_security"] = real_mod
            if had_attr:
                pkg.tirith_security = real_mod
        self.assertIs(res["approved"], True)
        self.assertNotEqual(res.get("reason", ""), "scanner_import_failed")

    def test_approval_latch_reset_restores_authority_and_is_not_shadowed(self):
        # The ACTUAL authority is approval's latch. Resetting it (as setUp
        # does) must restore "not required"; terminal_tool must delegate to
        # approval's function (no separate terminal-local bool that can drift
        # or alias the reset away).
        with mock.patch.dict(os.environ, {"HERMES_REQUIRE_COMMAND_SCAN": "1"}):
            self.assertTrue(approval_mod._is_mandatory_command_scan_required())
            self.assertTrue(approval_mod._MANDATORY_COMMAND_SCAN_LATCHED)
        # terminal delegates to the SAME authority function — not a copied bool.
        self.assertIs(
            getattr(terminal_mod, "_is_mandatory_command_scan_required", None),
            approval_mod._is_mandatory_command_scan_required,
            "terminal_tool must delegate to approval's authority function; a "
            "terminal-local latch bool would drift from the real authority",
        )
        # Reset the actual authority exactly as the fixture does.
        approval_mod._MANDATORY_COMMAND_SCAN_LATCHED = False
        os.environ.pop("HERMES_REQUIRE_COMMAND_SCAN", None)
        self.assertFalse(approval_mod._is_mandatory_command_scan_required())
        # No leaked required state: a yolo clean command approves normally.
        with mock.patch.dict(os.environ, {"HERMES_YOLO_MODE": "1"}):
            res = approval_mod.check_all_command_guards("git status", env_type="local")
        self.assertIs(res["approved"], True)
        self.assertNotEqual(res.get("reason", ""), "scanner_not_configured")


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(CONTROL_BASE, ignore_errors=True)
        if FROM_COMMIT:
            with contextlib.suppress(OSError):
                os.unlink(PATCH_PATH)
