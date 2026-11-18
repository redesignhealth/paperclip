# Proposing an email to send as your owner (`gmail_send`)

Use this for any request to send an email as your owner (TECH-8951). You never send mail yourself: you propose it on the comms board, your owner approves it, and the owner's own signed-in Claude session sends it. You have no send tool, and `send_gmail_message` is disabled for agents; never call it or look for a workaround. If `proposals_submit` or `proposals_get` is missing, tell your owner.

## The call

Call `proposals_submit` on the comms board MCP with `kind: "gmail_send"`, a top-level `rationale`, and top-level `confidence`, `importance`, `impact` (each `low`, `medium`, or `high`). Put the email in `action`:

```json
"action": {
  "target_id": "gmail:q3-board-update-2026-11-18",
  "action_type": "send_email",
  "to": ["jane@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Q3 board update",
  "body": "Hi Jane,\n\nThe update is attached.\n\nThanks",
  "attachments": ["1AbCdEfGhIjKlMnOpQrStUvWxYz"]
}
```

Rules, checked by the board on submit:

- `target_id`: `gmail:` plus a non-empty token, no whitespace. Make it unique per email (a topic and date work).
- `action_type`: exactly `send_email`. Anything else (`gmail_send`, `send`, `draft`, ...) is `invalid_value`.
- `to` is required and non-empty. `cc`, `bcc`, `attachments` are optional lists.
- At most 50 recipients in total across `to`, `cc`, `bcc`. Each address is a bare `name@domain.tld` (no display names, `<>`, commas, semicolons, quotes, whitespace, or control characters), at most 254 characters.
- `subject`: non-blank, at most 998 characters, one line. `body`: non-blank plain text, at most 12000 characters.
- `attachments`: at most 10 Google Drive file IDs (10-128 characters of letters, digits, `_`, `-`). Not names, URLs, or bytes.
- No other keys. Never send a `from`; the email always goes from your owner's account. An unknown key is `extra_field`.

On a 422 the response has `field_errors` (`path` and `code`, for example `to` / `not_canonical`). Read them and fix that field; do not guess at other action types. Submits are rate-limited per bot (default 5 per minute, 429 `rate_limited`): wait, do not hammer.

## Lifecycle

- A new `gmail_send` is always `pending`. It is never auto-approved. Only your owner's own decision on the decision page approves it.
- Approval only records the decision; the board then shows `applied`, but nothing has been sent at that point. The email goes out when your owner's signed-in session runs `send_approved_email` for that proposal id. Tell your owner the proposal id and that it needs approving and sending.
- Board statuses: `pending`, `approved`, `applying`, `applied`, `rejected`, `apply_failed`, `stale`, `withdrawn`. `proposals_get` shows only this board status. It cannot tell you that the email was actually sent. Do not tell the user "sent" on the strength of `applied`; say "approved, delivery not confirmed" unless the owner confirms.
- Always call `proposals_get` for the real status before telling anyone what is pending. Never assume.

## One-shot rules

- An open (`pending`/`applying`) `gmail_send` is never edited in place. Resubmitting the identical payload returns the same row. A changed payload is refused with 409 `proposal_immutable`: call `proposals_withdraw` (only works while `pending`), then submit again.
- A decided proposal (`rejected`, `apply_failed`, `stale`, `withdrawn`, or approved) is finished. To try again, submit a NEW proposal with a new `target_id`.
- A send the sender could not confirm is never retried automatically (the owner checks their Sent folder), and after 5 definite failures the hold is closed for good. If your owner reports a failed or unconfirmed send, treat the old proposal as final, never as still pending, and offer a new proposal. Do not resubmit before the owner says whether the first one went out, to avoid sending twice.
