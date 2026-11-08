/**
 * Guard: every web "Later" posts to the route that exists —
 * POST /api/email/:id/later (routes/email-later.ts) with only the chosen time.
 * PIM HTTP routes left in #430, and for months every in-app Later answered 404
 * from a POST /api/reminders nobody served.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = resolve(__dirname, "../../../web/src");
const read = (path: string) => readFileSync(resolve(WEB, path), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("web Later → POST /api/email/:id/later", () => {
  it("no web source calls the removed /api/reminders route", () => {
    const offenders = sourceFiles(WEB).filter((file) =>
      readFileSync(file, "utf8").includes("/api/reminders"),
    );
    expect(offenders).toEqual([]);
  });

  it("postReminder posts only the chosen time to the mail's later route", () => {
    const src = read("app/email/_v2/post-reminder.ts");
    expect(src).toContain("/api/email/${encodeURIComponent(emailId)}/later");
    expect(src).toMatch(
      /JSON\.stringify\(\{ remindAt: reminderDate\(key, now\)\.toISOString\(\) \}\)/,
    );
    expect(src).not.toMatch(/title:|description:/);
  });

  it("the reader and the legacy list use the shared postReminder", () => {
    for (const path of ["app/email/[id]/page.tsx", "app/email/page.tsx"]) {
      expect(read(path)).toMatch(/postReminder\(/);
    }
  });

  it("every caller toasts success only after the post resolves, and shows an error otherwise", () => {
    for (const path of [
      "app/email/_v2/use-mail-actions.ts",
      "app/today/reply-later-card.tsx",
      "app/email/[id]/page.tsx",
      "app/email/page.tsx",
    ]) {
      const src = read(path);
      const call = src.indexOf("await postReminder(");
      expect(call, path).toBeGreaterThan(-1);
      const tryBlock = src.slice(src.lastIndexOf("try {", call), call);
      expect(tryBlock, path).toContain("try {");
      const after = src.slice(call, call + 900);
      const success = after.indexOf('"success"');
      const fail = after.indexOf("catch (err)");
      expect(success, path).toBeGreaterThan(-1);
      expect(fail, path).toBeGreaterThan(success);
      expect(after.slice(fail, fail + 400), path).toMatch(/setError\(|"error"\)/);
    }
  });
});
