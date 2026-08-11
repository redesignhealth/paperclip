# Drafting Guardrails (TECH-4953)

Ported from maiea's `tools/sentiment_guard.py` and `tools/copy_guard.py`.
Both are pure, deterministic regex scans in maiea, wired into its single
outbound send choke point (`tools.gmail.send_email`) as a backstop, and into
its draft-time path (`draft_scheduling_reply_checked`) as the primary fix.

Paperclip has no equivalent programmatic content-lint framework for
agent-drafted text today (there is no TypeScript "tool" a skill must
implement, and no existing lint-on-draft mechanism in this codebase to hook
into — see `SKILL.md`'s capability-model note). Per this ticket's guidance,
that means this guardrail is **instruction text applied by you, the
drafting agent, before you finalize any draft** — not a bespoke TS lint
framework invented for this one skill. Apply both rules below to every
draft, every time, not just the first draft in a thread.

## Rule 1 — Never fabricate the principal's mental state

maiea's `sentiment_guard.py` hard-blocks phrases that assert the
executive's emotional state as fact — "Neil enjoyed," "Neil is looking
forward to," "Neil can't wait," a generic "looking forward to a great
conversation" closer, etc. — because an EA cannot actually know that. The
same rule applies here, generalized beyond a fixed phrase list:

- Do not write that your principal is "looking forward to," "excited
  about," "delighted by," "can't wait for," or otherwise attribute any
  feeling, anticipation, or emotional reaction to them, in any wording,
  unless your principal explicitly told you that in this conversation
  (in which case, quote or closely paraphrase what they actually said —
  do not embellish it into stronger language).
- Default to neutral, factual language about availability and next steps:
  "Neil is available Thursday at 3pm" is fine; "Neil is thrilled to meet
  Thursday at 3pm" is not, even if it "sounds friendlier" — you have no
  basis for the second claim.
- This applies to intros, negotiation replies, and confirmations alike. A
  confirmation message inventing enthusiasm ("really looking forward to
  connecting!") is exactly as much a violation as inventing it in a first
  outreach.

## Rule 2 — Never imply the schedule favored the principal at the counterparty's expense

maiea's `copy_guard.py` bans constructions like "times that work best for
Neil's calendar," "times around Neil's schedule," or "convenient for
Neil's calendar" — phrasing that frames offered times as chosen for the
principal's convenience rather than presented as options for the
counterparty to pick from.

- Present every offered time as an option for the counterparty, not as
  something selected to suit your principal. Prefer "here are a few times
  that could work — let me know what's easiest for you" over "here are
  times that work well with Neil's schedule."
- Deliberate non-violations, so you don't over-correct into stilted
  phrasing: "if any of these work for you," "let me know what works best
  for you," "I checked Neil's calendar and found a few options" (stating a
  fact about what you did is fine; framing the offered slots as chosen for
  Neil's benefit is not).
- This matters most in the drafting step (`SKILL.md` step 4) but also
  applies to confirmations: "great, that time works well for Neil" is
  borderline-favors-principal phrasing; "great, that time works for both of
  you" or "great, see you then" is not.

## Also apply, every draft

- **Plain text, not markdown.** maiea's `copy_guard.sanitize_markdown`
  strips bold/heading/bullet markdown artifacts LLM drafts tend to leak
  into what should be a plain-text email. Write your drafts as plain
  prose — no `**bold**`, no `# headings`, no `*` bullet markers — unless
  the delivery channel is explicitly markdown-rendering.
- Both rules are **hard blocks, not style suggestions**: if a draft you
  produced trips either rule, rewrite it before showing it to anyone,
  including before posting it to the principal for the ask-first
  confirmation in `SKILL.md` step 5. Do not ship a violating draft with a
  caveat attached — fix the draft.
