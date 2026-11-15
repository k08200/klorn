import { describe, expect, it } from "vitest";
import { databaseUrlFor, HOSTED_PROD_REF, looksLikeHostedProd, parseDbSpec } from "../db/target.js";
import { UsageError } from "../errors.js";

const none = () => undefined;
const lookupOf =
  (vars: Record<string, string>) =>
  (name: string): string | undefined =>
    vars[name];

describe("parseDbSpec", () => {
  it("resolves `compose` to the bundled compose Postgres", () => {
    const target = parseDbSpec("compose", none);
    expect(target).toMatchObject({ kind: "compose", user: "klorn", database: "klorn" });
    expect(target.label).toBe("compose postgres (klorn)");
  });

  it("reads a URL from the named environment variable and keeps the password out of the label", () => {
    const target = parseDbSpec(
      "env:MY_DB",
      lookupOf({ MY_DB: "postgresql://app:s3cr%40t@db.example.test:6543/klorn?sslmode=require" }),
    );
    expect(target.kind).toBe("url");
    if (target.kind !== "url") throw new Error("unreachable");
    expect(target.conn).toEqual({
      host: "db.example.test",
      port: "6543",
      user: "app",
      database: "klorn",
      password: "s3cr@t",
      sslmode: "require",
      sslrootcert: null,
      connectTimeout: null,
    });
    expect(target.label).toBe("db.example.test:6543/klorn");
    expect(target.label).not.toContain("s3cr");
    expect(target.label).not.toContain("app");
  });

  it("defaults the port to 5432", () => {
    const target = parseDbSpec("postgres://app@localhost/klorn", none);
    if (target.kind !== "url") throw new Error("expected url target");
    expect(target.conn.port).toBe("5432");
    expect(target.conn.password).toBeNull();
  });

  it("refuses a password on the command line, where ps can read it", () => {
    expect(() => parseDbSpec("postgresql://app:hunter2@localhost/klorn", none)).toThrow(UsageError);
    try {
      parseDbSpec("postgresql://app:hunter2@localhost/klorn", none);
    } catch (err) {
      expect(String(err)).toMatch(/PGPASSWORD|pgpass|env:/);
      expect(String(err)).not.toContain("hunter2");
    }
  });

  it("refuses a password passed as a query parameter on the command line", () => {
    expect(() => parseDbSpec("postgresql://app@localhost/klorn?password=hunter2", none)).toThrow(
      UsageError,
    );
  });

  it("reports a malformed %-escape as a usage error without echoing the value", () => {
    try {
      parseDbSpec("env:U", lookupOf({ U: "postgresql://app:50%off@localhost/klorn" }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect(String(err)).not.toContain("50%off");
    }
  });

  it("names a missing environment variable without echoing anything else", () => {
    expect(() => parseDbSpec("env:NOPE_DB", none)).toThrow(/NOPE_DB is not set/);
  });

  it("rejects an invalid environment variable name", () => {
    expect(() => parseDbSpec("env:bad-name", none)).toThrow(UsageError);
  });

  it("rejects a non-Postgres URL without echoing its value", () => {
    try {
      parseDbSpec("env:X", lookupOf({ X: "mysql://root:topsecret@h/db" }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect(String(err)).not.toContain("topsecret");
    }
  });

  it("rejects a URL with no database name", () => {
    expect(() => parseDbSpec("postgresql://app@localhost/", none)).toThrow(/database name/);
  });

  it("rejects a database name that libpq would read as a connection string", () => {
    expect(() => parseDbSpec("postgresql://app@localhost/host%3Devil", none)).toThrow(UsageError);
  });

  it("rejects anything that is not compose, env:VAR or a postgres URL", () => {
    expect(() => parseDbSpec("klorn", none)).toThrow(UsageError);
    expect(() => parseDbSpec("", none)).toThrow(UsageError);
  });
});

describe("looksLikeHostedProd", () => {
  it("flags the hosted project ref in a pooler username", () => {
    const target = parseDbSpec(
      "env:U",
      lookupOf({
        U: `postgresql://postgres.${HOSTED_PROD_REF}:pw@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres`,
      }),
    );
    expect(looksLikeHostedProd(target)).toBe(true);
  });

  it("flags the hosted project ref in a direct host, in any case", () => {
    const target = parseDbSpec(
      `postgresql://postgres@db.${HOSTED_PROD_REF.toUpperCase()}.supabase.co/postgres`,
      none,
    );
    expect(looksLikeHostedProd(target)).toBe(true);
  });

  it("flags a %-escaped project ref that the connection would decode", () => {
    const escaped = `postgres.${HOSTED_PROD_REF.replace("a", "%61")}`;
    const target = parseDbSpec(
      "env:U",
      lookupOf({
        U: `postgresql://${escaped}:pw@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`,
      }),
    );
    expect(target.kind === "url" && target.url.href.includes(HOSTED_PROD_REF)).toBe(false);
    expect(looksLikeHostedProd(target)).toBe(true);
  });

  it("does not flag another Supabase project or the compose database", () => {
    const other = parseDbSpec(
      "postgresql://postgres@db.abcdefghijklmnopqrst.supabase.co/postgres",
      none,
    );
    expect(looksLikeHostedProd(other)).toBe(false);
    expect(looksLikeHostedProd(parseDbSpec("compose", none))).toBe(false);
  });
});

describe("databaseUrlFor", () => {
  it("returns the URL with its own password", () => {
    const target = parseDbSpec("env:U", lookupOf({ U: "postgresql://a:b@h:5432/d" }));
    if (target.kind !== "url") throw new Error("expected url target");
    expect(databaseUrlFor(target, {})).toBe("postgresql://a:b@h:5432/d");
  });

  it("fills a password-less URL from PGPASSWORD, encoded", () => {
    const target = parseDbSpec("postgresql://a@h/d", none);
    if (target.kind !== "url") throw new Error("expected url target");
    expect(databaseUrlFor(target, { PGPASSWORD: "p@ss:w/rd" })).toBe(
      "postgresql://a:p%40ss%3Aw%2Frd@h/d",
    );
  });
});
