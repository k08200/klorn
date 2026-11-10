/**
 * A fetch shim that answers the API from fixtures — no network, no MSW
 * service worker (which a Capacitor WebView would not run anyway). Used by
 * `vite --mode mock` (Playwright screenshots, design review) and unit tests.
 * Only loaded through a dynamic import guarded by MOCK_API, so it is not in
 * the production bundle.
 *
 * Scenario (`?scenario=` once, then remembered for the tab):
 *   default | empty | error | offline | loading | noAccounts | signedOut
 *   flagsOff (Mail's dark routes 404) | draftUnavailable (reply drafting 503)
 *   sendReceipts (MANUAL_SEND_RECEIPTS_ENABLED on: sends answer with a server receipt)
 *   featuresOff (every flag-gated route as production's defaults answer it — Mail's too)
 */
import type { Transport } from "../client";
import {
  MOCK_INBOXES,
  MOCK_LANE_COUNTS,
  MOCK_USER,
  mockEvents,
  mockFirewall,
  mockPendingActions,
} from "./fixtures";
import { createMailMockState, mockMailRoute } from "./mail-transport";
import { handleHub } from "./routes-hub";

export const MOCK_SCENARIOS = [
  "default",
  "empty",
  "error",
  "offline",
  "loading",
  "noAccounts",
  "signedOut",
  "flagsOff",
  "draftUnavailable",
  "featuresOff",
  "sendReceipts",
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export const MOCK_TOKEN = "mock-session-token";
const SCENARIO_KEY = "klorn-mock-scenario";

export function currentScenario(): MockScenario {
  if (typeof window === "undefined") return "default";
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("scenario");
    if (fromUrl && (MOCK_SCENARIOS as readonly string[]).includes(fromUrl)) {
      window.sessionStorage.setItem(SCENARIO_KEY, fromUrl);
    }
    const stored = window.sessionStorage.getItem(SCENARIO_KEY);
    return stored && (MOCK_SCENARIOS as readonly string[]).includes(stored)
      ? (stored as MockScenario)
      : "default";
  } catch {
    return "default";
  }
}

function signupIsClosed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("signup") === "closed";
  } catch {
    return false;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface MockOptions {
  scenario?: () => MockScenario;
  now?: () => number;
  /** Artificial latency, so loading states are visible in dev. */
  latencyMs?: number;
}

export function createMockTransport(options: MockOptions = {}): Transport {
  const scenarioOf = options.scenario ?? currentScenario;
  const nowOf = options.now ?? (() => Date.now());
  const latency = options.latencyMs ?? 0;
  const mailState = createMailMockState();
  // Playwright reads what the app sent (mock builds only — this module never ships).
  if (typeof window !== "undefined") {
    (window as unknown as { __klornMailMock?: unknown }).__klornMailMock = mailState;
  }

  return async (url, init) => {
    const scenario = scenarioOf();
    const { pathname, searchParams } = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const authed = headers.get("Authorization") === `Bearer ${MOCK_TOKEN}`;
    const now = nowOf();

    if (scenario === "offline") throw new TypeError("Failed to fetch");
    if (latency) await new Promise((r) => setTimeout(r, latency));

    // ── Auth (public) ────────────────────────────────────────────────────
    if (pathname === "/api/auth/providers") {
      return json(200, { providers: [{ id: "google" }, { id: "apple" }] });
    }
    if (pathname === "/api/auth/login" && method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { password?: string };
      if (!body.password || body.password.length < 8) {
        return json(401, { error: "Invalid email or password" });
      }
      return json(200, { token: MOCK_TOKEN, user: MOCK_USER });
    }
    if (pathname === "/api/auth/logout") return json(200, { success: true });
    // Sign-up (routes/auth.ts). `?signup=closed` = BETA_GATE_ENABLED: invite-only,
    // and only an approved waitlist address (here: …@approved.example) may register.
    const signupClosed = signupIsClosed();
    if (pathname === "/api/auth/signup-status") return json(200, { open: !signupClosed });
    if (pathname === "/api/auth/register" && method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as {
        email?: string;
        password?: string;
        name?: string;
      };
      const email = (body.email ?? "").trim().toLowerCase();
      if (!email || !body.password) return json(400, { error: "Email and password required" });
      if (body.password.length < 8) {
        return json(400, { error: "Password must be at least 8 characters" });
      }
      if (signupClosed && !email.endsWith("@approved.example")) {
        return json(403, {
          error: "Early access is invite-only. Request access at /early-access.",
        });
      }
      if (email === MOCK_USER.email) return json(409, { error: "Email already registered" });
      return json(201, {
        token: MOCK_TOKEN,
        user: { ...MOCK_USER, email, name: body.name ?? email.split("@")[0] ?? null, plan: "FREE" },
      });
    }

    if (!authed) return json(401, { error: "Not authenticated" });

    if (scenario === "loading") return new Promise<Response>(() => {});
    if (scenario === "error") return json(500, { error: "Internal Server Error" });

    const empty = scenario === "empty" || scenario === "noAccounts";

    // Calendar, Assistant, Files, Accounts, Settings, Push, Plans (routes-hub.ts).
    // First: it answers the "Mail attachments" source's /api/email reads and
    // falls through for everything else, which Mail's routes then take.
    const hub = handleHub({ pathname, searchParams, method, body: init.body, scenario, now });
    if (hub) return hub;

    const mail = mockMailRoute({
      pathname,
      searchParams,
      method,
      init,
      now,
      scenario,
      state: mailState,
    });
    if (mail) return mail;

    // ── Authenticated reads ──────────────────────────────────────────────
    switch (pathname) {
      case "/api/auth/me":
        return json(200, {
          user: { ...MOCK_USER, hasAnyMailSource: scenario !== "noAccounts" },
        });
      case "/api/inbox/firewall":
        return json(200, mockFirewall(now, empty));
      case "/api/email/lane-counts":
        if (scenario === "noAccounts" || scenario === "empty") {
          const zero = { total: 0, unread: 0, threads: 0 };
          return json(200, {
            counts: { PUSH: zero, MEETING: zero, QUEUE: zero, INFO: zero, SILENT: zero },
            source: scenario === "noAccounts" ? "demo" : "gmail",
            ...(scenario === "noAccounts" ? { needsConnection: true } : {}),
          });
        }
        return json(200, MOCK_LANE_COUNTS);
      case "/api/email/inboxes":
        return json(
          200,
          scenario === "noAccounts" ? { ...MOCK_INBOXES, inboxes: [] } : MOCK_INBOXES,
        );
      case "/api/calendar":
        return json(200, { events: mockEvents(now, empty) });
      case "/api/chat/pending-actions":
        return json(200, { actions: mockPendingActions(now, empty) });
      case "/api/briefing/status":
        return json(200, {
          date: new Date(now).toISOString().slice(0, 10),
          generated: false,
          note: null,
          notification: null,
          push: {
            state: "not_sent",
            reason: null,
            deliveryId: null,
            acceptedAt: null,
            receivedAt: null,
            clickedAt: null,
          },
          automation: {
            configured: true,
            enabled: true,
            briefingTime: "08:00",
            timezone: "Asia/Seoul",
            reason: null,
          },
        });
      default:
        break;
    }
    return json(404, { error: `Mock has no route for ${method} ${pathname}` });
  };
}
