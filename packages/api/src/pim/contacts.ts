/**
 * Contact / CRM management for Eve
 */

import { prisma } from "../db.js";

export async function listContacts(userId: string, search?: string) {
  const where: Record<string, unknown> = { userId };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { company: { contains: search, mode: "insensitive" } },
      { tags: { contains: search, mode: "insensitive" } },
    ];
  }

  const contacts = await prisma.contact.findMany({
    where,
    orderBy: { name: "asc" },
  });

  return {
    contacts: contacts.map(
      (c: {
        id: string;
        name: string;
        email: string | null;
        phone: string | null;
        company: string | null;
        role: string | null;
        notes: string | null;
        tags: string | null;
      }) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        company: c.company,
        role: c.role,
        notes: c.notes,
        tags: c.tags,
      }),
    ),
  };
}

export async function createContact(
  userId: string,
  data: {
    name: string;
    email?: string;
    phone?: string;
    company?: string;
    role?: string;
    notes?: string;
    tags?: string;
  },
) {
  const contact = await prisma.contact.create({
    data: {
      userId,
      name: data.name,
      email: data.email || null,
      phone: data.phone || null,
      company: data.company || null,
      role: data.role || null,
      notes: data.notes || null,
      tags: data.tags || null,
    },
  });

  return { success: true, contact: { id: contact.id, name: contact.name } };
}

export async function updateContact(contactId: string, updates: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  for (const key of ["name", "email", "phone", "company", "role", "notes", "tags"]) {
    if (updates[key] !== undefined) data[key] = updates[key];
  }

  const contact = await prisma.contact.update({ where: { id: contactId }, data });
  return { success: true, contact: { id: contact.id, name: contact.name } };
}

export async function deleteContact(contactId: string) {
  await prisma.contact.delete({ where: { id: contactId } });
  return { success: true };
}

export const CONTACT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_contacts",
      description:
        "List contacts/people in the user's network. Can search by name, email, company, or tags.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search keyword (optional)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_contact",
      description: "Add a new contact/person to the CRM",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Contact name" },
          email: { type: "string", description: "Email address (optional)" },
          phone: { type: "string", description: "Phone number (optional)" },
          company: { type: "string", description: "Company name (optional)" },
          role: { type: "string", description: "Job title/role (optional)" },
          notes: { type: "string", description: "Notes about this contact (optional)" },
          tags: {
            type: "string",
            description: "Comma-separated tags like 'investor,partner' (optional)",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_contact",
      description: "Update an existing contact's information",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string", description: "Contact ID to update" },
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          company: { type: "string" },
          role: { type: "string" },
          notes: { type: "string" },
          tags: { type: "string" },
        },
        required: ["contact_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_contact",
      description: "Delete a contact",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string", description: "Contact ID to delete" },
        },
        required: ["contact_id"],
      },
    },
  },
];
