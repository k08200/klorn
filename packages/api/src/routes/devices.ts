import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { getEffectivePlan } from "../billing/stripe.js";
import { db, prisma } from "../db.js";

export async function deviceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/devices — List user's active devices
  app.get("/", async (request) => {
    const userId = getUserId(request);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, role: true },
    });
    const planConfig = getEffectivePlan(user?.plan || "FREE", user?.role);

    const devices = await db.device.findMany({
      where: { userId },
      orderBy: { lastActiveAt: "desc" },
      select: {
        id: true,
        deviceName: true,
        deviceType: true,
        ipAddress: true,
        lastActiveAt: true,
        createdAt: true,
      },
    });

    // Mark current device
    const auth = request.headers.authorization;
    let currentTokenHash: string | null = null;
    if (auth?.startsWith("Bearer ")) {
      const crypto = await import("node:crypto");
      currentTokenHash = crypto.createHash("sha256").update(auth.slice(7)).digest("hex");
    }

    const currentDevice = currentTokenHash
      ? await db.device.findUnique({
          where: { tokenHash: currentTokenHash },
          select: { id: true },
        })
      : null;

    return {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic Prisma model
      devices: devices.map((d: any) => ({
        ...d,
        isCurrent: d.id === currentDevice?.id,
      })),
      deviceLimit: planConfig.deviceLimit === Infinity ? null : planConfig.deviceLimit,
    };
  });

  // DELETE /api/devices/:id — Remove a specific device (remote logout)
  app.delete("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const device = await db.device.findUnique({ where: { id } });
    if (!device || device.userId !== userId) {
      return reply.code(404).send({ error: "Device not found" });
    }

    await db.device.delete({ where: { id } });
    return { success: true };
  });
}
