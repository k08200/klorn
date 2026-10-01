/**
 * Just enough XML to read a WebDAV / CalDAV multistatus answer (RFC 4918, RFC 4791)
 * — step C3. Not a general parser and not used as one.
 *
 * Why no dependency: the documents are small, machine-generated, and need a handful
 * of element names and one attribute (`comp name=`). The parse is strict where it
 * matters for safety and lenient where servers legitimately differ:
 *   - names are matched by LOCAL name, lowercased: `<d:href>`, `<D:href>` and
 *     `<href xmlns="DAV:">` are the same element (the prefix is arbitrary);
 *   - a DOCTYPE or any other `<!` declaration is refused, so no entity can be
 *     defined or expanded (no XXE, no billion laughs);
 *   - only the five predefined entities and numeric references are decoded; any
 *     other `&name;` is malformed;
 *   - tags must nest and close; anything else throws CaldavProtocolError("bad-xml").
 */

import { CaldavProtocolError } from "./caldav-errors.js";

export interface XmlNode {
  /** Local name, lowercased, prefix removed. */
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  /** The node's own text (CDATA included), entities decoded. */
  text: string;
}

const MAX_DEPTH = 64;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};
const MAX_CODE_POINT = 0x10ffff;
const TAG =
  /^<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function badXml(): never {
  throw new CaldavProtocolError("bad-xml");
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(":");
  return (colon === -1 ? qualified : qualified.slice(colon + 1)).toLowerCase();
}

export function decodeXmlText(text: string): string {
  return text.replace(/&([^;&\s]*);|&/g, (_match, entity: string | undefined) => {
    if (entity === undefined) return badXml();
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x" || entity[1] === "X";
      const digits = entity.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^\d{1,7}$/).test(digits)) return badXml();
      const code = Number.parseInt(digits, hex ? 16 : 10);
      return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : badXml();
    }
    return NAMED_ENTITIES[entity] ?? badXml();
  });
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    attrs[localName(match[1] ?? "")] = decodeXmlText(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

/** Skip a `<?...?>` or `<!--...-->` starting at `at`; -1 when `at` starts neither. */
function skipMarkup(xml: string, at: number): number {
  if (xml.startsWith("<?", at)) {
    const end = xml.indexOf("?>", at);
    return end === -1 ? badXml() : end + 2;
  }
  if (xml.startsWith("<!--", at)) {
    const end = xml.indexOf("-->", at);
    return end === -1 ? badXml() : end + 3;
  }
  return -1;
}

/** Parse a whole document; answers its root element. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: Array<{ node: XmlNode; qualified: string }> = [{ node: root, qualified: "" }];
  let at = 0;
  while (at < xml.length) {
    const current = stack[stack.length - 1].node;
    const lt = xml.indexOf("<", at);
    if (lt === -1 || lt > at) {
      const text = xml.slice(at, lt === -1 ? xml.length : lt);
      if (stack.length === 1 && text.trim() !== "") badXml();
      current.text += decodeXmlText(text);
      if (lt === -1) break;
      at = lt;
      continue;
    }
    const skipped = skipMarkup(xml, at);
    if (skipped !== -1) {
      at = skipped;
      continue;
    }
    if (xml.startsWith("<![CDATA[", at)) {
      const end = xml.indexOf("]]>", at);
      if (end === -1 || stack.length === 1) badXml();
      current.text += xml.slice(at + 9, end);
      at = end + 3;
      continue;
    }
    // DOCTYPE, ENTITY and every other declaration: refused.
    if (xml.startsWith("<!", at)) badXml();
    const match = TAG.exec(xml.slice(at, at + 4096));
    if (!match) badXml();
    const [whole, closing, qualified, rawAttrs, selfClosing] = match;
    at += whole.length;
    if (closing === "/") {
      const open = stack.pop();
      if (!open || stack.length === 0 || open.qualified !== qualified) badXml();
      continue;
    }
    const node: XmlNode = {
      name: localName(qualified),
      attrs: parseAttributes(rawAttrs ?? ""),
      children: [],
      text: "",
    };
    if (stack.length === 1 && root.children.length > 0) badXml();
    current.children.push(node);
    if (selfClosing !== "/") {
      if (stack.length > MAX_DEPTH) badXml();
      stack.push({ node, qualified });
    }
  }
  if (stack.length !== 1 || root.children.length !== 1) badXml();
  return root.children[0];
}

export function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((child) => child.name === name) : [];
}

export function firstChild(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((child) => child.name === name);
}

/** Every element of that name at any depth below `node`, document order. */
export function descendantsNamed(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return [];
  return node.children.flatMap((child) => [
    ...(child.name === name ? [child] : []),
    ...descendantsNamed(child, name),
  ]);
}

/** Trimmed own text of the first element of that name below `node`. */
export function textBelow(node: XmlNode | undefined, name: string): string | undefined {
  const found = descendantsNamed(node, name)[0];
  return found === undefined ? undefined : found.text.trim();
}

/** Escape a value for an XML request body. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
