import type { Locator, Page } from "@playwright/test";

/** A horizontal drag with the mouse (Pointer Events: the same path as touch). */
export async function swipe(page: Page, target: Locator, dx: number, steps = 12): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("swipe target not visible");
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x + (dx * i) / steps, y + (i % 2), { steps: 1 });
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

/** Drag without releasing (the mid-swipe artboard state); returns a release function. */
export async function holdSwipe(
  page: Page,
  target: Locator,
  dx: number,
): Promise<() => Promise<void>> {
  const box = await target.boundingBox();
  if (!box) throw new Error("swipe target not visible");
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(x + (dx * i) / 10, y, { steps: 1 });
    await page.waitForTimeout(16);
  }
  return async () => {
    await page.mouse.up();
  };
}

export interface MailMockState {
  dismissed: string[];
  snoozed: Array<[string, string]>;
  pins: Array<{ emailId: string; tier: string }>;
  /** `from` = the linked inbox a new mail left from (absent = primary). */
  sent: Array<{ to: string; subject: string; body: string; from?: string }>;
  tiers: Array<[string, string]>;
  unsubscribed: string[];
}

export async function mockState(page: Page): Promise<MailMockState> {
  return page.evaluate(() => {
    const s = (window as unknown as { __klornMailMock: Record<string, unknown> }).__klornMailMock;
    const arr = (v: unknown) => (v instanceof Set || v instanceof Map ? [...v] : v);
    return {
      dismissed: arr(s.dismissed),
      snoozed: arr(s.snoozed),
      pins: s.pins,
      sent: s.sent,
      tiers: arr(s.tiers),
      unsubscribed: arr(s.unsubscribed),
    } as never;
  });
}
