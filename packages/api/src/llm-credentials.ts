import { decryptOptional } from "./crypto-tokens.js";
import { prisma } from "./db.js";
import type { ProviderCredentials } from "./providers/index.js";

type UserWithKeys = {
  openRouterApiKey?: string | null;
  geminiApiKey?: string | null;
};

export async function getUserLlmCredentials(userId: string): Promise<ProviderCredentials> {
  const user = (await prisma.user.findUnique({ where: { id: userId } })) as UserWithKeys | null;
  if (!user) return {};

  return {
    openRouterApiKey: decryptOptional(user.openRouterApiKey),
    geminiApiKey: decryptOptional(user.geminiApiKey),
    quotaScope: userId,
  };
}
