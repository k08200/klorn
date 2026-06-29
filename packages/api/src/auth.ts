import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { db, prisma } from "./db.js";
import { getEffectivePlan } from "./stripe.js";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("JWT_SECRET must be set in production. Server cannot start without it.");
}
if (!JWT_SECRET) {
  console.warn("[AUTH] WARNING: JWT_SECRET not set — using insecure default for development.");
}
const EFFECTIVE_SECRET = JWT_SECRET || "klorn-dev-secret-do-not-use-in-production";
const TOKEN_EXPIRY = "7d";

function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const normalized = email.trim().toLowerCase();
  const allowed = adminEmails.includes(normalized);
  if (allowed) {
    // Audit log: every env-granted admin access is recorded so a leaked
    // ADMIN_EMAILS env can be traced after the fact.
    console.log(`[AUDIT][ADMIN_ENV] env-granted admin access for ${normalized}`);
  }
  return allowed;
}

export interface JwtPayload {
  userId: string;
  email: string;
  sessionId?: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(
    { ...payload, sessionId: payload.sessionId || crypto.randomUUID() },
    EFFECTIVE_SECRET,
    {
      expiresIn: TOKEN_EXPIRY,
    },
  );
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, EFFECTIVE_SECRET) as JwtPayload;
}

/**
 * True when a token was minted before the user's sessions were globally
 * invalidated. A password reset stamps `User.sessionsInvalidatedAt`; the JWT
 * `iat` claim (whole seconds, set by jwt.sign) is compared against that instant.
 *
 * This closes the reset-password bypass: reset wipes the Device table, dropping
 * the user to zero devices, which tripped the "no devices = legacy session,
 * allow through" branch in isDeviceSessionValid and re-accepted every
 * still-unexpired stolen JWT. The epoch check rejects those tokens regardless
 * of device rows. A `<` (strict) compare in whole seconds means a token minted
 * in the same second as the reset survives — a sub-second window that favors
 * not logging out the legitimate user, who re-logs in with a fresh `iat`.
 */
export function isTokenRevokedByEpoch(
  payload: JwtPayload,
  sessionsInvalidatedAt: Date | null | undefined,
): boolean {
  if (!sessionsInvalidatedAt) return false;
  const iat = (payload as { iat?: number }).iat;
  if (typeof iat !== "number") return false;
  return iat < Math.floor(sessionsInvalidatedAt.getTime() / 1000);
}

/** Load the user's session epoch and decide whether this token is revoked. */
async function sessionRevokedForToken(payload: JwtPayload): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { sessionsInvalidatedAt: true },
  });
  return isTokenRevokedByEpoch(payload, user?.sessionsInvalidatedAt);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Extract userId from Authorization header or fall back to "demo-user" */
export function getUserId(request: FastifyRequest): string {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      const payload = verifyToken(auth.slice(7));
      return payload.userId;
    } catch {
      // invalid token — fall through
    }
  }
  // Demo-user fallback is OFF by default. Requires both:
  //   1. NODE_ENV !== "production"
  //   2. ENABLE_DEMO_USER === "true" (explicit opt-in)
  // This prevents accidental anonymous access on staging/preview deploys.
  if (process.env.NODE_ENV !== "production" && process.env.ENABLE_DEMO_USER === "true") {
    return "demo-user";
  }
  throw new Error("Authentication required");
}

/** Fastify preHandler that requires authentication */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Authentication required" });
  }
  const rawToken = auth.slice(7);
  try {
    const payload = verifyToken(rawToken);
    // Verify the session is still active: device not kicked by another login,
    // AND the token was not issued before a global revocation (password reset).
    const [deviceValid, revoked] = await Promise.all([
      isDeviceSessionValid(rawToken),
      sessionRevokedForToken(payload),
    ]);
    if (!deviceValid || revoked) {
      return reply
        .code(401)
        .send({ error: "Session expired. Please log in again.", code: "DEVICE_KICKED" });
    }
    // Attach to request for downstream handlers
    (request as unknown as { userId: string }).userId = payload.userId;
  } catch {
    return reply.code(401).send({ error: "Invalid or expired token" });
  }
}

/** Fastify preHandler that requires ADMIN role */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Authentication required" });
  }
  try {
    const rawToken = auth.slice(7);
    const payload = verifyToken(rawToken);
    const [user, deviceValid] = await Promise.all([
      prisma.user.findUnique({ where: { id: payload.userId } }),
      isDeviceSessionValid(rawToken),
    ]);
    // Admin tokens get the same session-revocation guarantees as requireAuth:
    // a kicked device or a token predating a password reset must lose access.
    if (!deviceValid || isTokenRevokedByEpoch(payload, user?.sessionsInvalidatedAt)) {
      return reply
        .code(401)
        .send({ error: "Session expired. Please log in again.", code: "DEVICE_KICKED" });
    }
    if (!user || (user.role !== "ADMIN" && !isAdminEmail(user.email))) {
      return reply.code(403).send({ error: "Admin access required" });
    }
    (request as unknown as { userId: string }).userId = payload.userId;
  } catch {
    return reply.code(401).send({ error: "Invalid or expired token" });
  }
}

/** Hash a JWT token to store in the Device table */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Register a device for the user after login/register.
 * If the user exceeds their plan's device limit, the oldest device is removed.
 * Returns the created device ID.
 */
export async function registerDevice(
  userId: string,
  token: string,
  opts: { deviceName?: string; deviceType?: string; ipAddress?: string },
): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true },
  });
  const planConfig = getEffectivePlan(user?.plan || "FREE", user?.role);
  const limit = planConfig.deviceLimit;

  const device = await db.device.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      deviceName: opts.deviceName || null,
      deviceType: opts.deviceType || "web",
      ipAddress: opts.ipAddress || null,
    },
  });

  // Enforce device limit — remove oldest devices beyond the limit
  if (limit !== Infinity) {
    const devices = await db.device.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (devices.length > limit) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic Prisma model
      const toRemove = devices.slice(limit).map((d: any) => d.id);
      await db.device.deleteMany({ where: { id: { in: toRemove } } });
    }
  }

  return device.id;
}

/** Validate that a token's device session is still active */
export async function isDeviceSessionValid(token: string): Promise<boolean> {
  const tHash = hashToken(token);
  const device = await db.device.findUnique({ where: { tokenHash: tHash } });
  if (!device) {
    // No device record → this session was logged out or kicked. Reject it.
    // Every real session has registered a device since the Device table shipped
    // (2026-03), and any pre-device-tracking "legacy" token expired long ago
    // (7-day TTL). The old "0 devices = allow through" allowance is therefore
    // dead for legitimate sessions and only re-accepted logged-out/kicked tokens
    // — defeating server-side revocation on the common single-device logout.
    return false;
  }
  // Update lastActiveAt (non-blocking)
  db.device
    .update({ where: { id: device.id }, data: { lastActiveAt: new Date() } })
    .catch(() => {});
  return true;
}

/** Remove a device session (logout) */
export async function removeDeviceSession(token: string): Promise<void> {
  await db.device.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Ensure demo user exists (for unauthenticated use) */
export async function ensureDemoUser() {
  const hash = await hashPassword("demo");
  await prisma.user.upsert({
    where: { id: "demo-user" },
    create: {
      id: "demo-user",
      email: "demo@klorn.ai",
      name: "Demo User",
      passwordHash: hash,
    },
    update: {
      email: "demo@klorn.ai",
      name: "Demo User",
      passwordHash: hash,
    },
  });

  // Seed sample data if demo user has no tasks yet
  const taskCount = await prisma.task.count({ where: { userId: "demo-user" } });
  if (taskCount === 0) {
    await seedDemoData();
  }
}

async function seedDemoData() {
  const uid = "demo-user";
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Sample tasks
  await prisma.task.createMany({
    data: [
      {
        userId: uid,
        title: "Final landing page review",
        description: "Check CTA buttons, copy, and mobile responsiveness.",
        status: "IN_PROGRESS",
        priority: "HIGH",
        dueDate: tomorrow,
      },
      {
        userId: uid,
        title: "Prepare Product Hunt launch",
        description: "Draft five screenshots, the tagline, and maker comment.",
        status: "TODO",
        priority: "HIGH",
        dueDate: nextWeek,
      },
      {
        userId: uid,
        title: "Prepare investor meeting materials",
        description: "Update pitch deck v3 and attach the financial model.",
        status: "TODO",
        priority: "URGENT",
        dueDate: tomorrow,
      },
      {
        userId: uid,
        title: "Organize customer feedback",
        description: "Clean up feedback from five beta testers in the spreadsheet.",
        status: "DONE",
        priority: "MEDIUM",
      },
      {
        userId: uid,
        title: "Draft launch retrospective",
        description: "Theme: how we turned scattered work signals into a decision queue.",
        status: "TODO",
        priority: "LOW",
        dueDate: nextWeek,
      },
    ],
  });

  // Sample notes
  await prisma.note.createMany({
    data: [
      {
        userId: uid,
        title: "Klorn Q2 roadmap",
        content:
          "## Q2 goals\n\n1. Finish two-way Slack integration\n2. Launch team workspaces\n3. Ship desktop app v1.0\n4. Launch on Product Hunt\n\n### KPI\n- 500 MAU\n- 5% paid conversion",
      },
      {
        userId: uid,
        title: "Investor meeting notes",
        content:
          "## ABC Ventures meeting (Mar 28)\n\n- Interest: TAM, competitive differentiation\n- Feedback: decision workflow is clear; team mode should ship soon\n- Next step: follow-up meeting in two weeks",
      },
      {
        userId: uid,
        title: "Competitor analysis",
        content:
          "### Direct competitors\n- Notion AI: document-first, not decision-first\n- ChatGPT: general-purpose, weaker workspace context\n\n### Klorn differentiation\n- Decision queue instead of another inbox\n- Evidence and approval before execution\n- Work graph across mail, calendar, and tasks\n- Background preparation with user control",
      },
    ],
  });

  // Sample contacts
  await prisma.contact.createMany({
    data: [
      {
        userId: uid,
        name: "Minsu Kim",
        email: "minsu@example.com",
        company: "ABC Ventures",
        role: "Investor",
        tags: "investor,vc",
      },
      {
        userId: uid,
        name: "Sujin Lee",
        email: "sujin@example.com",
        company: "TechStartup",
        role: "CTO",
        tags: "partner,technical",
      },
      {
        userId: uid,
        name: "Jihoon Park",
        email: "jihoon@example.com",
        company: "DesignLab",
        role: "Designer",
        tags: "freelance,design",
      },
      {
        userId: uid,
        name: "Sarah Chen",
        email: "sarah@example.com",
        company: "Product Hunt",
        role: "Community Manager",
        tags: "launch,community",
      },
      {
        userId: uid,
        name: "Hana Jung",
        email: "hana@example.com",
        phone: "010-1234-5678",
        company: "Marketing Korea",
        role: "Marketer",
        tags: "marketing,content",
      },
    ],
  });

  // Sample reminders
  const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const tomorrowMorning = new Date(tomorrow);
  tomorrowMorning.setHours(9, 0, 0, 0);
  await prisma.reminder.createMany({
    data: [
      {
        userId: uid,
        title: "Reply to investor email",
        description: "Send follow-up materials to Minsu Kim at ABC Ventures.",
        remindAt: inTwoHours,
      },
      {
        userId: uid,
        title: "Weekly team meeting",
        description: "Share technical progress with CTO Sujin Lee.",
        remindAt: tomorrowMorning,
      },
    ],
  });

  // Sample calendar events
  const meetingStart = new Date(tomorrow);
  meetingStart.setHours(14, 0, 0, 0);
  const meetingEnd = new Date(tomorrow);
  meetingEnd.setHours(15, 0, 0, 0);
  await prisma.calendarEvent.createMany({
    data: [
      {
        userId: uid,
        title: "Investor meeting - ABC Ventures",
        startTime: meetingStart,
        endTime: meetingEnd,
        location: "WeWork Gangnam, 3F",
        color: "#d8a45d",
      },
      {
        userId: uid,
        title: "Product Hunt launch strategy",
        startTime: new Date(nextWeek.setHours(10, 0, 0, 0)),
        endTime: new Date(nextWeek.setHours(11, 0, 0, 0)),
        meetingLink: "https://meet.google.com/abc-defg-hij",
        color: "#14b8a6",
      },
    ],
  });

  console.log("[SEED] Demo data created for demo-user");
}
