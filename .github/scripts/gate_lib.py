"""Shared stdlib-only helpers for the paperclip Argus auto-approval gate (TECH-7014).

Everything here runs from trusted default-branch code. Rules enforced here for every caller:

- Only two fixed base URLs are ever contacted (GitHub API, Argus storage API). Redirects are
  refused, so a credential header is never replayed to another host.
- Requests have a bounded timeout; only GETs are retried (a POST that creates a check or a
  review is never replayed).
- Errors carry a fixed code only. Response bodies, review prose, headers and secrets are never
  put in an exception, a log line, or a check-run summary.
- PR numbers and SHAs are validated before they reach a URL or a check-run.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Any

OWNER = "redesignhealth"
REPO_NAME = "paperclip"
REPO = f"{OWNER}/{REPO_NAME}"
REPO_ID = 1326789272
DEFAULT_BRANCH = "master"
ORG_ID = 216950685

# The RH PR Approval Gate GitHub App (NOT the generic GitHub Actions app 15368, whose check
# context any branch workflow can forge).
APP_ID = 5166579
APP_BOT_LOGIN = "rh-pr-approval-gate[bot]"
REVIEW_MARKER = "<!-- rh-pr-approval-gate:argus-ci-approved -->"

# Legacy contract names kept for the ruleset's required checks.
CHECK_ARGUS = "argus-gate"
CHECK_CI = "ci-aggregate"

GITHUB_API = "https://api.github.com"
ARGUS_API = "https://api.core.redesignhealth.com"
_ALLOWED_BASES = frozenset({GITHUB_API, ARGUS_API})

WORKFLOW_PATH_RE = re.compile(r"\.github/workflows/[A-Za-z0-9._-]+\.ya?ml")
_PR_RE = re.compile(r"[1-9][0-9]{0,8}")
_SHA_RE = re.compile(r"[0-9a-f]{40}")
_SAFE_TOKEN_RE = re.compile(r"[A-Za-z0-9_.-]{1,64}")


class GateError(Exception):
    """A failure that carries a fixed, non-sensitive code only."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def parse_pr_number(value: Any) -> int:
    """Positive decimal integer only: no booleans, signs, whitespace, floats or zero."""
    if isinstance(value, bool):
        raise GateError("INVALID_PR_NUMBER")
    if isinstance(value, int):
        value = str(value)
    if not isinstance(value, str) or not _PR_RE.fullmatch(value):
        raise GateError("INVALID_PR_NUMBER")
    return int(value)


def is_full_sha(value: Any) -> bool:
    return isinstance(value, str) and _SHA_RE.fullmatch(value) is not None


def require_full_sha(value: Any) -> str:
    if not is_full_sha(value):
        raise GateError("INVALID_SHA")
    return value


def safe_token(value: Any, fallback: str = "(unrecognized)") -> str:
    """Emit a possibly PR-controlled name only if it is a short plain identifier."""
    if isinstance(value, str) and _SAFE_TOKEN_RE.fullmatch(value):
        return value
    return fallback


def workflow_path(run: dict[str, Any]) -> str | None:
    """Canonical workflow file path of a run (strips any `@ref` suffix); None if not a file path."""
    raw = run.get("path")
    if not isinstance(raw, str):
        return None
    path = raw.split("@", 1)[0]
    return path if WORKFLOW_PATH_RE.fullmatch(path) else None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _urlopen(req: urllib.request.Request, timeout: float) -> Any:
    return _OPENER.open(req, timeout=timeout)


def request_json(
    base: str,
    path: str,
    *,
    headers: dict[str, str],
    method: str = "GET",
    body: Any = None,
    timeout: float = 20,
    retries: int = 2,
) -> Any:
    if base not in _ALLOWED_BASES:
        raise GateError("BASE_URL_NOT_ALLOWED")
    if not path.startswith("/") or path.startswith("//") or "\\" in path or "\r" in path or "\n" in path:
        raise GateError("INVALID_PATH")
    data = None
    hdrs = dict(headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    attempts = (retries + 1) if method == "GET" else 1
    last = "NETWORK_ERROR"
    for attempt in range(attempts):
        req = urllib.request.Request(base + path, data=data, headers=hdrs, method=method)
        try:
            with _urlopen(req, timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            last = f"HTTP_{exc.code}"
            if exc.code < 500 and exc.code != 429:
                raise GateError(last) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            last = "NETWORK_ERROR"
        else:
            if not raw:
                return None
            try:
                return json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise GateError("MALFORMED_RESPONSE") from None
        if attempt + 1 < attempts:
            time.sleep(2**attempt)
    raise GateError(last)


class GitHub:
    """Minimal GitHub REST client bound to one token (read-only or App token)."""

    def __init__(self, token: str) -> None:
        if not token:
            raise GateError("MISSING_TOKEN")
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "paperclip-auto-approve",
        }

    def get(self, path: str) -> Any:
        return request_json(GITHUB_API, path, headers=self._headers)

    def post(self, path: str, body: Any) -> Any:
        return request_json(GITHUB_API, path, headers=self._headers, method="POST", body=body)

    def patch(self, path: str, body: Any) -> Any:
        return request_json(GITHUB_API, path, headers=self._headers, method="PATCH", body=body)

    def paginate(self, path: str, key: str | None = None, *, per_page: int = 100, max_pages: int = 10) -> list[Any]:
        """Collect every item of a list endpoint. Fails closed instead of silently truncating."""
        sep = "&" if "?" in path else "?"
        items: list[Any] = []
        for page in range(1, max_pages + 1):
            data = self.get(f"{path}{sep}per_page={per_page}&page={page}")
            chunk = data.get(key) if key and isinstance(data, dict) else data
            if not isinstance(chunk, list):
                raise GateError("MALFORMED_RESPONSE")
            items.extend(chunk)
            if len(chunk) < per_page:
                return items
        raise GateError("PAGINATION_LIMIT")


def pr_ineligibility(pr: Any, expected_head: str | None = None) -> str | None:
    """Return a fixed reason code if this PR must not be gated/approved, else None.

    Rejects: not open, wrong base branch/repo, missing or deleted head repo, malformed head SHA,
    a PR authored by the gate App itself (no self-approval), and a head that moved.
    Fork PRs are eligible provided base is master of repo 1326789272 and head repo exists with an integer ID.
    """
    if not isinstance(pr, dict):
        return "MALFORMED_PR"
    base = pr.get("base") or {}
    head = pr.get("head") or {}
    if pr.get("state") != "open":
        return "NOT_OPEN"
    base_repo = base.get("repo") or {}
    if base.get("ref") != DEFAULT_BRANCH or base_repo.get("id") != REPO_ID:
        return "WRONG_BASE"
    head_repo = head.get("repo")
    if not isinstance(head_repo, dict) or not isinstance(head_repo.get("id"), int) or head_repo.get("id") <= 0:
        return "FORK_OR_MISSING_HEAD_REPO"
    if not is_full_sha(head.get("sha")):
        return "INVALID_HEAD_SHA"
    author = (pr.get("user") or {}).get("login")
    if not isinstance(author, str) or not author:
        return "MALFORMED_PR"
    if author.lower() == APP_BOT_LOGIN:
        return "AUTHOR_IS_GATE_APP"
    if expected_head is not None and head.get("sha") != expected_head:
        return "HEAD_MOVED"
    return None


def write_output(name: str, value: str, path: str | None) -> None:
    """Append a single-line output to $GITHUB_OUTPUT (values here are validated, never PR text)."""
    if "\n" in value or "\r" in value:
        raise GateError("INVALID_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{name}={value}\n")
