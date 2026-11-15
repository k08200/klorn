/**
 * Prisma errors that quote content, for the database failure redaction tests.
 *
 * The messages copy what @prisma/client 6 produced against a real database
 * (NODE_ENV=production, i.e. errorFormat "minimal"): a validation error renders
 * the whole rejected call, values included, under an
 * "Invalid `prisma.<model>.<action>()` invocation:" header.
 */
import { Prisma } from "@prisma/client";
import { LLM_CANARY } from "./canary.js";

/** The same ten characters as the LLM canary: a value the error quotes. */
export const DB_CANARY = LLM_CANARY;

const CLIENT_VERSION = "6.19.3";

/** A create whose arguments carry a Slack message's text. */
export function validationErrorQuotingText(): Prisma.PrismaClientValidationError {
  return new Prisma.PrismaClientValidationError(
    [
      "",
      "Invalid `prisma.slackMessage.create()` invocation:",
      "",
      "{",
      "  data: {",
      `    text: "${DB_CANARY} the words someone wrote in Slack",`,
      "+   eventId: String",
      "  }",
      "}",
      "",
      "Argument `eventId` is missing.",
    ].join("\n"),
    { clientVersion: CLIENT_VERSION },
  );
}

/** A unique violation on a notification whose message quotes a mail subject. */
export function knownErrorQuotingSubject(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    [
      "",
      "Invalid `prisma.notification.create()` invocation:",
      "",
      `Unique constraint failed on the fields: (\`dedupKey\`) for "${DB_CANARY} Re: the subject"`,
    ].join("\n"),
    { code: "P2002", clientVersion: CLIENT_VERSION, meta: { modelName: "Notification" } },
  );
}

/** A raw query failure: Postgres's own message, which quotes the bad value. */
export function rawQueryErrorQuotingValue(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    [
      "",
      "Invalid `prisma.$queryRaw()` invocation:",
      "",
      `Raw query failed. Code: \`22P02\`. Message: \`invalid input syntax for type uuid: "${DB_CANARY}"\``,
    ].join("\n"),
    {
      code: "P2010",
      clientVersion: CLIENT_VERSION,
      meta: { code: "22P02", message: `invalid input syntax for type uuid: "${DB_CANARY}"` },
    },
  );
}
