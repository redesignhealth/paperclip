import { createRequire } from "node:module";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../packages/db/src/index.js";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
export const { sql } = require("drizzle-orm");

export {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
};

export function handleEmbeddedPostgresUnsupported(
  support: { supported: boolean; reason?: string },
  t?: { skip: (reason?: string) => void },
  ciEnv: string | undefined = process.env.CI,
): void {
  if (support.supported) return;
  const reason = support.reason ?? "embedded Postgres not supported";
  if (ciEnv === "true" || ciEnv === "1") {
    throw new Error(`Embedded Postgres is required in CI but not supported: ${reason}`);
  }
  if (t && typeof t.skip === "function") {
    t.skip(reason);
  }
}
