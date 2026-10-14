/**
 * The file name a signed download is saved under (step D1 of
 * docs/providers/unified-platform-plan.md). The name is display metadata from a
 * person or from a mail header, so it is cleaned before it is put into a
 * Content-Disposition value: no path, no quote, no line break, no bidi override.
 *
 * The disposition is always `attachment`. The value is built without spaces so
 * that it survives a signed query string byte for byte: a space would travel as
 * `+` or `%20` depending on the encoder, and the two do not sign the same.
 */

const MAX_DOWNLOAD_NAME_CHARS = 120;
const MAX_EXTENSION_CHARS = 16;
const FALLBACK_NAME = "download";

// With the `u` flag a surrogate range matches only UNPAIRED surrogates.
const LONE_SURROGATES = /[\uD800-\uDFFF]/gu;
// C0 controls, DEL, C1 controls, zero-width and bidi formatting characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
const CONTROL_AND_FORMAT = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;
// Characters no file system or header quoting should have to deal with.
const RESERVED = /["<>:|?*]/g;
const NOT_ASCII_SAFE = /[^A-Za-z0-9._-]/g;
const RFC5987_EXTRA = /['()*!]/g;

function lastPathComponent(name: string): string {
  const parts = name.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  if (extension.length < 2 || extension.length > MAX_EXTENSION_CHARS) {
    return { stem: name, extension: "" };
  }
  return { stem: name.slice(0, dot), extension };
}

function truncate(name: string): string {
  if (name.length <= MAX_DOWNLOAD_NAME_CHARS) return name;
  const { stem, extension } = splitExtension(name);
  return `${stem.slice(0, MAX_DOWNLOAD_NAME_CHARS - extension.length)}${extension}`;
}

/** A display-safe file name. Never empty, never a path. */
export function sanitizeDownloadName(name: string): string {
  const raw = typeof name === "string" ? name : "";
  const cleaned = lastPathComponent(raw.normalize("NFC"))
    .replace(LONE_SURROGATES, "")
    .replace(CONTROL_AND_FORMAT, " ")
    .replace(RESERVED, "")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+/, "")
    .replace(/[. ]+$/, "");
  return truncate(cleaned) || FALLBACK_NAME;
}

/** The name for clients that read only the plain `filename` parameter. */
function asciiFallback(name: string): string {
  const { stem, extension } = splitExtension(name);
  const asciiStem = /[A-Za-z0-9]/.test(stem) ? stem.replace(NOT_ASCII_SAFE, "_") : FALLBACK_NAME;
  return `${asciiStem}${extension.replace(NOT_ASCII_SAFE, "_")}`;
}

/** RFC 5987 `ext-value` body: UTF-8, percent-encoded. */
function encodeExtended(name: string): string {
  return encodeURIComponent(name).replace(
    RFC5987_EXTRA,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `attachment;filename="<ascii>";filename*=UTF-8''<utf-8>` for a download name.
 * The input is sanitised here; callers pass the raw display name.
 */
export function attachmentDisposition(downloadName: string): string {
  const name = sanitizeDownloadName(downloadName);
  return `attachment;filename="${asciiFallback(name)}";filename*=UTF-8''${encodeExtended(name)}`;
}
