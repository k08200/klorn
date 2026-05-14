/**
 * Document Writer for Jigeum - generate reports, proposals, emails drafts, etc.
 * Results are saved as Notes.
 */

import { prisma } from "./db.js";
import { CHAT_SYSTEM_PROMPT, createCompletion, MODEL, openai } from "./openai.js";

export async function writeDocument(
  userId: string,
  type: string,
  topic: string,
  details?: string,
): Promise<{ title: string; content: string; noteId: string }> {
  const typePrompts: Record<string, string> = {
    report: "Write a professional business report",
    proposal: "Write a project proposal",
    email_draft: "Write a professional email draft",
    meeting_notes: "Write organized meeting notes",
    plan: "Write a detailed action plan",
    summary: "Write a concise executive summary",
    blog: "Write a blog post draft",
    announcement: "Write an announcement",
  };

  const instruction = typePrompts[type] || `Write a ${type} document`;

  const prompt = `${instruction} about: ${topic}
${details ? `\nAdditional context: ${details}` : ""}

Write in English unless the user explicitly asks for another language.
Be professional, clear, and well-structured. Use markdown formatting.`;

  if (!openai) {
    return { title: topic, content: "LLM not configured.", noteId: "" };
  }

  const response = await createCompletion({
    model: MODEL,
    messages: [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content || "Failed to generate document.";
  const title = `${type.charAt(0).toUpperCase() + type.slice(1)}: ${topic}`;

  // Save as note
  const note = await prisma.note.create({
    data: { userId, title, content },
  });

  return { title, content, noteId: note.id };
}

export const WRITER_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "write_document",
      description:
        "Write a document (report, proposal, email draft, meeting notes, plan, summary, blog post, announcement). The document is automatically saved as a Note.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Document type: report, proposal, email_draft, meeting_notes, plan, summary, blog, announcement",
          },
          topic: { type: "string", description: "What the document is about" },
          details: {
            type: "string",
            description: "Additional context or requirements (optional)",
          },
        },
        required: ["type", "topic"],
      },
    },
  },
];
