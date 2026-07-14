/**
 * Skill Executor — Eve tool for running saved reusable workflows.
 *
 * Provides execute_skill and list_skills tools so Eve can discover
 * and run user-defined skills during chat and autonomous mode.
 */

import { prisma } from "./db.js";
import { renderSkillTemplate } from "./skill-render.js";

export const SKILL_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "execute_skill",
      description:
        "Run a saved reusable workflow (skill) by name. Skills are user-defined prompt templates. " +
        "Use list_skills first to see available skills. Variables in {{double braces}} are replaced with provided values.",
      parameters: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description:
              'The skill name to execute (e.g. "weekly_report", "investor_update"). ' +
              "Matched case-insensitively against saved skill names.",
          },
          variables: {
            type: "object",
            description:
              "Optional key-value pairs to substitute {{placeholders}} in the skill prompt. " +
              'Example: {"name": "Alice", "date": "2026-04-15"}',
            additionalProperties: { type: "string" },
          },
        },
        required: ["skill_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_skills",
      description:
        "List all saved skills for the current user. Returns skill names, descriptions, and available {{variables}}.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

function extractVariables(prompt: string): string[] {
  const matches = prompt.match(/\{\{(\w+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(2, -2)))];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/** List all skills for a user */
export async function listUserSkills(
  userId: string,
): Promise<{ skills: Array<{ name: string; description: string; variables: string[] }> }> {
  const rows = await prisma.skill.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  return {
    skills: rows.map((s) => ({
      name: s.name,
      description: s.description,
      variables: extractVariables(s.prompt),
    })),
  };
}

/** Execute a skill by name with optional variable substitution */
export async function executeSkill(
  userId: string,
  skillName: string,
  variables?: Record<string, string>,
): Promise<{ prompt: string; skillName: string } | { error: string }> {
  const normalized = normalize(skillName);
  const candidateKey = `skill_${normalized}`;

  const rows = await prisma.skill.findMany({ where: { userId } });
  const match = rows.find((s) => s.key === candidateKey || normalize(s.name) === normalized);

  if (!match) {
    return { error: `Skill "${skillName}" not found. Use list_skills to see available skills.` };
  }

  const prompt = renderSkillTemplate(match.prompt, variables);

  return { prompt, skillName: match.name };
}
