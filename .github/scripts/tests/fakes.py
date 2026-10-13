"""In-memory fakes: no network, no secrets."""
from __future__ import annotations

import base64
from typing import Any

import _path  # noqa: F401
import gate_lib
from gate_lib import GateError

SHA = "a" * 40
SHA2 = "b" * 40

TRUSTED_PR_YML = (
    "name: PR\n"
    "on:\n"
    "  pull_request:\n"
    "jobs:\n"
    "  ci:\n"
    "    uses: paperclipai/paperclip/.github/workflows/pr-trusted.yml@master\n"
)

CANONICAL_STORYBOOK_YML = (
    "name: Storybook Visual\n"
    "on:\n"
    "  workflow_dispatch:\n"
    "    inputs: {}\n"
    "  pull_request:\n"
    "    branches: [master]\n"
    "    types: [opened, reopened, synchronize, labeled]\n"
    "jobs:\n"
    "  visual:\n"
    "    name: Storybook visual regression\n"
    "    if: >-\n"
    "      (github.event_name == 'workflow_dispatch' && !inputs.deploy_preview) ||\n"
    "      (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'storybook-visual'))\n"
    "    runs-on: ubuntu-latest\n"
    "    steps: []\n"
    "  preview:\n"
    "    name: Deploy selected branch Storybook\n"
    "    if: github.event_name == 'workflow_dispatch' && inputs.deploy_preview\n"
    "    runs-on: ubuntu-latest\n"
    "    steps: []\n"
)


def pr(
    number: int = 7,
    sha: str = SHA,
    *,
    state="open",
    base="master",
    base_repo=gate_lib.REPO_ID,
    head_repo=gate_lib.REPO_ID,
    author="dev",
    changed=1,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    doc = {
        "number": number,
        "state": state,
        "user": {"login": author},
        "changed_files": changed,
        "base": {"ref": base, "repo": {"id": base_repo}},
        "head": {"sha": sha, "repo": None if head_repo is None else {"id": head_repo}},
    }
    if extra:
        doc.update(extra)  # hostile PR-controlled metadata (title/body/labels) the gate must ignore
    return doc


class FakeGitHub:
    """Routes GET by path prefix; records every write. `responses` maps a path prefix to a value or callable."""

    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        self.responses = responses or {}
        self.gets: list[str] = []
        self.writes: list[tuple[str, str, Any]] = []
        self.checks: dict[int, dict[str, Any]] = {}
        self._next = 100

    def _lookup(self, path: str) -> Any:
        for prefix in sorted(self.responses, key=len, reverse=True):
            if path.startswith(prefix):
                v = self.responses[prefix]
                return v() if callable(v) else v
        if "contents/.github/workflows/pr.yml" in path:
            return {"content": base64.b64encode(TRUSTED_PR_YML.encode("utf-8")).decode("ascii")}
        if "contents/.github/workflows/storybook-visual.yml" in path:
            return {"content": base64.b64encode(CANONICAL_STORYBOOK_YML.encode("utf-8")).decode("ascii")}
        raise GateError("HTTP_404")

    def get(self, path: str) -> Any:
        self.gets.append(path)
        if "/check-runs?" in path and "check_name=" in path:
            name = path.split("check_name=")[1].split("&")[0]
            return {"check_runs": [c for c in self.checks.values() if c["name"] == name]}
        return self._lookup(path)

    def paginate(self, path: str, key: str | None = None, **_: Any) -> list[Any]:
        self.gets.append(path)
        data = self._lookup(path)
        if key and isinstance(data, dict):
            data = data[key]
        return list(data)

    def post(self, path: str, body: Any) -> Any:
        self.writes.append(("POST", path, body))
        if path.endswith("/check-runs"):
            self._next += 1
            rec = {
                "id": self._next,
                "name": body["name"],
                "head_sha": body["head_sha"],
                "status": body["status"],
                "app": {"id": gate_lib.APP_ID},
            }
            self.checks[self._next] = rec
            return dict(rec)
        return {}

    def patch(self, path: str, body: Any) -> Any:
        self.writes.append(("PATCH", path, body))
        cid = int(path.rsplit("/", 1)[1])
        self.checks[cid].update(status=body.get("status", self.checks[cid]["status"]), conclusion=body.get("conclusion"))
        return {}

    def conclusions(self) -> dict[str, tuple[str, str | None]]:
        return {c["name"]: (c["status"], c.get("conclusion")) for c in self.checks.values()}
