import { describe, expect, it } from "vitest";
import { buildPgDumpInvocation } from "./backup-lib.js";

const PASSWORD = "p@ss/w:rd#tech7095";
const SENTINELS = {
  BETTER_AUTH_SECRET: "tech7095-better-auth-secret",
  PAPERCLIP_SECRETS_MASTER_KEY: "tech7095-master-key",
  ANTHROPIC_API_KEY: "sk-ant-tech7095",
  PAPERCLIP_SSO_PROVIDERS: "tech7095-sso",
  PGPASSWORD: "inherited-password-tech7095",
  PGSERVICE: "inherited-service",
};

describe("buildPgDumpInvocation (TECH-7095)", () => {
  const url = `postgres://dbuser:${encodeURIComponent(PASSWORD)}@db.internal:5433/paperclip?sslmode=require&application_name=backup`;

  it("keeps the credential out of argv and passes it via libpq env vars", () => {
    const { args, env, credentialInArgv } = buildPgDumpInvocation(url, 15, { PATH: "/usr/bin" });
    expect(credentialInArgv).toBe(false);
    expect(args.join(" ")).not.toContain(PASSWORD);
    expect(args.join(" ")).not.toContain("dbuser");
    expect(args.some((a) => a.startsWith("--dbname"))).toBe(false);
    expect(env).toMatchObject({
      PGHOST: "db.internal",
      PGPORT: "5433",
      PGUSER: "dbuser",
      PGPASSWORD: PASSWORD,
      PGDATABASE: "paperclip",
      PGSSLMODE: "require",
      PGAPPNAME: "backup",
      PGCONNECT_TIMEOUT: "15",
    });
  });

  it("does not forward the server's secrets or an inherited PGPASSWORD/PGSERVICE", () => {
    const { env } = buildPgDumpInvocation(url, 15, { PATH: "/usr/bin", HOME: "/h", ...SENTINELS });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.PAPERCLIP_SECRETS_MASTER_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PAPERCLIP_SSO_PROVIDERS).toBeUndefined();
    expect(env.PGSERVICE).toBeUndefined();
    expect(env.PGPASSWORD).toBe(PASSWORD); // the URL's, never the inherited one
    for (const value of Object.values(SENTINELS)) {
      if (value === SENTINELS.PGPASSWORD) continue;
      expect(JSON.stringify(env)).not.toContain(value);
    }
  });

  it("keeps operator libpq settings such as PGSSLROOTCERT", () => {
    const { env } = buildPgDumpInvocation(url, 15, { PGSSLROOTCERT: "/etc/ca.pem" });
    expect(env.PGSSLROOTCERT).toBe("/etc/ca.pem");
  });

  it("handles an IPv6 host and a URL without credentials or database", () => {
    const { env } = buildPgDumpInvocation("postgres://[::1]:5432/", 5, {});
    expect(env.PGHOST).toBe("::1");
    expect(env.PGPORT).toBe("5432");
    expect(env.PGUSER).toBeUndefined();
    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.PGDATABASE).toBeUndefined();
  });

  it("falls back to --dbname (flagged) for a URL parameter it cannot map, instead of dropping it", () => {
    const odd = "postgres://u:p@h/db?target_session_attrs=read-write";
    const { args, credentialInArgv } = buildPgDumpInvocation(odd, 5, {});
    expect(credentialInArgv).toBe(true);
    expect(args[0]).toBe(`--dbname=${odd}`);
  });

  it("falls back for a non-postgres string", () => {
    const { args, credentialInArgv } = buildPgDumpInvocation("host=localhost dbname=x", 5, {});
    expect(credentialInArgv).toBe(true);
    expect(args[0]).toBe("--dbname=host=localhost dbname=x");
  });
});
