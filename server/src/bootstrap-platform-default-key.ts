import { captureAndScrubCommsBoardProvisionerCredentials } from "./secrets/comms-board-provisioner-credentials.js";
import { captureDefaultMcpTemplateScope } from "./secrets/default-mcp-template-scope.js";
import { captureAndScrubPlatformDefaultOpenAiKey } from "./secrets/platform-default-openai-key.js";

// Early bootstrap side-effect: capture and scrub the platform default OpenAI API key
// from deployment process.env immediately on module evaluation, before any dotenv files,
// config parsers, instrumentation, or child process spawns can run or leak it.
captureAndScrubPlatformDefaultOpenAiKey();

// Same for the comms-board provisioner bearer tokens (TECH-7228): snapshot them (and freeze their
// endpoint URLs) from the deployment process.env, then delete the tokens so default-env children and
// later dotenv loads never see them.
captureAndScrubCommsBoardProvisionerCredentials();

// The default-MCP company-template rollout scope (TECH-7271) is an operator control: freeze it from the
// deployment environment now so a later dotenv load or child environment cannot change it.
captureDefaultMcpTemplateScope();
