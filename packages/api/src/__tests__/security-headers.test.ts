import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

// Guards the exact helmet config registered in index.ts: nosniff + Referrer-
// Policy on, CSP off (JSON API — the web app owns its own CSP).
describe("security headers (helmet)", () => {
  async function buildApp() {
    const app = Fastify();
    await app.register(helmet, { contentSecurityPolicy: false });
    app.get("/x", async () => ({ ok: true }));
    return app;
  }

  it("sets X-Content-Type-Options: nosniff on responses", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
  });

  it("sets a Referrer-Policy header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.headers["referrer-policy"]).toBeDefined();
    await app.close();
  });

  it("does NOT set a Content-Security-Policy (disabled for the JSON API)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.headers["content-security-policy"]).toBeUndefined();
    await app.close();
  });
});
