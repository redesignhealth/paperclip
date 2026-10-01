import { describe, expect, it } from "vitest";

import {
  validateHermesMemoryConfig,
  serializeMem0Json,
  buildCanonicalMem0Object,
  generateHermesMemoryYaml,
  extractMemorySensitiveValues,
  assertStrictPlainObject,
  createChunkAwareStreamingRedactor,
  redactSensitiveString,
  canSafelyRedactSecret,
  isCredentialKey,
  SAFE_PG_IDENTIFIER_REGEX,
  SAFE_AGENT_ID_REGEX,
  FORBIDDEN_CONFIG_KEYS,
  MIN_SECRET_REDACTION_LENGTH,
  REDACTION_MARKER,
  MAX_UNTERMINATED_LINE_BUFFER,
  MAX_CONFIG_STRING_LENGTH,
} from "./memory-config.js";

describe("memory-config", () => {
  const validMemoryInput = {
    provider: "mem0",
    mode: "oss",
    userId: "company",
    agentId: "agent_42_worker",
    llm: {
      provider: "openai",
      config: {
        model: "gpt-5.4-mini",
        temperature: 0.1,
        api_key: "sk-openai-secret-key-12345",
      },
    },
    embedder: {
      provider: "openai",
      config: {
        model: "text-embedding-3-small",
      },
    },
    vectorStore: {
      provider: "pgvector",
      config: {
        host: "pg.tenant-internal.net",
        port: 5432,
        user: "tenant_user_1",
        password: "super_secret_pg_password_987",
        dbname: "tenant_db_1",
        sslmode: "require",
        collectionName: "mem0_memories",
      },
    },
  };

  describe("validateHermesMemoryConfig", () => {
    it("validates a compliant memory configuration successfully", () => {
      const validated = validateHermesMemoryConfig(validMemoryInput);
      expect(validated.provider).toBe("mem0");
      expect(validated.mode).toBe("oss");
      expect(validated.userId).toBe("company");
      expect(validated.agentId).toBe("agent_42_worker");
      expect(validated.llm.provider).toBe("openai");
      expect(validated.llm.config.model).toBe("gpt-5.4-mini");
      expect(validated.embedder.provider).toBe("openai");
      expect(validated.vectorStore.provider).toBe("pgvector");
      expect(validated.vectorStore.config.host).toBe("pg.tenant-internal.net");
      expect(validated.vectorStore.config.port).toBe(5432);
      expect(validated.vectorStore.config.sslmode).toBe("require");
      expect(validated.vectorStore.config.collectionName).toBe("mem0_memories");
    });

    it("accepts snake_case property variations from wire/JSON payloads", () => {
      const snakeInput = {
        provider: "mem0",
        mode: "oss",
        user_id: "company",
        agent_id: "agent-uuid-1234-5678",
        llm: {
          provider: "ollama",
          config: { model: "llama3" },
        },
        embedder: {
          provider: "ollama",
          config: { model: "nomic-embed-text" },
        },
        vector_store: {
          provider: "pgvector",
          config: {
            host: "10.0.1.5",
            port: 5433,
            user: "hermes_user",
            password: "mypassword123",
            dbname: "hermes_db",
            sslmode: "require",
            collection_name: "hermes_coll",
          },
        },
      };

      const validated = validateHermesMemoryConfig(snakeInput);
      expect(validated.userId).toBe("company");
      expect(validated.agentId).toBe("agent-uuid-1234-5678");
      expect(validated.vectorStore.config.collectionName).toBe("hermes_coll");
      expect(validated.vectorStore.config.port).toBe(5433);
    });

    it("fails closed on non-object inputs", () => {
      expect(() => validateHermesMemoryConfig(null)).toThrow("must be a plain object");
      expect(() => validateHermesMemoryConfig(undefined)).toThrow("must be a plain object");
      expect(() => validateHermesMemoryConfig("invalid")).toThrow("must be a plain object");
      expect(() => validateHermesMemoryConfig([])).toThrow("must be a plain object");
    });

    it("fails closed on unrecognized top-level keys", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          extraField: "unexpected",
        }),
      ).toThrow('unrecognized key "extraField"');
    });

    it("fails closed on non-mem0 provider or non-oss mode", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          provider: "chroma",
        }),
      ).toThrow('provider must be "mem0"');

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          mode: "cloud",
        }),
      ).toThrow('mode must be "oss"');
    });

    it("requires userId to be exactly 'company'", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          userId: "user_123",
        }),
      ).toThrow('userId must be "company"');

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          userId: undefined,
          user_id: undefined,
        }),
      ).toThrow('userId must be "company"');
    });

    it("validates agentId against safe identifier constraints and rejects control characters", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          agentId: "",
        }),
      ).toThrow("agentId must be a non-empty safe identifier");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          agentId: "agent; DROP TABLE memories;--",
        }),
      ).toThrow("agentId must be a non-empty safe identifier");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          agentId: "agent\nnewline",
        }),
      ).toThrow("agentId must be a non-empty safe identifier");
    });

    it("rejects unauthorized LLM and embedder providers", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          llm: {
            provider: "anthropic",
            config: { model: "claude-3-haiku" },
          },
        }),
      ).toThrow('llm.provider must be "openai" or "ollama"');

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          embedder: {
            provider: "cohere",
            config: { model: "embed-english-v3.0" },
          },
        }),
      ).toThrow('embedder.provider must be "openai" or "ollama"');
    });

    it("rejects empty or missing model in LLM or embedder config", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          llm: {
            provider: "openai",
            config: { model: "" },
          },
        }),
      ).toThrow("llm.config.model must be a non-empty string");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          embedder: {
            provider: "openai",
            config: {},
          },
        }),
      ).toThrow("embedder.config.model must be a non-empty string");
    });

    it("rejects control characters or CRLF in model config strings", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          llm: {
            provider: "openai",
            config: { model: "gpt-5.4\r\nmalicious: header" },
          },
        }),
      ).toThrow("contains control characters or newlines");
    });

    it("strictly forbids connection_string in vector_store configuration", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: {
              ...validMemoryInput.vectorStore.config,
              connection_string: "postgresql://user:pass@host/db",
            },
          },
        }),
      ).toThrow("cannot contain connection_string; split fields must be used");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: {
              ...validMemoryInput.vectorStore.config,
              connectionString: "postgresql://user:pass@host/db",
            },
          },
        }),
      ).toThrow("cannot contain connection_string; split fields must be used");
    });

    it("rejects invalid vectorStore providers", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "qdrant",
            config: validMemoryInput.vectorStore.config,
          },
        }),
      ).toThrow('vector_store.provider must be "pgvector"');
    });

    it("validates host constraints", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, host: "" },
          },
        }),
      ).toThrow("vector_store.config.host must be a non-empty string");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, host: "host with space" },
          },
        }),
      ).toThrow("vector_store.config.host contains whitespace or control characters");
    });

    it("validates port range 1..65535", () => {
      for (const badPort of [0, 65536, -5, 5432.5, "5432"]) {
        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            vectorStore: {
              provider: "pgvector",
              config: { ...validMemoryInput.vectorStore.config, port: badPort },
            },
          }),
        ).toThrow("vector_store.config.port must be an integer between 1 and 65535");
      }
    });

    it("validates database and user identifiers against safe allowlist regex", () => {
      // Valid identifiers
      expect(SAFE_PG_IDENTIFIER_REGEX.test("valid_db")).toBe(true);
      expect(SAFE_PG_IDENTIFIER_REGEX.test("_internal")).toBe(true);
      expect(SAFE_PG_IDENTIFIER_REGEX.test("db123")).toBe(true);

      // Invalid identifiers (hyphens, spaces, special chars, SQL injection)
      expect(SAFE_PG_IDENTIFIER_REGEX.test("db-with-hyphen")).toBe(false);
      expect(SAFE_PG_IDENTIFIER_REGEX.test("db; DROP TABLE")).toBe(false);
      expect(SAFE_PG_IDENTIFIER_REGEX.test("123startswithnum")).toBe(false);
      expect(SAFE_PG_IDENTIFIER_REGEX.test("user' OR '1'='1")).toBe(false);

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, user: "bad-user-name" },
          },
        }),
      ).toThrow("safe PostgreSQL identifier");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, dbname: "db;DROP" },
          },
        }),
      ).toThrow("safe PostgreSQL identifier");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, collectionName: "col-hyphen" },
          },
        }),
      ).toThrow("safe PostgreSQL identifier");
    });

    it("requires sslmode to be strictly 'require'", () => {
      for (const badSsl of ["disable", "prefer", "allow", "verify-ca", "verify-full", ""]) {
        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            vectorStore: {
              provider: "pgvector",
              config: { ...validMemoryInput.vectorStore.config, sslmode: badSsl },
            },
          }),
        ).toThrow('vector_store.config.sslmode must be "require"');
      }
    });

    it("rejects missing vector_store with exact error message", () => {
      const withoutVector: Record<string, unknown> = { ...validMemoryInput };
      delete withoutVector.vectorStore;
      delete withoutVector.vector_store;
      expect(() => validateHermesMemoryConfig(withoutVector)).toThrow(
        "Invalid memory configuration: vector_store must be a plain object",
      );
    });

    it("rejects empty password or passwords shorter than MIN_SECRET_REDACTION_LENGTH", () => {
      for (const badPassword of ["", "a", "pw", "pw!"]) {
        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            vectorStore: {
              provider: "pgvector",
              config: { ...validMemoryInput.vectorStore.config, password: badPassword },
            },
          }),
        ).toThrow(`vector_store.config.password must be at least ${MIN_SECRET_REDACTION_LENGTH} characters`);
      }

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, password: "pass\nword" },
          },
        }),
      ).toThrow("vector_store.config.password contains control characters or newlines");

      // Password exceeding MAX_CONFIG_STRING_LENGTH
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, password: "p".repeat(MAX_CONFIG_STRING_LENGTH + 1) },
          },
        }),
      ).toThrow(`vector_store.config.password exceeds maximum string length of ${MAX_CONFIG_STRING_LENGTH}`);

      // Password exactly MAX_CONFIG_STRING_LENGTH
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, password: "p".repeat(MAX_CONFIG_STRING_LENGTH) },
          },
        }),
      ).not.toThrow();

      // Host exceeding MAX_CONFIG_STRING_LENGTH
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, host: "h".repeat(MAX_CONFIG_STRING_LENGTH + 1) },
          },
        }),
      ).toThrow(`vector_store.config.host exceeds maximum string length of ${MAX_CONFIG_STRING_LENGTH}`);

      // Host exactly MAX_CONFIG_STRING_LENGTH
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, host: "h".repeat(MAX_CONFIG_STRING_LENGTH) },
          },
        }),
      ).not.toThrow();
    });

    it("fails closed on conflicting camelCase and snake_case aliases", () => {
      // Conflicting userId / user_id
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          userId: "company",
          user_id: "other_company",
        }),
      ).toThrow("conflicting userId and user_id values provided");

      // Conflicting agentId / agent_id
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          agentId: "agent-1",
          agent_id: "agent-2",
        }),
      ).toThrow("conflicting agentId and agent_id values provided");

      // Conflicting vectorStore / vector_store
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: validMemoryInput.vectorStore,
          vector_store: {
            provider: "pgvector",
            config: {
              ...validMemoryInput.vectorStore.config,
              dbname: "different_db",
            },
          },
        }),
      ).toThrow("conflicting vectorStore and vector_store configurations provided");

      // Conflicting collectionName / collection_name
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: {
              ...validMemoryInput.vectorStore.config,
              collectionName: "coll_a",
              collection_name: "coll_b",
            },
          },
        }),
      ).toThrow("conflicting collectionName and collection_name values provided");
    });

    describe("recursive model config plain JSON validation", () => {
      it("preserves valid nested plain data (nested objects, arrays, numbers, booleans, null)", () => {
        const validated = validateHermesMemoryConfig({
          ...validMemoryInput,
          llm: {
            provider: "openai",
            config: {
              model: "gpt-5.4",
              temperature: 0.7,
              seed: 42,
              enabled: true,
              emptyValue: null,
              nestedParams: {
                stop: ["END", "STOP"],
                frequency_penalty: 0.5,
              },
            },
          },
        });

        expect(validated.llm.config).toEqual({
          model: "gpt-5.4",
          temperature: 0.7,
          seed: 42,
          enabled: true,
          emptyValue: null,
          nestedParams: {
            stop: ["END", "STOP"],
            frequency_penalty: 0.5,
          },
        });
      });

      it("rejects functions in config without echoing rejected values", () => {
        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: {
                model: "gpt-5.4",
                fn: () => "secret_code",
              },
            },
          }),
        ).toThrow('disallowed type "function"');
      });

      it("rejects symbols, bigint, and undefined in config", () => {
        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: {
                model: "gpt-5.4",
                sym: Symbol("secret"),
              },
            },
          }),
        ).toThrow('disallowed type "symbol"');

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: {
                model: "gpt-5.4",
                big: BigInt(12345),
              },
            },
          }),
        ).toThrow('disallowed type "bigint"');

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: {
                model: "gpt-5.4",
                und: undefined,
              },
            },
          }),
        ).toThrow('disallowed type "undefined"');
      });

      it("rejects non-plain objects such as Date or RegExp instances", () => {
        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: {
                model: "gpt-5.4",
                created: new Date(),
              },
            },
          }),
        ).toThrow("has an invalid prototype");
      });

      it("rejects prototype pollution keys (__proto__, constructor, prototype)", () => {
        const maliciousConfig = JSON.parse('{"model":"gpt-5.4","__proto__":{"polluted":true}}');
        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: maliciousConfig,
            },
          }),
        ).toThrow("forbidden prototype-pollution key");

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: {
                model: "gpt-5.4",
                constructor: { malicious: true },
              },
            },
          }),
        ).toThrow("forbidden prototype-pollution key");

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: {
                model: "gpt-5.4",
                prototype: { malicious: true },
              },
            },
          }),
        ).toThrow("forbidden prototype-pollution key");
      });

      it("rejects circular references", () => {
        const circularObj: Record<string, unknown> = { model: "gpt-5.4" };
        circularObj.self = circularObj;

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: circularObj,
            },
          }),
        ).toThrow("circular reference");
      });

      it("rejects control characters in nested keys and nested string values", () => {
        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: {
                model: "gpt-5.4",
                "nested\nkey": "value",
              },
            },
          }),
        ).toThrow("contains key with control characters or newlines");

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: {
                model: "gpt-5.4",
                nested: {
                  value: "bad\0string",
                },
              },
            },
          }),
        ).toThrow("contains control characters or newlines");
      });

      it("rejects excessive recursion depth", () => {
        let deep: any = { model: "gpt-5.4" };
        let curr = deep;
        for (let i = 0; i < 12; i++) {
          curr.inner = {};
          curr = curr.inner;
        }

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: {
              provider: "openai",
              config: deep,
            },
          }),
        ).toThrow("exceeds maximum depth");
      });
    });
  });

  describe("buildCanonicalMem0Object & serializeMem0Json", () => {
    it("produces the canonical mem0 JSON shape with snake_case and deterministic key ordering", () => {
      const validated = validateHermesMemoryConfig(validMemoryInput);
      const canonical = buildCanonicalMem0Object(validated);

      expect(canonical).toEqual({
        mode: "oss",
        oss: {
          llm: {
            provider: "openai",
            config: {
              api_key: "sk-openai-secret-key-12345",
              model: "gpt-5.4-mini",
              temperature: 0.1,
            },
          },
          embedder: {
            provider: "openai",
            config: {
              model: "text-embedding-3-small",
            },
          },
          vector_store: {
            provider: "pgvector",
            config: {
              host: "pg.tenant-internal.net",
              port: 5432,
              user: "tenant_user_1",
              password: "super_secret_pg_password_987",
              dbname: "tenant_db_1",
              sslmode: "require",
              collection_name: "mem0_memories",
            },
          },
        },
        user_id: "company",
        agent_id: "agent_42_worker",
      });

      const serialized = serializeMem0Json(validated);
      expect(serialized).toContain('"mode": "oss"');
      expect(serialized).toContain('"vector_store": {');
      expect(serialized).toContain('"collection_name": "mem0_memories"');
      expect(serialized).toContain('"user_id": "company"');
      expect(serialized).toContain('"agent_id": "agent_42_worker"');
      expect(serialized.endsWith("\n")).toBe(true);

      // Test parsing back
      const reparsed = JSON.parse(serialized);
      expect(reparsed).toEqual(canonical);
    });
  });

  describe("generateHermesMemoryYaml", () => {
    it("emits the separate Hermes config.yaml memory block", () => {
      const yaml = generateHermesMemoryYaml();
      expect(yaml).toBe("memory:\n  provider: mem0\n");
    });
  });

  describe("extractMemorySensitiveValues", () => {
    it("extracts database password and API keys for scrubbing without redacting user/dbname/collectionName/host", () => {
      const validated = validateHermesMemoryConfig(validMemoryInput);
      const sensitive = extractMemorySensitiveValues(validated);

      expect(sensitive).toContain("super_secret_pg_password_987");
      expect(sensitive).toContain("sk-openai-secret-key-12345");

      // Verify DB identifiers, host, and safe sentinels are not in sensitive list
      expect(sensitive).not.toContain("tenant_user_1");
      expect(sensitive).not.toContain("tenant_db_1");
      expect(sensitive).not.toContain("mem0_memories");
      expect(sensitive).not.toContain("pg.tenant-internal.net");
      expect(sensitive).not.toContain("company");
      expect(sensitive).not.toContain("require");
      expect(sensitive).not.toContain("pgvector");
      expect(sensitive).not.toContain("openai");
    });

    it("does not redact short user/dbname/collectionName and prevents structured output corruption", () => {
      const shortSecretsConfig = validateHermesMemoryConfig({
        ...validMemoryInput,
        llm: {
          provider: "openai",
          config: {
            model: "gpt-5.4",
            api_key: "sk-openai-secret-key-real-12345",
          },
        },
        vectorStore: {
          provider: "pgvector",
          config: {
            host: "db.co", // length 5
            user: "usr", // length 3
            password: "super_secret_pg_password_987", // length 27
            dbname: "d_1", // length 3
            sslmode: "require",
            collectionName: "col", // length 3
            port: 5432,
          },
        },
      });

      const sensitive = extractMemorySensitiveValues(shortSecretsConfig);

      // Real secrets MUST be present
      expect(sensitive).toContain("super_secret_pg_password_987");
      expect(sensitive).toContain("sk-openai-secret-key-real-12345");

      // DB identifiers and host MUST NOT be present
      expect(sensitive).not.toContain("usr");
      expect(sensitive).not.toContain("d_1");
      expect(sensitive).not.toContain("col");
      expect(sensitive).not.toContain("db.co");

      // Verify structured JSON output containing user, dbname, collectionName is NOT corrupted
      const structuredJson = JSON.stringify({
        status: "success",
        user: "usr",
        dbname: "d_1",
        collection: "col",
        script: "/usr/bin/python",
        protocol: "mem0",
        column: "col_a",
        secret: "super_secret_pg_password_987",
      });
      const redactor = createChunkAwareStreamingRedactor(sensitive);
      const chunks = redactor.process("stdout", structuredJson + "\n");
      chunks.push(...redactor.flush().map((f) => f.chunk));
      const result = chunks.join("");

      expect(result).not.toContain("super_secret_pg_password_987");
      expect(result).toContain("***REDACTED***");
      expect(result).toContain('"user":"usr"');
      expect(result).toContain('"dbname":"d_1"');
      expect(result).toContain('"collection":"col"');
      expect(result).toContain("/usr/bin/python");
      expect(result).toContain('"protocol":"mem0"');
      expect(result).toContain('"column":"col_a"');

      // Verify sorted longest first
      for (let i = 0; i < sensitive.length - 1; i++) {
        expect(sensitive[i].length).toBeGreaterThanOrEqual(sensitive[i + 1].length);
      }
    });

    it("includes short credentials (length 1..3) in sensitive values for boundary redaction", () => {
      const configWithShortValues = validateHermesMemoryConfig({
        ...validMemoryInput,
        llm: {
          provider: "openai",
          config: {
            model: "gpt-5.4",
            api_key: "k9", // short 2-char API key
          },
        },
        vectorStore: {
          provider: "pgvector",
          config: {
            host: "db.internal.net",
            user: "valid_user",
            password: "valid_secret_pass",
            dbname: "valid_db",
            sslmode: "require",
            collectionName: "valid_col",
            port: 5432,
          },
        },
      });

      const sensitive = extractMemorySensitiveValues(configWithShortValues);
      expect(sensitive).toContain("k9");
      expect(sensitive).toContain("valid_secret_pass");
    });

      it("allows standard numeric and boolean config fields like max_tokens, auth_timeout, oauth_enabled without false positives", () => {
        const configWithStandardFields = {
          ...validMemoryInput,
          llm: {
            provider: "openai",
            config: {
              model: "gpt-5.4",
              api_key: "valid_secret_key_123",
              max_tokens: 2000,
              max_completion_tokens: 1000,
              num_tokens: 500,
              auth_timeout: 30,
              oauth_enabled: true,
            },
          },
          embedder: {
            provider: "openai",
            config: {
              model: "text-embedding-3-small",
              api_key: "valid_embed_key_456",
              tokens_limit: 4096,
            },
          },
        };

        const validated = validateHermesMemoryConfig(configWithStandardFields);
        expect(validated.llm.config.max_tokens).toBe(2000);
        expect(validated.llm.config.auth_timeout).toBe(30);
        expect(validated.llm.config.oauth_enabled).toBe(true);

        const sensitive = extractMemorySensitiveValues(validated);
        expect(sensitive).toContain("valid_secret_key_123");
        expect(sensitive).toContain("valid_embed_key_456");
        // Verify numeric/boolean standard fields are NOT extracted as sensitive secrets
        expect(sensitive).not.toContain("2000");
        expect(sensitive).not.toContain("1000");
        expect(sensitive).not.toContain("500");
        expect(sensitive).not.toContain("30");
        expect(sensitive).not.toContain("true");
      });

      it("allows provider token counter fields like cached_tokens, reasoning_tokens, and billed_tokens with numeric values without treating them as credentials", () => {
        const configWithCounters = {
          ...validMemoryInput,
          llm: {
            provider: "openai",
            config: {
              model: "gpt-5.4",
              api_key: "valid_secret_key_123",
              cached_tokens: 1024,
              reasoning_tokens: 256,
              billed_tokens: 1280,
              thinking_tokens: 128,
              response_tokens: 512,
            },
          },
        };

        const validated = validateHermesMemoryConfig(configWithCounters);
        expect(validated.llm.config.cached_tokens).toBe(1024);
        expect(validated.llm.config.reasoning_tokens).toBe(256);
        expect(validated.llm.config.billed_tokens).toBe(1280);
        expect(validated.llm.config.thinking_tokens).toBe(128);
        expect(validated.llm.config.response_tokens).toBe(512);

        const sensitive = extractMemorySensitiveValues(validated);
        expect(sensitive).toContain("valid_secret_key_123");
        expect(sensitive).not.toContain("1024");
        expect(sensitive).not.toContain("256");
        expect(sensitive).not.toContain("1280");
        expect(sensitive).not.toContain("128");
        expect(sensitive).not.toContain("512");
      });

      it("isCredentialKey correctly identifies credentials and excludes token counters and standard config", () => {
        expect(isCredentialKey("api_key")).toBe(true);
        expect(isCredentialKey("apiKey")).toBe(true);
        expect(isCredentialKey("secret")).toBe(true);
        expect(isCredentialKey("secret_key")).toBe(true);
        expect(isCredentialKey("client_secret")).toBe(true);
        expect(isCredentialKey("token")).toBe(true);
        expect(isCredentialKey("access_token")).toBe(true);
        expect(isCredentialKey("auth_token")).toBe(true);
        expect(isCredentialKey("password")).toBe(true);
        expect(isCredentialKey("credential")).toBe(true);

        // Broad token and key families
        expect(isCredentialKey("refresh_token")).toBe(true);
        expect(isCredentialKey("refreshToken")).toBe(true);
        expect(isCredentialKey("api_token")).toBe(true);
        expect(isCredentialKey("apiToken")).toBe(true);
        expect(isCredentialKey("api_tokens")).toBe(true);
        expect(isCredentialKey("apiTokens")).toBe(true);
        expect(isCredentialKey("access_key")).toBe(true);
        expect(isCredentialKey("accessKey")).toBe(true);
        expect(isCredentialKey("private_key")).toBe(true);
        expect(isCredentialKey("privateKey")).toBe(true);
        expect(isCredentialKey("session_token")).toBe(true);
        expect(isCredentialKey("sessionToken")).toBe(true);
        expect(isCredentialKey("authorization")).toBe(true);
        expect(isCredentialKey("auth_key")).toBe(true);
        expect(isCredentialKey("authKey")).toBe(true);
        expect(isCredentialKey("signing_key")).toBe(true);
        expect(isCredentialKey("signingKey")).toBe(true);
        expect(isCredentialKey("secret_type")).toBe(true);
        expect(isCredentialKey("secretType")).toBe(true);
        expect(isCredentialKey("credential_url")).toBe(true);
        expect(isCredentialKey("credentialUrl")).toBe(true);
        expect(isCredentialKey("license_key")).toBe(true);
        expect(isCredentialKey("custom_token")).toBe(true);

        expect(isCredentialKey("max_tokens")).toBe(false);
        expect(isCredentialKey("max_completion_tokens")).toBe(false);
        expect(isCredentialKey("num_tokens")).toBe(false);
        expect(isCredentialKey("total_tokens")).toBe(false);
        expect(isCredentialKey("tokens")).toBe(false);
        expect(isCredentialKey("cached_tokens")).toBe(false);
        expect(isCredentialKey("reasoning_tokens")).toBe(false);
        expect(isCredentialKey("thinking_tokens")).toBe(false);
        expect(isCredentialKey("billed_tokens")).toBe(false);
        expect(isCredentialKey("response_tokens")).toBe(false);
        expect(isCredentialKey("auth_timeout")).toBe(false);
        expect(isCredentialKey("oauth_enabled")).toBe(false);
        expect(isCredentialKey("auth_enabled")).toBe(false);
        expect(isCredentialKey("auth_mode")).toBe(false);
        expect(isCredentialKey("auth_type")).toBe(false);
        expect(isCredentialKey("key_prefix")).toBe(false);
        expect(isCredentialKey("auth_ttl")).toBe(false);
        expect(isCredentialKey("auth_url")).toBe(false);
        expect(isCredentialKey("auth_endpoint")).toBe(false);
        expect(isCredentialKey("tokens_limit")).toBe(false);
      });

      it("token counter fields like cached_tokens, reasoning_tokens, and billed_tokens are never classified as credentials", () => {
        expect(isCredentialKey("cached_tokens")).toBe(false);
        expect(isCredentialKey("reasoning_tokens")).toBe(false);
        expect(isCredentialKey("thinking_tokens")).toBe(false);
        expect(isCredentialKey("billed_tokens")).toBe(false);
        expect(isCredentialKey("response_tokens")).toBe(false);

        // Explicit credentials ending in token/tokens or key/keys are still classified as credentials
        expect(isCredentialKey("api_tokens")).toBe(true);
        expect(isCredentialKey("apiTokens")).toBe(true);
        expect(isCredentialKey("auth_tokens")).toBe(true);
        expect(isCredentialKey("refresh_tokens")).toBe(true);
        expect(isCredentialKey("access_tokens")).toBe(true);
        expect(isCredentialKey("session_tokens")).toBe(true);
        expect(isCredentialKey("custom_token")).toBe(true);
      });

      it("classifies non-explicit plural and singular token keys as credentials", () => {
        expect(isCredentialKey("client_tokens")).toBe(true);
        expect(isCredentialKey("deploy_tokens")).toBe(true);
        expect(isCredentialKey("service_tokens")).toBe(true);
        expect(isCredentialKey("jwt_tokens")).toBe(true);
        expect(isCredentialKey("registry_tokens")).toBe(true);
        expect(isCredentialKey("vault_tokens")).toBe(true);
        expect(isCredentialKey("custom_tokens")).toBe(true);

        expect(isCredentialKey("client_token")).toBe(true);
        expect(isCredentialKey("deploy_token")).toBe(true);
        expect(isCredentialKey("service_token")).toBe(true);
        expect(isCredentialKey("jwt_token")).toBe(true);
        expect(isCredentialKey("registry_token")).toBe(true);
        expect(isCredentialKey("vault_token")).toBe(true);
        expect(isCredentialKey("custom_token")).toBe(true);
      });

      it("extracts sensitive values from plural token keys like client_tokens, deploy_tokens, custom_tokens", () => {
        const config = {
          ...validMemoryInput,
          llm: {
            provider: "openai",
            config: {
              model: "gpt-5.4",
              api_key: "key_1",
              client_tokens: "secret_client_token_val",
              deploy_tokens: "secret_deploy_token_val",
              service_tokens: "secret_service_token_val",
              custom_tokens: "secret_custom_token_val",
            },
          },
        };
        const validated = validateHermesMemoryConfig(config);
        const sensitive = extractMemorySensitiveValues(validated);
        expect(sensitive).toContain("secret_client_token_val");
        expect(sensitive).toContain("secret_deploy_token_val");
        expect(sensitive).toContain("secret_service_token_val");
        expect(sensitive).toContain("secret_custom_token_val");
      });

      it("explicit credentials are never vetoed by non-credential suffix exclusions", () => {
        expect(isCredentialKey("api_tokens")).toBe(true);
        expect(isCredentialKey("secret_type")).toBe(true);
        expect(isCredentialKey("credential_url")).toBe(true);
        expect(isCredentialKey("credential_endpoint")).toBe(true);
        expect(isCredentialKey("auth_token_type")).toBe(true);
        expect(isCredentialKey("apiTokens")).toBe(true);
        expect(isCredentialKey("secretType")).toBe(true);
        expect(isCredentialKey("credentialUrl")).toBe(true);
      });

      it("canSafelyRedactSecret correctly determines if secrets can be safely bounded", () => {
        expect(canSafelyRedactSecret("long_secret_123")).toBe(true);
        expect(canSafelyRedactSecret("abcd")).toBe(true);
        expect(canSafelyRedactSecret("tok")).toBe(true);
        expect(canSafelyRedactSecret("k1")).toBe(true);
        expect(canSafelyRedactSecret("a")).toBe(true);
        expect(canSafelyRedactSecret("_k")).toBe(true);
        expect(canSafelyRedactSecret("-k")).toBe(true);
        expect(canSafelyRedactSecret("/k")).toBe(true);
        expect(canSafelyRedactSecret("$ab")).toBe(true);
        expect(canSafelyRedactSecret("!a1")).toBe(true);

        expect(canSafelyRedactSecret("-")).toBe(false);
        expect(canSafelyRedactSecret("_")).toBe(false);
        expect(canSafelyRedactSecret("__")).toBe(false);
        expect(canSafelyRedactSecret("--")).toBe(false);
        expect(canSafelyRedactSecret("-_-")).toBe(false);
        expect(canSafelyRedactSecret("***")).toBe(false);
        expect(canSafelyRedactSecret("$$$")).toBe(false);
        expect(canSafelyRedactSecret("/")).toBe(false);
        expect(canSafelyRedactSecret("!")).toBe(false);
        expect(canSafelyRedactSecret("###")).toBe(false);
        expect(canSafelyRedactSecret("   ")).toBe(false);
        expect(canSafelyRedactSecret("")).toBe(false);
      });

    it("rejects short all-symbol credentials in llm and embedder blocks fail-closed", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          llm: {
            provider: "openai",
            config: {
              model: "gpt-5.4",
              api_key: "***",
            },
          },
        }),
      ).toThrow("llm.config.api_key must be at least 4 characters or contain alphanumeric characters");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          embedder: {
            provider: "openai",
            config: {
              model: "text-embedding-3-small",
              api_key: "$$$",
            },
          },
        }),
      ).toThrow("embedder.config.api_key must be at least 4 characters or contain alphanumeric characters");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          llm: {
            provider: "openai",
            config: {
              model: "gpt-5.4",
              api_key: "-",
            },
          },
        }),
      ).toThrow("llm.config.api_key must be at least 4 characters or contain alphanumeric characters");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          embedder: {
            provider: "openai",
            config: {
              model: "text-embedding-3-small",
              api_key: "__",
            },
          },
        }),
      ).toThrow("embedder.config.api_key must be at least 4 characters or contain alphanumeric characters");
    });

    describe("plain-object validation at all boundaries", () => {
      it("FORBIDDEN_CONFIG_KEYS is an immutable ReadonlySet that rejects modification", () => {
        expect(FORBIDDEN_CONFIG_KEYS.has("__proto__")).toBe(true);
        expect(FORBIDDEN_CONFIG_KEYS.has("constructor")).toBe(true);
        expect(FORBIDDEN_CONFIG_KEYS.has("prototype")).toBe(true);
        expect(FORBIDDEN_CONFIG_KEYS.size).toBe(3);

        expect(() => (FORBIDDEN_CONFIG_KEYS as any).add("foo")).toThrow(TypeError);
        expect(() => (FORBIDDEN_CONFIG_KEYS as any).delete("__proto__")).toThrow(TypeError);
        expect(() => (FORBIDDEN_CONFIG_KEYS as any).clear()).toThrow(TypeError);

        // Verify Set.prototype methods cannot mutate the internal set via call
        expect(() => Set.prototype.delete.call(FORBIDDEN_CONFIG_KEYS, "__proto__")).toThrow(TypeError);
        expect(() => Set.prototype.add.call(FORBIDDEN_CONFIG_KEYS, "foo")).toThrow(TypeError);
        expect(() => Set.prototype.clear.call(FORBIDDEN_CONFIG_KEYS)).toThrow(TypeError);
        expect(FORBIDDEN_CONFIG_KEYS.has("__proto__")).toBe(true);
        expect(FORBIDDEN_CONFIG_KEYS.size).toBe(3);
      });

      it("rejects root object with custom prototype", () => {
        const proto = { custom: true };
        const obj = Object.create(proto);
        Object.assign(obj, validMemoryInput);

        expect(() => validateHermesMemoryConfig(obj)).toThrow("has an invalid prototype");
      });

      it("rejects root object with getters without invoking the getter", () => {
        let getterCalled = false;
        const obj = { ...validMemoryInput };
        Object.defineProperty(obj, "userId", {
          enumerable: true,
          get() {
            getterCalled = true;
            return "company";
          },
        });

        expect(() => validateHermesMemoryConfig(obj)).toThrow("cannot contain getters or setters");
        expect(getterCalled).toBe(false);
      });

      it("rejects root object with inherited properties", () => {
        const proto = { user_id: "company" };
        const obj = Object.create(proto);
        Object.assign(obj, { ...validMemoryInput, userId: "company" });

        expect(() => validateHermesMemoryConfig(obj)).toThrow("has an invalid prototype");
      });

      it("rejects llm block with custom prototype or getters", () => {
        let getterCalled = false;
        const badLlm = Object.create({ proto: true });
        Object.assign(badLlm, validMemoryInput.llm);

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: badLlm,
          }),
        ).toThrow("has an invalid prototype");

        const getterLlm = { ...validMemoryInput.llm };
        Object.defineProperty(getterLlm, "provider", {
          enumerable: true,
          get() {
            getterCalled = true;
            return "openai";
          },
        });

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: getterLlm,
          }),
        ).toThrow("cannot contain getters or setters");
        expect(getterCalled).toBe(false);
      });

      it("rejects vectorStore and vectorStore.config with custom prototypes or getters", () => {
        let getterCalled = false;
        const badVec = Object.create({ proto: true });
        Object.assign(badVec, validMemoryInput.vectorStore);

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            vectorStore: badVec,
          }),
        ).toThrow("has an invalid prototype");

        const getterCfg = { ...validMemoryInput.vectorStore.config };
        Object.defineProperty(getterCfg, "password", {
          enumerable: true,
          get() {
            getterCalled = true;
            return "pass123";
          },
        });

        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            vectorStore: {
              provider: "pgvector",
              config: getterCfg,
            },
          }),
        ).toThrow("cannot contain getters or setters");
        expect(getterCalled).toBe(false);
      });

      it("safely compares vectorStore and vector_store aliases structurally without JSON.stringify or getter execution", () => {
        // Different key order, identical values
        const vStore1 = {
          provider: "pgvector",
          config: {
            host: "localhost",
            port: 5432,
            user: "user_a",
            password: "password_a",
            dbname: "db_a",
            sslmode: "require",
            collectionName: "col_a",
          },
        };
        const vStore2 = {
          provider: "pgvector",
          config: {
            collection_name: "col_a",
            sslmode: "require",
            dbname: "db_a",
            password: "password_a",
            user: "user_a",
            port: 5432,
            host: "localhost",
          },
        };

        const validated = validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: vStore1,
          vector_store: vStore2,
        });
        expect(validated.vectorStore.config.collectionName).toBe("col_a");

        // Conflicting host value
        expect(() =>
          validateHermesMemoryConfig({
            ...validMemoryInput,
            vectorStore: vStore1,
            vector_store: {
              ...vStore2,
              config: { ...vStore2.config, host: "other-host" },
            },
          }),
        ).toThrow("conflicting vectorStore and vector_store configurations provided");
      });
    });

    describe("validation error messages do not leak rejected values", () => {
      const sensitiveProbe = "super-secret-probe-token-998877";

      it("does not echo rejected provider", () => {
        try {
          validateHermesMemoryConfig({ ...validMemoryInput, provider: sensitiveProbe });
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe('Invalid memory configuration: provider must be "mem0"');
          expect(err.message).not.toContain(sensitiveProbe);
        }
      });

      it("does not echo rejected mode", () => {
        try {
          validateHermesMemoryConfig({ ...validMemoryInput, mode: sensitiveProbe });
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe('Invalid memory configuration: mode must be "oss"');
          expect(err.message).not.toContain(sensitiveProbe);
        }
      });

      it("does not echo rejected userId", () => {
        try {
          validateHermesMemoryConfig({ ...validMemoryInput, userId: sensitiveProbe });
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe('Invalid memory configuration: userId must be "company"');
          expect(err.message).not.toContain(sensitiveProbe);
        }
      });

      it("does not echo rejected port", () => {
        try {
          validateHermesMemoryConfig({
            ...validMemoryInput,
            vectorStore: {
              provider: "pgvector",
              config: { ...validMemoryInput.vectorStore.config, port: -9999 },
            },
          });
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe(
            "Invalid memory configuration: vector_store.config.port must be an integer between 1 and 65535",
          );
          expect(err.message).not.toContain("-9999");
        }
      });

      it("does not echo rejected sslmode", () => {
        try {
          validateHermesMemoryConfig({
            ...validMemoryInput,
            vectorStore: {
              provider: "pgvector",
              config: { ...validMemoryInput.vectorStore.config, sslmode: sensitiveProbe },
            },
          });
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe(
            'Invalid memory configuration: vector_store.config.sslmode must be "require"',
          );
          expect(err.message).not.toContain(sensitiveProbe);
        }
      });

      it("does not echo rejected llm.provider", () => {
        try {
          validateHermesMemoryConfig({
            ...validMemoryInput,
            llm: { provider: sensitiveProbe as any, config: { model: "gpt-5.4" } },
          });
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe(
            'Invalid memory configuration: llm.provider must be "openai" or "ollama"',
          );
          expect(err.message).not.toContain(sensitiveProbe);
        }
      });

      it("does not echo rejected vector_store.provider", () => {
        try {
          validateHermesMemoryConfig({
            ...validMemoryInput,
            vectorStore: {
              provider: sensitiveProbe as any,
              config: validMemoryInput.vectorStore.config,
            },
          });
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe(
            'Invalid memory configuration: vector_store.provider must be "pgvector"',
          );
          expect(err.message).not.toContain(sensitiveProbe);
        }
      });
    });

    describe("createChunkAwareStreamingRedactor", () => {
      it("redacts secret split across multiple chunk boundaries and emits discrete lines", () => {
        const redactor = createChunkAwareStreamingRedactor(["SuperSecretPassword123!"]);

        // Split "SuperSecretPassword123!" across 3 chunks within a line
        const out1 = redactor.process("stdout", "Connecting with Super");
        const out2 = redactor.process("stdout", "SecretPass");
        const out3 = redactor.process("stdout", "word123! on host\nSecond clean line\n");
        const flushed = redactor.flush();

        // Line-based processing: out1 and out2 buffer incomplete line; out3 completes 2 lines
        expect(out1).toEqual([]);
        expect(out2).toEqual([]);
        expect(out3).toEqual([
          "Connecting with ***REDACTED*** on host\n",
          "Second clean line\n",
        ]);
        expect(flushed).toEqual([]);
      });

      it("never splits replacement markers across chunk boundaries", () => {
        const secret = "VeryLongSecretKey1234567890";
        const redactor = createChunkAwareStreamingRedactor([secret]);

        // Stream chunk containing the secret and newline
        const lineWithSecret = `info: token=${secret}; ready\n`;
        const emitted = redactor.process("stdout", lineWithSecret);
        expect(emitted).toEqual(["info: token=***REDACTED***; ready\n"]);

        // Verify that the replacement marker is intact
        for (const chunk of emitted) {
          if (chunk.includes("***")) {
            expect(chunk).toContain("***REDACTED***");
            expect(chunk).not.toMatch(/\*\*\*RED(?!ACTED\*\*\*)/);
          }
        }
      });

      it("preserves stdout/stderr tail chronology on flush", () => {
        const redactor = createChunkAwareStreamingRedactor(["secret-tail-value-1234"]);

        // Case A: stdout written first, stderr written second (both without trailing newlines)
        redactor.process("stdout", "stdout tail message");
        redactor.process("stderr", "stderr tail error");

        const flushedA = redactor.flush();
        expect(flushedA).toEqual([
          { stream: "stdout", chunk: "stdout tail message" },
          { stream: "stderr", chunk: "stderr tail error" },
        ]);

        // Case B: stderr written first, stdout written second
        redactor.process("stderr", "stderr earlier error");
        redactor.process("stdout", "stdout later message");

        const flushedB = redactor.flush();
        expect(flushedB).toEqual([
          { stream: "stderr", chunk: "stderr earlier error" },
          { stream: "stdout", chunk: "stdout later message" },
        ]);
      });

      it("handles single-character chunks without leaking secret", () => {
        const secret = "secret_pw_1234";
        const redactor = createChunkAwareStreamingRedactor([secret]);

        const fullString = `pass=${secret};done\n`;
        const emittedChunks: string[] = [];

        for (const char of fullString) {
          emittedChunks.push(...redactor.process("stdout", char));
        }
        for (const f of redactor.flush()) {
          emittedChunks.push(f.chunk);
        }

        const total = emittedChunks.join("");
        expect(total).not.toContain(secret);
        expect(total).toBe("pass=***REDACTED***;done\n");
      });

      it("handles multiple streams and empty secrets gracefully with immediate fast-path", () => {
        const noSecretRedactor = createChunkAwareStreamingRedactor([]);
        // Unbuffered immediate return even without newline
        expect(noSecretRedactor.process("stdout", "normal text without newline")).toEqual([
          "normal text without newline",
        ]);
        expect(noSecretRedactor.flush()).toEqual([]);

        const multiStreamRedactor = createChunkAwareStreamingRedactor(["secret1_long", "secret2_long"]);
        const outStd = multiStreamRedactor.process("stdout", "stdout with secret1_long and more\n");
        const outErr = multiStreamRedactor.process("stderr", "stderr with secret2_long and more\n");

        const flushed = multiStreamRedactor.flush();
        const stdTotal = [...outStd, ...flushed.filter((f) => f.stream === "stdout").map((f) => f.chunk)].join("");
        const errTotal = [...outErr, ...flushed.filter((f) => f.stream === "stderr").map((f) => f.chunk)].join("");

        expect(stdTotal).toContain(REDACTION_MARKER);
        expect(stdTotal).not.toContain("secret1_long");
        expect(errTotal).toContain(REDACTION_MARKER);
        expect(errTotal).not.toContain("secret2_long");
      });

      it("preserves bare-CR segments for progress bars and in-place terminal updates", () => {
        const secret = "token_top_secret_99";
        const redactor = createChunkAwareStreamingRedactor([secret]);

        // Progress bar simulation: in-place carriage returns
        const input = "Progress: 10%\rProgress: 50% (" + secret + ")\rProgress: 100%\n";
        const chunks = redactor.process("stdout", input);

        expect(chunks).toEqual([
          "Progress: 10%\r",
          `Progress: 50% (${REDACTION_MARKER})\r`,
          "Progress: 100%\n",
        ]);

        // Trailing bare-CR buffering until subsequent chunk or flush
        const trailingRedactor = createChunkAwareStreamingRedactor([secret]);
        const part1 = trailingRedactor.process("stdout", "Spinning 1\r");
        expect(part1).toEqual([]); // Trailing CR held back in case \n arrives in next chunk

        const part2 = trailingRedactor.process("stdout", "Spinning 2\r");
        expect(part2).toEqual(["Spinning 1\r"]);

        const flushed = trailingRedactor.flush();
        expect(flushed).toEqual([{ stream: "stdout", chunk: "Spinning 2\r" }]);
      });

      it("handles mixed CRLF, LF, and bare CR line endings without character loss", () => {
        const secret = "secret_value_xyz";
        const redactor = createChunkAwareStreamingRedactor([secret]);

        const mixed = `line1\r\nline2\rline3\nline4 with ${secret}\r`;
        const out1 = redactor.process("stdout", mixed);
        expect(out1).toEqual([
          "line1\r\n",
          "line2\r",
          "line3\n",
        ]);

        const out2 = redactor.process("stdout", "line5\n");
        expect(out2).toEqual([
          `line4 with ${REDACTION_MARKER}\r`,
          "line5\n",
        ]);
      });

      it("handles oversized lines exceeding MAX_UNTERMINATED_LINE_BUFFER without splitting REDACTION_MARKER", () => {
        const secret = "secret_token_at_boundary_12345";
        const redactor = createChunkAwareStreamingRedactor([secret]);

        // Create an oversized chunk without any newlines
        const padLength = MAX_UNTERMINATED_LINE_BUFFER + 500;
        const largeChunk = "A".repeat(MAX_UNTERMINATED_LINE_BUFFER - 10) + secret + "B".repeat(500);

        const emitted = redactor.process("stdout", largeChunk);
        expect(emitted.length).toBeGreaterThan(0);

        // Verify that emitted slice does NOT contain the secret
        for (const chunk of emitted) {
          expect(chunk).not.toContain(secret);
          // If REDACTION_MARKER is present, it must be intact and not split
          if (chunk.includes("***")) {
            expect(chunk).toContain(REDACTION_MARKER);
            expect(chunk).not.toMatch(/\*\*\*RED(?!ACTED\*\*\*)/);
          }
        }

        const flushed = redactor.flush();
        const total = [...emitted, ...flushed.map((f) => f.chunk)].join("");
        expect(total).not.toContain(secret);
        expect(total).toContain(REDACTION_MARKER);
      });

      it("computes safeCut in raw-buffer coordinates and never splits raw secrets across oversized chunks", () => {
        // Secret that expands when redacted: 3 chars -> 10 chars ([REDACTED])
        const shortSecret = "k99";
        // Secret that shrinks when redacted: 50 chars -> 10 chars
        const longSecret = "very_long_super_secret_credential_token_value_xyz1";
        const redactor = createChunkAwareStreamingRedactor([shortSecret, longSecret]);

        const keepLen = longSecret.length - 1;
        const totalLen = MAX_UNTERMINATED_LINE_BUFFER + 500;
        const initialRawCut = totalLen - keepLen;
        // Position longSecret so it spans across initialRawCut: starts 10 chars before initialRawCut
        const secretStart = initialRawCut - 10;
        const oversizedBuf =
          "X".repeat(secretStart) +
          longSecret +
          "Y".repeat(totalLen - secretStart - longSecret.length);

        expect(oversizedBuf.length).toBe(totalLen);

        // Process chunk through redactor
        const emitted = redactor.processDetailed("stdout", oversizedBuf);
        expect(emitted.length).toBe(1);

        const { raw, redacted } = emitted[0];

        // 1. Raw cut must have pulled back before longSecret, so longSecret is NOT split in raw
        expect(raw.length).toBe(secretStart);
        expect(raw).not.toContain(longSecret);
        expect(raw.endsWith("X".repeat(10))).toBe(true);

        // 2. Redacted slice must match raw slice redaction exactly
        expect(redacted).toBe(raw); // raw was all 'X's

        // 3. Flush the remainder: longSecret must be in remaining raw and completely redacted in remaining chunk
        const flushed = redactor.flushDetailed();
        expect(flushed.length).toBe(1);

        const remainingRaw = flushed[0].rawChunk;
        const remainingRedacted = flushed[0].chunk;

        expect(remainingRaw.startsWith(longSecret)).toBe(true);
        expect(remainingRedacted).not.toContain(longSecret);
        expect(remainingRedacted.startsWith(REDACTION_MARKER)).toBe(true);

        // Combined output has zero leaked raw secrets
        const fullRaw = raw + remainingRaw;
        const fullRedacted = redacted + remainingRedacted;
        expect(fullRaw).toBe(oversizedBuf);
        expect(fullRedacted).not.toContain(longSecret);
      });

      it("rejects secrets exceeding MAX_CONFIG_STRING_LENGTH when creating streaming redactor", () => {
        const oversizedSecret = "s".repeat(MAX_CONFIG_STRING_LENGTH + 1);
        expect(() => createChunkAwareStreamingRedactor([oversizedSecret])).toThrow(
          `Cannot safely redact secret: sensitive value exceeds maximum allowed length of ${MAX_CONFIG_STRING_LENGTH} characters`,
        );
      });

      it("preserves holdback buffer and avoids leaking secret fragments when rawCut is zero under secret within allowed length", () => {
        const secretPrefix = "OVERSIZED_SECRET_PREFIX_";
        const secretSuffix = "_OVERSIZED_SECRET_SUFFIX";
        const longSecret = secretPrefix + "Z".repeat(1500) + secretSuffix;
        expect(longSecret.length).toBeLessThanOrEqual(MAX_CONFIG_STRING_LENGTH);

        const redactor = createChunkAwareStreamingRedactor([longSecret]);

        // Send first chunk shorter than keepLen so rawCut calculates to Math.max(0, chunk1.length - keepLen) === 0
        const splitPoint = 800;
        const chunk1 = longSecret.slice(0, splitPoint);

        const emitted1 = redactor.processDetailed("stdout", chunk1);

        // Under the holdback, the buffer is preserved and nothing is emitted
        expect(emitted1).toEqual([]);

        // Explicit fragment assertions: ensure no unredacted secret prefix or substring was emitted
        expect(emitted1.some((item) => item.raw.includes(secretPrefix) || item.redacted.includes(secretPrefix))).toBe(false);
        expect(emitted1.some((item) => item.raw.includes(longSecret.slice(0, 100)) || item.redacted.includes(longSecret.slice(0, 100)))).toBe(false);

        // Send second chunk: remainder of longSecret followed by a newline
        const chunk2 = longSecret.slice(splitPoint) + "\n";
        const emitted2 = redactor.processDetailed("stdout", chunk2);

        // Entire secret is now complete; complete line ending with \n is emitted and redacted
        expect(emitted2.length).toBeGreaterThan(0);
        for (const item of emitted2) {
          expect(item.redacted).toContain(REDACTION_MARKER);
          expect(item.redacted).not.toContain(longSecret);
          expect(item.redacted).not.toContain(secretPrefix);
          expect(item.redacted).not.toContain(secretSuffix);
          expect(item.redacted).not.toContain(longSecret.slice(0, 100));
          expect(item.redacted).not.toContain(longSecret.slice(-100));
        }

        const flushed = redactor.flushDetailed();
        const allRedacted = [
          ...emitted1.map((e) => e.redacted),
          ...emitted2.map((e) => e.redacted),
          ...flushed.map((f) => f.chunk),
        ].join("");

        expect(allRedacted).toContain(REDACTION_MARKER);
        expect(allRedacted).not.toContain(longSecret);
        expect(allRedacted).not.toContain(secretPrefix);
        expect(allRedacted).not.toContain(secretSuffix);
        expect(allRedacted).not.toContain(longSecret.slice(0, 100));
        expect(allRedacted).not.toContain(longSecret.slice(-100));
        expect(allRedacted).not.toContain(longSecret.slice(splitPoint - 50, splitPoint + 50));
      });

      it("preserves holdback buffer across chunk boundary and redacts when flushed without newline", () => {
        const secretPrefix = "OVERSIZED_FLUSH_PREFIX_";
        const secretSuffix = "_OVERSIZED_FLUSH_SUFFIX";
        const longSecret = secretPrefix + "W".repeat(1200) + secretSuffix;
        expect(longSecret.length).toBeLessThanOrEqual(MAX_CONFIG_STRING_LENGTH);

        const redactor = createChunkAwareStreamingRedactor([longSecret]);

        const splitPoint = 600;
        const chunk1 = longSecret.slice(0, splitPoint);
        const emitted1 = redactor.processDetailed("stdout", chunk1);
        expect(emitted1).toEqual([]);

        const chunk2 = longSecret.slice(splitPoint);
        const emitted2 = redactor.processDetailed("stdout", chunk2);
        const flushed = redactor.flushDetailed();

        const allEmittedRedacted = [...emitted1.map((e) => e.redacted), ...emitted2.map((e) => e.redacted)].join("");
        const allFlushed = flushed.map((f) => f.chunk).join("");
        const allRedacted = allEmittedRedacted + allFlushed;

        expect(allEmittedRedacted).not.toContain(secretPrefix);
        expect(allEmittedRedacted).not.toContain(secretSuffix);
        expect(allRedacted).toContain(REDACTION_MARKER);
        expect(allRedacted).not.toContain(longSecret);
        expect(allRedacted).not.toContain(secretPrefix);
        expect(allRedacted).not.toContain(secretSuffix);
        expect(allRedacted).not.toContain(longSecret.slice(0, 100));
        expect(allRedacted).not.toContain(longSecret.slice(-100));
      });

      it("enforces hard ceiling when rawCut remains zero and buffer exceeds MAX_UNTERMINATED_LINE_BUFFER + maxSecretLen", () => {
        const secret = "abacaba";
        const redactor = createChunkAwareStreamingRedactor([secret]);

        // Construct a pathological buffer of repeated overlapping secrets where rawCut walks to zero
        // and buffer length exceeds MAX_UNTERMINATED_LINE_BUFFER + secret.length
        const totalLen = MAX_UNTERMINATED_LINE_BUFFER + secret.length + 100;
        let chain = "";
        while (chain.length < totalLen) {
          chain += "abac";
        }
        chain += "aba";
        expect(chain.length).toBeGreaterThanOrEqual(MAX_UNTERMINATED_LINE_BUFFER + secret.length);

        const emitted = redactor.processDetailed("stdout", chain);
        // The hard ceiling backstop fires because buf.length >= MAX_UNTERMINATED_LINE_BUFFER + maxSecretLen
        // and rawCut cannot progress
        expect(emitted.length).toBeGreaterThan(0);
        for (const item of emitted) {
          expect(item.redacted).not.toContain(secret);
          expect(item.redacted).toContain(REDACTION_MARKER);
        }
        // Buffer was cleared to "" by hard ceiling
        const flushed = redactor.flushDetailed();
        expect(flushed.length).toBe(0);
      });

      it("does not split self-overlapping secret across chunk boundary when bounded loop terminates with straddling secret", () => {
        // Self-overlapping secret with period 4: "abacaba" has overlapping occurrences in "abacabacaba"
        const secret = "abacaba";
        const redactor = createChunkAwareStreamingRedactor([secret]);

        const keepLen = secret.length - 1;
        const totalLen = MAX_UNTERMINATED_LINE_BUFFER + 500;
        const initialRawCut = totalLen - keepLen;

        // "abacabacaba" contains two occurrences of "abacaba":
        // occurrence 1: offset 0..7
        // occurrence 2: offset 4..11
        // Place the chain so occurrence 2 straddles initialRawCut (offset 4 starts before initialRawCut, ends after).
        // Pass 1 adjusts rawCut to offset 4.
        // At rawCut = offset 4, occurrence 1 (offset 0..7) still straddles rawCut (0 < 4 < 7)!
        // Since maxPasses = Math.max(1, cleanedSecrets.length) = 1, passCount reaches maxPasses.
        // The post-loop invariant check detects that occurrence 1 still straddles rawCut and holds back the buffer (rawCut = 0).
        const chain = "abacabacaba";
        const chainStart = initialRawCut - 7;
        const buf =
          "X".repeat(chainStart) +
          chain +
          "Y".repeat(totalLen - chainStart - chain.length);

        const emitted = redactor.processDetailed("stdout", buf);
        const flushed = redactor.flushDetailed();

        const allEmittedRaw = emitted.map((e) => e.raw).join("");
        const allEmittedRedacted = emitted.map((e) => e.redacted).join("");
        const allFlushedChunk = flushed.map((f) => f.chunk).join("");
        const totalOutput = allEmittedRedacted + allFlushedChunk;

        // No unredacted fragments of "abacaba" (e.g. "abac" or "aba") can appear in emitted or flushed
        expect(allEmittedRaw).not.toContain("abacabacaba");
        expect(allEmittedRedacted).not.toContain(secret);
        expect(allFlushedChunk).not.toContain(secret);
        expect(totalOutput).not.toContain(secret);
        expect(totalOutput).toContain(REDACTION_MARKER);
      });

      it("redacts short tokens via streaming redactor without corrupting words or counters", () => {
        const redactor = createChunkAwareStreamingRedactor(["tok", "x1"]);
        const input = "Using token tok and x1 for MCP.\nTokens: 1200 input, 300 output.\n";
        const emitted = redactor.process("stdout", input);

        expect(emitted).toEqual([
          `Using token ${REDACTION_MARKER} and ${REDACTION_MARKER} for MCP.\n`,
          "Tokens: 1200 input, 300 output.\n",
        ]);
      });

      it("provides detailed streaming output with both raw and redacted chunks", () => {
        const redactor = createChunkAwareStreamingRedactor(["secret123"]);
        const out = redactor.processDetailed("stderr", "2026-10-01 12:34:56,123 [INFO] secret123 ready\n");
        expect(out).toEqual([
          {
            raw: "2026-10-01 12:34:56,123 [INFO] secret123 ready\n",
            redacted: `2026-10-01 12:34:56,123 [INFO] ${REDACTION_MARKER} ready\n`,
          },
        ]);
        redactor.processDetailed("stdout", "unfinished secret123 tail");
        const flushed = redactor.flushDetailed();
        expect(flushed).toEqual([
          {
            stream: "stdout",
            chunk: `unfinished ${REDACTION_MARKER} tail`,
            rawChunk: "unfinished secret123 tail",
          },
        ]);
      });
    });

    describe("redactSensitiveString exact-value boundary contract", () => {
      it("redacts standard secrets (length >= MIN_SECRET_REDACTION_LENGTH) via substring replacement", () => {
        const text = "Connecting with secret_password_123 on database";
        expect(redactSensitiveString(text, ["secret_password_123"])).toBe(
          `Connecting with ${REDACTION_MARKER} on database`,
        );
      });

      it("redacts short tokens (length < MIN_SECRET_REDACTION_LENGTH) at exact boundaries", () => {
        const text = 'Bearer tok; token="tok"; HERMES_TOKEN=tok; tok at start, and tok.';
        expect(redactSensitiveString(text, ["tok"])).toBe(
          `Bearer ${REDACTION_MARKER}; token="${REDACTION_MARKER}"; HERMES_TOKEN=${REDACTION_MARKER}; ${REDACTION_MARKER} at start, and ${REDACTION_MARKER}.`,
        );
      });

      it("does NOT corrupt words or token counters containing short token substrings", () => {
        const text = "Tokens: 500 input, 100 output. The tokenizer took stock of the situation.";
        expect(redactSensitiveString(text, ["tok"])).toBe(
          "Tokens: 500 input, 100 output. The tokenizer took stock of the situation.",
        );
      });

      it("handles single-character short tokens safely without corrupting words", () => {
        const text = "Server a is ready for application database";
        expect(redactSensitiveString(text, ["a"])).toBe(
          `Server ${REDACTION_MARKER} is ready for application database`,
        );
      });

      it("handles empty secrets array or empty text safely without modifications", () => {
        expect(redactSensitiveString("", ["tok"])).toBe("");
        expect(redactSensitiveString("hello world", [])).toBe("hello world");
        expect(redactSensitiveString("hello world", [""])).toBe("hello world");
      });

      it("processes unsorted secrets longest-first to prevent shorter secrets from masking longer ones", () => {
        const text = "Connecting with tok_secret_long_credential and tok.";
        // 'tok' is passed first, but 'tok_secret_long_credential' is longer and must be redacted first
        expect(redactSensitiveString(text, ["tok", "tok_secret_long_credential"])).toBe(
          `Connecting with ${REDACTION_MARKER} and ${REDACTION_MARKER}.`,
        );
      });

      it("handles three-tier unsorted prefix secrets without partial redaction remnants", () => {
        const text = "Keys: subsecret_tier3, subsecret, and sub.";
        expect(redactSensitiveString(text, ["sub", "subsecret_tier3", "subsecret"])).toBe(
          `Keys: ${REDACTION_MARKER}, ${REDACTION_MARKER}, and ${REDACTION_MARKER}.`,
        );
      });

      it("redacts secrets containing regex metacharacters without regex errors or wildcards", () => {
        const text = "Secrets: [api.key]+, sec*ret?, a$b^c(d), and key|val.";
        expect(
          redactSensitiveString(text, ["[api.key]+", "sec*ret?", "a$b^c(d)", "key|val"]),
        ).toBe(`Secrets: ${REDACTION_MARKER}, ${REDACTION_MARKER}, ${REDACTION_MARKER}, and ${REDACTION_MARKER}.`);
      });

      it("redacts short secrets (length 1..3) containing regex metacharacters via RegExp escaping", () => {
        const text = "Tokens a* and k+ and c? are active, while a*b and wa* remain untouched.";
        expect(redactSensitiveString(text, ["a*", "k+", "c?"])).toBe(
          `Tokens ${REDACTION_MARKER} and ${REDACTION_MARKER} and ${REDACTION_MARKER} are active, while a*b and wa* remain untouched.`,
        );
      });

      it("safely handles asymmetric short-secret boundaries without corrupting paths", () => {
        const text = "Checking path /opt/k and k/bin with token /k and k/ standalone.";
        // Secrets with leading or trailing slashes must not match inside paths like /opt/k or k/bin
        expect(redactSensitiveString(text, ["/k", "k/"])).toBe(
          `Checking path /opt/k and k/bin with token ${REDACTION_MARKER} and ${REDACTION_MARKER} standalone.`,
        );
      });

      it("redacts Unicode and multibyte secrets correctly", () => {
        const text = "Unicode keys: 🔑secret🗝️ and секрет123.";
        expect(redactSensitiveString(text, ["🔑secret🗝️", "секрет123"])).toBe(
          `Unicode keys: ${REDACTION_MARKER} and ${REDACTION_MARKER}.`,
        );
      });

      it("skips degenerate short non-alphanumeric secrets to protect paths, syntax, and logs", () => {
        const text = "/opt/hermes/bin/python3 -c '$100 ! --flag // '";
        // None of '/', '$', '!', ' ', '//', '---' have token boundary characters;
        // they must be skipped rather than causing bare global substring replacement.
        expect(redactSensitiveString(text, ["/", "$", "!", " ", "//", "---"])).toBe(
          "/opt/hermes/bin/python3 -c '$100 ! --flag // '",
        );
      });

      it("redacts short alphanumeric secrets at path or punctuation boundaries without corrupting words", () => {
        const text = "Path /opt/k1/bin/k10 contains token k1 and tok.";
        expect(redactSensitiveString(text, ["k1", "tok"])).toBe(
          `Path /opt/${REDACTION_MARKER}/bin/k10 contains token ${REDACTION_MARKER} and ${REDACTION_MARKER}.`,
        );
      });
    });
  });
});
