/**
 * Shared test helpers for company memory upgrade sweep tests (TECH-8191).
 */

import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  companySecrets,
  companySecretVersions,
  createDb,
  heartbeatRuns,
  type Db,
} from "../../packages/db/src/index.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-census-helpers.js";

import { createRequire } from "node:module";
import type { ConversionClient, ConversionClientResult } from "../../server/src/services/company-memory-upgrade/llm-converter.js";
import type { EmbeddingClient, EmbeddingResult } from "../../server/src/services/company-memory-upgrade/embedding-client.js";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
export const { eq } = require("drizzle-orm");

export {
  agents,
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  companySecrets,
  companySecretVersions,
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  sql,
  startEmbeddedPostgresTestDatabase,
};

/**
 * Manual virtual clock implementing both MonotonicClock and Clock interfaces.
 * sleep() advances virtual time without wall-clock waiting.
 */
export class ManualClock {
  private currentTimeMs: number;

  constructor(initialTimeMs: number = 1_700_000_000_000) {
    this.currentTimeMs = initialTimeMs;
  }

  nowMs(): number {
    return this.currentTimeMs;
  }

  now(): Date {
    return new Date(this.currentTimeMs);
  }

  advance(ms: number): void {
    this.currentTimeMs += ms;
  }

  async sleep(ms: number): Promise<void> {
    this.currentTimeMs += ms;
  }
}

/**
 * Prepares a test tenant PostgreSQL database with mem0_memories table.
 */
export async function setupTenantMem0Table(
  sqlClient: any,
  tableName: string = "mem0_memories",
  vectorType: string = '"vector(1536)"',
): Promise<void> {
  await sqlClient.unsafe(`
    DO $$ BEGIN
      CREATE DOMAIN "vector(1536)" AS text;
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
  `);

  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "payload" jsonb NOT NULL,
      "vector" ${vectorType} NOT NULL
    );
  `);
}

/**
 * Inserts a test Mem0 memory row into the live collection table.
 */
export async function insertTenantMemoryRow(
  sqlClient: any,
  params: {
    id?: string;
    agentId?: string | null;
    userId?: string | null;
    data?: string | null;
    tableName?: string;
    extraPayload?: Record<string, unknown>;
  },
): Promise<string> {
  const rowId = params.id ?? randomUUID();
  const tableName = params.tableName ?? "mem0_memories";
  const payload = {
    agent_id: params.agentId ?? null,
    user_id: params.userId ?? "company",
    data: params.data ?? "Substantive preference for testing.",
    created_at: new Date().toISOString(),
    ...(params.extraPayload ?? {}),
  };

  await sqlClient.unsafe(
    `INSERT INTO "${tableName}" (id, payload, vector) VALUES ($1::uuid, $2, $3);`,
    [rowId, payload, "mock-vector-data"],
  );

  return rowId;
}

export const MEMORY_FIXTURE_CORPUS = {
  preference: "Operator prefers quarterly budget reviews over monthly ones.",
  decision: "The architecture committee decided to adopt PostgreSQL pgvector for vector storage.",
  lesson: "Deploying schema changes during peak traffic causes transaction lock contention.",
  procedure: "To rotate credentials run pnpm memory:upgrade and inspect the generated report.",
  noiseAck: "ok sounds good thanks!",
  noiseGreeting: "Hello there! Good morning.",
  sensitiveApiKey: "Use secret API key sk-proj-123456789012345678901234567890 for auth.",
  sensitivePassword: "Database credentials password = Sup3rS3cretP@ssword! here.",
};

export function createFakeConversionClient(
  handler?: (text: string) => Partial<ConversionClientResult>,
): ConversionClient {
  return {
    async convert(text: string): Promise<ConversionClientResult> {
      if (handler) {
        const custom = handler(text);
        if (custom.status) {
          const defaultRecords = custom.status === "convert"
            ? [
                {
                  data: `Converted durable fact: ${text}`.slice(0, 100),
                  type: "fact" as const,
                  subject: "test preference",
                  confidence: 0.95,
                },
              ]
            : [];
          return {
            status: custom.status as any,
            records: (custom as any).records ?? defaultRecords,
            reasonCode: (custom as any).reasonCode ?? "",
            rejectCode: (custom as any).rejectCode ?? "",
            inputTokens: custom.inputTokens ?? 650,
            outputTokens: custom.outputTokens ?? 80,
          };
        }
      }
      return {
        status: "convert",
        records: [
          {
            data: `Converted durable fact: ${text}`.slice(0, 100),
            type: "fact",
            subject: "test preference",
            confidence: 0.95,
          },
        ],
        inputTokens: 650,
        outputTokens: 80,
      };
    },
  };
}

export function createFakeEmbeddingClient(vector?: number[]): EmbeddingClient {
  const defaultVector = vector ?? new Array(1536).fill(0.01);
  return {
    async embed(_text: string): Promise<EmbeddingResult> {
      return {
        embedding: defaultVector,
        tokens: 15,
      };
    },
  };
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  parsedBody?: any;
}

export function createRecordingFetch(
  mockResponses: Array<
    | { status?: number; headers?: Record<string, string>; body: any }
    | ((req: RecordedRequest) => { status?: number; headers?: Record<string, string>; body: any })
  >,
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let callIndex = 0;

  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? String(init.body) : "";
    let parsedBody: any;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = undefined;
    }

    const headersRecord: Record<string, string> = {};
    if (init?.headers) {
      if (typeof (init.headers as any).forEach === "function") {
        (init.headers as any).forEach((v: string, k: string) => {
          headersRecord[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headersRecord[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          headersRecord[k.toLowerCase()] = String(v);
        }
      }
    }

    const req: RecordedRequest = { url, method, headers: headersRecord, body, parsedBody };
    requests.push(req);

    const mock = mockResponses[callIndex] ?? mockResponses[mockResponses.length - 1];
    callIndex++;

    const res = typeof mock === "function" ? mock(req) : mock;
    const status = res?.status ?? 200;
    const resHeaders = new Headers(res?.headers ?? { "Content-Type": "application/json" });
    const resBody = typeof res?.body === "string" ? res.body : JSON.stringify(res?.body ?? {});

    return new Response(resBody, {
      status,
      headers: resHeaders,
    });
  };

  return { fetch: fetchFn as typeof fetch, requests };
}

export async function insertCompanyOpenAiSecret(
  db: Db,
  companyId: string,
  key: string = "sk-mock-valid-openai-key-123456789012345678",
  provider: string = "local_encrypted",
): Promise<void> {
  const secretId = randomUUID();
  await db.insert(companySecrets).values({
    id: secretId,
    companyId,
    scope: "company",
    key: "openai_api_key",
    name: "OpenAI API Key",
    provider,
    status: "active",
    latestVersion: 1,
  });

  let material: Record<string, unknown> = { plaintext: key };
  if (provider === "local_encrypted") {
    const { getSecretProvider } = await import("../../server/src/secrets/provider-registry.js");
    const secretProvider = getSecretProvider("local_encrypted");
    const prepared = await secretProvider.createSecret({
      value: key,
      secret: { id: secretId, companyId, key: "openai_api_key", name: "OpenAI API Key" } as any,
    });
    material = prepared.material;
  }

  await db.insert(companySecretVersions).values({
    secretId,
    version: 1,
    material,
    valueSha256: "dummy-sha256",
    fingerprintSha256: "dummy-fingerprint",
    status: "current",
  });
}
