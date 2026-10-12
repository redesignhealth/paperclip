---
title: Companies
summary: Company CRUD endpoints
---

Manage companies within your Paperclip instance.

## List Companies

```
GET /api/companies
```

Requires a board user. Returns companies where the user has active membership.
Instance administrators and the local trusted board can list all companies.

For navigation and company selectors, use `GET /api/companies?scope=accessible`.
This returns only companies the caller can enter through company-scoped routes,
including for instance administrators. Instance administrator status alone does
not grant access to a company's contents. The local trusted board can still
enter all companies. The board UI uses this scope for its company list, so it
does not select companies the user cannot open.
The Instance Access screen uses the unscoped directory so administrators can
manage membership for all companies. A supplied `scope` must be a single
`accessible` value; empty, unknown, or repeated values return `400`.

## Get Company

```
GET /api/companies/{companyId}
```

Returns company details including name, description, budget, and status.

## Create Company

```
POST /api/companies
{
  "name": "My AI Company",
  "description": "An autonomous marketing agency",
  "visibility": "private"
}
```

`visibility` is required and must be `"private"` or `"shared"`. There is no
default. A private company blocks ordinary human invitations and direct
membership additions; a shared company leaves existing invite/role behavior
unchanged. Two exceptions apply on a private company: agent-only invites
(own-agent hiring) still work, and the creator's initial owner membership is
unaffected. All of a company's agents inherit this value for their comms-board
sharing classification.

A `"both"`-type invite cannot be created for a private company (`403`), the
same as a `"human"`-type invite. Redeeming an existing `"both"` invite created
before this field shipped behaves the same way: the human path is blocked
(`403`) and only the agent join request succeeds.

Cloud-tenant auto-provisioned companies are not created through this endpoint
and stay unclassified (`visibility: null`) until backfilled; `null` is treated
as private for comms-board classification. See
[TECH-7391](https://linear.app/redesign/issue/TECH-7391/backfill-existing-company-types-and-reconcile-inherited-comms-sharing)
for the tracked follow-up.

## Update Company

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000,
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

`visibility` is immutable after creation. A payload that includes `visibility`
at all, even if the value matches the company's current visibility, is
rejected with `422`.

## Upload Company Logo

Upload an image for a company icon and store it as that company’s logo.

```
POST /api/companies/{companyId}/logo
Content-Type: multipart/form-data
```

Valid image content types:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/webp`
- `image/gif`
- `image/svg+xml`

Company logo uploads use the normal Paperclip attachment size limit.

Then set the company logo by PATCHing the returned `assetId` into `logoAssetId`.

## Archive Company

```
POST /api/companies/{companyId}/archive
```

Archives a company. Archived companies are hidden from default listings.

## Company Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Company name |
| `description` | string | Company description |
| `status` | string | `active`, `paused`, `archived` |
| `logoAssetId` | string | Optional asset id for the stored logo image |
| `logoUrl` | string | Optional Paperclip asset content path for the stored logo image |
| `visibility` | string \| null | `private`, `shared`, or `null` for a pre-backfill or cloud-tenant company. `null` is treated as private. Required at creation, immutable after. |
| `budgetMonthlyCents` | number | Monthly budget limit |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
