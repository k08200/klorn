/**
 * Skill Recorder
 *
 * Watches PendingAction history and automatically proposes new Skills
 * when it detects a repeated sequence of tool calls that the user has
 * consistently approved.
 *
 * Detection logic:
 *   1. Load the last 30 days of EXECUTED PendingActions per user.
 *   2. Group by toolName and extract common argument patterns.
 *   3. Find sequences (pairs/triples) that repeat ≥3 times.
 *   4. If a matching Skill doesn't already exist, propose it via
 *      a new PendingAction (skill_record — LOW risk).
 *
 * Runs once per week from the pattern-learner scheduler.
 */

import { prisma } from "./db.js";
import { createCompletion, MODEL } from "./openai.js";

const MIN_REPEAT = 3; // sequence must repeat this many times
const LOOK_BACK_DAYS = 30;
const MAX_PROPOSALS_PER_RUN = 2; // cap to avoid flooding inbox

interface ActionRecord {
  toolName: string;
  toolArgs: string;
  createdAt: Date;
}

interface ToolSequence {
  tools: string[]; // ordered tool names
  count: number;
  argSamples: string[][]; // toolArgs for each slot, up to 3 samples
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function detectAndProposeSkills(userId: string): Promise<number> {
  try {
    const actions = await loadRecentActions(userId);
    if (actions.length < MIN_REPEAT * 2) return 0;

    const sequences = detectRepeatedSequences(actions);
    if (sequences.length === 0) return 0;

    let proposed = 0;
    for (const seq of sequences.slice(0, MAX_PROPOSALS_PER_RUN)) {
      const alreadyExists = await skillAlreadyExists(userId, seq.tools);
      if (alreadyExists) continue;

      const alreadyProposed = await proposalAlreadyPending(userId, seq.tools);
      if (alreadyProposed) continue;

      await proposeSkillCreation(userId, seq);
      proposed++;
    }

    if (proposed > 0) {
      console.log(`[SKILL-RECORDER] Proposed ${proposed} new skill(s) for user ${userId}`);
    }
    return proposed;
  } catch (err) {
    console.warn("[SKILL-RECORDER] detectAndProposeSkills failed:", err);
    return 0;
  }
}

// ─── Detection ────────────────────────────────────────────────────────────────

async function loadRecentActions(userId: string): Promise<ActionRecord[]> {
  const since = new Date(Date.now() - LOOK_BACK_DAYS * 24 * 60 * 60 * 1000);
  return prisma.pendingAction.findMany({
    where: { userId, status: "EXECUTED", createdAt: { gte: since } },
    select: { toolName: true, toolArgs: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

function detectRepeatedSequences(actions: ActionRecord[]): ToolSequence[] {
  const seqCounts = new Map<string, { count: number; args: string[][] }>();

  const SESSION_WINDOW = 24 * 60 * 60 * 1000;

  // Sliding window of pairs and triples
  for (let i = 0; i < actions.length - 1; i++) {
    const a = actions[i];
    const b = actions[i + 1];

    const abDiff = b.createdAt.getTime() - a.createdAt.getTime();
    if (abDiff > SESSION_WINDOW) continue;

    // Pair: A→B
    const pairKey = `${a.toolName}→${b.toolName}`;
    const pair = seqCounts.get(pairKey) || { count: 0, args: [[], []] };
    pair.count++;
    if (pair.args[0].length < 3) pair.args[0].push(a.toolArgs);
    if (pair.args[1].length < 3) pair.args[1].push(b.toolArgs);
    seqCounts.set(pairKey, pair);

    // Triple: A→B→C (only when C exists and is within session window of B)
    if (i + 2 < actions.length) {
      const c = actions[i + 2];
      const bcDiff = c.createdAt.getTime() - b.createdAt.getTime();
      if (bcDiff <= SESSION_WINDOW) {
        const tripleKey = `${a.toolName}→${b.toolName}→${c.toolName}`;
        const triple = seqCounts.get(tripleKey) || { count: 0, args: [[], [], []] };
        triple.count++;
        if (triple.args[0].length < 3) triple.args[0].push(a.toolArgs);
        if (triple.args[1].length < 3) triple.args[1].push(b.toolArgs);
        if (triple.args[2].length < 3) triple.args[2].push(c.toolArgs);
        seqCounts.set(tripleKey, triple);
      }
    }
  }

  const results: ToolSequence[] = [];
  for (const [key, data] of seqCounts) {
    if (data.count < MIN_REPEAT) continue;
    const tools = key.split("→");
    results.push({ tools, count: data.count, argSamples: data.args });
  }

  // Prefer longer sequences (triples over pairs covering same tools), then by frequency
  return results.sort((a, b) => {
    if (b.tools.length !== a.tools.length) return b.tools.length - a.tools.length;
    return b.count - a.count;
  });
}

// ─── Dedup guards ─────────────────────────────────────────────────────────────

async function skillAlreadyExists(userId: string, tools: string[]): Promise<boolean> {
  const skills = await prisma.skill.findMany({
    where: { userId },
    select: { prompt: true },
  });
  const toolSignature = tools.join(",");
  return skills.some((s) => s.prompt.includes(toolSignature));
}

async function proposalAlreadyPending(userId: string, tools: string[]): Promise<boolean> {
  const toolSignature = tools.join("→");
  const recent = await prisma.pendingAction.findFirst({
    where: {
      userId,
      toolName: "record_skill",
      status: "PENDING",
      toolArgs: { contains: toolSignature },
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
  });
  return Boolean(recent);
}

// ─── Proposal ─────────────────────────────────────────────────────────────────

async function proposeSkillCreation(userId: string, seq: ToolSequence): Promise<void> {
  const skillName = await generateSkillName(seq);
  const skillKey = skillName
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  const skillPrompt = buildSkillPrompt(seq);

  // Find or create a today conversation for agent proposals
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let convo = await prisma.conversation.findFirst({
    where: { userId, source: "agent", createdAt: { gte: today } },
    select: { id: true },
  });
  if (!convo) {
    convo = await prisma.conversation.create({
      data: { userId, source: "agent", title: "Jigeum Suggestions" },
    });
  }

  const reasoning = `You've done "${seq.tools.join(" → ")}" ${seq.count} times in the last ${LOOK_BACK_DAYS} days. Saving it as a reusable skill means you can trigger this workflow with one command instead of approving it step by step each time.`;

  const message = await prisma.message.create({
    data: {
      conversationId: convo.id,
      role: "ASSISTANT",
      content: `**Pattern detected**: You repeatedly use ${seq.tools.map((t) => `\`${t}\``).join(" → ")} (${seq.count}× in 30 days).\n\n${reasoning}\n\n**Proposal**: Save this as the **"${skillName}"** skill so you can run it any time with one command.`,
      metadata: JSON.stringify({ source: "agent", hasAction: true }),
    },
  });

  await prisma.pendingAction.create({
    data: {
      conversationId: convo.id,
      messageId: message.id,
      userId,
      toolName: "record_skill",
      toolArgs: JSON.stringify({ key: skillKey, name: skillName, prompt: skillPrompt }),
      reasoning,
    },
  });
}

async function generateSkillName(seq: ToolSequence): Promise<string> {
  // Try LLM for a good name; fall back to derived name
  try {
    const res = await createCompletion({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: `Give a 2-3 word skill name (title case, no quotes) for a workflow that does: ${seq.tools.join(" then ")}. Return only the name.`,
        },
      ],
    });
    const name = res.choices[0]?.message?.content?.trim().slice(0, 40);
    if (name && name.length > 2) return name;
  } catch {
    // fall through
  }

  // Deterministic fallback
  const toolLabels = seq.tools
    .map((t) =>
      t
        .replace(/_/g, " ")
        .split(" ")
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" "),
    )
    .join(" + ");
  return toolLabels;
}

function buildSkillPrompt(seq: ToolSequence): string {
  const steps = seq.tools.map((t, i) => `Step ${i + 1}: ${t.replace(/_/g, " ")}`).join("\n");
  return `Execute this workflow:\n${steps}\n\nApply to: {{target}}`;
}

// ─── Scheduler helper ─────────────────────────────────────────────────────────

/**
 * Run skill detection for all eligible users.
 * Call from pattern-learner or automation-scheduler weekly.
 */
export async function detectSkillsForAllUsers(): Promise<void> {
  try {
    const configs = await prisma.automationConfig.findMany({
      where: { autonomousAgent: true },
      select: { userId: true },
    });
    for (const { userId } of configs) {
      try {
        await detectAndProposeSkills(userId);
      } catch {
        // skip individual failures
      }
    }
  } catch (err) {
    console.error("[SKILL-RECORDER] Batch run failed:", err);
  }
}
