/**
 * Canonical names of the Arcana provisioner control-plane settings (TECH-7252), shared so the server boot
 * snapshot and the CLI's `.env` preload agree on exactly which keys are reserved for the deployment
 * environment (same pattern as the comms-board provisioner, TECH-7228). Names only: no values, no logic.
 */
export const ARCANA_URL_ENV = "PAPERCLIP_ARCANA_URL";
export const ARCANA_PROVISION_KEY_ENV = "PAPERCLIP_ARCANA_PROVISION_KEY";
/** The Arcana MCP endpoint the static `rh-arcana-brain` template points agents at (TECH-7253). Not a secret. */
export const ARCANA_MCP_URL_ENV = "PAPERCLIP_ARCANA_MCP_URL";

/** Bearer holding only ACA's `arcana:bind` scope, used to register a brain directory row (TECH-7693). A secret: scrubbed at boot. */
export const ARCANA_BINDING_TOKEN_ENV = "PAPERCLIP_ARCANA_BINDING_TOKEN";

export const ARCANA_PROVISIONER_ENV_KEYS: readonly string[] = Object.freeze([
  ARCANA_URL_ENV,
  ARCANA_PROVISION_KEY_ENV,
  ARCANA_MCP_URL_ENV,
  ARCANA_BINDING_TOKEN_ENV,
]);
