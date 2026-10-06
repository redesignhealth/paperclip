/**
 * Canonical names of the four comms-board provisioner control-plane settings (TECH-7228).
 *
 * Shared so the server boot snapshot and the CLI's `.env` preload agree on exactly which keys are
 * reserved for the deployment environment. Names only: this module holds no values and no logic.
 */
export const COMMS_BOARD_MCP_URL_ENV = "PAPERCLIP_COMMS_BOARD_MCP_URL";
export const COMMS_BOARD_ADMIN_TOKEN_ENV = "PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN";
export const COMMS_BOARD_OWNERSHIP_API_URL_ENV = "PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL";
export const COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV = "PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN";

export const COMMS_BOARD_PROVISIONER_ENV_KEYS: readonly string[] = Object.freeze([
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
]);
