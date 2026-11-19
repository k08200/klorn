/**
 * klorn.ai's landing pages carry one inline script that sends a first visit to
 * the root to the reader's language: Korean to /ko/, Chinese to /zh/ (the site
 * ships Simplified only, so every Chinese locale goes there). A language the
 * reader picked in the menu always wins, the redirect fires at most once per
 * browser session, deep links stay put, and a client that states no language
 * list (navigator.languages) is never redirected.
 *
 * The script is inline in website/index.html and copied into the ko and zh
 * landings, so this runs the copy each page ships in a sandbox with a fake
 * browser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const PAGES = ["website/index.html", "website/ko/index.html", "website/zh/index.html"] as const;
const SCRIPT_START = "// Language: follow the browser preference";
const SCRIPT_END = "})();";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), "utf8");
}

function redirectScript(rel: string): string {
  const html = read(rel);
  const start = html.indexOf(SCRIPT_START);
  expect(start, `${rel} carries the language redirect`).toBeGreaterThan(-1);
  const end = html.indexOf(SCRIPT_END, start);
  expect(end, `${rel}'s language redirect ends with ${SCRIPT_END}`).toBeGreaterThan(start);
  return html.slice(start, end + SCRIPT_END.length);
}

interface Visit {
  languages?: readonly string[];
  language?: string;
  path?: string;
  stored?: string | null;
  triedThisSession?: boolean;
  /** A language-menu link on the page, as its data-lang-pick value. */
  menuPick?: string;
}

interface VisitResult {
  /** Where the script sent the browser, or null. */
  to: string | null;
  local: Map<string, string>;
  session: Map<string, string>;
  /** Click the menu link given as `menuPick`. */
  clickMenuPick: () => void;
}

/** Run the page's script as one page load in a fake browser. */
function load(rel: string, v: Visit): VisitResult {
  let to: string | null = null;
  const local = new Map<string, string>();
  if (v.stored) local.set("klorn.lang", v.stored);
  const session = new Map<string, string>();
  if (v.triedThisSession) session.set("klorn.lang.tried", "1");
  const storage = (m: Map<string, string>) => ({
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, value: string) => m.set(k, value),
  });
  const clicks: Array<() => void> = [];
  const menuLinks = v.menuPick
    ? [
        {
          getAttribute: (name: string) => (name === "data-lang-pick" ? v.menuPick : null),
          addEventListener: (type: string, handler: () => void) => {
            if (type === "click") clicks.push(handler);
          },
        },
      ]
    : [];
  runInNewContext(redirectScript(rel), {
    document: {
      querySelectorAll: (selector: string) => (selector === "[data-lang-pick]" ? menuLinks : []),
    },
    localStorage: storage(local),
    sessionStorage: storage(session),
    navigator: { languages: v.languages, language: v.language },
    location: {
      protocol: "https:",
      pathname: v.path ?? "/",
      replace: (target: string) => {
        to = target;
      },
    },
  });
  return {
    to,
    local,
    session,
    clickMenuPick: () => {
      for (const click of clicks) click();
    },
  };
}

/** The path one page load redirected to, or null. */
function visit(rel: string, v: Visit): string | null {
  return load(rel, v).to;
}

describe("landing language redirect", () => {
  it("ships the same script on every landing", () => {
    const [en, ...others] = PAGES.map(redirectScript);
    for (const copy of others) expect(copy).toBe(en);
  });

  describe.each(PAGES)("%s", (page) => {
    it.each([
      ["zh", "/zh/"],
      ["zh-CN", "/zh/"],
      ["zh-Hans", "/zh/"],
      ["zh-Hans-CN", "/zh/"],
      ["zh-SG", "/zh/"],
      ["zh-TW", "/zh/"],
      ["zh-HK", "/zh/"],
      ["zh-Hant", "/zh/"],
      ["ZH-cn", "/zh/"],
      ["ko", "/ko/"],
      ["ko-KR", "/ko/"],
    ])("sends a first visit to / in %s to %s", (language, target) => {
      expect(visit(page, { languages: [language, "en-US"] })).toBe(target);
      expect(visit(page, { languages: [language], path: "/index.html" })).toBe(target);
    });

    it.each([
      ["en-US"],
      ["en"],
      ["ja-JP"],
      ["fr"],
      ["kok"],
      ["zhx"],
      [""],
    ])("keeps %j on the English page", (language) => {
      expect(visit(page, { languages: [language] })).toBeNull();
    });

    it("follows the first language only", () => {
      expect(visit(page, { languages: ["en-US", "zh-CN"] })).toBeNull();
    });

    it("never redirects after a pick in the language menu", () => {
      expect(visit(page, { languages: ["zh-CN"], stored: "en" })).toBeNull();
      expect(visit(page, { languages: ["en-US"], stored: "zh" })).toBeNull();
    });

    it("redirects at most once per browser session", () => {
      const first = load(page, { languages: ["zh-CN"] });
      expect(first.to).toBe("/zh/");
      expect(first.session.get("klorn.lang.tried")).toBe("1");
      expect(load(page, { languages: ["en-US"] }).session.has("klorn.lang.tried")).toBe(false);
      // Marked only when it actually redirects, never before the other checks.
      const deepLink = load(page, { languages: ["zh-CN"], path: "/pricing/" });
      expect(deepLink.session.has("klorn.lang.tried")).toBe(false);
      const picked = load(page, { languages: ["zh-CN"], stored: "en" });
      expect(picked.session.has("klorn.lang.tried")).toBe(false);
      expect(visit(page, { languages: ["zh-CN"], triedThisSession: true })).toBeNull();
    });

    it("remembers a pick in the language menu", () => {
      const loaded = load(page, { languages: ["en-US"], path: "/zh/", menuPick: "zh" });
      expect(loaded.local.has("klorn.lang")).toBe(false);
      loaded.clickMenuPick();
      expect(loaded.local.get("klorn.lang")).toBe("zh");
    });

    it("lets a reader change an earlier pick", () => {
      const loaded = load(page, { languages: ["en-US"], stored: "en", menuPick: "ko" });
      loaded.clickMenuPick();
      expect(loaded.local.get("klorn.lang")).toBe("ko");
    });

    it("leaves a deep link where it points", () => {
      expect(visit(page, { languages: ["zh-CN"], path: "/pricing/" })).toBeNull();
      expect(visit(page, { languages: ["zh-CN"], path: "/zh/" })).toBeNull();
    });

    it("never redirects a client that states no language list", () => {
      expect(visit(page, { language: "zh-CN" })).toBeNull();
      expect(visit(page, { languages: [], language: "ko-KR" })).toBeNull();
    });
  });
});
