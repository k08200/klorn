/**
 * Daily Briefing — Eve's autonomous planning feature
 *
 * Aggregates tasks, calendar events, and recent emails into a daily summary.
 * Can be triggered manually or via cron.
 */

import type { FastifyInstance } from "fastify";
import { AGENT_SYSTEM_PROMPT } from "./agent/prompt.js";
import { getUserId } from "./auth.js";
import { type BriefingSignals, buildBriefingSignals } from "./briefing-signals.js";
import { getBriefingStatus } from "./briefing-status.js";
import { listEvents } from "./calendar.js";
import { prisma } from "./db.js";
import { recordFeedback } from "./feedback.js";
import { listEmails } from "./gmail.js";
import { getUserLlmCredentials } from "./llm-credentials.js";
import { listNotes } from "./notes.js";
import { createCompletion, MODEL } from "./openai.js";
import { sendPushNotification } from "./push.js";
import { listTasks } from "./tasks.js";
import { localDayUtcRange, normalizeTimeZone } from "./time-zone.js";
import { pushNotification } from "./websocket.js";

interface BriefingData {
  tasks: unknown;
  events: unknown;
  emails: unknown;
  notes: unknown;
  signals: BriefingSignals;
}

type BriefingFeedbackChoice = "useful" | "wrong" | "later" | "done";

const BRIEFING_TOP_ACTION_TOOL = "briefing_top_action";
const BRIEFING_FEEDBACK_CHOICES = new Set<BriefingFeedbackChoice>([
  "useful",
  "wrong",
  "later",
  "done",
]);
const BRIEFING_SIGNAL_BY_CHOICE = {
  useful: "APPROVED",
  wrong: "REJECTED",
  later: "SNOOZED",
  done: "DISMISSED",
} as const;
const BRIEFING_CHOICE_BY_SIGNAL = {
  APPROVED: "useful",
  REJECTED: "wrong",
  SNOOZED: "later",
  DISMISSED: "done",
} as const;

async function gatherBriefingData(userId: string): Promise<BriefingData> {
  const results = await Promise.allSettled([
    listTasks(userId),
    listEvents(userId, 10).catch(() => ({ events: [] })),
    listEmails(userId, 5).catch(() => ({ emails: [] })),
    listNotes(userId).catch(() => ({ notes: [] })),
  ]);

  const data = {
    tasks: results[0].status === "fulfilled" ? results[0].value : { tasks: [] },
    events: results[1].status === "fulfilled" ? results[1].value : { events: [] },
    emails: results[2].status === "fulfilled" ? results[2].value : { emails: [] },
    notes: results[3].status === "fulfilled" ? results[3].value : { notes: [] },
  };

  return {
    ...data,
    signals: buildBriefingSignals(data),
  };
}

function briefingTopActionSourceId(noteId: string, rank: number): string {
  return `briefing:${noteId}:top:${rank}`;
}

function parseRank(value: string | undefined): number | null {
  if (!value) return null;
  const rank = Number.parseInt(value, 10);
  return Number.isInteger(rank) && rank >= 1 && rank <= 3 ? rank : null;
}

function findUserBriefingNote(userId: string, noteId: string) {
  return prisma.note.findFirst({
    where: {
      id: noteId,
      userId,
      title: { startsWith: "Daily Briefing" },
    },
    select: { id: true, createdAt: true },
  });
}

export default async function generateBriefing(userId: string): Promise<string> {
  const data = await gatherBriefingData(userId);

  const today = new Date().toLocaleDateString("ko-KR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // The brief is the user's first read of the day — it has to make them feel
  // "someone thought about my day." Data dumps fail that bar. This prompt asks
  // the model to *decide* what matters and surface connections across domains.
  const briefingPrompt = `오늘은 ${today}. 사용자가 자리에 앉자마자 읽는 1분짜리 아침 브리핑을 써줘.

## 너의 역할
데이터를 요약하는 게 아니라, **오늘 뭐부터 해야 할지 결정**하는 것. 조용한 의사결정 파트너처럼 맥락과 다음 수를 짚어줘.

## 반드시 할 것
1. **도메인 연결**: "서버가 미리 찾은 신호"의 crossLinks를 우선 근거로 삼아 이메일·캘린더·태스크를 엮어서 언급. 새로운 연결을 상상해서 만들지 말고, 근거가 약하면 생략.
2. **Top 3 액션**: "서버가 미리 찾은 신호"의 topActions 순서를 기본값으로 사용. 순서를 임의로 바꾸지 말고, 표현만 자연스럽게 다듬어. 각각 한 줄 이유.
3. **빈 시간 활용**: 캘린더가 비어있으면 "여유 있으니 X하기 좋아요"처럼 능동 제안.
4. **반드시 생략**: "데이터를 전달받았다", "X 일정이 없습니다" 같은 메타 코멘트. 유저는 그거 알 필요 없음.

## 출력 형식
- 첫 줄: 오늘 하루 한 줄 요약 (예: "오늘 미팅 1건, 답장 밀린 게 2개 있어요")
- **오늘의 Top 3** — 번호 붙은 액션 + 이유
- **연결된 항목** (있을 때만) — 이메일/태스크/일정이 어떻게 얽혀있는지
- **나머지** — 일정과 이메일 요약 2~3줄
- 한국어, 친근한 의사결정 파트너 톤, 리포트 톤 X
- 전체 150~300자

## 예시
오늘은 미팅 1건, 답장 밀린 게 2개 있어요.

**오늘의 Top 3**
1. 오전에 김○○님 답장 쓰기 — 48시간 지났고 내일 미팅 리드타임이라 급함
2. 오후 3시 Zoom 전에 Notion 자료 읽기 — 회의 효율 위해 15분만 투자
3. 피치덱 2시간 블록 확보 — 다음 주 투자자 미팅 앞두고 밀림

**연결**
- Vercel 배포 실패 이메일 → "deploy 수정" 태스크와 같은 건. Top 1 답장과 별개로 오전 중 처리 권장.

**나머지**
- 15:00 Zoom 외 일정 없음
- 읽지 않은 이메일 중 긴급 없음

---

## 서버가 미리 찾은 신호
이 섹션은 결정적 규칙으로 만든 근거다. 연결된 항목을 말할 때는 가능한 한 이 안의 crossLinks, deadlines, urgentItems를 사용해.
오늘의 Top 3는 topActions를 우선 사용해. LLM은 톤을 다듬는 역할이고, 새로운 Top 3를 재선정하지 않는다.
Signals: ${JSON.stringify(data.signals)}

## 오늘 데이터
Tasks: ${JSON.stringify(data.tasks)}
Calendar: ${JSON.stringify(data.events)}
Emails: ${JSON.stringify(data.emails)}
Recent Notes: ${JSON.stringify(data.notes)}`;

  const credentials = await getUserLlmCredentials(userId);
  const response = await createCompletion(
    {
      model: MODEL,
      messages: [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        { role: "user", content: briefingPrompt },
      ],
    },
    { credentials },
  );

  return response.choices[0]?.message?.content || "No briefing generated.";
}

export async function createDailyBriefingDelivery(userId: string): Promise<{
  briefing: string;
  note: { id: string; createdAt: Date };
  notification: { id: string; createdAt: Date } | null;
  reused: boolean;
}> {
  const today = await todayRangeForUser(userId);
  const existing = await prisma.note.findFirst({
    where: {
      userId,
      title: { startsWith: "Daily Briefing" },
      createdAt: today,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, content: true, createdAt: true },
  });
  if (existing) {
    const notification = await ensureDailyBriefingNotification(userId, existing.content);
    return {
      briefing: existing.content,
      note: { id: existing.id, createdAt: existing.createdAt },
      notification,
      reused: true,
    };
  }

  const briefing = await generateBriefing(userId);

  const note = await prisma.note.create({
    data: {
      userId,
      title: `Daily Briefing — ${new Date().toLocaleDateString("ko-KR")}`,
      content: briefing,
    },
    select: { id: true, createdAt: true },
  });

  const notification = await ensureDailyBriefingNotification(userId, briefing);

  return { briefing, note, notification, reused: false };
}

async function ensureDailyBriefingNotification(
  userId: string,
  briefing: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const today = await todayRangeForUser(userId);
  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      type: "briefing",
      createdAt: today,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
  if (existing) return null;

  const briefingMsg = briefing.slice(0, 200) + (briefing.length > 200 ? "..." : "");
  const notification = await prisma.notification.create({
    data: {
      userId,
      type: "briefing",
      title: "Daily Briefing Ready",
      message: briefingMsg,
      link: "/briefing",
    },
    select: { id: true, createdAt: true },
  });

  pushNotification(userId, {
    id: notification.id,
    type: "briefing",
    title: "Daily Briefing Ready",
    message: briefingMsg,
    createdAt: notification.createdAt.toISOString(),
  });

  await sendPushNotification(
    userId,
    {
      title: "Daily Briefing Ready",
      body: briefingMsg,
      url: "/briefing",
      notificationId: notification.id,
    },
    "daily_briefing",
  );

  return notification;
}

export function briefingRoutes(app: FastifyInstance) {
  // GET /api/briefing/feedback/summary — dogfood trust metric for Top 3 quality
  app.get("/feedback/summary", async (request) => {
    const userId = getUserId(request);
    const { days } = request.query as { days?: string };
    const parsedDays = days ? Number.parseInt(days, 10) : 7;
    const windowDays = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 90) : 7;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const rows = await prisma.feedbackEvent.groupBy({
      by: ["signal"],
      where: {
        userId,
        source: "ATTENTION_ITEM",
        toolName: BRIEFING_TOP_ACTION_TOOL,
        createdAt: { gte: since },
      },
      _count: { signal: true },
    });

    const counts = { useful: 0, wrong: 0, later: 0, done: 0 };
    for (const row of rows) {
      const choice =
        BRIEFING_CHOICE_BY_SIGNAL[row.signal as keyof typeof BRIEFING_CHOICE_BY_SIGNAL];
      if (choice) counts[choice] = row._count.signal;
    }
    const total = counts.useful + counts.wrong + counts.later + counts.done;

    return {
      since: since.toISOString(),
      days: windowDays,
      total,
      counts,
      usefulRate: total > 0 ? counts.useful / total : null,
    };
  });

  // POST /api/briefing/generate — Generate daily briefing
  app.post("/generate", async (request) => {
    const userId = getUserId(request);
    const { briefing, note, notification, reused } = await createDailyBriefingDelivery(userId);
    return { briefing, note, notification, reused };
  });

  // GET /api/briefing/data — Get raw briefing data
  app.get("/data", async (request) => {
    const userId = getUserId(request);
    const data = await gatherBriefingData(userId);
    return data;
  });

  // GET /api/briefing/today — Latest briefing stored today (or null)
  app.get("/today", async (request) => {
    const userId = getUserId(request);
    const today = await todayRangeForUser(userId);

    const note = await prisma.note.findFirst({
      where: {
        userId,
        title: { startsWith: "Daily Briefing" },
        createdAt: today,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, content: true, createdAt: true },
    });

    return { briefing: note };
  });

  // GET /api/briefing/:id/top-actions/feedback — latest feedback per Top 3 rank
  app.get("/:id/top-actions/feedback", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const note = await findUserBriefingNote(userId, id);
    if (!note) return reply.code(404).send({ error: "Briefing not found" });

    const sourceIds = [1, 2, 3].map((rank) => briefingTopActionSourceId(id, rank));
    const rows = await prisma.feedbackEvent.findMany({
      where: {
        userId,
        source: "ATTENTION_ITEM",
        toolName: BRIEFING_TOP_ACTION_TOOL,
        sourceId: { in: sourceIds },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        sourceId: true,
        signal: true,
        evidence: true,
        createdAt: true,
      },
    });

    const feedback: Record<number, unknown> = {};
    for (const row of rows) {
      const rank = parseRank(row.sourceId.split(":").at(-1));
      if (!rank || feedback[rank]) continue;
      const choice =
        BRIEFING_CHOICE_BY_SIGNAL[row.signal as keyof typeof BRIEFING_CHOICE_BY_SIGNAL];
      if (!choice) continue;
      feedback[rank] = {
        id: row.id,
        rank,
        choice,
        signal: row.signal,
        evidence: row.evidence,
        createdAt: row.createdAt.toISOString(),
      };
    }

    return { feedback };
  });

  // POST /api/briefing/:id/top-actions/:rank/feedback — capture Top 3 quality
  app.post("/:id/top-actions/:rank/feedback", async (request, reply) => {
    const userId = getUserId(request);
    const { id, rank: rawRank } = request.params as { id: string; rank: string };
    const rank = parseRank(rawRank);
    if (!rank) return reply.code(400).send({ error: "rank must be 1, 2, or 3" });

    const body = (request.body ?? {}) as {
      choice?: string;
      label?: string;
      evidence?: string;
    };
    const choice = body.choice as BriefingFeedbackChoice | undefined;
    if (!choice || !BRIEFING_FEEDBACK_CHOICES.has(choice)) {
      return reply.code(400).send({ error: "choice must be one of useful, wrong, later, done" });
    }

    const note = await findUserBriefingNote(userId, id);
    if (!note) return reply.code(404).send({ error: "Briefing not found" });

    const signal = BRIEFING_SIGNAL_BY_CHOICE[choice];
    const evidence = JSON.stringify({
      choice,
      noteId: id,
      rank,
      label: typeof body.label === "string" ? body.label.slice(0, 500) : null,
      evidence: typeof body.evidence === "string" ? body.evidence.slice(0, 500) : null,
    });

    await recordFeedback({
      userId,
      source: "ATTENTION_ITEM",
      sourceId: briefingTopActionSourceId(id, rank),
      signal,
      toolName: BRIEFING_TOP_ACTION_TOOL,
      evidence,
    });

    return {
      feedback: {
        noteId: id,
        rank,
        choice,
        signal,
      },
    };
  });

  // GET /api/briefing/status — Today's briefing, notification, and push state
  app.get("/status", (request) => {
    const userId = getUserId(request);
    return getBriefingStatus(userId);
  });
}

async function todayRangeForUser(userId: string): Promise<{ gte: Date; lt: Date }> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  const { gte, lt } = localDayUtcRange(new Date(), normalizeTimeZone(config?.timezone));
  return { gte, lt };
}

// Tool for Eve to generate briefing on demand
export const BRIEFING_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "generate_briefing",
      description:
        "Generate a daily briefing summarizing today's tasks, calendar events, emails, and notes. Use this when the user asks for a daily summary or morning briefing.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];
