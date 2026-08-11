import type { ToolConnectionOwnership, ToolConnectionTransport } from "./tool-access.js";
export type AppCategory = "ai"|"analytics"|"commerce"|"communication"|"content"|"data"|"developer"|"productivity"|"other";
export type OAuthRedirectConstraints = "https-or-loopback-http";
export interface FieldDef { key:string; label:string; type:"text"|"password"|"textarea"|"datetime"|"select"|"checkbox"; required?:boolean; placeholder?:string; helperMd?:string; secret?:boolean; prefix?:string; validation?:{pattern?:string;maxLength?:number}; options?:Array<{value:string;label:string}> }
// identityModel: "personal_only" means the provider has no legitimate
// non-personal identity (Gmail, Calendar, a user-scoped Slack grant) -- the
// gateway never falls back to a workspace-level credential for this class of
// connection, resolving only the specific person the run is acting for (see
// server/src/services/tool-gateway.ts, resolvePersonalOrConnectionCredentialHeaders).
// Omitted or "company_or_personal" preserves today's connection-level-credential
// behavior. Link-connected servers with no AppDefinition set this directly on
// the connection's own config instead of here.
// catalogExcludedTools: tool names that must NEVER appear in an agent's
// resolved tool catalog for this connection method, regardless of what the
// upstream server's `tools/list` response reports. Enforced in
// `remoteTools()` (server/src/services/tool-access.ts) as a code-level
// backstop for connectors that expose an internal/administrative tool
// (e.g. a token-minting tool) alongside the tools actually meant to be
// agent-callable -- see rh-scheduler-mcp.json's `mint_token_for_subject`.
// This is defense-in-depth: it does not replace server-side scope checks,
// it removes reliance on documentation/instruction text alone to keep such
// tools out of every agent profile's catalog.
export interface ConnectionMethodDef { key:string; transport:ToolConnectionTransport; auth:"oauth"|"api_key"|"none"; ownershipModes:ToolConnectionOwnership[]; whenToUse:string; identityModel?:"personal_only"|"company_or_personal"; defaults?:{serverUrl?:string;discoveryUrl?:string|null;serviceHost?:string;templateKey?:string;authorizationEndpoint?:string;tokenEndpoint?:string;metadataUrl?:string;scopesHint?:string[]}; tenantFields?:FieldDef[]; extensionFields?:FieldDef[]; credentialFields?:FieldDef[]; keyPlacement?:{location:"header"|"query"|"body_json"|"env";name:string;prefix?:string|null}; guidanceMd:string; consoleLinks?:{register?:string;keys?:string;settings?:string;docs?:string}; warnings?:string[]; variants?:Array<{key:string;label:string;whenToUse:string;tenantFields?:FieldDef[]}>; riskTier:"S1"|"S2"|"S3"|"S4"; requiredResourceFilters?:string[]; catalogExcludedTools?:string[] }
export interface AppDefinition { schemaVersion:1; slug:string; name:string; description:string; categories:AppCategory[]; featured?:boolean; branding:{logoUrl:string;darkLogoUrl?:string;backgroundColor?:string;accentColor?:string}; urlPatterns:string[]; docsUrl?:string; redirectConstraints?:OAuthRedirectConstraints; methods:ConnectionMethodDef[]; suggestable?:boolean; availability?:{available:boolean;reason?:string;robotEmail?:string}; ownershipAvailability?:Partial<Record<ToolConnectionOwnership,boolean>> }
