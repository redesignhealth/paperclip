import { describe, expect, it } from "vitest";

import {
  validateHermesMemoryConfig,
  serializeMem0Json,
  buildCanonicalMem0Object,
  generateHermesMemoryYaml,
  extractMemorySensitiveValues,
  assertStrictPlainObject,
  createChunkAwareStreamingRedactor,
  SAFE_PG_IDENTIFIER_REGEX,
  SAFE_AGENT_ID_REGEX,
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
        model: "gpt-4o-mini",
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
      expect(validated.llm.config.model).toBe("gpt-4o-mini");
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
            config: { model: "gpt-4o\r\nmalicious: header" },
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

    it("rejects empty password or passwords with control characters", () => {
      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, password: "" },
          },
        }),
      ).toThrow("vector_store.config.password must be a non-empty string");

      expect(() =>
        validateHermesMemoryConfig({
          ...validMemoryInput,
          vectorStore: {
            provider: "pgvector",
            config: { ...validMemoryInput.vectorStore.config, password: "pass\nword" },
          },
        }),
      ).toThrow("vector_store.config.password contains control characters or newlines");
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
              model: "gpt-4o",
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
          model: "gpt-4o",
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
                model: "gpt-4o",
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
                model: "gpt-4o",
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
                model: "gpt-4o",
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
                model: "gpt-4o",
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
                model: "gpt-4o",
                created: new Date(),
              },
            },
          }),
        ).toThrow("has an invalid prototype");
      });

      it("rejects prototype pollution keys (__proto__, constructor, prototype)", () => {
        const maliciousConfig = JSON.parse('{"model":"gpt-4o","__proto__":{"polluted":true}}');
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
                model: "gpt-4o",
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
                model: "gpt-4o",
                prototype: { malicious: true },
              },
            },
          }),
        ).toThrow("forbidden prototype-pollution key");
      });

      it("rejects circular references", () => {
        const circularObj: Record<string, unknown> = { model: "gpt-4o" };
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
                model: "gpt-4o",
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
                model: "gpt-4o",
                nested: {
                  value: "bad\0string",
                },
              },
            },
          }),
        ).toThrow("contains control characters or newlines");
      });

      it("rejects excessive recursion depth", () => {
        let deep: any = { model: "gpt-4o" };
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
              model: "gpt-4o-mini",
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
    it("extracts database credentials, host, and API keys for scrubbing", () => {
      const validated = validateHermesMemoryConfig(validMemoryInput);
      const sensitive = extractMemorySensitiveValues(validated);

      expect(sensitive).toContain("super_secret_pg_password_987");
      expect(sensitive).toContain("pg.tenant-internal.net");
      expect(sensitive).toContain("tenant_user_1");
      expect(sensitive).toContain("tenant_db_1");
      expect(sensitive).toContain("mem0_memories");
      expect(sensitive).toContain("sk-openai-secret-key-12345");

      // Verify safe sentinels are not in sensitive list
      expect(sensitive).not.toContain("company");
      expect(sensitive).not.toContain("require");
      expect(sensitive).not.toContain("pgvector");
      expect(sensitive).not.toContain("openai");
    });

    it("extracts all memory descriptor DB fields and API keys regardless of length", () => {
      const shortSecretsConfig = validateHermesMemoryConfig({
        ...validMemoryInput,
        llm: {
          provider: "openai",
          config: {
            model: "gpt-4o",
            api_key: "k9", // short 2-char API key
          },
        },
        vectorStore: {
          provider: "pgvector",
          config: {
            host: "db.co", // length 5
            user: "usr", // length 3
            password: "pw!", // length 3
            dbname: "d_1", // length 3
            sslmode: "require",
            collectionName: "col", // length 3
            port: 5432,
          },
        },
      });

      const sensitive = extractMemorySensitiveValues(shortSecretsConfig);

      // All DB fields and credentials MUST be present regardless of short length
      expect(sensitive).toContain("pw!");
      expect(sensitive).toContain("k9");
      expect(sensitive).toContain("usr");
      expect(sensitive).toContain("d_1");
      expect(sensitive).toContain("col");
      expect(sensitive).toContain("db.co");

      // Verify sorted longest first
      for (let i = 0; i < sensitive.length - 1; i++) {
        expect(sensitive[i].length).toBeGreaterThanOrEqual(sensitive[i + 1].length);
      }
    });

    describe("plain-object validation at all boundaries", () => {
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
    });

    describe("createChunkAwareStreamingRedactor", () => {
      it("redacts secret split across multiple chunk boundaries", () => {
        const redactor = createChunkAwareStreamingRedactor(["SuperSecretPassword123!"]);

        // Split "SuperSecretPassword123!" across 3 chunks:
        // Chunk 1: "Connecting with Super"
        // Chunk 2: "SecretPass"
        // Chunk 3: "word123! on host\n"
        const out1 = redactor.process("stdout", "Connecting with Super");
        const out2 = redactor.process("stdout", "SecretPass");
        const out3 = redactor.process("stdout", "word123! on host\n");
        const flushed = redactor.flush();

        const emitted = [
          ...out1,
          ...out2,
          ...out3,
          ...flushed.filter((f) => f.stream === "stdout").map((f) => f.chunk),
        ].join("");

        expect(emitted).not.toContain("SuperSecretPassword123!");
        expect(emitted).toContain("***REDACTED***");
        expect(emitted).toBe("Connecting with ***REDACTED*** on host\n");
      });

      it("handles single-character chunks without leaking secret", () => {
        const secret = "secret_pw";
        const redactor = createChunkAwareStreamingRedactor([secret]);

        const fullString = `pass=${secret};done`;
        const emittedChunks: string[] = [];

        for (const char of fullString) {
          emittedChunks.push(...redactor.process("stdout", char));
        }
        for (const f of redactor.flush()) {
          emittedChunks.push(f.chunk);
        }

        const total = emittedChunks.join("");
        expect(total).not.toContain(secret);
        expect(total).toBe("pass=***REDACTED***;done");
      });

      it("handles multiple streams and empty secrets gracefully", () => {
        const noSecretRedactor = createChunkAwareStreamingRedactor([]);
        expect(noSecretRedactor.process("stdout", "normal text")).toEqual(["normal text"]);
        expect(noSecretRedactor.flush()).toEqual([]);

        const multiStreamRedactor = createChunkAwareStreamingRedactor(["secret1", "secret2"]);
        const outStd = multiStreamRedactor.process("stdout", "stdout with secret1 and more");
        const outErr = multiStreamRedactor.process("stderr", "stderr with secret2 and more");

        const flushed = multiStreamRedactor.flush();
        const stdTotal = [...outStd, ...flushed.filter((f) => f.stream === "stdout").map((f) => f.chunk)].join("");
        const errTotal = [...outErr, ...flushed.filter((f) => f.stream === "stderr").map((f) => f.chunk)].join("");

        expect(stdTotal).toContain("***REDACTED***");
        expect(stdTotal).not.toContain("secret1");
        expect(errTotal).toContain("***REDACTED***");
        expect(errTotal).not.toContain("secret2");
      });
    });
  });
});
