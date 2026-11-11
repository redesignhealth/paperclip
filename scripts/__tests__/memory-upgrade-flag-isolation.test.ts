import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_CENSUS_FLAGS, ALLOWED_DRAIN_FLAGS, ALLOWED_FLIP_FLAGS,
  ALLOWED_PUBLISH_FLAGS, ALLOWED_RECOVER_FLAGS, ALLOWED_ROLLBACK_FLAGS,
  ALLOWED_STATUS_FLAGS, ALLOWED_SWEEP_FLAGS, ALLOWED_VERIFY_FLAGS,
  BOOLEAN_CENSUS_FLAGS, BOOLEAN_DRAIN_FLAGS, BOOLEAN_FLIP_FLAGS,
  BOOLEAN_FLAGS,
  BOOLEAN_PUBLISH_FLAGS, BOOLEAN_RECOVER_FLAGS, BOOLEAN_ROLLBACK_FLAGS,
  BOOLEAN_STATUS_FLAGS, BOOLEAN_SWEEP_FLAGS, BOOLEAN_VERIFY_FLAGS,
  validateNoUnknownFlags, VALUE_FLAGS,
} from "../memory-upgrade.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

interface CommandFlagSpec {
  name: string;
  label: string;
  allowed: Set<string>;
  boolean: Set<string>;
}

export const COMMAND_FLAG_SPECS: CommandFlagSpec[] = [
  { name: "census", label: "read-only census", allowed: ALLOWED_CENSUS_FLAGS, boolean: BOOLEAN_CENSUS_FLAGS },
  { name: "sweep", label: "sweep", allowed: ALLOWED_SWEEP_FLAGS, boolean: BOOLEAN_SWEEP_FLAGS },
  { name: "publish", label: "publish", allowed: ALLOWED_PUBLISH_FLAGS, boolean: BOOLEAN_PUBLISH_FLAGS },
  { name: "flip", label: "flip", allowed: ALLOWED_FLIP_FLAGS, boolean: BOOLEAN_FLIP_FLAGS },
  { name: "drain", label: "drain", allowed: ALLOWED_DRAIN_FLAGS, boolean: BOOLEAN_DRAIN_FLAGS },
  { name: "verify", label: "verify", allowed: ALLOWED_VERIFY_FLAGS, boolean: BOOLEAN_VERIFY_FLAGS },
  { name: "rollback", label: "rollback", allowed: ALLOWED_ROLLBACK_FLAGS, boolean: BOOLEAN_ROLLBACK_FLAGS },
  { name: "status", label: "status", allowed: ALLOWED_STATUS_FLAGS, boolean: BOOLEAN_STATUS_FLAGS },
  { name: "recover", label: "recover", allowed: ALLOWED_RECOVER_FLAGS, boolean: BOOLEAN_RECOVER_FLAGS },
];

test("per-command flag isolation matrix (TECH-8191)", async (t) => {
  const allAllowedUnion = new Set<string>();
  for (const s of COMMAND_FLAG_SPECS) {
    for (const f of s.allowed) allAllowedUnion.add(f);
  }

  await t.test("commands do not share mutable boolean or allowed flag set instances", () => {
    assert.ok(
      BOOLEAN_CENSUS_FLAGS !== BOOLEAN_FLAGS,
      "BOOLEAN_CENSUS_FLAGS must not share instance with mutable BOOLEAN_FLAGS",
    );
    for (let i = 0; i < COMMAND_FLAG_SPECS.length; i++) {
      for (let j = i + 1; j < COMMAND_FLAG_SPECS.length; j++) {
        const a = COMMAND_FLAG_SPECS[i], b = COMMAND_FLAG_SPECS[j];
        assert.notEqual(a.allowed, b.allowed, `'${a.name}' / '${b.name}' must not share allowed Set`);
        assert.notEqual(a.boolean, b.boolean, `'${a.name}' / '${b.name}' must not share boolean Set`);
      }
    }
  });

  await t.test("every non-boolean allowed flag is registered in global VALUE_FLAGS arity table", () => {
    for (const s of COMMAND_FLAG_SPECS) {
      for (const f of s.allowed) {
        if (!s.boolean.has(f)) assert.ok(VALUE_FLAGS.has(f), `'${s.name}' flag '${f}' must be in VALUE_FLAGS`);
      }
    }
  });

  await t.test("table-driven foreign flag rejection: every command rejects flags of other commands", () => {
    for (const s of COMMAND_FLAG_SPECS) {
      const foreign = [...allAllowedUnion].filter((f) => !s.allowed.has(f));
      assert.ok(foreign.length > 0, `'${s.name}' must have foreign flags`);
      for (const flag of foreign) {
        assert.throws(
          () => validateNoUnknownFlags([flag], s.allowed, s.label, s.boolean),
          (err: unknown) => {
            assert.ok(err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT");
            assert.ok(err.message.includes(`Unknown option '${flag}'`));
            assert.ok(err.message.includes(`Only ${s.label} options are accepted.`));
            return true;
          },
        );
      }
    }
  });

  await t.test("every command accepts its own allowed flags", () => {
    for (const s of COMMAND_FLAG_SPECS) {
      for (const f of s.allowed) {
        if (s.boolean.has(f)) {
          assert.doesNotThrow(() => validateNoUnknownFlags([f], s.allowed, s.label, s.boolean));
          if (f.startsWith("--")) {
            assert.throws(
              () => validateNoUnknownFlags([`${f}=val`], s.allowed, s.label, s.boolean),
              (err: unknown) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
            );
          }
        } else {
          assert.doesNotThrow(() => validateNoUnknownFlags([f, "val"], s.allowed, s.label, s.boolean));
          assert.doesNotThrow(() => validateNoUnknownFlags([`${f}=val`], s.allowed, s.label, s.boolean));
        }
      }
    }
  });
});
