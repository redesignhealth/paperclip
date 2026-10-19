# Proposing into your own Arcana brain

You have a private Arcana brain (read with the `recall`, `search_pages`, `read_page`, `coverage`, `open_source` tools of your Arcana MCP). The brain is read-only for you. You change it only by **proposing** a source through the comms board tools `proposals_submit` and `proposals_get`. If those tools return `installation_required` or are missing, tell your human owner; do not work around it.

## When to propose

Propose: durable facts about your work, your owner's stable preferences, and stable procedures you will want next week (how a recurring task is done, where something lives, a decision and its reason).

Never propose: secrets, tokens, passwords, credentials, PHI, PII, or anything you would not want a colleague to read; one-off chatter, status updates, or anything that will be stale in days. If unsure whether something is sensitive, do not propose it. Credentials go through `POST /api/agents/me/secret-proposals`, never a brain proposal.

## How to call

`proposals_submit` with `kind: "arcana_source_add"` (new source) or `"arcana_source_revise"` (new revision of a source you own; also pass `supersedes_revision` from `open_source` or `coverage`), plus `rationale` and `confidence`, `importance`, `impact` (each `low`, `medium` or `high`). The `action` object:

```json
{
  "action_type": "source_add",
  "logical_id": "how-we-close-the-books",
  "filename": "how-we-close-the-books.md",
  "content": "<markdown, plain text facts>",
  "sha256": "<hex sha256 of content>",
  "target_id": "arcana-source:how-we-close-the-books",
  "audience": "private",
  "citations": []
}
```

Use one `logical_id` per topic and revise it rather than adding near-duplicates. Keep `audience` as `private`. Resubmitting the same target updates your pending proposal in place. For `arcana_source_revise` use the same fields with `"action_type": "source_revise"` and `supersedes_revision` (inside `action`) set to the revision you are replacing. Cite the span of an existing source (`citations`) when a new source is derived from one. The rationale is for the reviewer; keep it short and factual.

`proposals_submit` returns a `proposal_id` and a `status`. If the status is not terminal, call `proposals_get` with the id on a later run (not in a tight loop) to see the outcome. A proposal never changes your brain until it is applied; do not assume it landed until `proposals_get` says so.

## What approval means

A human decides each proposal, or, where auto-approval rules are enabled for your brain, those rules do. Where enabled, the rules look at relevance to your one-pager and screen for sensitive information; PHI and PII never auto-approve and are held for a human; any edit to your one-pager is never auto-approved. A held proposal waits for your owner. A rejection means do not retry the same content; change it or drop it. Approval is not a reason to propose more often.

## Keep your one-pager current

Your one-pager is the pinned source with `logical_id` `agent-profile` in your own brain: who you are, what you do, which topics you cover, who you work for. Reviewers judge relevance against it. Read it with `read_page`/`open_source`. When your role or scope changes, propose an `arcana_source_revise` of `agent-profile` (it always needs a human), and keep it short, factual and free of sensitive details. If it does not exist yet, propose it with `arcana_source_add`.

## Other brains

Proposals aimed at another agent's brain need human approval from both owners and are **not enabled yet**. Do not try to write to another brain; if you hold knowledge another agent needs, say so in a task comment or message instead.
