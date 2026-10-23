"""Argus verdict evaluation for the auto-approval gate (TECH-7014).

Contract (api-main `GET /api/v1/code-review/storage/reviews/{owner}/{repo}/{pr}`): a JSON object
`{"rounds": [...]}` of PUBLISHED rounds only (rows with a non-null verdict), newest first, capped
at 200. Each round has `repo`, `pr_number`, `sha`, `current_stage`, `created_at`, `verdict`.

Rule: take the rounds recorded for exactly the PR head H; the newest by server `created_at` (every
round tied at that instant) must be `current_stage == "completed"` with verdict `APPROVE`. There is
no fallback to an older approval, to another SHA, or to "any approval".

Trust boundary, stated plainly: the API authenticates the writer with a shared key, so any holder of
that key (trusted RH submitters, privileged main credentials) can write a verdict. This check proves
"the Argus store holds a terminal APPROVE for H", not cryptographic proof that Argus ran.

States: `approve` (pass), `blocking` (definitive failure), `pending` (no usable published review for
H yet), `error` (malformed or unrecognised data; fail closed).
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import gate_lib
from gate_lib import GateError

TERMINAL_STAGE = "completed"
_API_KEY_RE = re.compile(r"[\x21-\x7e]{8,512}")

# Fixed SSM name and region: never taken from PR input.
SSM_API_KEY_NAME = "/general/prod/api-secret-key"
SSM_REGION = "us-east-1"


@dataclass(frozen=True)
class ArgusResult:
    state: str  # approve | blocking | pending | error
    code: str
    summary: str

    @property
    def passed(self) -> bool:
        return self.state == "approve"


def _parse_aware(value: Any) -> float | None:
    """Parse an ISO-8601 timestamp; a missing UTC offset is invalid (fail closed)."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        dt = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if dt.tzinfo is None or dt.utcoffset() is None:
        return None
    return dt.timestamp()


def evaluate(raw: Any, head_sha: str, pr_number: int) -> ArgusResult:
    short = head_sha[:7]
    if not gate_lib.is_full_sha(head_sha):
        return ArgusResult("error", "INVALID_SHA", "The PR head SHA is not a full commit SHA.")
    if not isinstance(raw, dict) or not isinstance(raw.get("rounds"), list):
        return ArgusResult("error", "MALFORMED_RESPONSE", "The Argus review response has an unexpected shape.")

    matching: list[dict[str, Any]] = []
    for rnd in raw["rounds"]:
        if not isinstance(rnd, dict):
            return ArgusResult("error", "MALFORMED_ROUND", "An Argus round is not an object.")
        pr = rnd.get("pr_number")
        if rnd.get("repo") != gate_lib.REPO or isinstance(pr, bool) or pr != pr_number:
            return ArgusResult("error", "ROUND_IDENTITY_MISMATCH", "An Argus round does not belong to this repository and PR.")
        if rnd.get("sha") == head_sha:
            matching.append(rnd)

    if not matching:
        code = "STALE_REVIEW" if raw["rounds"] else "MISSING_REVIEW"
        return ArgusResult(
            "pending",
            code,
            f"No published Argus review exists for the current head {short}. Run /argus-review-loop on this head.",
        )

    stamped: list[tuple[float, dict[str, Any]]] = []
    for rnd in matching:
        epoch = _parse_aware(rnd.get("created_at"))
        if epoch is None:
            return ArgusResult("error", "MALFORMED_TIMESTAMP", f"An Argus round for {short} has no valid timezone-aware timestamp.")
        stamped.append((epoch, rnd))
    newest = max(epoch for epoch, _ in stamped)
    tied = [rnd for epoch, rnd in stamped if epoch == newest]

    if any(rnd.get("verdict") == "BLOCKING" for rnd in tied):
        return ArgusResult("blocking", "VERDICT_BLOCKING", f"The newest Argus review of {short} is BLOCKING.")
    if any(rnd.get("current_stage") != TERMINAL_STAGE for rnd in tied):
        return ArgusResult("pending", "NON_TERMINAL_ROUND", f"The newest Argus review of {short} is not completed yet.")
    if any(rnd.get("verdict") != "APPROVE" for rnd in tied):
        return ArgusResult("error", "INVALID_VERDICT", f"The newest Argus review of {short} has an unrecognised verdict.")
    return ArgusResult("approve", "EXACT_HEAD_APPROVE", f"Argus approved exactly the current head {short}.")


def fetch_api_key() -> str:
    """Read the Argus storage key from SSM with the assumed CI role; mask it before use.

    The key stays in this process: it is never written to GITHUB_OUTPUT, argv of another tool, an
    artifact or a log.
    """
    try:
        proc = subprocess.run(
            [
                "aws", "ssm", "get-parameter",
                "--name", SSM_API_KEY_NAME,
                "--region", SSM_REGION,
                "--with-decryption",
                "--query", "Parameter.Value",
                "--output", "text",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (subprocess.SubprocessError, OSError):
        raise GateError("ARGUS_KEY_UNAVAILABLE") from None
    key = proc.stdout.strip()
    if not _API_KEY_RE.fullmatch(key) or key == "None":
        raise GateError("ARGUS_KEY_INVALID")
    print(f"::add-mask::{key}")
    return key


def fetch_reviews(pr_number: int, api_key: str) -> Any:
    return gate_lib.request_json(
        gate_lib.ARGUS_API,
        f"/api/v1/code-review/storage/reviews/{gate_lib.OWNER}/{gate_lib.REPO_NAME}/{pr_number}",
        headers={"X-API-Key": api_key, "Accept": "application/json", "User-Agent": "paperclip-auto-approve"},
    )


def check(pr_number: int, head_sha: str, api_key: str) -> ArgusResult:
    """Fetch and evaluate; API errors (401/403/5xx/network/malformed) are `error`, never approve."""
    try:
        raw = fetch_reviews(pr_number, api_key)
    except GateError as exc:
        return ArgusResult("error", f"ARGUS_API_{exc.code}", "The Argus review API could not be read; failing closed.")
    return evaluate(raw, head_sha, pr_number)
