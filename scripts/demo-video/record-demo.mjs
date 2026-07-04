// Klorn mock-data product demo recorder (Playwright, password login — no Google OAuth).
// Logs "SCENE <name> <seconds>" boundaries so captions can be burned precisely.
import { chromium } from "playwright";

const BASE = "https://app.klorn.ai";
const EMAIL = process.env.DEMO_EMAIL || "";
const PASSWORD = process.env.DEMO_PW || "";
const OUT_DIR = new URL("./videos/", import.meta.url).pathname;
if (!EMAIL || !PASSWORD) { console.error("Set DEMO_EMAIL and DEMO_PW"); process.exit(1); }

const t0 = Date.now();
const mark = (name) => console.log(`SCENE ${name} ${((Date.now() - t0) / 1000).toFixed(1)}`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake cursor so the recording shows pointer movement (headless has no OS cursor).
const CURSOR_JS = `
  (() => {
    const d = document.createElement('div');
    d.id = '__cur';
    d.style.cssText = 'position:fixed;z-index:2147483647;width:18px;height:18px;border-radius:50%;background:rgba(252,211,77,.85);box-shadow:0 0 0 3px rgba(0,0,0,.35);pointer-events:none;top:0;left:0;transition:transform .05s linear';
    const add = () => document.body && document.body.appendChild(d);
    document.body ? add() : addEventListener('DOMContentLoaded', add);
    addEventListener('mousemove', (e) => { d.style.transform = 'translate(' + (e.clientX-9) + 'px,' + (e.clientY-9) + 'px)'; }, true);
  })();
`;

async function smoothClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box for locator");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
  await pause(350);
  await locator.click();
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  recordVideo: { dir: OUT_DIR, size: { width: 1600, height: 1000 } },
});
const page = await ctx.newPage();
await page.addInitScript(CURSOR_JS);

try {
  // ── login ──
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  mark("login");
  await pause(1500);
  await page.getByLabel(/email/i).fill(EMAIL);
  await pause(400);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await pause(400);
  await smoothClick(page, page.getByRole("button", { name: /open decision queue/i }));
  await page.waitForURL(/\/inbox/, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
  await pause(1500);
  // dismiss tour card if present
  const dismiss = page.getByRole("button", { name: /dismiss/i });
  if (await dismiss.isVisible().catch(() => false)) { await dismiss.click(); await pause(500); }

  // ── firewall board ──
  mark("firewall");
  await smoothClick(page, page.getByRole("tab", { name: /firewall board/i }).or(page.getByRole("button", { name: /firewall board/i })).first());
  await page.waitForLoadState("networkidle");
  await pause(4500);
  await page.mouse.wheel(0, 300); await pause(2000);
  await page.mouse.wheel(0, -300); await pause(1000);

  // ── mail list ──
  mark("mail_list");
  await smoothClick(page, page.getByRole("link", { name: /^mail$/i }).first());
  await page.waitForURL(/\/email/, { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  await pause(1200);
  await smoothClick(page, page.getByRole("button", { name: "All signals", exact: true }));
  await pause(3000);

  // ── open urgent mail + judgment ──
  mark("judgment");
  const mailLink = page.locator('a[href*="/email/"]:visible').filter({ hasText: /3pm sync/i }).first();
  await mailLink.scrollIntoViewIfNeeded();
  await smoothClick(page, mailLink);
  await page.waitForURL(/\/email\/[a-f0-9-]+/, { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  await pause(2000);
  const judgment = page.getByText(/klorn judgment/i).first();
  await judgment.scrollIntoViewIfNeeded();
  const jb = await judgment.boundingBox();
  if (jb) await page.mouse.move(jb.x + 60, jb.y + 40, { steps: 20 });
  await pause(4000);

  // ── draft reply ──
  mark("draft");
  const draftBtn = page.getByRole("button", { name: /draft reply/i }).first();
  await draftBtn.scrollIntoViewIfNeeded();
  await smoothClick(page, draftBtn);
  await page.getByRole("button", { name: /send this reply/i }).waitFor({ timeout: 90000 });
  await pause(3500);
  mark("send");
  await smoothClick(page, page.getByRole("button", { name: /send this reply/i }));
  await pause(4000);

  // ── calendar ──
  mark("calendar");
  await smoothClick(page, page.getByRole("link", { name: /^calendar$/i }).first());
  await page.waitForURL(/\/calendar/, { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  await pause(3500);

  // ── new event ──
  mark("new_event");
  await smoothClick(page, page.getByRole("button", { name: /new event/i }).first());
  await page.getByLabel(/title/i).waitFor({ timeout: 10000 });
  await pause(600);
  await page.getByLabel(/title/i).fill("Coffee with Alex");
  await pause(600);
  await smoothClick(page, page.getByRole("button", { name: /create event/i }));
  await pause(4000);

  // ── settings/connections ──
  mark("settings");
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await pause(1000);
  const conn = page.getByText(/^connections$/i).first();
  await conn.scrollIntoViewIfNeeded();
  await pause(3500);

  mark("end");
  await pause(1500);
} catch (err) {
  console.error("RECORD_FAIL:", err.message);
  await page.screenshot({ path: `${OUT_DIR}/fail.png` }).catch(() => {});
} finally {
  await ctx.close(); // flushes video
  await browser.close();
}
console.log("DONE");
