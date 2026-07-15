import { prisma } from "../db.js";

export async function listNotes(userId: string, search?: string) {
  const where: Record<string, unknown> = { userId };
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { content: { contains: search, mode: "insensitive" } },
    ];
  }

  const notes = await prisma.note.findMany({
    where,
    orderBy: { updatedAt: "desc" },
  });

  return {
    notes: notes.map((n: { id: string; title: string; content: string; updatedAt: Date }) => ({
      id: n.id,
      title: n.title,
      content: n.content,
      updatedAt: n.updatedAt.toISOString(),
    })),
  };
}

export async function createNote(userId: string, title: string, content: string) {
  const note = await prisma.note.create({
    data: { userId, title, content },
  });

  return { success: true, note: { id: note.id, title: note.title } };
}

export async function updateNote(noteId: string, updates: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  if (updates.title) data.title = updates.title;
  if (updates.content !== undefined) data.content = updates.content;

  const note = await prisma.note.update({ where: { id: noteId }, data });

  return { success: true, note: { id: note.id, title: note.title } };
}

export async function deleteNote(noteId: string) {
  await prisma.note.delete({ where: { id: noteId } });
  return { success: true };
}

export const NOTE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_notes",
      description: "List the user's notes/memos. Can search by keyword.",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Search keyword to filter notes (optional)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_note",
      description: "Create a new note/memo for the user",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title" },
          content: { type: "string", description: "Note content (supports markdown)" },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_note",
      description: "Update an existing note",
      parameters: {
        type: "object",
        properties: {
          note_id: { type: "string", description: "The note ID to update" },
          title: { type: "string", description: "New title (optional)" },
          content: { type: "string", description: "New content (optional)" },
        },
        required: ["note_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_note",
      description: "Delete a note by its ID",
      parameters: {
        type: "object",
        properties: {
          note_id: { type: "string", description: "The note ID to delete" },
        },
        required: ["note_id"],
      },
    },
  },
];
