import { beforeEach, describe, expect, it, vi } from "vitest";

type SkillRow = {
  id: string;
  userId: string;
  key: string;
  name: string;
  description: string;
  prompt: string;
  createdAt: Date;
  updatedAt: Date;
};

const store = new Map<string, SkillRow>(); // composite "userId|key" → row

vi.mock("../db.js", () => {
  const skill = {
    findMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
      return Array.from(store.values()).filter((s) => s.userId === where.userId);
    }),
  };
  return { prisma: { skill }, db: { skill } };
});

const { executeSkill, listUserSkills } = await import("../agentcore/skill-executor.js");

function addSkill(userId: string, name: string, prompt: string, description = "") {
  const key = `skill_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const now = new Date();
  store.set(`${userId}|${key}`, {
    id: key,
    userId,
    key,
    name,
    description,
    prompt,
    createdAt: now,
    updatedAt: now,
  });
}

describe("skill-executor", () => {
  beforeEach(() => store.clear());

  describe("listUserSkills", () => {
    it("returns empty array when no skills exist", async () => {
      const result = await listUserSkills("user-1");
      expect(result.skills).toEqual([]);
    });

    it("lists skills with extracted variables", async () => {
      addSkill("user-1", "Weekly Report", "Summarize tasks for {{week}} assigned to {{team}}");
      addSkill("user-1", "Quick Note", "Create a note about {{topic}}");

      const result = await listUserSkills("user-1");
      expect(result.skills).toHaveLength(2);

      const weekly = result.skills.find((s) => s.name === "Weekly Report");
      expect(weekly?.variables).toEqual(["week", "team"]);

      const note = result.skills.find((s) => s.name === "Quick Note");
      expect(note?.variables).toEqual(["topic"]);
    });

    it("lists skills with no variables", async () => {
      addSkill("user-1", "Daily Standup", "List today's tasks and yesterday's completed items");

      const result = await listUserSkills("user-1");
      expect(result.skills[0].variables).toEqual([]);
    });
  });

  describe("executeSkill", () => {
    it("returns error when skill not found", async () => {
      const result = await executeSkill("user-1", "nonexistent");
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("not found");
    });

    it("executes a skill by name", async () => {
      addSkill("user-1", "Weekly Report", "Summarize this week's tasks");

      const result = await executeSkill("user-1", "Weekly Report");
      expect(result).toEqual({
        prompt: "Summarize this week's tasks",
        skillName: "Weekly Report",
      });
    });

    it("matches skill name case-insensitively", async () => {
      addSkill("user-1", "Weekly Report", "Summarize tasks");

      const result = await executeSkill("user-1", "weekly report");
      expect(result).toHaveProperty("prompt");
    });

    it("matches by partial normalized name", async () => {
      addSkill("user-1", "Weekly Report", "Summarize tasks");

      const result = await executeSkill("user-1", "weekly_report");
      expect(result).toHaveProperty("prompt");
    });

    it("substitutes variables", async () => {
      addSkill("user-1", "Greet", "Hello {{name}}, welcome to {{company}}!");

      const result = await executeSkill("user-1", "Greet", {
        name: "Alice",
        company: "Acme",
      });
      expect(result).toEqual({
        prompt: "Hello Alice, welcome to Acme!",
        skillName: "Greet",
      });
    });

    it("substitutes duplicate variables", async () => {
      addSkill("user-1", "Repeat", "{{word}} {{word}} {{word}}");

      const result = await executeSkill("user-1", "Repeat", { word: "hello" });
      expect(result).toEqual({
        prompt: "hello hello hello",
        skillName: "Repeat",
      });
    });

    it("leaves unmatched variables as-is", async () => {
      addSkill("user-1", "Partial", "Hello {{name}}, your role is {{role}}");

      const result = await executeSkill("user-1", "Partial", { name: "Bob" });
      expect(result).toEqual({
        prompt: "Hello Bob, your role is {{role}}",
        skillName: "Partial",
      });
    });

    it("works without variables parameter", async () => {
      addSkill("user-1", "Simple", "Just do the thing");

      const result = await executeSkill("user-1", "Simple");
      expect(result).toEqual({
        prompt: "Just do the thing",
        skillName: "Simple",
      });
    });
  });
});
