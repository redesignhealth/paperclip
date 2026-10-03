"""Shared constants and SHA invariant helpers for Merge Gate scripts (TECH-7014)."""

from __future__ import annotations

import re
from typing import Any

DEFAULT_BRANCH = "master"

ANCHOR_WORKFLOW_NAME = "Merge Gate Trigger"
ANCHOR_WORKFLOW_FILE = "merge-gate-trigger.yml"

GATE_WORKFLOW_NAME = "Merge Gate"
GATE_WORKFLOW_FILE = "merge-gate.yml"

GATE_EXCLUDED_WORKFLOW_NAMES = frozenset({ANCHOR_WORKFLOW_NAME, GATE_WORKFLOW_NAME})
GATE_EXCLUDED_WORKFLOW_FILES = frozenset({ANCHOR_WORKFLOW_FILE, GATE_WORKFLOW_FILE})

# Label-gated workflow definitions (workflow name -> required PR label and file).
# In paperclip, Storybook Visual is gated by the 'storybook-visual' label.
# Note: trigger_coverage_test serves as the label-gated drift detector ensuring all PR
# workflows remain registered in the gate, while unknown workflows fail as CLASSIFIER_DRIFT.
LABEL_GATED_WORKFLOWS = {
    "Storybook Visual": {
        "label": "storybook-visual",
        "file": "storybook-visual.yml",
    }
}

# Shared default HTTP timeout (seconds) for GitHub API calls across gate scripts.
HTTP_TIMEOUT_S = 30

_HEX_40_RE = re.compile(r"^[0-9a-fA-F]{40}$")


def is_valid_40_hex_sha(s: Any) -> bool:
    """Validate that value is strictly a 40-character hexadecimal git commit SHA.

    Enforces exact boundary: must be a string with len == 40 matching [0-9a-fA-F].
    Does NOT strip or permit surrounding whitespace. Padded strings fail closed.
    """
    return isinstance(s, str) and len(s) == 40 and bool(_HEX_40_RE.match(s))


def normalize_sha(s: str) -> str:
    """Strictly validate and return lowercase 40-hex git commit SHA.

    Raw workflow and API boundaries MUST first pass strict validation with no
    surrounding whitespace. Raises ValueError if s is not strictly valid 40-hex.
    """
    if not is_valid_40_hex_sha(s):
        raise ValueError(f"Invalid 40-hex SHA: {s!r}")
    return s.lower()


def shas_equal(sha1: Any, sha2: Any) -> bool:
    """Check if two SHAs are both valid 40-hex and equal (case-insensitive)."""
    if not (is_valid_40_hex_sha(sha1) and is_valid_40_hex_sha(sha2)):
        return False
    return sha1.lower() == sha2.lower()


def is_valid_compatible_40_hex_sha(s: Any) -> bool:
    """Check if value is a 40-hex SHA after stripping surrounding whitespace.

    Used ONLY where compatibility with stored payloads (e.g. Argus review JSON)
    is specifically intended.
    """
    return isinstance(s, str) and is_valid_40_hex_sha(s.strip())


def normalize_compatible_sha(s: Any) -> str:
    """Normalize a SHA where surrounding whitespace compatibility is specifically allowed.

    Only for legacy/stored payloads (e.g. stored Argus review records).
    Strips surrounding whitespace, then strictly validates 40-hex and returns lowercase.
    Raises ValueError if invalid.
    """
    if not isinstance(s, str):
        raise ValueError(f"Expected str for SHA, got {type(s).__name__}")
    stripped = s.strip()
    if not is_valid_40_hex_sha(stripped):
        raise ValueError(f"Invalid 40-hex SHA: {s!r}")
    return stripped.lower()
