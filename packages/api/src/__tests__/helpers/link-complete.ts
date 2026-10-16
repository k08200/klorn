/**
 * Drive an account-link OAuth flow the way a client does now: the GET callback
 * parks the code and redirects to `/link/complete#h=<handle>`, and the
 * starting user's own session redeems the handle through
 * POST /api/auth/link/complete. Returns the completion response, whose
 * `{ next }` is the path the callback used to redirect to.
 */

import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

const HANDLE_IN_LOCATION = /\/link\/complete#h=([0-9a-f]{64})$/;

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

/** The handle a parking callback handed back; fails the test when there is none. */
export function parkedHandle(callback: InjectResponse): string {
  expect(callback.statusCode).toBe(302);
  const handle = HANDLE_IN_LOCATION.exec(String(callback.headers.location ?? ""))?.[1];
  expect(handle, `callback did not park: ${callback.headers.location}`).toBeDefined();
  return handle as string;
}

export async function callbackThenComplete(
  app: Pick<FastifyInstance, "inject">,
  callbackUrl: string,
  headers: Record<string, string>,
): Promise<InjectResponse> {
  const callback = await app.inject({ method: "GET", url: callbackUrl });
  return app.inject({
    method: "POST",
    url: "/api/auth/link/complete",
    headers,
    payload: { handle: parkedHandle(callback) },
  });
}
