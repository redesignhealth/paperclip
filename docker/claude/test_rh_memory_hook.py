"""Tests for docker/claude/rh-memory-hook (TECH-8410).

Run: python3 -m unittest discover -s docker/claude -p 'test_*.py'
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_PATH = Path(__file__).with_name("rh-memory-hook")
_loader = importlib.machinery.SourceFileLoader("rh_memory_hook", str(_PATH))
_spec = importlib.util.spec_from_loader("rh_memory_hook", _loader)
assert _spec is not None
hook = importlib.util.module_from_spec(_spec)
_loader.exec_module(hook)

ENV = {"RH_MEMORY_TOKEN": "tok", "RH_MEMORY_URL": "https://mem.example.com/"}


def _transcript(entries: list[dict]) -> str:
    handle = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    with handle:
        for entry in entries:
            handle.write(json.dumps(entry) + "\n")
    return handle.name


class RecallTest(unittest.TestCase):
    def test_noop_without_token(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(hook, "_post") as post:
            self.assertIsNone(hook.recall({"prompt": "what did we decide?"}))
        post.assert_not_called()

    def test_requires_https_url(self) -> None:
        env = {"RH_MEMORY_TOKEN": "tok", "RH_MEMORY_URL": "http://mem.example"}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(hook, "_post") as post:
            self.assertIsNone(hook.recall({"prompt": "what did we decide?"}))
        post.assert_not_called()

    def test_returns_additional_context(self) -> None:
        results = {"results": [{"memory": "Dan prefers  short\nanswers", "score": 0.9}, {"memory": ""}]}
        with mock.patch.dict(os.environ, {**ENV, "RH_MEMORY_PROXY": "http://127.0.0.1:1055"}, clear=True), \
                mock.patch.object(hook, "_post", return_value=results) as post:
            out = json.loads(hook.recall({"prompt": "  how should I answer?  "}) or "{}")
        url, path, token, proxy, body, _timeout = post.call_args.args
        self.assertEqual((url, path, token, proxy), ("https://mem.example.com", "/search", "tok", "http://127.0.0.1:1055"))
        self.assertEqual(body, {"query": "how should I answer?", "top_k": 5})
        spec = out["hookSpecificOutput"]
        self.assertEqual(spec["hookEventName"], "UserPromptSubmit")
        self.assertIn("- Dan prefers short answers", spec["additionalContext"])

    def test_no_output_when_nothing_found(self) -> None:
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook, "_post", return_value={"results": []}):
            self.assertIsNone(hook.recall({"prompt": "anything new?"}))

    def test_trivial_prompt_skipped(self) -> None:
        with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(hook, "_post") as post:
            self.assertIsNone(hook.recall({"prompt": "ok"}))
        post.assert_not_called()

    def test_main_fails_open(self) -> None:
        stdin = io.StringIO(json.dumps({"prompt": "what did we decide?"}))
        stdout = io.StringIO()
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook, "_post", side_effect=OSError("unreachable")), \
                mock.patch("sys.stdin", stdin), mock.patch("sys.stdout", stdout):
            self.assertEqual(hook.main(["rh-memory-hook", "recall"]), 0)
        self.assertEqual(stdout.getvalue(), "")


class LastExchangeTest(unittest.TestCase):
    def test_picks_last_prompt_and_following_text(self) -> None:
        path = _transcript([
            {"message": {"role": "user", "content": "old question"}},
            {"message": {"role": "assistant", "content": [{"type": "text", "text": "old answer"}]}},
            {"isMeta": True, "message": {"role": "user", "content": "<system note>"}},
            {"message": {"role": "user", "content": "Use Postgres for the cache"}},
            {"message": {"role": "assistant", "content": [
                {"type": "text", "text": "Switching to Postgres."},
                {"type": "tool_use", "name": "Edit", "input": {}},
            ]}},
            {"message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}},
            {"message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}]}},
            "not a dict",
        ])
        self.assertEqual(hook.last_exchange(path), [
            {"role": "user", "content": "Use Postgres for the cache"},
            {"role": "assistant", "content": "Switching to Postgres.\nDone."},
        ])

    def test_empty_without_assistant_reply(self) -> None:
        path = _transcript([{"message": {"role": "user", "content": "hello there"}}])
        self.assertEqual(hook.last_exchange(path), [])


class CaptureTest(unittest.TestCase):
    def test_noop_without_token(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(hook.os, "fork") as fork:
            hook.capture({"transcript_path": "/nonexistent"})
        fork.assert_not_called()

    def test_parent_returns_after_fork(self) -> None:
        path = _transcript([
            {"message": {"role": "user", "content": "remember the deploy window is Tuesday"}},
            {"message": {"role": "assistant", "content": "Noted."}},
        ])
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook.os, "fork", return_value=1234), \
                mock.patch.object(hook, "_post") as post:
            hook.capture({"transcript_path": path})
        post.assert_not_called()  # the request runs only in the detached child

    def test_child_posts_exchange(self) -> None:
        path = _transcript([
            {"message": {"role": "user", "content": "remember the deploy window is Tuesday"}},
            {"message": {"role": "assistant", "content": "Noted."}},
        ])
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook.os, "fork", return_value=0), \
                mock.patch.object(hook.os, "setsid"), \
                mock.patch.object(hook.os, "_exit", side_effect=SystemExit) as exit_, \
                mock.patch.object(hook, "_post") as post:
            with self.assertRaises(SystemExit):
                hook.capture({"transcript_path": path})
        exit_.assert_called_once_with(0)
        _url, path_arg, _token, _proxy, body, _timeout = post.call_args.args
        self.assertEqual(path_arg, "/memories")
        self.assertEqual([m["role"] for m in body["messages"]], ["user", "assistant"])


class ManagedSettingsTest(unittest.TestCase):
    def test_registers_both_hooks(self) -> None:
        settings = json.loads(_PATH.with_name("managed-settings.json").read_text())
        commands = {
            event: [h["command"] for group in groups for h in group["hooks"]]
            for event, groups in settings["hooks"].items()
        }
        self.assertEqual(commands, {
            "UserPromptSubmit": ["/usr/local/bin/rh-memory-hook recall"],
            "Stop": ["/usr/local/bin/rh-memory-hook capture"],
        })


if __name__ == "__main__":
    unittest.main()
