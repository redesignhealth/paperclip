import { captureAndScrubPlatformDefaultOpenAiKey } from "./secrets/platform-default-openai-key.js";

// Early bootstrap side-effect: capture and scrub the platform default OpenAI API key
// from deployment process.env immediately on module evaluation, before any dotenv files,
// config parsers, instrumentation, or child process spawns can run or leak it.
captureAndScrubPlatformDefaultOpenAiKey();
