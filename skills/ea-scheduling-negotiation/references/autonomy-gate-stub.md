# Autonomy Gate — Stub Contract (TECH-4951/4952/4953)

## Why this is stubbed, not real

`rh-scheduler-mcp` has an internal autonomy gate at
`src/scheduler_mcp/autonomy/gate.py` (`evaluate_gate(context, *, audit_log)
-> GateResult`, a three-valued `{ACT, ASK_FIRST, CANNOT_DETERMINE}` decision
with a `reason` and a `permanently_gated` flag). It is real, tested code —
but it is **not exposed as an MCP tool** as of this ticket. There is no
`rh-scheduler-mcp` tool an agent can call to reach it. Building that
exposing tool is explicitly out of scope for this ticket (per product
decision) and belongs to a future `rh-scheduler-mcp` ticket, not to any
change on the Paperclip side.

Per that same product decision, this skill does not wait for that tool to
exist. It defines the decision point now, gives it a clearly-named stub
behavior, and documents exactly what a future ticket needs to change.

## The stub, as an instruction (not code)

There is no TypeScript function to point to here — per this skill's
capability model (see `SKILL.md`'s intro and `skills/paperclip-create-agent/SKILL.md`),
the "stub" is this instruction, followed literally, every time:

> **AUTONOMY GATE CALL — STUBBED. Always resolves to ASK_FIRST.**
> Whenever this skill's workflow reaches a point where it would ask
> "may I act on this scheduling decision without the principal's
> confirmation first?", the answer in this version of the skill is always
> **ASK_FIRST**, regardless of how confident, low-risk, or "obviously fine"
> the situation looks. Do not reason your way to `ACT`. Do not skip the
> confirmation step. Post the decision and your reasoning to the principal
> (a Paperclip `request_confirmation` issue-thread interaction) and wait for
> their response before treating the scheduling action as decided. Set
> `continuationPolicy: "wake_assignee"` on that interaction --
> `request_confirmation` defaults to `continuationPolicy: "none"`, which
> never wakes you back up, so omitting this would strand the negotiation
> forever even after the principal responds (see `SKILL.md` step 5).

This applies to every situation `evaluate_gate`'s real design doc
(`~/repos/rh-scheduler-mcp/docs/ea-scheduling-negotiation-and-autonomy.md`)
describes as potentially autonomous — grabbing an open slot, moving the
principal's own commitment, moving a meeting for someone else, crossing a
hard rule, cancelling/rescheduling something already booked, or sending an
external invite. All of them resolve to ASK_FIRST here, not just the
permanently-gated ones the real gate would also ask-first for. That is a
strictly more conservative behavior than the real gate (which lets
`grab_open_slot` start permissive and lets other action types earn `ACT`
over time) — deliberately so, since this stub has no `ConfidenceInputs`,
no rule lookup, and no audit trail to ground a less conservative answer in.

## What a future ticket needs to do to make this real

1. `rh-scheduler-mcp` needs a new MCP tool (e.g. `evaluate_autonomy_gate`)
   that accepts whatever `GateContext` shape `gate.py` needs (action type,
   owner identity, requester, matched rules, confidence inputs, incumbent/
   competing meeting context) and returns the `GateResult` — this is
   `rh-scheduler-mcp` work, not Paperclip work, and is explicitly out of
   scope for this ticket.
2. Once that tool exists, add it to the connector's action catalog
   (`packages/shared/src/app-definitions/rh-scheduler-mcp.json`'s
   `scopesHint`, plus whatever catalog-entry risk classification the
   connector playbook's action-catalog step requires — this is very likely
   a `read` action itself, since the gate call is a decision lookup, not a
   side effect. It never returns "and I already sent/booked it" — it's the
   caller's job to check the result before acting on it.)
3. Replace the stub instruction above with a real one: "call
   `evaluate_autonomy_gate` with `{context}`; if the result is `ACT`, you
   may proceed without asking first; if `ASK_FIRST` or
   `CANNOT_DETERMINE`, ask the principal via `request_confirmation` before
   proceeding; `CANNOT_DETERMINE` should be reported as 'the gate could not
   evaluate this, not that it declined' — do not collapse it into
   `ASK_FIRST`'s wording even though the workflow effect (pause and ask) is
   the same."
4. Even once real, this skill still must not add a `book_meeting` or
   `send_scheduling_email`-equivalent MCP call — the gate answers "may I
   act," it does not create a write path. A write path on the
   `rh-scheduler-mcp` side is a separate, larger piece of work with its own
   review (calendar mutation, external send) that this ticket does not
   attempt to unblock.
