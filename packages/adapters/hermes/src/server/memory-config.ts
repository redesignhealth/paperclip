/**
 * Configuration and validation for tenant-scoped Hermes mem0 memory.
 *
 * Hermes v0.20.0 reads `$HERMES_HOME/mem0.json` directly.
 *
 * Python mem0ai 2.0.10 split-field pgvector config connects directly to `dbname`.
 * It does NOT connect to maintenance `postgres` or issue `CREATE DATABASE`.
 * Split fields only; connection strings are strictly rejected.
 *
 * SENSITIVE: Contains plaintext per-company database and provider credentials.
 * Must NEVER be logged, serialized to persistent storage, or emitted in diagnostic events.
 */

export const SAFE_PG_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
export const SAFE_AGENT_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export const MAX_CONFIG_DEPTH = 8;
export const MAX_CONFIG_KEYS = 100;
export const MAX_CONFIG_STRING_LENGTH = 4096;
export const FORBIDDEN_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface ValidatedHermesMemoryConfig {
  readonly provider: "mem0";
  readonly mode: "oss";
  readonly userId: "company";
  readonly agentId: string;
  readonly llm: {
    readonly provider: "openai" | "ollama";
    readonly config: Readonly<Record<string, unknown>>;
  };
  readonly embedder: {
    readonly provider: "openai" | "ollama";
    readonly config: Readonly<Record<string, unknown>>;
  };
  readonly vectorStore: {
    readonly provider: "pgvector";
    readonly config: {
      readonly host: string;
      readonly port: number;
      readonly user: string;
      readonly password: string;
      readonly dbname: string;
      readonly sslmode: "require";
      readonly collectionName: string;
    };
  };
}

export interface CanonicalMem0Json {
  readonly mode: "oss";
  readonly oss: {
    readonly llm: {
      readonly provider: "openai" | "ollama";
      readonly config: Record<string, unknown>;
    };
    readonly embedder: {
      readonly provider: "openai" | "ollama";
      readonly config: Record<string, unknown>;
    };
    readonly vector_store: {
      readonly provider: "pgvector";
      readonly config: {
        readonly host: string;
        readonly port: number;
        readonly user: string;
        readonly password: string;
        readonly dbname: string;
        readonly sslmode: "require";
        readonly collection_name: string;
      };
    };
  };
  readonly user_id: "company";
  readonly agent_id: string;
}

function assertNoControlChars(val: string, fieldName: string): void {
  if (/[\r\n\0]/.test(val)) {
    throw new Error(`Invalid memory configuration: ${fieldName} contains control characters or newlines`);
  }
}

/**
 * Validates that target is an own-property strict plain object without custom prototype,
 * inherited properties, getters/setters, or forbidden prototype-pollution keys.
 * Inspects property descriptors safely without reading property values through accessors.
 * Fails with generic field names; never logs or includes unvalidated values.
 */
export function assertStrictPlainObject(
  target: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    throw new Error(`Invalid memory configuration: ${fieldName} must be a plain object`);
  }

  const proto = Object.getPrototypeOf(target);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`Invalid memory configuration: ${fieldName} has an invalid prototype`);
  }

  const ownKeys = Reflect.ownKeys(target);
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new Error(`Invalid memory configuration: ${fieldName} contains symbol keys`);
    }

    if (FORBIDDEN_CONFIG_KEYS.has(key)) {
      throw new Error(`Invalid memory configuration: ${fieldName} contains forbidden prototype-pollution key`);
    }

    if (/[\r\n\0]/.test(key)) {
      throw new Error(`Invalid memory configuration: ${fieldName} contains key with control characters or newlines`);
    }

    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (!desc) {
      throw new Error(`Invalid memory configuration: ${fieldName} property descriptor missing`);
    }

    if (desc.get !== undefined || desc.set !== undefined) {
      throw new Error(`Invalid memory configuration: ${fieldName} cannot contain getters or setters`);
    }

    if (!desc.enumerable) {
      throw new Error(`Invalid memory configuration: ${fieldName} cannot contain non-enumerable properties`);
    }
  }

  // Reject inherited properties
  for (const key in target) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      throw new Error(`Invalid memory configuration: ${fieldName} cannot contain inherited properties`);
    }
  }

  return target as Record<string, unknown>;
}

/**
 * Recursively validates and sanitizes plain JSON data for model configs.
 * Rejects functions, symbols, bigint, undefined, non-plain objects, cycles,
 * prototype-pollution keys, excessive depth/size, and control characters in keys/strings.
 * Never includes or logs rejected values in error messages.
 */
function sanitizePlainJsonData(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
  keyCounter: { count: number },
): unknown {
  if (depth > MAX_CONFIG_DEPTH) {
    throw new Error(`Invalid memory configuration: ${path} exceeds maximum depth of ${MAX_CONFIG_DEPTH}`);
  }

  if (value === null) {
    return null;
  }

  const type = typeof value;
  if (type === "string") {
    const str = value as string;
    if (str.length > MAX_CONFIG_STRING_LENGTH) {
      throw new Error(`Invalid memory configuration: ${path} exceeds maximum string length of ${MAX_CONFIG_STRING_LENGTH}`);
    }
    if (/[\r\n\0]/.test(str)) {
      throw new Error(`Invalid memory configuration: ${path} contains control characters or newlines`);
    }
    return str;
  }

  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid memory configuration: ${path} must be a finite number`);
    }
    return value;
  }

  if (type === "boolean") {
    return value;
  }

  if (type === "function" || type === "symbol" || type === "bigint" || type === "undefined") {
    throw new Error(`Invalid memory configuration: ${path} contains disallowed type "${type}"`);
  }

  if (typeof value === "object") {
    if (seen.has(value as object)) {
      throw new Error(`Invalid memory configuration: ${path} contains a circular reference`);
    }
    seen.add(value as object);

    if (Array.isArray(value)) {
      const arr = value as unknown[];
      keyCounter.count += arr.length;
      if (keyCounter.count > MAX_CONFIG_KEYS) {
        throw new Error(`Invalid memory configuration: configuration exceeds maximum complexity limit of ${MAX_CONFIG_KEYS} elements`);
      }
      return arr.map((item, index) =>
        sanitizePlainJsonData(item, `${path}[${index}]`, depth + 1, seen, keyCounter),
      );
    }

    const record = assertStrictPlainObject(value, path);
    const result: Record<string, unknown> = {};
    const keys = Object.keys(record);
    keyCounter.count += keys.length;
    if (keyCounter.count > MAX_CONFIG_KEYS) {
      throw new Error(`Invalid memory configuration: configuration exceeds maximum complexity limit of ${MAX_CONFIG_KEYS} elements`);
    }

    for (const key of keys) {
      result[key] = sanitizePlainJsonData(
        record[key],
        path ? `${path}.${key}` : key,
        depth + 1,
        seen,
        keyCounter,
      );
    }
    return result;
  }

  throw new Error(`Invalid memory configuration: ${path} contains unsupported data`);
}

function validateModelConfig(
  blockName: "llm" | "embedder",
  provider: unknown,
  config: unknown,
): { provider: "openai" | "ollama"; config: Record<string, unknown> } {
  if (provider !== "openai" && provider !== "ollama") {
    throw new Error(`Invalid memory configuration: ${blockName}.provider must be "openai" or "ollama"`);
  }

  const plainCfg = assertStrictPlainObject(config, `${blockName}.config`);

  const sanitized = sanitizePlainJsonData(
    plainCfg,
    `${blockName}.config`,
    0,
    new Set<object>(),
    { count: 0 },
  ) as Record<string, unknown>;

  if (typeof sanitized.model !== "string" || sanitized.model.trim().length === 0) {
    throw new Error(`Invalid memory configuration: ${blockName}.config.model must be a non-empty string`);
  }

  return {
    provider,
    config: sanitized,
  };
}

/**
 * Validates untrusted or unknown memory input fail-closed.
 *
 * Enforces:
 * - provider: "mem0"
 * - mode: "oss"
 * - userId / user_id: strictly "company", rejects conflicting camel/snake values
 * - agentId / agent_id: safe identifier without controls, rejects conflicting camel/snake values
 * - llm and embedder blocks: providers "openai" | "ollama", non-empty model, recursive plain-JSON safe
 * - vectorStore / vector_store: provider "pgvector", split fields only, rejects conflicting camel/snake values
 * - host, user, password, dbname, collectionName: non-empty, no control chars
 * - port: integer 1..65535
 * - sslmode: strictly "require"
 * - dbname, user, collectionName: match safe PostgreSQL identifier regex
 * - rejection of connection_string or unknown vector store options
 * - strict plain-object checks across all object boundaries
 */
export function validateHermesMemoryConfig(input: unknown): ValidatedHermesMemoryConfig {
  const raw = assertStrictPlainObject(input, "root configuration");

  // Allowed top-level fields
  const allowedTopLevel = new Set([
    "provider",
    "mode",
    "userId",
    "user_id",
    "agentId",
    "agent_id",
    "llm",
    "embedder",
    "vectorStore",
    "vector_store",
  ]);

  for (const key of Object.keys(raw)) {
    if (!allowedTopLevel.has(key)) {
      throw new Error(`Invalid memory configuration: unrecognized key "${key}"`);
    }
  }

  if (raw.provider !== "mem0") {
    throw new Error('Invalid memory configuration: provider must be "mem0"');
  }

  if (raw.mode !== "oss") {
    throw new Error('Invalid memory configuration: mode must be "oss"');
  }

  // Detect conflicting camel/snake aliases
  if (raw.userId !== undefined && raw.user_id !== undefined && raw.userId !== raw.user_id) {
    throw new Error("Invalid memory configuration: conflicting userId and user_id values provided");
  }
  const userId = raw.userId ?? raw.user_id;
  if (userId !== "company") {
    throw new Error('Invalid memory configuration: userId must be "company"');
  }

  if (raw.agentId !== undefined && raw.agent_id !== undefined && raw.agentId !== raw.agent_id) {
    throw new Error("Invalid memory configuration: conflicting agentId and agent_id values provided");
  }
  const agentId = raw.agentId ?? raw.agent_id;
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_REGEX.test(agentId)) {
    throw new Error("Invalid memory configuration: agentId must be a non-empty safe identifier without control characters");
  }

  // LLM block
  const rawLlm = assertStrictPlainObject(raw.llm, "llm");
  const validatedLlm = validateModelConfig("llm", rawLlm.provider, rawLlm.config);

  // Embedder block
  const rawEmbedder = assertStrictPlainObject(raw.embedder, "embedder");
  const validatedEmbedder = validateModelConfig("embedder", rawEmbedder.provider, rawEmbedder.config);

  // Vector store block: safe normalized structural handling without JSON.stringify or getter execution
  if (raw.vectorStore === undefined && raw.vector_store === undefined) {
    throw new Error("Invalid memory configuration: vectorStore must be a plain object");
  }

  let validatedVectorStore: {
    provider: "pgvector";
    config: {
      host: string;
      port: number;
      user: string;
      password: string;
      dbname: string;
      sslmode: "require";
      collectionName: string;
    };
  };

  if (raw.vectorStore !== undefined && raw.vector_store !== undefined) {
    const v1 = validateVectorStoreBlock(raw.vectorStore, "vectorStore");
    const v2 = validateVectorStoreBlock(raw.vector_store, "vector_store");
    if (
      v1.provider !== v2.provider ||
      v1.config.host !== v2.config.host ||
      v1.config.port !== v2.config.port ||
      v1.config.user !== v2.config.user ||
      v1.config.password !== v2.config.password ||
      v1.config.dbname !== v2.config.dbname ||
      v1.config.sslmode !== v2.config.sslmode ||
      v1.config.collectionName !== v2.config.collectionName
    ) {
      throw new Error("Invalid memory configuration: conflicting vectorStore and vector_store configurations provided");
    }
    validatedVectorStore = v1;
  } else if (raw.vectorStore !== undefined) {
    validatedVectorStore = validateVectorStoreBlock(raw.vectorStore, "vectorStore");
  } else {
    validatedVectorStore = validateVectorStoreBlock(raw.vector_store, "vector_store");
  }

  return {
    provider: "mem0",
    mode: "oss",
    userId: "company",
    agentId,
    llm: validatedLlm,
    embedder: validatedEmbedder,
    vectorStore: validatedVectorStore,
  };
}

function validateVectorStoreBlock(
  rawVector: unknown,
  fieldName: string,
): {
  provider: "pgvector";
  config: {
    host: string;
    port: number;
    user: string;
    password: string;
    dbname: string;
    sslmode: "require";
    collectionName: string;
  };
} {
  const vectorObj = assertStrictPlainObject(rawVector, fieldName);

  if (vectorObj.provider !== "pgvector") {
    throw new Error('Invalid memory configuration: vector_store.provider must be "pgvector"');
  }

  const vecCfg = assertStrictPlainObject(vectorObj.config, `${fieldName}.config`);

  // Check for forbidden connection_string
  if ("connection_string" in vecCfg || "connectionString" in vecCfg) {
    throw new Error("Invalid memory configuration: vector_store.config cannot contain connection_string; split fields must be used");
  }

  const allowedVecCfgKeys = new Set([
    "host",
    "port",
    "user",
    "password",
    "dbname",
    "sslmode",
    "collectionName",
    "collection_name",
  ]);

  for (const key of Object.keys(vecCfg)) {
    if (!allowedVecCfgKeys.has(key)) {
      throw new Error(`Invalid memory configuration: unrecognized vector_store.config key "${key}"`);
    }
  }

  // host
  const host = vecCfg.host;
  if (typeof host !== "string" || host.trim().length === 0) {
    throw new Error("Invalid memory configuration: vector_store.config.host must be a non-empty string");
  }
  if (/[\s\r\n\0]/.test(host)) {
    throw new Error("Invalid memory configuration: vector_store.config.host contains whitespace or control characters");
  }

  // port
  const port = vecCfg.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid memory configuration: vector_store.config.port must be an integer between 1 and 65535");
  }

  // user
  const user = vecCfg.user;
  if (typeof user !== "string" || !SAFE_PG_IDENTIFIER_REGEX.test(user)) {
    throw new Error("Invalid memory configuration: vector_store.config.user must be a safe PostgreSQL identifier matching ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$");
  }

  // password
  const password = vecCfg.password;
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Invalid memory configuration: vector_store.config.password must be a non-empty string");
  }
  assertNoControlChars(password, "vector_store.config.password");

  // dbname
  const dbname = vecCfg.dbname;
  if (typeof dbname !== "string" || !SAFE_PG_IDENTIFIER_REGEX.test(dbname)) {
    throw new Error("Invalid memory configuration: vector_store.config.dbname must be a safe PostgreSQL identifier matching ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$");
  }

  // sslmode
  const sslmode = vecCfg.sslmode;
  if (sslmode !== "require") {
    throw new Error('Invalid memory configuration: vector_store.config.sslmode must be "require"');
  }

  // collectionName
  if (
    vecCfg.collectionName !== undefined &&
    vecCfg.collection_name !== undefined &&
    vecCfg.collectionName !== vecCfg.collection_name
  ) {
    throw new Error("Invalid memory configuration: conflicting collectionName and collection_name values provided");
  }
  const collectionName = vecCfg.collectionName ?? vecCfg.collection_name;
  if (typeof collectionName !== "string" || !SAFE_PG_IDENTIFIER_REGEX.test(collectionName)) {
    throw new Error("Invalid memory configuration: vector_store.config.collectionName must be a safe PostgreSQL identifier matching ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$");
  }

  return {
    provider: "pgvector",
    config: {
      host,
      port,
      user,
      password,
      dbname,
      sslmode: "require",
      collectionName,
    },
  };
}

/**
 * Builds the canonical mem0 JSON object with deterministic key ordering.
 */
export function buildCanonicalMem0Object(config: ValidatedHermesMemoryConfig): CanonicalMem0Json {
  const sortKeys = (obj: Record<string, unknown>): Record<string, unknown> => {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = obj[key];
    }
    return sorted;
  };

  return {
    mode: "oss",
    oss: {
      llm: {
        provider: config.llm.provider,
        config: sortKeys(config.llm.config as Record<string, unknown>),
      },
      embedder: {
        provider: config.embedder.provider,
        config: sortKeys(config.embedder.config as Record<string, unknown>),
      },
      vector_store: {
        provider: "pgvector",
        config: {
          host: config.vectorStore.config.host,
          port: config.vectorStore.config.port,
          user: config.vectorStore.config.user,
          password: config.vectorStore.config.password,
          dbname: config.vectorStore.config.dbname,
          sslmode: "require",
          collection_name: config.vectorStore.config.collectionName,
        },
      },
    },
    user_id: "company",
    agent_id: config.agentId,
  };
}

/**
 * Serializes the validated configuration deterministically to JSON format.
 */
export function serializeMem0Json(config: ValidatedHermesMemoryConfig): string {
  const canonical = buildCanonicalMem0Object(config);
  return JSON.stringify(canonical, null, 2) + "\n";
}

/**
 * Generates the separate Hermes config.yaml memory block.
 * Notice: host config inheritance must not widen ALLOWED_HOST_CONFIG_KEYS.
 */
export function generateHermesMemoryYaml(): string {
  return "memory:\n  provider: mem0\n";
}

export const MIN_SECRET_REDACTION_LENGTH = 4;
export const REDACTION_MARKER = "***REDACTED***";
export const MAX_UNTERMINATED_LINE_BUFFER = 64 * 1024;

/**
 * Extracts sensitive credential strings from the validated memory config for scrubbing/redaction.
 * Redacts TRUE secrets: database password and provider credentials (API keys, tokens, secrets).
 * Does NOT redact non-secret database identifiers (user, dbname, collectionName, host) to prevent
 * broad substring replacement from corrupting structured JSON output or diagnostic logs.
 * Avoids infinite/empty replacements, requires minimum length, dedupes, and sorts longest first.
 */
export function extractMemorySensitiveValues(config: ValidatedHermesMemoryConfig): string[] {
  const values = new Set<string>();

  const addSensitive = (val: unknown) => {
    if (typeof val === "string" && val.length >= MIN_SECRET_REDACTION_LENGTH) {
      values.add(val);
    }
  };

  // Database password is the only secret in vectorStore.config:
  addSensitive(config.vectorStore.config.password);

  // Credentials / provider secrets in llm and embedder blocks:
  const collectCredentialsFromConfig = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        collectCredentialsFromConfig(item);
      }
      return;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (/key|secret|token|password|auth|credential/i.test(k) && typeof v === "string") {
        addSensitive(v);
      } else if (typeof v === "object" && v !== null) {
        collectCredentialsFromConfig(v);
      }
    }
  };
  collectCredentialsFromConfig(config.llm.config);
  collectCredentialsFromConfig(config.embedder.config);

  return Array.from(values).sort((a, b) => b.length - a.length);
}

export interface StreamingRedactor {
  process(stream: "stdout" | "stderr", chunk: string): string[];
  flush(): Array<{ stream: "stdout" | "stderr"; chunk: string }>;
}

/**
 * Creates a chunk-aware streaming redactor that holds a suffix between chunks
 * to detect secrets spanning chunk boundaries, emits safe portions, and flushes at end.
 *
 * Line/chunk handling: Complete lines (terminated by \n) are emitted line-by-line so
 * downstream consumers (such as emitLogChunk) receive anchored lines for proper
 * classification (e.g. distinguishing benign INFO/MCP stderr logs from errors).
 * Replacement markers (***REDACTED***) are never split across chunks.
 * Output flushes preserve stdout/stderr tail chronology based on arrival order.
 */
export function createChunkAwareStreamingRedactor(
  sensitiveValues: readonly string[],
): StreamingRedactor {
  const cleanedSecrets = Array.from(
    new Set(
      sensitiveValues.filter(
        (s): s is string => typeof s === "string" && s.length >= MIN_SECRET_REDACTION_LENGTH,
      ),
    ),
  ).sort((a, b) => b.length - a.length);

  const maxSecretLen = cleanedSecrets.length > 0 ? cleanedSecrets[0].length : 0;
  const keepLen = maxSecretLen > 1 ? maxSecretLen - 1 : 0;

  const buffers: Record<"stdout" | "stderr", string> = {
    stdout: "",
    stderr: "",
  };

  // Monotonic sequence counter to preserve tail chronology across streams
  let sequenceCounter = 0;
  const lastUpdated: Record<"stdout" | "stderr", number> = {
    stdout: 0,
    stderr: 0,
  };

  const redactString = (input: string): string => {
    let result = input;
    for (const secret of cleanedSecrets) {
      if (result.includes(secret)) {
        result = result.replaceAll(secret, REDACTION_MARKER);
      }
    }
    return result;
  };

  return {
    process(stream: "stdout" | "stderr", chunk: string): string[] {
      if (!chunk) return [];

      lastUpdated[stream] = ++sequenceCounter;
      buffers[stream] += chunk;

      const emitted: string[] = [];
      const buf = buffers[stream];
      const lastNewlineIdx = buf.lastIndexOf("\n");

      if (lastNewlineIdx !== -1) {
        // We have at least one complete line ending with \n.
        // Secrets do not span across newlines (\r\n\0 are forbidden in secrets),
        // so complete lines contain complete secrets and are safe to redact.
        const completeLines = buf.slice(0, lastNewlineIdx + 1);
        buffers[stream] = buf.slice(lastNewlineIdx + 1);

        // Split into individual line chunks so downstream consumers (like emitLogChunk)
        // receive discrete lines with intact line starts for anchored classification.
        const lines = completeLines.match(/[^\r\n]*\r?\n/g);
        if (lines) {
          for (const line of lines) {
            emitted.push(redactString(line));
          }
        } else {
          emitted.push(redactString(completeLines));
        }
      } else if (buf.length > MAX_UNTERMINATED_LINE_BUFFER) {
        // Safety cap for extremely long lines without a newline.
        // We must hold back keepLen characters at the tail for secret boundary detection,
        // but ensure we never split a REDACTION_MARKER.
        const redacted = redactString(buf);
        let safeCut = Math.max(0, redacted.length - keepLen);

        // Ensure safeCut does not fall inside REDACTION_MARKER
        const marker = REDACTION_MARKER;
        for (let i = Math.max(0, safeCut - marker.length + 1); i < safeCut; i++) {
          if (redacted.startsWith(marker, i) && i + marker.length > safeCut) {
            // safeCut falls inside this marker: cut BEFORE the marker
            safeCut = i;
            break;
          }
        }

        if (safeCut > 0) {
          emitted.push(redacted.slice(0, safeCut));
          buffers[stream] = redacted.slice(safeCut);
        }
      }

      return emitted;
    },

    flush(): Array<{ stream: "stdout" | "stderr"; chunk: string }> {
      const results: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

      // Sort streams by lastUpdated arrival order to preserve stdout/stderr tail chronology
      const activeStreams = (["stdout", "stderr"] as const)
        .filter((s) => buffers[s].length > 0)
        .sort((a, b) => lastUpdated[a] - lastUpdated[b]);

      for (const stream of activeStreams) {
        if (buffers[stream].length > 0) {
          const finalChunk = redactString(buffers[stream]);
          buffers[stream] = "";
          if (finalChunk.length > 0) {
            results.push({ stream, chunk: finalChunk });
          }
        }
      }
      return results;
    },
  };
}
