/**
 * Slack text handling, linear and size-capped (docs/providers/slack.md §12).
 * No regex is built from Slack- or user-supplied input, and every scan here is
 * a single pass: this repo has had event-loop outages from regexes on mail
 * text, and Slack text is just as untrusted.
 */

/** Characters of one message Klorn keeps (Slack allows 40,000). */
export const SLACK_MAX_TEXT = 4000;
/** The longest `<…>` token Slack markup produces that we try to render. */
const MAX_MARKUP_TOKEN = 300;

/** At most `max` UTF-16 units, never ending on half a surrogate pair. */
export function capSlackText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Whether the text mentions exactly this user: `<@U123>` or `<@U123|name>`. */
export function mentionsSlackUser(text: string, slackUserId: string): boolean {
  if (slackUserId.length === 0) return false;
  const needle = `<@${slackUserId}`;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const next = text.charAt(at + needle.length);
    if (next === ">" || next === "|") return true;
    from = at + needle.length;
  }
  return false;
}

const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
];

/** Index of the `>` closing the token opened at `start`, or -1; scans a bounded window. */
function tokenEnd(text: string, start: number): number {
  const limit = Math.min(text.length, start + 1 + MAX_MARKUP_TOKEN);
  for (let j = start + 1; j < limit; j++) {
    const ch = text.charAt(j);
    if (ch === ">") return j;
    if (ch === "<") return -1;
  }
  return -1;
}

/** Renders one `<…>` token body (without the brackets) as plain text. */
function renderToken(body: string): string {
  const bar = body.indexOf("|");
  const label = bar >= 0 ? body.slice(bar + 1) : "";
  const target = bar >= 0 ? body.slice(0, bar) : body;
  if (target.startsWith("@")) return "@someone";
  if (target.startsWith("#")) return label ? `#${label}` : "#channel";
  if (target.startsWith("!")) {
    const word = target.slice(1);
    return word === "here" || word === "channel" || word === "everyone" ? `@${word}` : label;
  }
  return label || target;
}

/**
 * Slack markup as one line of plain text: mentions, channel links and URLs
 * rendered, `&amp;` / `&lt;` / `&gt;` decoded, whitespace collapsed, capped.
 */
export function slackPlainText(text: string, max: number): string {
  let out = "";
  let i = 0;
  let lastWasSpace = true;
  const push = (piece: string) => {
    for (let k = 0; k < piece.length; k++) {
      const ch = piece.charAt(k);
      const space = ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
      if (space) {
        if (!lastWasSpace) out += " ";
        lastWasSpace = true;
      } else {
        out += ch;
        lastWasSpace = false;
      }
    }
  };
  while (i < text.length && out.length < max) {
    const ch = text.charAt(i);
    if (ch === "<") {
      const close = tokenEnd(text, i);
      if (close > i) {
        push(renderToken(text.slice(i + 1, close)));
        i = close + 1;
        continue;
      }
    } else if (ch === "&") {
      const entity = ENTITIES.find(([name]) => text.startsWith(name, i));
      if (entity) {
        push(entity[1]);
        i += entity[0].length;
        continue;
      }
    }
    push(ch);
    i += 1;
  }
  return capSlackText(out.trimEnd(), max);
}
