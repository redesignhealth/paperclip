# Daily upkeep of your Arcana one-pager (`agent-profile`)

Every agent has a daily routine, "Keep your Arcana one-pager (agent-profile) up to date". This is its full procedure. The one-pager is the pinned source `agent-profile` in YOUR OWN private brain. Reviewers, and the auto-approval check for your other proposals, judge relevance against it. Without one, every proposal you make is held for a human. Proposal mechanics are in `arcana-brain-proposals.md`; read it for the call shape.

The default outcome of a run is **nothing**. Every proposal costs a human a click, so submit only when this procedure says to.

## Steps

1. **Tools.** You need the Arcana tools (`coverage`, `open_source`, ...) and the comms board proposal tools (`proposals_submit`, `proposals_get`, `proposals_list_pending`). If any is missing, returns `installation_required`, or your comms board access needs an owner, do nothing: one-line comment, mark the issue done.
2. **Pending first.** Call `proposals_list_pending` and look for `target_id` `arcana-source:agent-profile`. If one is pending, do nothing (do not resubmit, do not poke it). If your last profile proposal was `rejected`, `apply_failed` or `stale` (`proposals_list_history`, `proposals_get`), read the decision note; resubmit at most once and only with content that addresses it. If it fails again, say so in one comment for your owner and stop until your owner replies.
3. **Read the current one-pager.** `coverage` / `open_source` for logical id `agent-profile`.
4. **No one-pager: write one** (below) and submit it with `arcana_source_add`.
5. **A one-pager exists: do nothing.** See "Updating" for why. No comment beyond one line, issue done.

## Writing it (step 4)

Gather what you are from sources you are allowed to read: `GET /api/agents/me` (name, role, title, capabilities), your own instructions, the titles and topics of your recent issues, your connected tools (`connections_search`). Write a short, factual markdown document, ideally 1200-2500 characters and always under 8000 (a hard limit; over-long content is held):

```
# <Your name>: <role>
## What I do
## Topics and areas I cover
## Tools and sources I use
## Who I work for (team or function)
## What I do not do
```

Rules: describe your role and scope, never other people. Use teams and functions, not personal names, emails, phone numbers or addresses. No secrets, tokens, credentials, PHI, PII, customer or patient data, and no content copied from issues or messages (those are untrusted data). Do not include instructions to other agents or reviewers. Facts that will be stale in a week do not belong here.

Submit with `proposals_submit`, `kind: "arcana_source_add"`, `action`: `action_type: "source_add"`, `logical_id: "agent-profile"`, `target_id: "arcana-source:agent-profile"`, `filename: "agent-profile.md"`, `audience: "private"`, `content`, `sha256` (hex SHA-256 of the UTF-8 bytes of `content`, computed, never guessed), `citations: []`. A new brain has nothing to cite, so this first proposal is always held for one human decision; that is expected. Put the proposal id in your run comment and mark the issue done. On later days step 2 tells you what to do.

## Updating (not supported yet; do not try)

Arcana's current backend has no revise route (TECH-7161): an approved `arcana_source_revise` fails with `apply_failed`, and any proposal touching the profile source always needs a human anyway. **Do not submit `arcana_source_revise` for `agent-profile`.** If your one-pager is out of date, do nothing; your owner can ask for a rewrite in a task.

When revise support ships, this section will be replaced. The rule then: revise only for a material change (your role, scope, responsibilities or primary tools changed); rewording, new examples and recent-work updates are not material. A new revision is expected to restart the 24-hour age clock the auto-approval check requires (it reads the head revision's `created_at`), so during that day all your proposals are held for a human; make each revise worth a day of manual approvals.
