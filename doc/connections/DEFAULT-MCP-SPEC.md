# Default MCP spec

Every new agent can be offered a short list of MCP apps. The apps start OFF. This feature is off by default.

## Turn it on

Set `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED=true`. When the flag is not `true`, agent creation does not change.
Agents that already exist are never changed by this feature.

## The spec

`server/src/services/default-mcp-spec.ts` holds the list. Each entry names an org connection (the template) and a `defaultEnabled` value.
To add an app, add one entry. Only an entry with special auth needs a `setupHook`.

- **Ordinary entry (for example Google):** the agent toggles the org connection itself. OAuth consent is never started at create time.
- **Dedicated entry (comms board):** the org connection is a read-only template. Setup creates one connection per agent, named `<template>:<agentId>`. Only that connection can be installed or used by the agent. The org template and the connections of other agents are refused.

## What OFF means

An app is ON for an agent only with an explicit per-agent install row. A company-wide install, a company profile, or an organization grant does not turn it on. The gateway, token mint, effective profiles and the run projection use one rule.
An agent whose row is missing, or whose protected `defaultMcp` key is corrupted, is refused (never treated as a legacy agent).
A managed per-agent connection cannot change its secret or its credential policy. Only the header path can move.
Removing the install blocks the next session and the next call. It does not cancel a call that is already running.

## Comms board identity (operator prerequisites)

Setup calls two existing APIs. It needs these server settings:

- `PAPERCLIP_COMMS_BOARD_MCP_URL` and `PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN` (board `comms_admin_register`).
- `PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL` and `PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN` (ownership `POST /agents`).

Each URL must be `https` (any host, so a private tailnet works). Plain `http` is allowed only for `127.0.0.1`, `localhost` or `[::1]`. A URL with a user name, a query or a fragment is refused, and the entry waits as `provisioner_config_invalid`. Redirects are never followed.
The ownership reply must name the same token base, be active, and be owned by the verified owner. Any other reply is an unknown result.

The admin and ownership tokens are control-plane credentials. They are never given to an agent.
The agent token has only `comms:read` and `comms:write`. It lives in the company secret store and is bound to the agent connection.
The org must also provide an active `api_key` template connection named `rh-comms-board` with one header credential. Until it exists, the entry stays `pending` and retries.

## Setup state

State is in `agents.metadata.defaultMcp`. Only the server writes it. Setup is durable: a 60-second sweep resumes pending work.
A lost register or mint response is an unknown result. It is never repeated and never rotated automatically.
The token life is 30 days. Rotation is not part of this feature. The existing backend rejects an expired token.
