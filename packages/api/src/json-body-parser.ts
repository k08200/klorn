import type { FastifyInstance } from "fastify";
import { parse as secureJsonParse } from "secure-json-parse";

/** Fixed on purpose: the parser's own message quotes the start of the body. */
const INVALID_JSON_BODY_MESSAGE = "Invalid JSON body";

/**
 * What Fastify's own parser does with a prototype-poisoning key: refuse the body.
 * JSON.parse keeps `"__proto__"` as an own key, and an Object.assign or a deep
 * merge downstream then writes it into a prototype.
 */
const POISONING_REFUSED = { protoAction: "error", constructorAction: "error" } as const;

/**
 * A body that is not valid JSON under an `application/json` content type, or
 * that carries a prototype-poisoning key.
 *
 * Carries the status and code of Fastify's own error for the same case, so the
 * global error handler (error-handler.ts) answers it as a client error: 400,
 * no log line, no Sentry event. The message is fixed and there is no `cause`: a
 * `JSON.parse` SyntaxError quotes the start of the input, and the input is
 * whatever an unauthenticated caller chose to send.
 */
export class InvalidJsonBodyError extends Error {
  readonly statusCode = 400;
  readonly code = "FST_ERR_CTP_INVALID_JSON_BODY";

  constructor() {
    super(INVALID_JSON_BODY_MESSAGE);
    this.name = "InvalidJsonBodyError";
  }
}

/**
 * The API's `application/json` body parser.
 *
 * It replaces Fastify's own so the exact bytes the sender wrote stay on the
 * request as `rawBody`: the Paddle and Resend webhook signature checks are an
 * HMAC over those bytes, and re-serializing the parsed body would not match.
 * An empty body parses as `{}`, as it always has. A `__proto__` key, or a
 * `constructor` object with a `prototype`, anywhere in the body is refused with
 * the same 400 as malformed JSON, as Fastify's own parser refuses it.
 */
export function registerJsonBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const str = (body as string) || "{}";
    (req as unknown as { rawBody: string }).rawBody = str;
    let parsed: unknown;
    try {
      parsed = secureJsonParse(str, POISONING_REFUSED);
    } catch {
      done(new InvalidJsonBodyError(), undefined);
      return;
    }
    done(null, parsed);
  });
}
