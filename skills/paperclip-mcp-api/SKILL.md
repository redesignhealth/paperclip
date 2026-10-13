---
name: paperclip-mcp-api
description: Use the paperclipApiRequest MCP tool, not terminal curl, for Paperclip API writes. This is the supported transport for writes; curl calls carrying a bearer token can be blocked by mandatory command scanning (scanner_finding_blocked).
---

# Use the MCP tool for Paperclip API writes

`paperclipApiRequest` is the supported way to make a write (POST, PUT, PATCH,
DELETE — issue updates, comments, routine edits, status changes, proposals,
etc.) against the Paperclip `/api`. Use it instead of a terminal
`curl ... -H "Authorization: Bearer $PAPERCLIP_API_KEY"` call, which the base
`paperclip` skill's Authentication section otherwise describes.

Why: terminal commands, including curl commands carrying a bearer token,
route through mandatory Hermes command scanning. That scanner has no bypass,
exception, or silencing flag: a blocked call fails with
`scanner_finding_blocked` and retrying the same way will not help. The
`paperclipApiRequest` MCP tool call is not a terminal command, so it is not
subject to that scanning — but the point of using it is that it is the
supported transport, not that it dodges a control. It uses the same
authenticated API client and the same permissions as curl would.

**How to use it:** the tool is exposed by whichever MCP connection in this
company provides `paperclipApiRequest` (the `@paperclipai/mcp-server`
package; the connection's display name is set per company by whoever
connected it, so do not assume a fixed name). It takes the same `method`,
`path`, and optional `jsonBody` you would otherwise pass to curl, and it
already has `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` wired in — do not pass
credentials in the call.

Example: instead of
`curl -X PATCH "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -d '{"status":"blocked"}'`,
call `paperclipApiRequest` with `method: "PATCH"`, `path: "/issues/<issueId>"`,
`jsonBody: '{"status":"blocked"}'`.

GET requests via curl are not known to be blocked and do not need to change,
but using `paperclipApiRequest` for those too is fine and keeps one calling
convention.

If `paperclipApiRequest` is unavailable (no such MCP connection for this
agent) and a write is blocked by the scanner, do not retry the curl call and
do not try to work around the scanner. Say so explicitly and ask the board to
connect an MCP server providing `paperclipApiRequest` for this agent.
