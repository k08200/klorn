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
    // Own keys only: `&constructor;` must not find the object prototype's.
    return Object.hasOwn(NAMED_ENTITIES, entity) ? (NAMED_ENTITIES[entity] as string) : badXml();
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

interface ParseState {
  readonly xml: string;
  readonly root: XmlNode;
  readonly stack: Array<{ node: XmlNode; qualified: string }>;
  at: number;
}

const MAX_TAG_LENGTH = 4096;
const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";

/** Text up to the next `<`, into the open element (only whitespace outside the root). */
function readText(state: ParseState, lt: number): void {
  const text = state.xml.slice(state.at, lt === -1 ? state.xml.length : lt);
  if (state.stack.length === 1 && text.trim() !== "") badXml();
  state.stack[state.stack.length - 1].node.text += decodeXmlText(text);
  state.at = lt === -1 ? state.xml.length : lt;
}

/** A `<?..?>`, comment or CDATA section at `at`; false when it is none of them. */
function readSpecial(state: ParseState): boolean {
  const skipped = skipMarkup(state.xml, state.at);
  if (skipped !== -1) {
    state.at = skipped;
    return true;
  }
  if (!state.xml.startsWith(CDATA_OPEN, state.at)) return false;
  const end = state.xml.indexOf(CDATA_CLOSE, state.at);
  if (end === -1 || state.stack.length === 1) badXml();
  state.stack[state.stack.length - 1].node.text += state.xml.slice(
    state.at + CDATA_OPEN.length,
    end,
  );
  state.at = end + CDATA_CLOSE.length;
  return true;
}

/** An opening, closing or self-closing tag at `at`. */
function readTag(state: ParseState): void {
  // DOCTYPE, ENTITY and every other declaration are refused (the tag grammar below
  // refuses them too; this says so).
  if (state.xml.startsWith("<!", state.at)) badXml();
  const match = TAG.exec(state.xml.slice(state.at, state.at + MAX_TAG_LENGTH));
  if (!match) badXml();
  const [whole, closing, qualified, rawAttrs, selfClosing] = match;
  state.at += whole.length;
  if (closing === "/") {
    const open = state.stack.pop();
    if (!open || state.stack.length === 0 || open.qualified !== qualified) badXml();
    return;
  }
  const node: XmlNode = {
    name: localName(qualified),
    attrs: parseAttributes(rawAttrs ?? ""),
    children: [],
    text: "",
  };
  if (state.stack.length === 1 && state.root.children.length > 0) badXml();
  state.stack[state.stack.length - 1].node.children.push(node);
  if (selfClosing === "/") return;
  if (state.stack.length > MAX_DEPTH) badXml();
  state.stack.push({ node, qualified });
}

/** Parse a whole document; answers its root element. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const state: ParseState = { xml, root, stack: [{ node: root, qualified: "" }], at: 0 };
  while (state.at < xml.length) {
    const lt = xml.indexOf("<", state.at);
    if (lt !== state.at) readText(state, lt);
    else if (!readSpecial(state)) readTag(state);
  }
  if (state.stack.length !== 1 || root.children.length !== 1) badXml();
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
