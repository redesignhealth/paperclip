#!/usr/bin/env python3
"""Independent test harness for the Mem0 patches: auto_sync control (TECH-8191) and MEM0_PROXY (TECH-8409).

Verifies:
1. Pinned upstream source tarball checksum matches source.lock.
2. patches.lock checksums and markers for both 0001 and 0002 patches.
3. Clean application of 0001 and 0002 patches to freshly unpacked 0.21.3 source.
4. Python module marker and _coerce_bool parsing behavior.
5. Patch 0003 applies cleanly and SelfHostedBackend honors the opt-in MEM0_PROXY (and only that variable).
6. Mem0 provider behavior with doubles:
   - Missing auto_sync defaults to existing automatic turn sync (client.add called).
   - auto_sync: false completely disables automatic sync_turn writes (zero client.add from sync_turn).
   - Explicit memory operations (mem0_add, mem0_search, mem0_update, mem0_delete, prefetch) remain fully functional.
   - auto_sync: true retains automatic turn sync.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock

REPO_ROOT = Path(__file__).resolve().parent.parent
HERMES_DOCKER_DIR = REPO_ROOT / "docker" / "hermes"
SOURCE_LOCK_PATH = HERMES_DOCKER_DIR / "source.lock"
PATCHES_LOCK_PATH = HERMES_DOCKER_DIR / "patches.lock"

# Parse custom CLI args before unittest.main consumes sys.argv
CUSTOM_TARBALL_PATH: str | None = None
if "--tarball" in sys.argv:
    idx = sys.argv.index("--tarball")
    if idx + 1 < len(sys.argv):
        CUSTOM_TARBALL_PATH = sys.argv[idx + 1]
        del sys.argv[idx : idx + 2]
    else:
        sys.stderr.write("ERROR: --tarball requires a path argument\n")
        sys.exit(1)


def parse_lockfile(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            result[k.strip()] = v.strip()
    return result


HTTPX_CLOSURE = ("httpx", "httpcore", "h11", "anyio", "idna", "certifi", "sniffio", "typing-extensions", "socksio")


def ensure_httpx(cleanup_list: list) -> None:
    """Make `httpx` importable for the SelfHostedBackend proxy tests (patch 0003).

    CI runs this harness on the runner's bare python3, which has no httpx. Install the exact hash-pinned
    versions from docker/hermes/requirements-*.txt (no dependency resolution, hashes required) into a managed
    temp dir and put it on sys.path. A no-op when httpx is already importable.
    """
    try:
        import httpx  # noqa: F401

        return
    except ImportError:
        pass
    wanted: list[str] = []
    for req_file in sorted(HERMES_DOCKER_DIR.glob("requirements-*.txt")):
        block: list[str] = []
        keep = False
        for line in req_file.read_text(encoding="utf-8").splitlines():
            if line and not line[0].isspace() and not line.startswith(("#", "-")):
                if keep and block:
                    wanted.append("\n".join(block))
                block = [line]
                keep = line.split("==", 1)[0].strip().lower().replace("_", "-") in HTTPX_CLOSURE
            elif block and line.strip().startswith("--hash"):
                block.append(line)
        if keep and block:
            wanted.append("\n".join(block))
    names = {b.split("==", 1)[0].strip().lower().replace("_", "-") for b in wanted}
    missing = set(HTTPX_CLOSURE) - names
    assert not missing, f"pinned closure is missing {sorted(missing)}"
    target = tempfile.TemporaryDirectory(prefix="hermes-httpx-")
    cleanup_list.append(target.cleanup)
    req_path = Path(target.name) / "requirements.txt"
    req_path.write_text("\n".join(wanted) + "\n", encoding="utf-8")
    site = Path(target.name) / "site"
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "--no-deps", "--require-hashes", "--target", str(site), "-r", str(req_path)],
        check=True,
    )
    sys.path.insert(0, str(site))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_source_tarball(
    explicit_path: str | None,
    url: str,
    expected_sha: str,
    cleanup_list: list,
) -> tuple[Path, str]:
    """Resolve and sha256-verify the pinned upstream tarball.

    Precedence:
    1. Explicit --tarball CLI argument
    2. HERMES_UPSTREAM_TARBALL env var
    3. Common local cache paths (/tmp/hermes-src.tar.gz, etc.)
    4. Fresh download from the url recorded in source.lock into a managed temp dir.
    Fails closed on any sha256 mismatch or download failure.
    """
    if explicit_path:
        p = Path(explicit_path).resolve()
        if not p.is_file():
            raise FileNotFoundError(f"Explicit tarball not found: {explicit_path}")
        actual_sha = sha256_file(p)
        if actual_sha != expected_sha:
            raise ValueError(
                f"Explicit tarball sha256 mismatch: got {actual_sha}, expected {expected_sha}"
            )
        return p, "explicit-path"

    # Check env var and well-known local offline cache files
    env_tarball = os.environ.get("HERMES_UPSTREAM_TARBALL")
    candidates: list[tuple[Path, str]] = []
    if env_tarball:
        candidates.append((Path(env_tarball), "env-HERMES_UPSTREAM_TARBALL"))
    candidates.extend(
        [
            (Path("/tmp/hermes-src.tar.gz"), "local-cache-/tmp/hermes-src.tar.gz"),
            (Path("/tmp/hermes.tgz"), "local-cache-/tmp/hermes.tgz"),
        ]
    )

    for cand_path, label in candidates:
        if cand_path.is_file() and sha256_file(cand_path) == expected_sha:
            return cand_path, label

    # Fetch from locked URL into private temporary directory
    download_temp = tempfile.TemporaryDirectory(prefix="hermes-download-")
    cleanup_list.append(download_temp.cleanup)
    download_target = Path(download_temp.name) / "hermes-source.tar.gz"

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "paperclip-test-runner/1.0"},
    )
    h = hashlib.sha256()
    total_bytes = 0
    with urllib.request.urlopen(req, timeout=60) as resp, open(download_target, "wb") as out_f:
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            total_bytes += len(chunk)
            if total_bytes > 200 * 1024 * 1024:
                raise ValueError("Upstream source archive exceeded 200MB limit")
            h.update(chunk)
            out_f.write(chunk)

    downloaded_sha = h.hexdigest()
    if downloaded_sha != expected_sha:
        raise ValueError(
            f"Downloaded tarball sha256 mismatch: got {downloaded_sha}, expected {expected_sha} from {url}"
        )

    return download_target, "locked-url-fetch"


class TestMem0AutoSyncControl(unittest.TestCase):
    _cleanup_callbacks: list = []
    temp_dir: tempfile.TemporaryDirectory | None = None
    source_tree: Path | None = None
    mem0_mod: any = None

    @classmethod
    def setUpClass(cls):
        source_lock = parse_lockfile(SOURCE_LOCK_PATH)
        patches_lock = parse_lockfile(PATCHES_LOCK_PATH)

        # 1. Verify lock assertions
        upstream_name = source_lock.get("name", "hermes-agent")
        upstream_version = source_lock["version"]
        expected_src_sha = source_lock["sha256"]
        upstream_url = source_lock["url"]

        assert upstream_version == "0.21.3", f"Unexpected version: {upstream_version}"
        assert patches_lock["upstream_sha256"] == expected_src_sha
        assert patches_lock["patch_file"] == "patches/0001-require-command-scan.patch"
        assert patches_lock["postpatch_marker"] == "TECH-7355-MANDATORY-COMMAND-SCAN"
        assert patches_lock["extension_version"] == "0.21.3+tech7355.2"
        assert patches_lock["patch_file_2"] == "patches/0002-mem0-auto-sync.patch"
        assert patches_lock["postpatch_marker_2"] == "TECH-8191-MEM0-AUTO-SYNC"
        assert patches_lock["extension_version_2"] == "0.21.3+tech8191.1"
        assert patches_lock["patch_file_3"] == "patches/0003-mem0-self-hosted-proxy.patch"
        assert patches_lock["postpatch_marker_3"] == "TECH-8409-MEM0-PROXY"
        assert patches_lock["extension_version_3"] == "0.21.3+tech8409.1"

        patch1_path = HERMES_DOCKER_DIR / patches_lock["patch_file"]
        assert sha256_file(patch1_path) == patches_lock["patch_sha256"], "Patch 1 sha mismatch"

        patch2_path = HERMES_DOCKER_DIR / patches_lock["patch_file_2"]
        assert sha256_file(patch2_path) == patches_lock["patch_sha256_2"], "Patch 2 sha mismatch"

        # 2. Resolve verified tarball (fail-closed if mismatch)
        tarball_path, source_origin = resolve_source_tarball(
            CUSTOM_TARBALL_PATH,
            upstream_url,
            expected_src_sha,
            cls._cleanup_callbacks,
        )
        print(
            f"[mem0-auto-sync-test] Resolved {upstream_name} {upstream_version} "
            f"(sha256 {expected_src_sha}) via {source_origin} from {tarball_path}"
        )

        # 3. Extract into clean temp directory
        cls.temp_dir = tempfile.TemporaryDirectory(prefix="test-mem0-auto-sync-")
        cls._cleanup_callbacks.append(cls.temp_dir.cleanup)
        cls.source_tree = Path(cls.temp_dir.name) / "hermes-agent"
        cls.source_tree.mkdir(parents=True)

        subprocess.run(
            ["tar", "-xzf", str(tarball_path), "-C", str(cls.source_tree), "--strip-components=1"],
            check=True,
        )

        # 4. Apply Patch 1 (Tirith security)
        subprocess.run(
            ["git", "-C", str(cls.source_tree), "init", "-q"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(cls.source_tree), "apply", "--check", str(patch1_path)],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(cls.source_tree), "apply", str(patch1_path)],
            check=True,
        )
        tirith_py = cls.source_tree / "tools" / "tirith_security.py"
        assert patches_lock["postpatch_marker"] in tirith_py.read_text(encoding="utf-8")

        # 5. Apply Patch 2 (Mem0 auto-sync control)
        subprocess.run(
            ["git", "-C", str(cls.source_tree), "apply", "--check", str(patch2_path)],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(cls.source_tree), "apply", str(patch2_path)],
            check=True,
        )
        mem0_init_py = cls.source_tree / "plugins" / "memory" / "mem0" / "__init__.py"
        assert patches_lock["postpatch_marker_2"] in mem0_init_py.read_text(encoding="utf-8")

        # 6. Apply Patch 3 (opt-in MEM0_PROXY for the self-hosted backend)
        patch3_path = HERMES_DOCKER_DIR / patches_lock["patch_file_3"]
        assert sha256_file(patch3_path) == patches_lock["patch_sha256_3"], "Patch 3 sha mismatch"
        subprocess.run(
            ["git", "-C", str(cls.source_tree), "apply", "--check", str(patch3_path)],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(cls.source_tree), "apply", str(patch3_path)],
            check=True,
        )
        backend_py = cls.source_tree / "plugins" / "memory" / "mem0" / "_backend.py"
        assert patches_lock["postpatch_marker_3"] in backend_py.read_text(encoding="utf-8")

        # 7. Import patched mem0 module
        ensure_httpx(cls._cleanup_callbacks)
        sys.path.insert(0, str(cls.source_tree))
        import plugins.memory.mem0 as mem0_mod
        import plugins.memory.mem0._backend as backend_mod

        cls.mem0_mod = mem0_mod
        cls.backend_mod = backend_mod

    @classmethod
    def tearDownClass(cls):
        if cls.source_tree and str(cls.source_tree) in sys.path:
            sys.path.remove(str(cls.source_tree))
        for cb in reversed(cls._cleanup_callbacks):
            try:
                cb()
            except Exception:
                pass

    def test_marker_present_and_exact(self):
        self.assertEqual(
            self.mem0_mod.MEM0_AUTO_SYNC_PATCH_MARKER,
            "TECH-8191-MEM0-AUTO-SYNC",
        )

    def test_coerce_bool_idiom(self):
        fn = self.mem0_mod._coerce_bool
        # Booleans and numbers
        self.assertIs(fn(True), True)
        self.assertIs(fn(False), False)
        self.assertIs(fn(1), True)
        self.assertIs(fn(0), False)

        # Truthy words
        for word in ("true", "True", "TRUE", "yes", "YES", "1", "on", "ON"):
            self.assertIs(fn(word), True)

        # Falsy words
        for word in ("false", "False", "FALSE", "no", "NO", "0", "off", "OFF"):
            self.assertIs(fn(word), False)

        # Defaults on unknown or None
        self.assertIs(fn(None, True), True)
        self.assertIs(fn(None, False), False)
        self.assertIs(fn("unknown", True), True)
        self.assertIs(fn("unknown", False), False)
        self.assertIs(fn([], True), True)

    def test_config_schema_contains_auto_sync(self):
        provider = self.mem0_mod.Mem0MemoryProvider()
        schema = provider.get_config_schema()
        auto_sync_entry = next((e for e in schema if e.get("key") == "auto_sync"), None)
        self.assertIsNotNone(auto_sync_entry)
        self.assertEqual(auto_sync_entry["default"], "true")
        self.assertEqual(auto_sync_entry["choices"], ["true", "false"])

    def test_provider_double_default_missing_auto_sync_syncs_turns(self):
        """When auto_sync is omitted in mem0.json, default behavior must preserve legacy turn sync."""
        mock_backend = MagicMock()
        mock_backend.add.return_value = {"results": []}

        provider = self.mem0_mod.Mem0MemoryProvider()
        provider._create_backend = lambda: mock_backend

        # Initialize with config lacking auto_sync
        config = {
            "mode": "oss",
            "user_id": "agent-worker-1",
            "agent_id": "agent-worker-1",
            "oss": {"vector_store": {"provider": "pgvector"}},
        }
        with unittest.mock.patch.object(self.mem0_mod, "_load_config", return_value=config):
            provider.initialize(session_id="session-1")

        self.assertIs(provider._auto_sync, True)
        self.assertIs(provider._backend, mock_backend)

        # sync_turn should invoke backend.add via thread
        provider.sync_turn("User states task progress", "Acknowledged progress")
        if provider._sync_thread and provider._sync_thread.is_alive():
            provider._sync_thread.join(timeout=2.0)

        self.assertEqual(mock_backend.add.call_count, 1)
        args, kwargs = mock_backend.add.call_args
        messages = args[0]
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]["role"], "user")
        self.assertEqual(messages[0]["content"], "User states task progress")
        self.assertEqual(messages[1]["role"], "assistant")
        self.assertEqual(messages[1]["content"], "Acknowledged progress")
        self.assertTrue(kwargs.get("infer"))

    def test_provider_double_auto_sync_false_yields_zero_sync_turn_writes_and_retains_tools(self):
        """When auto_sync is False, sync_turn must store nothing, while add/search/update/delete/prefetch remain available."""
        mock_backend = MagicMock()
        mock_backend.add.return_value = {"results": [], "event_id": "ev-101"}
        mock_backend.search.return_value = [
            {"id": "mem-1", "memory": "Fact A: prefers dark mode", "score": 0.95}
        ]
        mock_backend.update.return_value = {"message": "Memory updated successfully"}
        mock_backend.delete.return_value = {"message": "Memory deleted successfully"}

        provider = self.mem0_mod.Mem0MemoryProvider()
        provider._create_backend = lambda: mock_backend

        config = {
            "mode": "oss",
            "user_id": "agent-worker-2",
            "agent_id": "agent-worker-2",
            "auto_sync": False,
            "oss": {"vector_store": {"provider": "pgvector"}},
        }
        with unittest.mock.patch.object(self.mem0_mod, "_load_config", return_value=config):
            provider.initialize(session_id="session-2")

        self.assertIs(provider._auto_sync, False)
        self.assertIs(provider._backend, mock_backend)

        # 1. sync_turn: must NOT call backend.add (ZERO automatic writes)
        provider.sync_turn("Run wake payload status update", "Worker finished turn")
        if provider._sync_thread and provider._sync_thread.is_alive():
            provider._sync_thread.join(timeout=2.0)

        self.assertEqual(
            mock_backend.add.call_count,
            0,
            "sync_turn must NOT write when auto_sync is false",
        )
        self.assertIsNone(
            provider._sync_thread,
            "No sync thread should even be spawned when auto_sync is false",
        )

        # 2. Explicit tool add (mem0_add via handle_tool_call): persists memory
        add_res_raw = provider.handle_tool_call(
            "mem0_add", {"content": "Important durable preference"}
        )
        add_res = json.loads(add_res_raw)
        self.assertEqual(add_res.get("result"), "Fact stored.")
        self.assertEqual(mock_backend.add.call_count, 1)
        add_args, add_kwargs = mock_backend.add.call_args
        self.assertEqual(
            add_args[0], [{"role": "user", "content": "Important durable preference"}]
        )
        self.assertFalse(add_kwargs["infer"])
        self.assertEqual(add_kwargs["user_id"], "agent-worker-2")

        # 3. Explicit tool search (mem0_search via handle_tool_call): finds memory
        search_res_raw = provider.handle_tool_call(
            "mem0_search", {"query": "durable preference"}
        )
        search_res = json.loads(search_res_raw)
        self.assertEqual(search_res["count"], 1)
        self.assertEqual(search_res["results"][0]["id"], "mem-1")
        self.assertEqual(search_res["results"][0]["memory"], "Fact A: prefers dark mode")
        self.assertEqual(mock_backend.search.call_count, 1)

        # 4. Explicit tool update (mem0_update via handle_tool_call): modifies memory
        update_res_raw = provider.handle_tool_call(
            "mem0_update", {"memory_id": "mem-1", "text": "Updated preference text"}
        )
        update_res = json.loads(update_res_raw)
        self.assertEqual(update_res["message"], "Memory updated successfully")
        mock_backend.update.assert_called_once_with("mem-1", "Updated preference text")

        # 5. Explicit tool delete (mem0_delete via handle_tool_call): removes memory
        delete_res_raw = provider.handle_tool_call(
            "mem0_delete", {"memory_id": "mem-1"}
        )
        delete_res = json.loads(delete_res_raw)
        self.assertEqual(delete_res["message"], "Memory deleted successfully")
        mock_backend.delete.assert_called_once_with("mem-1")

        # 6. Prefetch: reads context synchronously before first turn LLM call
        prefetch_out = provider.prefetch("prefers dark mode")
        self.assertIn("## Mem0 Memory", prefetch_out)
        self.assertIn("Fact A: prefers dark mode", prefetch_out)
        self.assertGreaterEqual(mock_backend.search.call_count, 2)

    def test_provider_double_auto_sync_true_syncs_turns(self):
        """When auto_sync is explicitly True, sync_turn behaves normally."""
        mock_backend = MagicMock()
        mock_backend.add.return_value = {"results": []}

        provider = self.mem0_mod.Mem0MemoryProvider()
        provider._create_backend = lambda: mock_backend

        config = {
            "mode": "oss",
            "user_id": "agent-worker-3",
            "agent_id": "agent-worker-3",
            "auto_sync": True,
            "oss": {"vector_store": {"provider": "pgvector"}},
        }
        with unittest.mock.patch.object(self.mem0_mod, "_load_config", return_value=config):
            provider.initialize(session_id="session-3")

        self.assertIs(provider._auto_sync, True)
        provider.sync_turn("User query", "Assistant response")
        if provider._sync_thread and provider._sync_thread.is_alive():
            provider._sync_thread.join(timeout=2.0)

        self.assertEqual(mock_backend.add.call_count, 1)

    # --- Patch 0003: opt-in MEM0_PROXY for SelfHostedBackend (mem0 traffic only) ---

    def _pool_class(self, backend) -> str:
        return type(backend._client._transport._pool).__name__

    def _make_backend(self, env: dict, **kwargs):
        scrubbed = {"MEM0_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"}
        base = {k: v for k, v in os.environ.items() if k.upper() not in scrubbed}
        with unittest.mock.patch.dict(os.environ, {**base, **env}, clear=True):
            return self.backend_mod.SelfHostedBackend("k", "https://mem.example.ts.net", **kwargs)

    def test_proxy_marker_present(self):
        self.assertEqual(self.backend_mod.MEM0_PROXY_PATCH_MARKER, "TECH-8409-MEM0-PROXY")

    def test_no_proxy_by_default(self):
        self.assertEqual(self._pool_class(self._make_backend({})), "ConnectionPool")

    def test_empty_mem0_proxy_is_ignored(self):
        self.assertEqual(self._pool_class(self._make_backend({"MEM0_PROXY": ""})), "ConnectionPool")

    def test_mem0_proxy_routes_through_proxy(self):
        backend = self._make_backend({"MEM0_PROXY": "http://127.0.0.1:1055"})
        pool = backend._client._transport._pool
        self.assertEqual(type(pool).__name__, "HTTPProxy")
        self.assertEqual(pool._proxy_url.host, b"127.0.0.1")
        self.assertEqual(pool._proxy_url.port, 1055)

    def test_generic_proxy_env_is_not_adopted(self):
        # The explicit transport disables generic proxy env; only MEM0_PROXY opts in.
        backend = self._make_backend(
            {
                "HTTPS_PROXY": "http://127.0.0.1:9",
                "https_proxy": "http://127.0.0.1:9",
                "ALL_PROXY": "http://127.0.0.1:9",
                "all_proxy": "http://127.0.0.1:9",
            }
        )
        self.assertEqual(self._pool_class(backend), "ConnectionPool")

    def test_injected_transport_still_wins(self):
        import httpx

        sentinel = httpx.MockTransport(lambda r: httpx.Response(200, json={}))
        backend = self._make_backend({"MEM0_PROXY": "http://127.0.0.1:1055"}, transport=sentinel)
        self.assertIs(backend._client._transport, sentinel)


if __name__ == "__main__":
    unittest.main(verbosity=2)
