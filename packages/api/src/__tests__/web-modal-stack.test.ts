// Pins packages/web/src/lib/modal-stack.ts — the shared overlay stack and
// ref-counted scroll lock used by Sheet and the confirm dialog. Pure logic,
// run from the api suite because the web package has no unit-test runner
// (see web-tool-labels.test.ts).
import { describe, expect, it } from "vitest";
import {
  createModalStack,
  createScrollLock,
  isPlainEscape,
} from "../../../web/src/lib/modal-stack";

describe("createModalStack", () => {
  it("only the most recently opened overlay is on top", () => {
    const stack = createModalStack();
    const sheet = Symbol("sheet");
    const confirm = Symbol("confirm");
    stack.push(sheet);
    expect(stack.isTop(sheet)).toBe(true);
    stack.push(confirm);
    expect(stack.isTop(confirm)).toBe(true);
    expect(stack.isTop(sheet)).toBe(false);
    stack.remove(confirm);
    expect(stack.isTop(sheet)).toBe(true);
  });

  it("removing a lower overlay first keeps the top one on top", () => {
    const stack = createModalStack();
    const a = Symbol("a");
    const b = Symbol("b");
    stack.push(a);
    stack.push(b);
    stack.remove(a);
    expect(stack.top()).toBe(b);
    expect(stack.size()).toBe(1);
  });

  it("re-pushing a token moves it to the top without duplicating it", () => {
    const stack = createModalStack();
    const a = Symbol("a");
    const b = Symbol("b");
    stack.push(a);
    stack.push(b);
    stack.push(a);
    expect(stack.top()).toBe(a);
    expect(stack.size()).toBe(2);
  });

  it("an empty stack has no top", () => {
    const stack = createModalStack();
    expect(stack.top()).toBeUndefined();
    expect(stack.isTop(Symbol("x"))).toBe(false);
    stack.remove(Symbol("never-pushed"));
    expect(stack.size()).toBe(0);
  });
});

describe("createScrollLock", () => {
  it("locks on the first lease and restores the original value on the last", () => {
    const style = { overflow: "auto" };
    const lock = createScrollLock(() => style);
    const releaseA = lock.acquire();
    expect(style.overflow).toBe("hidden");
    const releaseB = lock.acquire();
    releaseA();
    expect(style.overflow).toBe("hidden");
    releaseB();
    expect(style.overflow).toBe("auto");
    expect(lock.count()).toBe(0);
  });

  it("restores correctly when overlays close in either order", () => {
    const style = { overflow: "" };
    const lock = createScrollLock(() => style);
    const releaseA = lock.acquire();
    const releaseB = lock.acquire();
    releaseB();
    releaseA();
    expect(style.overflow).toBe("");
  });

  it("release is idempotent", () => {
    const style = { overflow: "scroll" };
    const lock = createScrollLock(() => style);
    const releaseA = lock.acquire();
    const releaseB = lock.acquire();
    releaseA();
    releaseA();
    expect(lock.count()).toBe(1);
    expect(style.overflow).toBe("hidden");
    releaseB();
    expect(style.overflow).toBe("scroll");
  });
});

describe("isPlainEscape", () => {
  const key = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;
  it("accepts a plain Escape", () => {
    expect(isPlainEscape(key({ key: "Escape", isComposing: false, keyCode: 27 }))).toBe(true);
  });
  it("ignores Escape that ends an IME composition (Korean input)", () => {
    expect(isPlainEscape(key({ key: "Escape", isComposing: true, keyCode: 27 }))).toBe(false);
    expect(isPlainEscape(key({ key: "Escape", isComposing: false, keyCode: 229 }))).toBe(false);
  });
  it("ignores other keys", () => {
    expect(isPlainEscape(key({ key: "Tab", isComposing: false, keyCode: 9 }))).toBe(false);
  });
});
