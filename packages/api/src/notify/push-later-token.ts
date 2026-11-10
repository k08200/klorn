/**
 * "Later" capability for a web push action button (decision N1). The service
 * worker has no session, so the push carries a signed token naming exactly one
 * (user, email); POST /api/notifications/push/later sets the reminder for it.
 *
 * Same construction as billing/tier-override-token.ts, with its own purpose
 * string, so this token, a tier-override token and a session JWT can never be
 * replayed as one another. The grant is narrow and idempotent (one pending
 * reminder per mail, for the token's own user), so possession is the
 * authorization, for at most TOKEN_TTL.
 */

import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { resolveEffectiveJwtSecret } from "../auth.js";

const LATER_SECRET = createHmac("sha256", resolveEffectiveJwtSecret())
  .update("push-later-v1")
  .digest("hex");

// Matches the tier-override token: a notification may sit unread for days.
const TOKEN_TTL = "7d";
const TOKEN_KIND = "push-later";

export interface PushLaterGrant {
  userId: string;
  emailId: string;
}

export function mintPushLaterToken(userId: string, emailId: string): string {
  return jwt.sign({ kind: TOKEN_KIND, userId, emailId }, LATER_SECRET, { expiresIn: TOKEN_TTL });
}

/** The grant, or null for any failure (never throws; the caller answers 401). */
export function verifyPushLaterToken(token: string): PushLaterGrant | null {
  try {
    const decoded = jwt.verify(token, LATER_SECRET, { algorithms: ["HS256"] }) as {
      kind?: unknown;
      userId?: unknown;
      emailId?: unknown;
    };
    if (
      decoded.kind !== TOKEN_KIND ||
      typeof decoded.userId !== "string" ||
      typeof decoded.emailId !== "string" ||
      !decoded.userId ||
      !decoded.emailId
    ) {
      return null;
    }
    return { userId: decoded.userId, emailId: decoded.emailId };
  } catch {
    return null;
  }
}
