import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { extractVoiceProfile, getVoiceProfile } from "../voice-profile-extractor.js";

export async function voiceProfileRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/voice-profile — current profile (or null)
  app.get("/", async (request) => {
    const userId = getUserId(request);
    const profile = await getVoiceProfile(userId);
    return { profile };
  });

  // POST /api/voice-profile/refresh — force extraction, return latest
  app.post("/refresh", async (request) => {
    const userId = getUserId(request);
    await extractVoiceProfile(userId, { force: true });
    const profile = await getVoiceProfile(userId);
    return { profile };
  });
}
