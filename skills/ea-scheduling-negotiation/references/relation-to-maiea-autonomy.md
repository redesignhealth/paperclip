# Two Different "Autonomy" Gates — Do Not Conflate Them

This skill's design touches two distinct pieces of prior art that both use
the word "autonomy" and both decide something like "may this proceed
without a human." They are not the same design, do not share code, and
should not be merged into one concept.

## 1. maiea's `_autonomy.py: decide_send` / `SendDecision`

- **What it is**: a pure, total, positive-allowlist function maiea uses at
  its own outbound-email choke point. `decide_send(*, autonomy, gated,
  bypass, message_class="unknown", facts=None) -> SendDecision`. A
  `scheduling_autonomy` profile value sends only if it is literally in
  `SEND_ALLOWED_TIERS` (`{"auto_send", "auto_book"}`); everything else —
  a typo, `None`, a future tier nobody added yet — queues for human
  approval. This inverted a prior bug (Architect Ruling D8/D9) where an
  unrecognized tier value fell through to sending instead of queuing.
- **What it decides**: strictly binary (`allow: bool`) — send this specific
  email now, or don't. It is keyed on a per-user `profile` setting and
  thread-state flags (`gated`, `bypass`), not on a track record of past
  approvals/rejections.
- **When it runs**: at maiea's own single outbound-send function, as the
  very last gate before an SMTP call.

## 2. `rh-scheduler-mcp`'s `autonomy/gate.py: evaluate_gate`

- **What it is**: a three-valued (`ACT`, `ASK_FIRST`, `CANNOT_DETERMINE`)
  decision over a richer `GateContext` — action type (`grab_open_slot`,
  `move_own_commitment`, `move_meeting_for_another`, `block_own_calendar`,
  and three permanently-gated classes), matched owner rules (hard vs. soft,
  precedence-ordered), and `ConfidenceInputs` (approval/rejection counts,
  whether an explicit rule covered the situation). It is explicitly a
  successor design, not a refactor of `_autonomy.py` — see its module
  docstring's reference to "generalized `check_send_eligibility`."
- **What it decides**: not "send this email," but "may the EA act on this
  category of scheduling action right now, given policy and track record" —
  a broader question that also covers moving/holding calendar time, not
  only sending mail.
- **Never-raise contract**: like maiea's `_guards.py` guard functions, every
  internal failure becomes `CANNOT_DETERMINE`, never a raised exception —
  the same "a bool would let a caller collapse error into clear" discipline
  `_guards.py` documents, generalized to three values instead of two.
- **Where it lives**: entirely inside `rh-scheduler-mcp`, not exposed as an
  MCP tool as of this ticket (see `references/autonomy-gate-stub.md`).

## How they relate

`evaluate_gate` reads as a deliberate generalization of the shape
`decide_send` pioneered (deny-by-default, explicit allowlist/track-record
reasoning, never silently permissive on an unrecognized input) — but it is
not a drop-in replacement, a superset in every dimension, or built on the
same code. `decide_send` is maiea's own, already-shipped (TECH-3387/D8) gate
for one specific choke point (the SMTP call); `evaluate_gate` is a newer,
broader design for the negotiation-and-calendar-action space this skill
covers, still missing its MCP-facing tool. Do not have this skill call
`decide_send`'s allowlist logic — it is maiea-internal, tied to maiea's own
`profile` schema and thread-state flags, and has no equivalent meaning in
Paperclip's agent/company model. This skill's decision point is, and should
remain, conceptually aligned with `evaluate_gate`'s three-valued shape (see
`references/autonomy-gate-stub.md`), even while the tool that would let this
skill actually call it does not exist yet.

## What was explicitly NOT carried over

maiea's `_rate_limiter.py` (`_queue_pending_approval` around line 219,
`_send_and_record` around line 380) implements a completely different,
older escalation mechanism: opening a Slack DM to the principal via
`slack_client`/`_wc.conversations_open`, rendering a Block Kit approval
card, and falling back to a plain-text Slack DM if the Block Kit send
fails. That is Slack-native, SQLite-row-backed (`pending_approvals` table),
and entirely specific to maiea's own bot deployment.

None of that was ported. This skill's ask-first path
(`SKILL.md` step 5) uses Paperclip's own primitives instead — a
`request_confirmation` issue-thread interaction on the checked-out issue,
per `skills/paperclip/SKILL.md`'s "Issue-Thread Interactions" section — not
a Slack DM, not Block Kit, and not a bespoke approval table. If a future
ticket wants Slack notification in addition to the Paperclip interaction,
that is a new, separate design decision, not a resurrection of
`_rate_limiter.py`'s logic.
