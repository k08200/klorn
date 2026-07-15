/**
 * Memory Tools for Eve — Inspired by Claude Code's memdir/ system
 *
 * Allows Eve to remember facts, preferences, and context about each user
 * across conversations. Memories are automatically loaded into system prompt.
 */

import { prisma } from "../db.js";

// biome-ignore lint/suspicious/noExplicitAny: Prisma dynamic model access requires untyped delegate
const db: Record<string, Record<string, (...args: any[]) => Promise<any>>> = prisma as never;

// Tool definitions for OpenAI function calling
export const MEMORY_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "remember",
      description:
        "Save a fact, preference, or context about the user for future reference. Use this when the user tells you something important about themselves, their preferences, their work, or gives you feedback. Examples: preferred language, work schedule, project context, corrections.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["PREFERENCE", "FACT", "DECISION", "CONTEXT", "FEEDBACK"],
            description:
              "PREFERENCE: user preferences (language, tone). FACT: facts about user (name, company). DECISION: past decisions. CONTEXT: ongoing work context. FEEDBACK: corrections/instructions from user.",
          },
          key: {
            type: "string",
            description:
              "Short label for this memory (e.g. 'preferred_language', 'company_name', 'project_deadline')",
          },
          content: {
            type: "string",
            description: "The information to remember",
          },
        },
        required: ["type", "key", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "recall",
      description:
        "Search your memories about the user. Use this when you need to check what you know about the user, their preferences, or past context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search term to find relevant memories (searches key and content)",
          },
          type: {
            type: "string",
            enum: ["PREFERENCE", "FACT", "DECISION", "CONTEXT", "FEEDBACK"],
            description: "Optional: filter by memory type",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "forget",
      description:
        "Remove a specific memory. Use when the user asks you to forget something or when information is outdated.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "The key of the memory to forget",
          },
          type: {
            type: "string",
            enum: ["PREFERENCE", "FACT", "DECISION", "CONTEXT", "FEEDBACK"],
            description: "The type of the memory to forget",
          },
        },
        required: ["key", "type"],
      },
    },
  },
];

/** Save or update a memory */
export async function remember(
  userId: string,
  type: string,
  key: string,
  content: string,
  source?: string,
): Promise<string> {
  const memory = await db.memory.upsert({
    where: {
      userId_type_key: {
        userId,
        type: type as "PREFERENCE" | "FACT" | "DECISION" | "CONTEXT" | "FEEDBACK",
        key,
      },
    },
    update: { content, source, updatedAt: new Date() },
    create: {
      userId,
      type: type as "PREFERENCE" | "FACT" | "DECISION" | "CONTEXT" | "FEEDBACK",
      key,
      content,
      source,
    },
  });
  return JSON.stringify({ success: true, id: memory.id, message: `Remembered: ${key}` });
}

/** Search memories */
export async function recall(userId: string, query?: string, type?: string): Promise<string> {
  const where: Record<string, unknown> = { userId };
  if (type) where.type = type;
  if (query) {
    where.OR = [
      { key: { contains: query, mode: "insensitive" } },
      { content: { contains: query, mode: "insensitive" } },
    ];
  }

  const memories = await db.memory.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  if (memories.length === 0) {
    return JSON.stringify({ memories: [], message: "No memories found" });
  }

  // Update lastUsedAt for accessed memories
  const ids = memories.map((m: { id: string }) => m.id);
  await db.memory.updateMany({
    where: { id: { in: ids } },
    data: { lastUsedAt: new Date() },
  });

  return JSON.stringify({
    memories: memories.map(
      (m: { type: string; key: string; content: string; updatedAt: Date }) => ({
        type: m.type,
        key: m.key,
        content: m.content,
        updatedAt: m.updatedAt,
      }),
    ),
  });
}

/** Forget a specific memory */
export async function forget(userId: string, key: string, type: string): Promise<string> {
  try {
    await db.memory.delete({
      where: {
        userId_type_key: {
          userId,
          type: type as "PREFERENCE" | "FACT" | "DECISION" | "CONTEXT" | "FEEDBACK",
          key,
        },
      },
    });
    return JSON.stringify({ success: true, message: `Forgot: ${key}` });
  } catch {
    return JSON.stringify({ success: false, message: `Memory not found: ${key}` });
  }
}

/**
 * Load relevant memories for system prompt injection.
 * Called before each chat message to give Eve context about the user.
 */
export async function loadMemoriesForPrompt(userId: string): Promise<string> {
  const memories = await db.memory.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 30,
  });

  if (memories.length === 0) return "";

  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    const label = m.type.toLowerCase();
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(`- ${m.key}: ${m.content}`);
  }

  let result = "\n\n[User Memory — Things you remember about this user]\n";
  for (const [type, items] of Object.entries(grouped)) {
    result += `\n${type}:\n${items.join("\n")}\n`;
  }

  return result;
}
