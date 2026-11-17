import { afterEach, describe, expect, it, vi } from "vitest";
import { isAdminEmail } from "../auth.js";

describe("isAdminEmail audit line", () => {
  const saved = process.env.ADMIN_EMAILS;

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = saved;
  });

  it("names the admitted account by user id, never the address", () => {
    process.env.ADMIN_EMAILS = "first.admin@example.com, , Second.Admin@Example.com";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(isAdminEmail(" second.admin@example.com", "user-2")).toBe(true);
    expect(isAdminEmail("nobody@example.com", "user-9")).toBe(false);

    const lines = log.mock.calls.map((args) => args.map(String).join(" "));
    expect(lines).toEqual(["[AUDIT][ADMIN_ENV] env-granted admin access for user user-2"]);
    for (const line of lines) expect(line.toLowerCase()).not.toContain("admin@example.com");
  });
});
