/**
 * Who may ask the browser for notification permission (packages/web/src).
 *
 * PushRegister (components/push-register.tsx) runs on every signed-in page
 * load and used to call Notification.requestPermission() there, with no user
 * gesture: browsers that require one ignore or auto-deny it, and Chrome counts
 * ignored prompts toward quieting the site's prompts for good. The prompt now
 * comes only from the two buttons that explain it: the onboarding banner's
 * Enable and the settings toggle. PushRegister only refreshes a subscription
 * the user already granted.
 *
 * The scan reads every web source file; a new caller is a product decision —
 * add it here with the button that triggers it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_SRC = join(__dirname, "../../../web/src");

/** Files allowed to prompt, each from a click handler. */
const PROMPTERS = new Set([
  // "Enable" on the push onboarding banner.
  "components/push-onboarding-banner.tsx",
  // The push toggle in Settings → Notifications.
  "app/settings/_sections/use-push.ts",
]);

// Notification.requestPermission (also as window.Notification…) and
// Notification["requestPermission"]. An alias or destructuring would slip past
// this scan; none exists, and a reviewer should refuse one.
const PROMPT =
  /Notification\s*\.\s*requestPermission\b|Notification\s*\[\s*["']requestPermission["']\s*\]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : [];
  });
}

describe("web notification permission prompts", () => {
  const callers = sourceFiles(WEB_SRC)
    .filter((file) => PROMPT.test(readFileSync(file, "utf8")))
    .map((file) => relative(WEB_SRC, file).split("\\").join("/"))
    .sort();

  it("only the onboarding banner and the settings toggle prompt", () => {
    expect(callers).toEqual([...PROMPTERS].sort());
  });

  it("PushRegister never prompts on page load", () => {
    const source = readFileSync(join(WEB_SRC, "components/push-register.tsx"), "utf8");
    expect(source).not.toMatch(/requestPermission/);
  });

  it("PushRegister refreshes a subscription only once permission is granted", () => {
    const source = readFileSync(join(WEB_SRC, "components/push-register.tsx"), "utf8");
    expect(source).toMatch(/Notification\.permission\s*!==\s*"granted"/);
  });
});
