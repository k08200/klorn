import { describe, expect, it } from "vitest";
import { withUtcSessionTimeZone } from "../db-url.js";

describe("withUtcSessionTimeZone", () => {
  it("appends the UTC timezone option to a bare postgres URL", () => {
    expect(withUtcSessionTimeZone("postgresql://u:p@host:5432/db")).toBe(
      "postgresql://u:p@host:5432/db?options=-c%20timezone%3DUTC",
    );
  });

  it("uses & when the URL already has a query string", () => {
    expect(withUtcSessionTimeZone("postgres://h/db?sslmode=require")).toBe(
      "postgres://h/db?sslmode=require&options=-c%20timezone%3DUTC",
    );
  });

  it("is a no-op when options or a timezone is already set", () => {
    const withOptions = "postgresql://h/db?options=-c%20search_path%3Dapp";
    expect(withUtcSessionTimeZone(withOptions)).toBe(withOptions);
    const withTz = "postgresql://h/db?timezone=UTC";
    expect(withUtcSessionTimeZone(withTz)).toBe(withTz);
  });

  it("is a no-op for non-postgres / empty URLs", () => {
    expect(withUtcSessionTimeZone(undefined)).toBeUndefined();
    expect(withUtcSessionTimeZone("")).toBe("");
    expect(withUtcSessionTimeZone("mysql://h/db")).toBe("mysql://h/db");
  });
});
