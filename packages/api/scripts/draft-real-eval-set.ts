/**
 * Real eval set drafting kit (#648) — shrink the founder's job to
 * review-and-approve without ever auto-committing real mail.
 *
 * Pipeline (all local; nothing here writes to the repo's eval/ directory):
 *
 *   1. DRAFT   npx tsx scripts/draft-real-eval-set.ts --user=<email> \
 *                [--in=../../poc-ground-truth.json] [--out=../../poc-real-eval-set.draft.json]
 *              Collects the founder's REAL labeled mail from two sources —
 *              the POC ground-truth file (labels, no bodies) joined to the DB
 *              for bodies, and the DecisionLabel ledger (OVERRIDE:<tier> /
 *              CONFIRM:<tier> = explicit ground truth) joined to EmailMessage —
 *              then mechanically scrubs addresses/URLs/phones (deterministic,
 *              sender-consistent placeholders). Every item lands with
 *              reviewed:false + scrubNotes for the eyeball pass.
 *              The default --out matches the gitignored poc-*.json pattern.
 *
 *   2. REVIEW  The founder edits the draft: fix anything the patterns missed
 *              (names in prose, org names), then flip each row to reviewed:true.
 *
 *   3. FINALIZE --finalize=<draft> --final-out=<file>
 *              Refuses unless EVERY row is reviewed:true; strips reviewed/
 *              scrubNotes; emits the eval-schema file; runs the leak-linter.
 *
 *   4. VERIFY  --verify=<file>
 *              The pre-commit tripwire: exits 2 if anything address/URL/
 *              phone-shaped (non-placeholder) remains. Run it on
 *              eval/real-eval-set.json before every commit of that file.
 *
 *   5. EMIT-CONTEXT --emit-context=<final file> --user=<email>
 *              Snapshot each item's PRODUCTION judge context (numeric
 *              knowledge only) into `context` fixtures so the eval judges
 *              warm-start. Re-run after ledger-heavy dogfood stretches.
 *
 * Read-only against the DB. Never persists anything server-side.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createScrubContext,
  type DraftEvalItem,
  lintPii,
  type RealEvalSourceItem,
  scrubItem,
} from "../src/eval-scrub.js";

interface CliArgs {
  user?: string;
  in?: string;
  out: string;
  verify?: string;
  finalize?: string;
  finalOut?: string;
  emitContext?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (const raw of argv) {
    const kv = raw.match(/^--([\w-]+)=(.+)$/);
    if (kv) map.set(kv[1], kv[2]);
  }
  return {
    user: map.get("user"),
    in: map.get("in"),
    out: map.get("out") ?? "../../poc-real-eval-set.draft.json",
    verify: map.get("verify"),
    finalize: map.get("finalize"),
    finalOut: map.get("final-out"),
    emitContext: map.get("emit-context"),
  };
}

const TIERS = new Set(["PUSH", "QUEUE", "SILENT", "AUTO"]);

/**
 * Warm-start fixtures (#648 follow-up): for each item in a finalized eval
 * file, look up its ORIGINAL sender in the DB (by gmailId — the scrubbed file
 * keeps it) and snapshot the PRODUCTION buildJudgeContext's numeric knowledge
 * (senderPrior + senderFacts, never text — judgeContextToFixture) into the
 * item's `context` field. poc-accuracy's default --context=fixture mode then
 * judges warm-start, the way prod actually runs: the first cold-start
 * measurement scored PUSH 0/4 precisely because the founder's OVERRIDE:PUSH
 * priors were invisible to a contextless eval.
 */
async function runEmitContext(path: string, userEmail: string | undefined): Promise<number> {
  if (!userEmail) throw new Error("--emit-context requires --user=<founder email>");
  const [{ buildJudgeContext }, { prisma }, { judgeContextToFixture }] = await Promise.all([
    import("../src/judge/judge-context.js"),
    import("../src/db.js"),
    import("../src/eval-context.js"),
  ]);
  const user = await prisma.user.findUnique({ where: { email: userEmail }, select: { id: true } });
  if (!user) throw new Error(`no user found for email=${userEmail}`);

  const filePath = resolve(path);
  const doc = JSON.parse(readFileSync(filePath, "utf8")) as {
    items: Array<Record<string, unknown>>;
  };
  let withPrior = 0;
  let withFacts = 0;
  const priorTiers: Record<string, number> = {};
  for (const item of doc.items) {
    const gmailId = String(item.gmailId ?? "");
    const email = gmailId
      ? await prisma.emailMessage.findFirst({
          where: { userId: user.id, gmailId },
          select: { from: true },
        })
      : null;
    if (!email) {
      delete item.context;
      continue;
    }
    const context = await buildJudgeContext(user.id, { from: email.from });
    const fixture = judgeContextToFixture(context);
    if (fixture) {
      item.context = fixture;
      if (fixture.senderPrior) {
        withPrior++;
        priorTiers[fixture.senderPrior.tier] = (priorTiers[fixture.senderPrior.tier] ?? 0) + 1;
      }
      if (fixture.senderFacts) withFacts++;
    } else {
      delete item.context;
    }
  }
  await prisma.$disconnect();
  writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(
    `Emitted context fixtures → ${filePath}: ${withPrior} item(s) with a senderPrior (${JSON.stringify(priorTiers)}), ${withFacts} with senderFacts.`,
  );
  const findings = lintPii(readFileSync(filePath, "utf8"));
  if (findings.length > 0) {
    console.error(
      `LEAK GUARD FAIL after emit — ${findings.length} finding(s); NOT safe to commit:`,
    );
    for (const f of findings.slice(0, 10)) console.error(`  ${f}`);
    return 2;
  }
  console.log("Leak guard PASS — fixtures are numeric-only.");
  return 0;
}

function runVerify(path: string): number {
  const text = readFileSync(resolve(path), "utf8");
  const findings = lintPii(text);
  if (findings.length === 0) {
    console.log(`VERIFY PASS — no address/URL/phone-shaped strings in ${path}`);
    return 0;
  }
  console.error(`VERIFY FAIL — ${findings.length} finding(s) in ${path}:`);
  for (const f of findings) console.error(`  ${f}`);
  console.error("Fix every finding before committing — a public repo leak is irreversible.");
  return 2;
}

function runFinalize(draftPath: string, finalOut: string | undefined): number {
  if (!finalOut) throw new Error("--finalize requires --final-out=<file>");
  const draft = JSON.parse(readFileSync(resolve(draftPath), "utf8")) as {
    metadata?: Record<string, unknown>;
    items: DraftEvalItem[];
  };
  const unreviewed = draft.items.filter((i) => i.reviewed !== true);
  if (unreviewed.length > 0) {
    console.error(
      `FINALIZE REFUSED — ${unreviewed.length} row(s) still reviewed:false: ${unreviewed
        .slice(0, 10)
        .map((i) => i.id)
        .join(", ")}${unreviewed.length > 10 ? ", …" : ""}`,
    );
    return 2;
  }
  const items = draft.items.map(({ reviewed: _r, scrubNotes: _n, ...rest }) => rest);
  const out = {
    metadata: {
      // Must match the leak-linter's placeholder shape (person-N@domain-N
      // .example) — the linter scans this file's own metadata too.
      userEmail: "person-0@domain-0.example",
      extractedAt: new Date().toISOString(),
      count: items.length,
      provenance:
        "real founder-labeled mail, PII-scrubbed and row-by-row reviewed (scripts/draft-real-eval-set.ts, #648)",
    },
    items,
  };
  const text = JSON.stringify(out, null, 2);
  const findings = lintPii(text);
  if (findings.length > 0) {
    console.error(`FINALIZE REFUSED — leak-linter found ${findings.length} finding(s):`);
    for (const f of findings) console.error(`  ${f}`);
    return 2;
  }
  writeFileSync(resolve(finalOut), `${text}\n`, "utf8");
  console.log(`FINALIZED ${items.length} item(s) → ${resolve(finalOut)} (linter clean)`);
  console.log("Next: move/commit it as packages/api/eval/real-eval-set.json and repoint eval.yml.");
  return 0;
}

async function collectSourceItems(args: CliArgs): Promise<RealEvalSourceItem[]> {
  const { prisma } = await import("../src/db.js");
  const user = await prisma.user.findUnique({
    where: { email: args.user },
    select: { id: true },
  });
  if (!user) throw new Error(`no user found for email=${args.user}`);

  const items: RealEvalSourceItem[] = [];
  const seenGmailIds = new Set<string>();

  // Source 1 — the POC ground-truth file: labels are founder-authored; bodies
  // are joined from the DB (the file predates body capture).
  if (args.in) {
    const file = JSON.parse(readFileSync(resolve(args.in), "utf8")) as {
      items: Array<Record<string, unknown>>;
    };
    for (const raw of file.items) {
      const label = raw.label as string | null;
      if (!label || !TIERS.has(label)) continue;
      const gmailId = String(raw.gmailId ?? "");
      const email = gmailId
        ? await prisma.emailMessage.findFirst({
            where: { userId: user.id, gmailId },
            select: { body: true, snippet: true },
          })
        : null;
      seenGmailIds.add(gmailId);
      items.push({
        id: String(raw.id ?? gmailId),
        gmailId,
        from: String(raw.from ?? ""),
        subject: String(raw.subject ?? ""),
        snippet: (raw.snippet as string | null) ?? email?.snippet ?? null,
        body: email?.body ?? null,
        labels: (raw.labels as string[]) ?? [],
        receivedAt: String(raw.receivedAt ?? ""),
        label,
      });
    }
  }

  // Source 2 — the DecisionLabel ledger: OVERRIDE:<tier> and CONFIRM:<tier>
  // are the founder's explicit per-email ground truth (attention-override.ts).
  const ledger = await prisma.decisionLabel.findMany({
    where: {
      userId: user.id,
      source: "EMAIL",
      OR: [{ outcome: { startsWith: "OVERRIDE:" } }, { outcome: { startsWith: "CONFIRM:" } }],
    },
    select: { sourceId: true, outcome: true },
    orderBy: { outcomeAt: "asc" },
  });
  for (const row of ledger) {
    const truth = row.outcome?.split(":")[1] ?? "";
    if (!TIERS.has(truth)) continue;
    const email = await prisma.emailMessage.findFirst({
      where: { userId: user.id, id: row.sourceId },
      select: {
        gmailId: true,
        from: true,
        subject: true,
        snippet: true,
        body: true,
        labels: true,
        receivedAt: true,
      },
    });
    if (!email || seenGmailIds.has(email.gmailId)) continue;
    seenGmailIds.add(email.gmailId);
    items.push({
      id: `ledger-${row.sourceId}`,
      gmailId: email.gmailId,
      from: email.from,
      subject: email.subject,
      snippet: email.snippet,
      body: email.body,
      labels: email.labels,
      receivedAt: email.receivedAt.toISOString(),
      label: truth,
      note: `ground truth from DecisionLabel ${row.outcome}`,
    });
  }

  await prisma.$disconnect();
  return items;
}

async function runDraft(args: CliArgs): Promise<number> {
  if (!args.user) throw new Error("--user=<founder email> is required for drafting");
  const source = await collectSourceItems(args);
  if (source.length === 0) throw new Error("no labeled items found — nothing to draft");

  const ctx = createScrubContext();
  const drafted = source.map((item) => scrubItem(item, ctx));

  const byLabel: Record<string, number> = {};
  let withBody = 0;
  for (const item of drafted) {
    byLabel[item.label] = (byLabel[item.label] ?? 0) + 1;
    if (item.body) withBody++;
  }

  const outPath = resolve(args.out);
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        metadata: {
          draftedAt: new Date().toISOString(),
          count: drafted.length,
          REVIEW:
            "Every row must be eyeballed: fix names/orgs the scrubber can't see, then set reviewed:true. Then run --finalize, then --verify. Never commit this draft file.",
        },
        items: drafted,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`Drafted ${drafted.length} item(s) → ${outPath}`);
  console.log(`  label distribution: ${JSON.stringify(byLabel)}`);
  console.log(`  with body: ${withBody}/${drafted.length}`);
  console.log(
    `  scrub replacements: ${ctx.addressMap.size} addresses, ${ctx.urlCount.value} urls, ${ctx.phoneCount.value} phones`,
  );
  const vacuous = ["PUSH", "AUTO"].filter((t) => (byLabel[t] ?? 0) < 5);
  if (vacuous.length > 0) {
    console.log(
      `  ⚠ low support for ${vacuous.join(", ")} — eval floors on these tiers will be coarse; label more of them during dogfood (override/confirm in the app).`,
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.emitContext) return await runEmitContext(args.emitContext, args.user);
  if (args.verify) return runVerify(args.verify);
  if (args.finalize) return runFinalize(args.finalize, args.finalOut);
  return await runDraft(args);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
