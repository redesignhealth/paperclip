"""Shared constants for Merge Gate scripts and drift tests (TECH-7014)."""

from __future__ import annotations

ANCHOR_WORKFLOW_NAME = "Merge Gate Trigger"
ANCHOR_WORKFLOW_FILE = "merge-gate-trigger.yml"

GATE_WORKFLOW_NAME = "Merge Gate"
GATE_WORKFLOW_FILE = "merge-gate.yml"

GATE_EXCLUDED_WORKFLOW_NAMES = frozenset({ANCHOR_WORKFLOW_NAME, GATE_WORKFLOW_NAME})
GATE_EXCLUDED_WORKFLOW_FILES = frozenset({ANCHOR_WORKFLOW_FILE, GATE_WORKFLOW_FILE})

# Label-gated workflow definitions (workflow name -> required PR label and file)
# In paperclip, Storybook Visual is gated by the 'storybook-visual' label.
LABEL_GATED_WORKFLOWS = {
    "Storybook Visual": {
        "label": "storybook-visual",
        "file": "storybook-visual.yml",
    }
}
