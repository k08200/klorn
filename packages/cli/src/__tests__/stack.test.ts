import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVersion, up, upgrade } from "../commands/stack.js";
import { CliError, UsageError } from "../errors.js";
import {
  GOOD_ENV,
  HEALTH_OK,
  harness,
  jsonResponse,
  type RecordedCall,
  runs,
  writeDump,
} from "./helpers.js";

const afterF = (call: RecordedCall) => call.argv.slice(call.argv.indexOf("-f") + 2).join(" ");

describe("parseVersion", () => {
  it("accepts semver, major.minor and latest, with or without a leading v", () => {
    expect(parseVersion("v0.4.1")).toEqual({ tag: "0.4.1", exact: true });
    expect(parseVersion("0.4")).toEqual({ tag: "0.4", exact: false });
    expect(parseVersion("latest")).toEqual({ tag: "latest", exact: false });
  });

  it("rejects anything else", () => {
    for (const bad of ["", "0.4.1;rm -rf /", "1.2.3.4", "0.4.1\nJWT_SECRET=x", "main"]) {
      expect(() => parseVersion(bad), bad).toThrow(UsageError);
    }
  });
});

describe("klorn up", () => {
  it("starts the stack and waits for a healthy API", async () => {
    const h = harness({ fetch: () => jsonResponse(HEALTH_OK) });
    await expect(up(h.ctx)).resolves.toBe(0);
    expect(h.calls.map(afterF)).toEqual(["up -d"]);
    expect(h.calls[0]?.opts).toEqual({ inherit: true });
    expect(h.out.join("\n")).toContain("0.4.0");
  });

  it("refuses to start a stack whose env would not boot", async () => {
    const h = harness({ envFile: GOOD_ENV.replace(/^JWT_SECRET=.*$/m, "JWT_SECRET=") });
    const err = await up(h.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(String(err)).toContain("JWT_SECRET");
    expect(h.calls).toEqual([]);
  });

  it("warns about a missing LLM provider but still starts (the API boots without one)", async () => {
    const h = harness({
      envFile: GOOD_ENV.replace(/^ANTHROPIC_API_KEY=.*$/m, "ANTHROPIC_API_KEY="),
      fetch: () => jsonResponse(HEALTH_OK),
    });
    await expect(up(h.ctx)).resolves.toBe(0);
    expect(h.err.join("\n")).toMatch(/warn: env\.llm_provider/);
  });

  it("refuses a missing env file", async () => {
    const h = harness({ envFile: null });
    await expect(up(h.ctx)).rejects.toThrow(/\.env\.selfhost/);
  });

  it("only manages the compose stack", async () => {
    const h = harness({ opts: { db: "postgresql://a@h/d" } });
    await expect(up(h.ctx)).rejects.toThrow(UsageError);
  });

  it("gives up when the API never turns healthy", async () => {
    const h = harness({
      opts: { timeoutSec: 10 },
      fetch: () => jsonResponse({ ...HEALTH_OK, status: "degraded", db: "unreachable" }),
    });
    await expect(up(h.ctx)).rejects.toThrow(/degraded/);
  });
});

interface UpgradeStack {
  current?: string | null;
  migrateFails?: boolean;
  newVersion?: string;
  newStatus?: "ok" | "degraded";
}

function upgradeStack({
  current = "0.4.0",
  migrateFails = false,
  newVersion = "0.4.1",
  newStatus = "ok",
}: UpgradeStack = {}) {
  const state = { recreated: false };
  const handler = (call: RecordedCall) => {
    if (runs(call, "pg_dump")) return writeDump(call);
    if (call.argv.includes("deploy")) return migrateFails ? { code: 1 } : {};
    if (call.argv.includes("--force-recreate")) state.recreated = true;
    return undefined;
  };
  const fetch = () => {
    if (!state.recreated && current === null) throw new TypeError("fetch failed");
    return jsonResponse({
      ...HEALTH_OK,
      status: state.recreated ? newStatus : "ok",
      version: state.recreated ? newVersion : current,
      uptime: state.recreated ? 3 : 9000,
    });
  };
  return { state, handler, fetch };
}

describe("klorn upgrade", () => {
  it("pulls, backs up, migrates with the new image, pins the version, restarts and waits for it", async () => {
    const s = upgradeStack();
    const h = harness({ handler: s.handler, fetch: s.fetch, opts: { yes: true } });
    await expect(upgrade(h.ctx, "v0.4.1")).resolves.toBe(0);
    const steps = h.calls.map((c) => (runs(c, "pg_dump") ? "backup" : afterF(c)));
    expect(steps).toEqual([
      "pull api web",
      "up -d --wait postgres",
      "backup",
      "run --rm --no-deps -T -w /app/packages/api api npx prisma migrate deploy",
      "up -d --force-recreate api web",
    ]);
    for (const c of h.calls.filter((c) => !runs(c, "pg_dump") && !afterF(c).includes("postgres"))) {
      expect(c.spec.env).toEqual({ KLORN_VERSION: "0.4.1" });
    }
    expect(h.calls.find((c) => runs(c, "pg_dump"))?.opts?.stdoutFile).toMatch(
      /pre-upgrade-0\.4\.1\.dump\.partial$/,
    );
    expect(readFileSync(join(h.repoRoot, ".env.selfhost"), "utf8")).toMatch(
      /^KLORN_VERSION=0\.4\.1$/m,
    );
    expect(h.out.join("\n")).toContain("0.4.1");
  });

  it("refuses without --yes in a non-interactive shell, before pulling", async () => {
    const s = upgradeStack();
    const h = harness({ handler: s.handler, fetch: s.fetch });
    await expect(upgrade(h.ctx, "0.4.1")).rejects.toThrow(/--yes/);
    expect(h.calls).toEqual([]);
  });

  it("refuses a downgrade unless --allow-downgrade", async () => {
    const s = upgradeStack({ current: "0.5.0" });
    const h = harness({ handler: s.handler, fetch: s.fetch, opts: { yes: true } });
    await expect(upgrade(h.ctx, "0.4.1")).rejects.toThrow(/downgrade/);
    expect(h.calls).toEqual([]);
    const h2 = harness({
      handler: s.handler,
      fetch: s.fetch,
      opts: { yes: true, allowDowngrade: true },
    });
    await expect(upgrade(h2.ctx, "0.4.1")).resolves.toBe(0);
  });

  it("stops before restarting when the migration fails, leaves the pin alone and explains the rollback", async () => {
    const s = upgradeStack({ migrateFails: true });
    const h = harness({ handler: s.handler, fetch: s.fetch, opts: { yes: true } });
    const err = await upgrade(h.ctx, "0.4.1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    // Pin first (the running version, since nothing was pinned), then restore.
    expect(String(err)).toMatch(
      /1\. set KLORN_VERSION=0\.4\.0 [\s\S]*2\. pnpm klorn backup restore '.*pre-upgrade-0\.4\.1\.dump' --target compose/,
    );
    expect(h.commands().some((c) => c.includes("--force-recreate"))).toBe(false);
    expect(readFileSync(join(h.repoRoot, ".env.selfhost"), "utf8")).not.toContain("KLORN_VERSION");
  });

  it("fails with the rollback steps when the new api never turns healthy", async () => {
    const s = upgradeStack({ newStatus: "degraded" });
    const h = harness({ handler: s.handler, fetch: s.fetch, opts: { yes: true, timeoutSec: 20 } });
    const err = await upgrade(h.ctx, "0.4.1").catch((e: unknown) => e);
    expect(String(err)).toMatch(/degraded/);
    expect(String(err)).toMatch(/set KLORN_VERSION=0\.4\.0/);
  });

  it("calls a healthy new api on another version a tag mismatch, not an outage", async () => {
    const s = upgradeStack({ newVersion: "0.4.0" });
    const h = harness({ handler: s.handler, fetch: s.fetch, opts: { yes: true, timeoutSec: 20 } });
    const err = await upgrade(h.ctx, "0.4.1").catch((e: unknown) => e);
    expect(String(err)).toMatch(/up and healthy but reports version 0\.4\.0, not 0\.4\.1/);
    expect(String(err)).not.toMatch(/to roll back/);
  });

  it("keeps an existing pin as the rollback target", async () => {
    const s = upgradeStack({ migrateFails: true });
    const h = harness({
      envFile: `${GOOD_ENV}KLORN_VERSION=0.3.9\n`,
      handler: s.handler,
      fetch: s.fetch,
      opts: { yes: true },
    });
    const err = await upgrade(h.ctx, "0.4.1").catch((e: unknown) => e);
    expect(String(err)).toMatch(/set KLORN_VERSION=0\.3\.9/);
  });

  it("refuses an X.Y downgrade and ignores a running version it cannot compare", async () => {
    const lower = upgradeStack({ current: "0.4.2" });
    const h = harness({ handler: lower.handler, fetch: lower.fetch, opts: { yes: true } });
    await expect(upgrade(h.ctx, "0.3")).rejects.toThrow(/downgrade/);
    const dev = upgradeStack({ current: "0.5.0-rc.1" });
    const h2 = harness({ handler: dev.handler, fetch: dev.fetch, opts: { yes: true } });
    await expect(upgrade(h2.ctx, "0.4.1")).resolves.toBe(0);
    expect(h2.err.join("\n")).toMatch(/skipping the downgrade check/);
  });

  it("upgrades when the API is down (version unknown)", async () => {
    const s = upgradeStack({ current: null });
    const h = harness({ handler: s.handler, fetch: s.fetch, opts: { yes: true } });
    await expect(upgrade(h.ctx, "0.4.1")).resolves.toBe(0);
    expect(h.err.join("\n")).toMatch(/not answering/);
  });

  it("explains the rollback when the version cannot be pinned after migrating", async () => {
    const s = upgradeStack();
    const h = harness({ handler: s.handler, fetch: s.fetch, opts: { yes: true } });
    chmodSync(h.repoRoot, 0o555);
    try {
      const err = await upgrade(h.ctx, "0.4.1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect(String(err)).toMatch(/could not pin KLORN_VERSION[\s\S]*to roll back/);
      expect(h.commands().some((c) => c.includes("--force-recreate"))).toBe(false);
    } finally {
      chmodSync(h.repoRoot, 0o755);
    }
  });

  it("skips the backup with --no-backup", async () => {
    const s = upgradeStack();
    const h = harness({ handler: s.handler, fetch: s.fetch, opts: { yes: true, noBackup: true } });
    await expect(upgrade(h.ctx, "0.4.1")).resolves.toBe(0);
    expect(h.calls.some((c) => runs(c, "pg_dump"))).toBe(false);
  });

  it("accepts latest without an exact version to wait for", async () => {
    const s = upgradeStack({ newVersion: "0.4.3" });
    const h = harness({ handler: s.handler, fetch: s.fetch, opts: { yes: true } });
    await expect(upgrade(h.ctx, "latest")).resolves.toBe(0);
  });
});
