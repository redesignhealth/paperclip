# Proposing an email to send as your owner (`gmail_send`)

Use this for any request to send an email as your owner (TECH-8951). You never send mail yourself: you propose it on the comms board, your owner approves it, and the approvals service then sends it as your owner. No agent or session has a send tool: `send_gmail_message` is disabled on the server for everyone, so never try to call it or work around it. Drafting (`draft_gmail_message`) is not sending. If `proposals_submit` or `proposals_get` is missing, tell your owner.

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

If `proposals_submit` fails with 401 or 403, stop: do not retry, do not change the payload, and do not try other tools. Report it to your owner as a credential or permission problem (agents created before `comms:proposals:write` was added need their credential rescoped by an operator).

On a 422 the response has `field_errors` (`path` and `code`, for example `to` / `not_canonical`). Read them and fix that field; do not guess at other action types. Submits are rate-limited per bot (default 5 per minute, 429 `rate_limited`): wait, do not hammer.

## Lifecycle

- A new `gmail_send` is always `pending`. It is never auto-approved. Only your owner's own decision on the decision page approves it.
- After approval, the board shows `applied` with `apply_result.sent: false`. That is only the recorded decision. A background worker in the approvals service then sends the email once, as your owner, through rh-google-mcp. You never trigger, retry, or confirm that send.
- Board statuses: `pending`, `approved`, `applying`, `applied`, `rejected`, `apply_failed`, `stale`, `withdrawn`.
- What you can see: `proposals_get` returns the board status and `apply_result`. What you cannot see: whether the email actually went out. The send result (sent, failed, unconfirmed) lives in the approvals ledger and is shown only on the owner's decision page. `applied` does not mean sent. Say "approved; the send result is on your decision page" and ask the owner, never "sent" or "delivered", unless the owner confirms.
- Always call `proposals_get` for the real status before telling anyone what is pending. A `rejected`, `apply_failed`, `stale`, `withdrawn` or `applied` proposal is not pending; never report a stale status.

## One-shot rules

- An open (`pending`/`applying`) `gmail_send` is never edited in place. Resubmitting the identical payload returns the same row. A changed payload is refused with 409 `proposal_immutable`. You cannot withdraw: only `proposals_submit` and `proposals_get` are available to you. Tell your owner there is already an open email proposal for that `target_id` (give its id), and submit a NEW proposal with a new `target_id` only if the owner wants the changed email. Do not resubmit variations on your own.
- There are no retries. A failed or unconfirmed send is final, and a rejected or otherwise decided proposal is finished. To try again, submit a NEW proposal with a new `target_id`.
- If your owner tells you the send failed or is unconfirmed, say plainly that the first email did not send (or may not have), that it will not be retried, and offer a new proposal. Before resubmitting after an unconfirmed send, ask the owner to check their Sent folder so the email is not sent twice.
