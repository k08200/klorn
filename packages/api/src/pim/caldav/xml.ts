/**
 * Just enough XML to read a WebDAV/CalDAV multistatus response.
 *
 * No parser dependency, on purpose — but that decision has a cost, so the
 * scope is drawn tightly around it. This reads a narrow, machine-generated
 * document shape (RFC 4918 `multistatus`) where we need six element names and
 * no attributes. It is not a general XML parser and must not be used as one.
 *
 * The one thing it must get right is namespace prefixes. The same response is
 * `<d:href>` from one server, `<D:href>` from another and `<href>` from a
 * third, and all three are correct — the prefix is arbitrary and only the
 * namespace binding is meaningful. So every match here is on the *local name*,
 * prefix-insensitive. Matching `d:href` literally is the bug that makes a
 * client work against iCloud and fail against Fastmail.
 */

/** Decode the five predefined XML entities, plus numeric character references. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // last: an escaped entity like &amp;lt; must survive
}

/** Strip CDATA wrappers, then decode entities. CalDAV servers use either. */
function textContent(inner: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  if (cdata?.[1] !== undefined) return cdata[1];
  return decodeEntities(inner);
}

const localName = (name: string) => name.replace(/^[^:]*:/, "").toLowerCase();

/**
 * Return the inner XML of every element whose local name matches, at any depth.
 *
 * Nesting is handled by counting opens and closes of the same local name, so
 * `<response>` inside `<response>` (which servers do not send, but which a
 * naive non-greedy regex would mis-pair anyway) cannot truncate a block.
 */
export function findElements(xml: string, name: string): string[] {
  const target = name.toLowerCase();
  const tag = /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)([^>]*?)(\/?)>/g;
  const out: string[] = [];

  let depth = 0;
  let startIndex = -1;
  let match: RegExpExecArray | null = tag.exec(xml);
  while (match !== null) {
    const [full, closing, rawName, , selfClosing] = match;
    if (localName(rawName ?? "") === target) {
      if (closing === "/") {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          out.push(xml.slice(startIndex, match.index));
          startIndex = -1;
        }
      } else if (selfClosing === "/") {
        if (depth === 0) out.push("");
      } else {
        if (depth === 0) startIndex = match.index + full.length;
        depth++;
      }
    }
    match = tag.exec(xml);
  }
  return out;
}

/** The text of the first matching element, or undefined when absent. */
export function findText(xml: string, name: string): string | undefined {
  const [first] = findElements(xml, name);
  return first === undefined ? undefined : textContent(first).trim();
}

/** The text of the first matching element, without trimming — ICS needs its newlines. */
export function findRawText(xml: string, name: string): string | undefined {
  const [first] = findElements(xml, name);
  return first === undefined ? undefined : textContent(first);
}

/** True when an element with this local name appears anywhere in the fragment. */
export function hasElement(xml: string, name: string): boolean {
  const target = name.toLowerCase();
  const tag = /<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)[^>]*?>/g;
  let match: RegExpExecArray | null = tag.exec(xml);
  while (match !== null) {
    if (localName(match[1] ?? "") === target) return true;
    match = tag.exec(xml);
  }
  return false;
}

/** Escape text for inclusion in an XML request body we generate. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
