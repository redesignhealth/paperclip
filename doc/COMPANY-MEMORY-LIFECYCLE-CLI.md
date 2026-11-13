# Company Memory Lifecycle CLI (TECH-8191)

Operator reference for the live agent-scoped Mem0 migration. For a non-localhost target, pass `--prod` and set `MEMORY_UPGRADE_ALLOW_PROD=1`. Host locality is not proof that a database is non-production.

Confirmed mutations require `--confirm <company-uuid>`, matching `--company` when both are supplied. Without confirmation, commands that support dry runs produce a read-only preview. Reports support `--output`/`--out` and `--format text|json`.

| Command | Purpose | Writes? | Requires `--confirm` | Dry-run support | Key flags | Refusal conditions |
| --- | --- | --- | --- | --- | --- | --- |
| `census` | Inspect legacy rows, routing, and conversion budget. | No; read-only. | No. | Read-only by definition; no `--dry-run`. | `--database-url`, `--company`, `--control-plane-url`, `--table`, `--long-threshold`, `--prod`. | Missing DSN; invalid target/table; production safety gate. |
| `sweep` | Convert legacy rows, embed them, and record ledger/staging outcomes; live collection is `SELECT`-only. | Yes: ledger, staging, counters; no live rows. Uses the company's OpenAI key. | Yes; IDs must match. | No `--dry-run`. | `--model`, `--openai-key-file`, `--max-rows`, `--max-cost-usd`, rate limits, pause flags, `--operator-label`, `--prod`. | Missing/mismatched IDs or DSNs; lease, routing, budget, converter, or preflight failure. |
| `publish` | Publish converted staging rows to the live collection. | Yes: live insert and staging `published_at` in one transaction. | Yes. | Yes, `--dry-run`. | `--batch-sources`, `--max-rows`, `--page-size`, pause flags, `--prod`. | Malformed staging; source, tenant-fence, schema/vector, state, or lease failure. |
| `flip` | Set the company marker and advance `sweeping` through `flipping` to `draining`. | Yes: marker, state, counters. | Yes, plus `--ack-agent-scope-flag`. | Yes, `--dry-run`. | `--ack-agent-scope-flag`, `--mode copy`, `--probe-limit`, `--prod`. | Outstanding publishable source; state/marker, mode, preflight, lease, or fence failure. Acknowledgment is not proof. |
| `drain` | Establish post-flip quiescence evidence; it does not run a sweep. | Yes when confirmed: probe streak/confirmation evidence. | Yes. | Yes, `--dry-run`; `--once` runs one iteration. | `--max-drain-hours`, `--probe-interval-minutes` (minimum 10), `--probe-limit`, `--blocking-run-limit`, `--once`, `--prod`. | Missing observation, pending work, missing-scope rows, unfinished pre-flip runs, competing lease, or timeout. Timeout leaves `draining`. |
| `verify` | Apply completeness gates and advance `draining` to `verified`. | Yes when gates pass: timestamp/state/counters. | Yes. | Yes, `--dry-run`. | `--allow-quarantined`, `--probe-limit`, `--blocking-run-limit`, `--prod`. | Failed gate, including pending publish, probe blockers, quarantines (unless explicitly allowed), or lease conflict. |
| `rollback` | Clear marker and revert/terminate the upgrade state. | Yes: marker/state/lease; never deletes live rows. | Yes. | Yes, `--dry-run`. | `--table`, `--prod`. | `sweeping`, `needs_recovery`, or `pruning`/`completed`; refused once pruning starts. |
| `recover` | Recover `needs_recovery` to recorded prior state and release the lease. | Yes, atomically: state/error/lease. Never changes marker. | Yes. | Yes, `--dry-run`. | `--control-plane-url`, `--prod`. | State is not `needs_recovery`, deletion admission fails, invalid recovery target, or lease/CAS conflict. |

`status` and `prune` are not built. Do not substitute manual SQL or attempt those commands.

## Typical single-company pilot

1. Run `census` and confirm the supported embedding pair (§5.5). Deploy the parser and rebuilt Hermes image before changing agent hardening configuration.
2. Run `sweep`, then `publish`, until no publishable staging remains. Quarantined sources do not block `flip`.
3. Add `PAPERCLIP_MEMORY_HARDENING=agent-scoped-mem0` to each intended agent's `adapterConfig.env`, resending the complete existing environment. Do not enable it server-wide for a narrow pilot.
4. Run `flip ... --confirm <uuid> --ack-agent-scope-flag`. This is a live cutover: do not use `NOLOGIN` or terminate connections.
5. Run `drain` until two clean probes at least 10 minutes apart establish quiescence. Other agents' company-scoped writes commonly prevent confirmation; never run prune on a partially flipped company.
6. Run `verify`; treat quarantines as a recorded policy decision, not a routine `--allow-quarantined` override.
7. If state becomes `needs_recovery`, run `recover` first. Rollback retains agent-scoped rows and is near-final: a later upgrade reconverts and duplicates legacy content (TECH-8326).
