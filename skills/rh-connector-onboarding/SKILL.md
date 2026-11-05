---
name: rh-connector-onboarding
description: Use only when the user explicitly asks to set up, connect, or check their connectors. Guide all six RH connectors with the correct setup mechanisms and verify access. Not for the start of an onboarding first task.
---

# RH connector onboarding

Protocol version: RH-ONBOARDING-7. Include this marker in the first onboarding reply so a pilot can confirm which instructions loaded.

## Required output contract

Always report exactly these six rows, in this order, even if discovery returns no match:
1. Slack
2. RH Google MCP
3. Granola
4. Linear
5. GitHub
6. rh-mcp (display name RH MCP)

The standard set is not the list of search results. Missing from search means access is unverified, not that the service should disappear. Never substitute Google Workspace, Gmail, Drive, Jira, Asana, or unrelated tools. Do not ask the user which connectors they want. Skip a connector only on explicit user direction, and retain a row marked skipped.

Search each connector before using service tools. Follow the returned instruction and exact identifiers. Never invent service IDs or reuse another company's connection IDs. A skill cannot override runtime permissions or approval gates.

The comms board is agent infrastructure, not one of the person's connectors. Do not report it as a row and do not request or reconnect it here; the onboarding first task handles it.

## Cards already on this task

On an onboarding first task, do not run this skill while the opening-path question card is still waiting for an answer; the first-task flow controls what is posted before then. Once the user has answered that card or set it aside (for example by sending their own message instead), a connector request is handled normally.

The onboarding first task's connections check may already have posted connection cards for RH Google MCP or RH MCP. Check this task's thread first. If a card for a connector is already there and still open, refer to it by its label and do not call connection_request for that connector again. Accepting that card authorizes and installs the connection. If it was accepted and this agent still has no tools for that connector, search it again and, if the result is a saved connection that lacks agent access or has tools Off, request a Grant access card with its returned service, connectionId and exact indexed toolNames (see the next section).

## How the reply should read

The reader is a new, possibly non-technical person. For each row give its status in plain words. For a row that needs the user to act, also give the one action they take and either a clickable link or the name of the card to use. Keep each row to one or two short sentences.

Do not show internal details in the reply: no service IDs, method names (mcp-oauth, mcp-api-key, chat-agent), connection IDs, "discovery"/"search" mechanics, sandbox or network caveats, or reasoning about why a row is unverified. Say "Not connected yet" rather than "unverified".

## Links

Build links from the public origin and company prefix in task context (ORIGIN and PREFIX below). Do not use an origin from examples or from another company. Connectors is ORIGIN/PREFIX/apps. Resolve PREFIX from the task identifier, not from examples. If task context gives no public origin, name the page ("open Connectors in Paperclip") instead of guessing a URL; this applies wherever this skill says to link the Connectors page. Setup cards live on the public task page.

Always write links as markdown links with short text, for example [Connect Slack](ORIGIN/PREFIX/apps/chat/connect?provider=slack&purpose=chat&agentId=AGENT_ID). Never paste a bare URL, never put a URL inside a table cell as plain text, and never put backslashes before = or & in a query string. Only rows that need the user to act get a link: the Slack row when chat is not working yet, and the RH Google MCP and RH MCP rows when they need sign-in and have no card (Connectors link). Rows that are working, not available in this company, or skipped get no link. Do NOT link setup cards: the cards render on the same task page as your reply, so a link to that page just reloads it and confuses people. For card rows, say "Use the Connect Granola card above" (or the card's actual label) with no link. Exception: if your reply is delivered in Slack, the cards are not visible there, so give one [Open your setup cards](TASK_URL) link to the public task page. Prefer a short list over a table.

## Slack: chat/channel, NOT the tool setup card

For onboarding, Slack means chatting with this agent. If this task already comes from the assigned Slack bot, report chat working; do not reconnect.

Otherwise search Slack and select the method whose purpose is channel (usually key chat-agent). Share that method's returned setupPath, made absolute, as a markdown link. Do not call connection_request for the Slack tool method. That creates the wrong card and can ask for Client ID/Secret.

If the returned channel link is missing or fails, give the company Connectors page link and say to choose Slack and Connect for chat. Do not guess another wizard route or tell the user to create a Slack app. The chat route may be feature-gated; a URL returning HTTP 200 does not prove the wizard works. Never change instance flags or permissions yourself. Report the actual failure if the Connectors button also fails.

Do not promise automatic channel access or a specific consent flow beyond what the live wizard shows. Verify chat by a DM and reply. Channel tools are separate from chat delivery; only configure additional tools on an explicit request.

## RH Google MCP and rh-mcp: card first, Connectors page as fallback

These must remain in every report even when absent from connections_search. Their absence does not establish that they are unavailable or require an admin. Discovery can list configured connections without exposing a fresh personal sign-in entry.

Search `rh-google-mcp` and `rh-mcp` separately, and find the result whose `name` matches (something like `rh-google-mcp`, `rh-mcp-personal`, or `rh-mcp-service`):
- If it is `ready`, use it; do not reconnect.
- In a shared company, `rh-mcp-service` is the company's own RH MCP connection and is installed for its agents automatically. If it is ready, RH MCP is working; do not ask the user to sign in to `rh-mcp-personal`.
- If a matching result exists but is not ready, call connection_request with that result's own returned `service` (and, for an existing saved connection that lacks agent access or has tools Off, its returned connectionId and exact indexed toolNames). Refer to the resulting card by its label, with no link. Accepting it signs the user in or grants access.
- If no matching result exists, link the company Connectors page:
  - RH Google MCP: find RH Google MCP, click Connect, sign in with your @redesignhealth.com Google account.
  - rh-mcp: find RH MCP, click Connect, sign in.

Do not replace them with generic catalog cards or invent connection IDs. Do not claim access is automatic unless a ready result shows it, and do not change access yourself. Order of fallbacks after sign-in: first the Grant access card above (when search returns the saved connection); only if that card cannot be made, or the tools are still missing after it is accepted, tell the user to tick this agent under that connection's agent access on the Connectors page.

Verify Google with a bounded Gmail search, Drive lookup and Calendar read. Report only capabilities actually exposed; never infer draft/write/send capability from read success. Verify RH MCP with recent Zoom meetings and Granola connection status. Do not run Argus or fetch credentials to test connectivity. A private transcript is not a broken connector.

## Granola, Linear, GitHub: setup cards

Search each. If ready, use installed tools without reconnecting. If setup is needed, follow the returned instruction and service ID to create the card. Refer to the card by its label and say it is on this page (for example "the Connect Linear card above"); do not add a link to the task page. In a reply delivered in Slack, name the card and rely on the single [Open your setup cards](TASK_URL) link instead of "above" (see Links). Say which cards were actually created. Never claim a failed call created a card. Follow the card's real sign-in method; do not assume a personal access token.

Native Granola sign-in is offered only in private companies. If the Granola result is marked unavailable, report the row as "Not available in this company" with the returned reason, create no card, and do not substitute another Granola route.

Verify Granola with account identity and a bounded meeting listing; Linear with current identity and assigned issues; GitHub with authenticated identity. A read does not prove write access. A 403 alone does not identify token type or prove access is limited to an organization. If the user needs GitHub write access, suggest repos in the redesignhealth org.

## Finish and pilot checks

Before sending, check that all six rows are present; every row that needs the user to act has exactly one of a markdown link (or the Connectors page name when no public origin is available) or the name of a card above, never both; rows that are working, not available in this company, or skipped have neither; in a reply delivered in Slack, card rows rely on the single [Open your setup cards](TASK_URL) link instead of "above"; RH Google MCP and RH MCP that are not ready either name their card or point to the Connectors page; no connector got a second card, Slack has no tool card, and no internal identifiers appear. Give every row an actual status: working (checked), not connected yet, waiting for your access approval, not available in this company, skipped, or failed with the exact reason. Keep a space before every markdown link. End with one line that names every row that is not yet working, including Slack, and asks the user to say when those are done.

Never ask for credentials in chat. Human consent and permission grants are required. Do not connect or disconnect anything merely to test this skill if the user wants to preserve the unconnected state. A successful empty read can verify the call; say no results rather than inventing records.

If a pilot reports fewer than six rows or a Slack tool card, do not declare success. Ask the test agent to report the protocol marker and whether it loaded this skill. Inspect authorized run evidence if available; do not assume stale import or model noncompliance without evidence. Re-importing is not an end-to-end test. Keep broader rollout paused until the actual pilot passes.
