/**
 * Meeting Auto-Attendance & Summarization
 *
 * - Monitors Google Calendar for upcoming meetings
 * - Auto-opens meeting links (Google Meet, Zoom)
 * - Records audio via macOS (if permissions granted)
 * - Summarizes meeting content
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthedClient } from "./gmail.js";
import { parseLlmJson } from "./llm-json.js";
import { createCompletion, MODEL } from "./openai.js";
import { captureError } from "./sentry.js";

const exec = promisify(execFile);
const IS_MACOS = process.platform === "darwin";

interface MeetingEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  meetingLink: string | null;
  attendees: string[];
}

interface MeetingSummary {
  title: string;
  date: string;
  duration: string;
  attendees: string[];
  keyPoints: string[];
  actionItems: string[];
  decisions: string[];
  rawNotes: string;
}

/** Check calendar for upcoming meetings with video links */
export async function getUpcomingMeetings(userId: string): Promise<MeetingEvent[]> {
  // Use the shared authed client (getAuthedClient) rather than a raw OAuth2
  // client built from the stored token. A bare `new google.auth.OAuth2()` has
  // no client credentials, so it cannot refresh an expired access token and
  // never persists a refreshed one — once the access token expired, the call
  // would fail and the bare catch below would silently return [], so meeting
  // reminders would just stop with no signal. getAuthedClient refreshes and
  // persists the token the same way the Gmail path does.
  const auth = await getAuthedClient(userId);
  if (!auth) return [];

  try {
    const { google } = await import("googleapis");
    const calendar = google.calendar({ version: "v3", auth });
    const now = new Date();
    const later = new Date(now.getTime() + 24 * 60 * 60 * 1000); // next 24 hours

    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: later.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    return (response.data.items || [])
      .map((event) => {
        // Extract meeting link from description, location, or conferenceData
        let meetingLink: string | null = null;
        const confData = event.conferenceData;
        if (confData?.entryPoints) {
          const videoEntry = confData.entryPoints.find((e) => e.entryPointType === "video");
          if (videoEntry) meetingLink = videoEntry.uri || null;
        }
        if (!meetingLink && event.hangoutLink) {
          meetingLink = event.hangoutLink;
        }
        if (!meetingLink) {
          const text = `${event.description || ""} ${event.location || ""}`;
          const zoomMatch = text.match(/https:\/\/[^\s]*zoom\.us\/[^\s]*/);
          const meetMatch = text.match(/https:\/\/meet\.google\.com\/[^\s]*/);
          meetingLink = zoomMatch?.[0] || meetMatch?.[0] || null;
        }

        return {
          id: event.id || "",
          summary: event.summary || "Untitled Meeting",
          start: event.start?.dateTime || event.start?.date || "",
          end: event.end?.dateTime || event.end?.date || "",
          meetingLink,
          attendees: (event.attendees || []).map((a) => a.email || "").filter(Boolean),
        };
      })
      .filter((e) => e.meetingLink); // Only meetings with links
  } catch (err) {
    // Never swallow silently: without a signal, a systemic calendar failure
    // (revoked scope, API outage) is indistinguishable from "no meetings".
    // Log only the message + a clean Error: a GaxiosError carries the outbound
    // request config (incl. the Authorization: Bearer header) on err.config, so
    // serializing the raw error could write a live access token to stdout/Sentry.
    // (The other googleapis catch blocks share this raw-error pattern — a global
    // Sentry beforeSend scrub is the codebase-wide fix, tracked separately.)
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[MEETING] getUpcomingMeetings failed for user ${userId}: ${msg}`);
    captureError(new Error(`getUpcomingMeetings: ${msg}`), {
      tags: { scope: "meeting.get-upcoming" },
    });
    return [];
  }
}

/** Allowed meeting platform hostnames */
const ALLOWED_MEETING_HOSTS = [
  "meet.google.com",
  "zoom.us",
  "us02web.zoom.us",
  "us04web.zoom.us",
  "us05web.zoom.us",
  "us06web.zoom.us",
  "teams.microsoft.com",
  "teams.live.com",
  "whereby.com",
  "around.co",
  "gather.town",
  "app.gather.town",
];

/** Auto-open a meeting link in the default browser */
export async function joinMeeting(
  meetingLink: string,
): Promise<{ success: boolean; link: string; error?: string }> {
  if (!IS_MACOS) throw new Error("Auto-join requires macOS");

  // Validate URL to prevent SSRF / command injection
  let parsed: URL;
  try {
    parsed = new URL(meetingLink);
  } catch {
    return { success: false, link: meetingLink, error: "Invalid URL" };
  }

  if (parsed.protocol !== "https:") {
    return {
      success: false,
      link: meetingLink,
      error: "Only HTTPS meeting links are allowed",
    };
  }

  const host = parsed.hostname.toLowerCase();
  const isAllowed = ALLOWED_MEETING_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
  if (!isAllowed) {
    return {
      success: false,
      link: meetingLink,
      error: `Unrecognized meeting platform: ${host}`,
    };
  }

  await exec("open", [parsed.href], { timeout: 5_000 });
  return { success: true, link: parsed.href };
}

/** Start audio recording via macOS (requires permission) */
export async function startRecording(): Promise<{ path: string; pid: number }> {
  if (!IS_MACOS) throw new Error("Recording requires macOS");

  const path = `/tmp/klorn-meeting-${Date.now()}.m4a`;

  // Use macOS built-in afrecord or sox
  const proc = require("node:child_process").spawn("afrecord", ["-d", "aac", "-f", "m4af", path], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  return { path, pid: proc.pid || 0 };
}

/** Stop audio recording */
export async function stopRecording(pid: number): Promise<{ success: boolean }> {
  try {
    process.kill(pid, "SIGTERM");
    return { success: true };
  } catch {
    return { success: false };
  }
}

/** Summarize meeting notes using LLM */
export async function summarizeMeeting(
  userId: string,
  title: string,
  notes: string,
  attendees: string[],
): Promise<MeetingSummary> {
  const response = await createCompletion(
    {
      model: MODEL,
      messages: [
        {
          role: "system",
          content: `You are a meeting notes summarizer. Given raw meeting notes, create a structured summary in JSON format with these fields:
- keyPoints: array of key discussion points (max 10)
- actionItems: array of action items with assignees if mentioned
- decisions: array of decisions made
Keep it concise and actionable. Respond in the same language as the notes.`,
        },
        {
          role: "user",
          content: `Meeting: ${title}\nAttendees: ${attendees.join(", ")}\n\nNotes:\n${notes}`,
        },
      ],
    },
    { userId },
  );

  const content = response.choices[0]?.message?.content || "{}";
  let parsed: {
    keyPoints?: string[];
    actionItems?: string[];
    decisions?: string[];
  };
  try {
    parsed = parseLlmJson<typeof parsed>(content);
  } catch {
    parsed = { keyPoints: [content], actionItems: [], decisions: [] };
  }

  return {
    title,
    date: new Date().toISOString(),
    duration: "unknown",
    attendees,
    keyPoints: parsed.keyPoints || [],
    actionItems: parsed.actionItems || [],
    decisions: parsed.decisions || [],
    rawNotes: notes,
  };
}

// Tool definitions for function calling
export const MEETING_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_upcoming_meetings",
      description:
        "Get upcoming meetings with video call links from Google Calendar (next 24 hours). Shows meeting title, time, link, and attendees.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "join_meeting",
      description:
        "Auto-open a meeting link (Google Meet, Zoom) in the browser. Use when user says 'join my meeting' or when it's time for a scheduled meeting.",
      parameters: {
        type: "object",
        properties: {
          meeting_link: {
            type: "string",
            description: "The meeting URL (Google Meet or Zoom link)",
          },
        },
        required: ["meeting_link"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "summarize_meeting",
      description:
        "Summarize meeting notes into key points, action items, and decisions. Use after a meeting when the user provides notes or wants a summary.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Meeting title" },
          notes: {
            type: "string",
            description: "Raw meeting notes or transcript",
          },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "List of attendee names/emails",
          },
        },
        required: ["title", "notes"],
      },
    },
  },
];
