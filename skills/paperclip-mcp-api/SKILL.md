---
name: paperclip-mcp-api
description: Prefer the paperclipApiRequest MCP tool over terminal curl for Paperclip API writes. Terminal curl calls carrying a bearer token route through mandatory command scanning and can be blocked (scanner_finding_blocked); MCP tool calls are not scanned.
---

# Prefer the MCP tool for Paperclip API writes

The `paperclip` skill's Authentication section tells you to call the Paperclip
`/api` endpoints with `curl ... -H "Authorization: Bearer $PAPERCLIP_API_KEY"`
from the terminal. Do not do that for calls that change state (POST, PUT,
PATCH, DELETE — issue updates, comments, routine edits, status changes,
proposals, etc.).

Terminal commands, including curl commands carrying a bearer token, route
through mandatory Hermes command scanning. That scanner has no bypass,
exception, or silencing flag: a blocked call fails with
`scanner_finding_blocked` and retrying the same way will not help. Sending the
same authenticated request through a shell command is the thing that gets
blocked, not the underlying API operation.

**Instead, use the `paperclipApiRequest` MCP tool** (from the "Paperclip MCP
Server (API request)" connection, when connected for this agent). It is an MCP
tool call, not a terminal command, so it does not go through command
scanning. It takes the same `method`, `path`, and optional `jsonBody` you
would otherwise pass to curl, and it already has `PAPERCLIP_API_URL` /
`PAPERCLIP_API_KEY` wired in — do not pass credentials in the call.

Example: instead of
`curl -X PATCH "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -d '{"status":"blocked"}'`,
call `paperclipApiRequest` with `method: "PATCH"`, `path: "/issues/<issueId>"`,
`jsonBody: '{"status":"blocked"}'`.

GET requests via curl are not known to be blocked and do not need to change,
but using `paperclipApiRequest` for those too is fine and keeps one calling
convention.

If `paperclipApiRequest` is unavailable (not connected for this agent) and a
write is blocked by the scanner, do not retry the curl call and do not try to
work around the scanner. Say so explicitly and ask the board to connect the
"Paperclip MCP Server (API request)" tool for this agent.
