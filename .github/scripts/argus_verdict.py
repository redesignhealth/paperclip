#!/usr/bin/env python3
"""Argus review verdict evaluator for merge gates (TECH-7014).

Verifies that Argus review storage contains an exact-head APPROVE verdict
for the current PR head SHA. Evaluates newest review(s), handling timestamp
sorting, tied newest reviews, and fallback server ordering.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass
class ArgusVerdictResult:
    passed: bool
    reason_code: str
    summary: str
    details: dict[str, Any] | None = None


def parse_iso_timestamp(ts: Any) -> float | None:
    """Parse ISO-8601 timestamp string into epoch seconds."""
    if not isinstance(ts, str) or not ts.strip():
        return None
    s = ts.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


def evaluate_argus_data(raw_data: Any, expected_sha: str) -> ArgusVerdictResult:
    """Evaluate Argus review payload against expected commit SHA."""
    # 1. Validate expected_sha
    if not expected_sha or not isinstance(expected_sha, str) or not expected_sha.strip():
        return ArgusVerdictResult(
            passed=False,
            reason_code="EMPTY_SHA",
            summary="PR head SHA is empty or invalid.",
        )
    expected_sha = expected_sha.strip()
    short_sha = expected_sha[:7]

    # 2. Validate raw_data
    if raw_data is None:
        return ArgusVerdictResult(
            passed=False,
            reason_code="MALFORMED_DATA",
            summary="Argus review data is null or empty.",
        )

    if isinstance(raw_data, str):
        try:
            raw_data = json.loads(raw_data)
        except Exception:
            return ArgusVerdictResult(
                passed=False,
                reason_code="MALFORMED_DATA",
                summary="Argus review response is not valid JSON.",
            )

    if not isinstance(raw_data, (dict, list)):
        return ArgusVerdictResult(
            passed=False,
            reason_code="MALFORMED_DATA",
            summary="Argus review data has unexpected top-level structure.",
        )

    # 3. Extract reviews list
    reviews: list[dict[str, Any]] = []
    if isinstance(raw_data, dict):
        if "rounds" in raw_data and isinstance(raw_data["rounds"], list):
            reviews = raw_data["rounds"]
        elif "reviews" in raw_data and isinstance(raw_data["reviews"], list):
            reviews = raw_data["reviews"]
        elif "data" in raw_data and isinstance(raw_data["data"], list):
            reviews = raw_data["data"]
        elif "sha" in raw_data and "verdict" in raw_data:
            reviews = [raw_data]
    elif isinstance(raw_data, list):
        reviews = raw_data

    if not reviews:
        return ArgusVerdictResult(
            passed=False,
            reason_code="MISSING_REVIEW",
            summary=f"No Argus reviews found for this PR. Run /argus-review-loop to generate a review.",
        )

    # 4. Filter reviews matching expected SHA
    sha_reviews = [
        r for r in reviews if isinstance(r, dict) and r.get("sha") == expected_sha
    ]
    if not sha_reviews:
        return ArgusVerdictResult(
            passed=False,
            reason_code="STALE_REVIEW",
            summary=(
                f"No Argus review found for current PR head SHA {short_sha}. "
                "Any prior approval is invalidated by new commits. Run /argus-review-loop to approve current head."
            ),
        )

    # 5. Authoritative timestamp validation & newest review resolution (Finding 3)
    # Fail closed if ANY exact-SHA round has missing/malformed authoritative timestamp;
    # never fall back to unverified server order.
    parsed_with_ts: list[tuple[float, dict[str, Any]]] = []
    for r in sha_reviews:
        ts_val = r.get("created_at") or r.get("timestamp") or r.get("date")
        epoch = parse_iso_timestamp(ts_val)
        if epoch is None:
            return ArgusVerdictResult(
                passed=False,
                reason_code="MISSING_OR_MALFORMED_TIMESTAMP",
                summary=(
                    f"Argus review for SHA {short_sha} has missing or unparseable timestamp. "
                    "Fail closed; authoritative timestamp required on all exact-SHA rounds."
                ),
                details={"sha": expected_sha},
            )
        parsed_with_ts.append((epoch, r))

    # Sort descending by timestamp
    parsed_with_ts.sort(key=lambda x: x[0], reverse=True)
    max_ts = parsed_with_ts[0][0]

    # Tied newest: all reviews matching max_ts
    tied_newest = [r for epoch, r in parsed_with_ts if epoch == max_ts]

    # Require newest exact-SHA rounds to be terminal per storage schema
    for r in tied_newest:
        stage = r.get("current_stage")
        if stage is not None and stage != "completed":
            return ArgusVerdictResult(
                passed=False,
                reason_code="NON_TERMINAL_ROUND",
                summary=(
                    f"Latest Argus review at SHA {short_sha} is non-terminal (stage: running). "
                    "Wait for review round to complete."
                ),
                details={"sha": expected_sha},
            )
        status_val = r.get("status")
        if status_val is not None and status_val in {"running", "in_progress", "pending"}:
            return ArgusVerdictResult(
                passed=False,
                reason_code="NON_TERMINAL_ROUND",
                summary=(
                    f"Latest Argus review at SHA {short_sha} is non-terminal. "
                    "Wait for review round to complete."
                ),
                details={"sha": expected_sha},
            )

    # Whitelist accepted verdict enums and emit only generic reason codes (Finding 8)
    # Never copy unexpected private response values or review prose into output/summary
    has_blocking = False
    has_invalid = False

    for r in tied_newest:
        v = r.get("verdict")
        if v == "BLOCKING":
            has_blocking = True
        elif v != "APPROVE":
            has_invalid = True

    if has_blocking:
        return ArgusVerdictResult(
            passed=False,
            reason_code="VERDICT_BLOCKING",
            summary=(
                f"Argus recorded a BLOCKING verdict at SHA {short_sha}. "
                "Run /argus-review-loop to resolve findings."
            ),
            details={"sha": expected_sha},
        )

    if has_invalid:
        return ArgusVerdictResult(
            passed=False,
            reason_code="INVALID_VERDICT_ENUM",
            summary=(
                f"Argus review contains an unrecognized or non-terminal verdict at SHA {short_sha}. "
                "Run /argus-review-loop to resolve findings."
            ),
            details={"sha": expected_sha},
        )

    # All tied newest reviews are terminal APPROVE
    return ArgusVerdictResult(
        passed=True,
        reason_code="EXACT_HEAD_APPROVE",
        summary=f"Argus approved PR at exact head SHA {short_sha}.",
        details={"sha": expected_sha},
    )


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Evaluate Argus review verdict for commit SHA")
    parser.add_argument("--sha", required=True, help="Expected PR head SHA")
    parser.add_argument("--input-file", help="Path to JSON file containing review response (default: stdin)")
    args = parser.parse_args()

    if args.input_file:
        with open(args.input_file, encoding="utf-8") as f:
            raw_content = f.read()
    else:
        raw_content = sys.stdin.read()

    result = evaluate_argus_data(raw_content, args.sha)
    output = {
        "passed": result.passed,
        "reason_code": result.reason_code,
        "summary": result.summary,
        "details": result.details,
    }
    print(json.dumps(output, indent=2))
    if not result.passed:
        sys.exit(1)


if __name__ == "__main__":
    main()
