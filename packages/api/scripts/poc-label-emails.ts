/**
 * POC ground-truth extractor (Day 5 of POC.md sprint).
 *
 * Pulls the N most-recent EmailMessage rows for a given user out of the
 * database and writes them to a JSON file with empty `label` fields. The
 * founder fills `label` in by hand (SILENT | QUEUE | PUSH | AUTO), then
 * scripts/poc-accuracy.ts compares those labels against judgeEmail.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/poc-label-emails.ts \
 *     --user-email=k0820086@gmail.com \
 *     --count=50 \
 *     --out=./poc-ground-truth.json
 *
 * The script never writes to the database. It's read-only.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

interface CliArgs {
  userEmail: string;
  count: number;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (const raw of argv) {
    const m = raw.match(/^--([\w-]+)=(.+)$/);
    if (m) map.set(m[1], m[2]);
  }

  const userEmail = map.get("user-email");
  if (!userEmail) {
    throw new Error("--user-email=<address> is required (e.g. --user-email=k0820086@gmail.com)");
  }

  const count = Number(map.get("count") ?? "50");
  if (!Number.isFinite(count) || count <= 0 || count > 500) {
    throw new Error("--count must be a positive integer ≤ 500");
  }

  const out = map.get("out") ?? "./poc-ground-truth.json";
  return { userEmail, count, out };
}

interface GroundTruthItem {
  id: string;
  gmailId: string;
  from: string;
  subject: string;
  snippet: string | null;
  labels: string[];
  receivedAt: string;
  /** Filled in by the founder by hand. One of SILENT | QUEUE | PUSH | AUTO. */
  label: null | "SILENT" | "QUEUE" | "PUSH" | "AUTO";
  /** Optional free-text note the founder can leave for disagreement analysis. */
  note?: string;
}

interface GroundTruthFile {
  metadata: {
    userEmail: string;
    extractedAt: string;
    count: number;
    instructions: string;
    tierGuide: Record<string, string>;
  };
  items: GroundTruthItem[];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL env var is required");
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { email: args.userEmail },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new Error(`No user found with email=${args.userEmail}`);
    }

    const rows = await prisma.emailMessage.findMany({
      where: { userId: user.id },
      orderBy: { receivedAt: "desc" },
      take: args.count,
      select: {
        id: true,
        gmailId: true,
        from: true,
        subject: true,
        snippet: true,
        labels: true,
        receivedAt: true,
      },
    });

    if (rows.length === 0) {
      throw new Error(`User ${args.userEmail} has zero EmailMessage rows — run Gmail sync first.`);
    }

    const items: GroundTruthItem[] = rows.map((r) => ({
      id: r.id,
      gmailId: r.gmailId,
      from: r.from,
      subject: r.subject,
      snippet: r.snippet,
      labels: r.labels,
      receivedAt: r.receivedAt.toISOString(),
      label: null,
    }));

    const file: GroundTruthFile = {
      metadata: {
        userEmail: user.email,
        extractedAt: new Date().toISOString(),
        count: items.length,
        instructions:
          "Open this file in your editor and set `label` on each item to one of SILENT | QUEUE | PUSH | AUTO. Leave `label` as null to skip that row from the accuracy run. Optionally add a `note` for disagreement analysis.",
        tierGuide: {
          SILENT: "Recorded only. I don't want to see or hear about this.",
          QUEUE: "Goes into the inbox queue. I'll check it on my own schedule.",
          PUSH: "Wake me up. This needs attention within hours.",
          AUTO: "Klorn can handle this automatically without me looking. (Recoverable if wrong.)",
        },
      },
      items,
    };

    const outPath = resolve(args.out);
    writeFileSync(outPath, JSON.stringify(file, null, 2), "utf8");

    console.log(`Wrote ${items.length} email(s) to ${outPath}`);
    console.log(`Next: open ${outPath}, fill in the 'label' field on each item,`);
    console.log("      then run:");
    console.log(`        npx tsx scripts/poc-accuracy.ts --in=${args.out}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
