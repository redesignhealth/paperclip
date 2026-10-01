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
  SAFE_PG_IDENTIFIER_REGEX,
  SAFE_AGENT_ID_REGEX,
  MIN_SECRET_REDACTION_LENGTH,
  REDACTION_MARKER,
  MAX_UNTERMINATED_LINE_BUFFER,
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

    it("ignores secrets shorter than MIN_SECRET_REDACTION_LENGTH to prevent broad substring corruption", () => {
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
      expect(sensitive).not.toContain("k9");
      expect(sensitive).toContain("valid_secret_pass");
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

      it("redacts short tokens via streaming redactor without corrupting words or counters", () => {
        const redactor = createChunkAwareStreamingRedactor(["tok", "x1"]);
        const input = "Using token tok and x1 for MCP.\nTokens: 1200 input, 300 output.\n";
        const emitted = redactor.process("stdout", input);

        expect(emitted).toEqual([
          `Using token ${REDACTION_MARKER} and ${REDACTION_MARKER} for MCP.\n`,
          "Tokens: 1200 input, 300 output.\n",
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
    });
  });
});
