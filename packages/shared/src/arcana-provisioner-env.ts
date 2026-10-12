/**
 * Canonical names of the Arcana provisioner control-plane settings (TECH-7252), shared so the server boot
 * snapshot and the CLI's `.env` preload agree on exactly which keys are reserved for the deployment
 * environment (same pattern as the comms-board provisioner, TECH-7228). Names only: no values, no logic.
 */
export const ARCANA_URL_ENV = "PAPERCLIP_ARCANA_URL";
export const ARCANA_PROVISION_TOKEN_ENV = "PAPERCLIP_ARCANA_PROVISION_TOKEN";

export const ARCANA_PROVISIONER_ENV_KEYS: readonly string[] = Object.freeze([ARCANA_URL_ENV, ARCANA_PROVISION_TOKEN_ENV]);
