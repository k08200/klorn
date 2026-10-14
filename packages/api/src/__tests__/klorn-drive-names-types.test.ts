/**
 * D3: what an upload's name and bytes become. The name is metadata only
 * (cleaned, capped, never a key segment). The type is sniffed from the bytes;
 * the client's Content-Type is never read. Only a listed document, image, PDF,
 * text or office type is kept as a label; everything else, executables and
 * HTML or SVG included, is stored as application/octet-stream (and every
 * download is an octet-stream attachment anyway, D1).
 */

import { describe, expect, it } from "vitest";
import {
  KLORN_DRIVE_LABELLED_TYPES,
  klornStoredTypePolicy,
  OCTET_STREAM,
  SNIFF_BYTES,
  sniffContentType,
} from "../drive/klorn-content-type.js";
import { cleanKlornFileName, KLORN_FILE_NAME_MAX_CHARS } from "../drive/klorn-file-name.js";

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);
const withPrefix = (prefix: Uint8Array, total = 64) => {
  const out = new Uint8Array(total);
  out.set(prefix);
  return out;
};

describe("cleanKlornFileName", () => {
  it("composes the name (NFC), so a name typed on a Mac and a search for it meet", () => {
    expect(cleanKlornFileName("한글.pdf".normalize("NFD"))).toBe("한글.pdf".normalize("NFC"));
  });

  it("strips control characters and every bidi control, which can disguise an extension", () => {
    expect(cleanKlornFileName("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(cleanKlornFileName("a‎b‏c؜d⁦e⁩.txt")).toBe("abcde.txt");
    expect(cleanKlornFileName("line\nbreak\u0000.txt")).toBe("linebreak.txt");
  });

  it("caps the length in characters, not bytes", () => {
    const long = `${"가".repeat(KLORN_FILE_NAME_MAX_CHARS + 50)}.txt`;
    expect([...(cleanKlornFileName(long) ?? "")]).toHaveLength(KLORN_FILE_NAME_MAX_CHARS);
  });

  it.each(["", "   ", "‮", ".", ".."])("refuses %j", (name) => {
    expect(cleanKlornFileName(name)).toBeNull();
  });

  it("keeps a slash: the name is metadata, never a path", () => {
    expect(cleanKlornFileName("a/b.txt")).toBe("a/b.txt");
  });
});

describe("sniffContentType", () => {
  it.each([
    ["report.bin", text("%PDF-1.7\n"), "application/pdf"],
    ["photo", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image/png"],
    ["photo.png", bytes(0xff, 0xd8, 0xff, 0xe0), "image/jpeg"],
    ["anim", text("GIF89a"), "image/gif"],
    ["pic", text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "), "image/webp"],
    ["scan.tif", bytes(0x49, 0x49, 0x2a, 0x00), "image/tiff"],
    ["old.bmp", text("BM"), "image/bmp"],
    ["note", text("plain words\nand more"), "text/plain"],
    ["table.csv", text("a,b\n1,2\n"), "text/csv"],
    ["readme.md", text("# Title\n"), "text/markdown"],
    ["data.json", text('{"a": 1}'), "application/json"],
    ["letter.rtf", text("{\\rtf1\\ansi"), "application/rtf"],
  ])("%s is labelled from its bytes", (name, head, expected) => {
    expect(sniffContentType(head, name)).toBe(expected);
  });

  it("an iPhone photo (HEIC) is recognised by its ftyp brand", () => {
    const head = withPrefix(bytes(0, 0, 0, 0x18, ...text("ftypheic")));
    expect(sniffContentType(head, "IMG_0001.HEIC")).toBe("image/heic");
  });

  it("an OpenDocument file names its own type in the first entry", () => {
    const head = new Uint8Array(128);
    head.set(bytes(0x50, 0x4b, 0x03, 0x04));
    head.set(text("mimetypeapplication/vnd.oasis.opendocument.text"), 30);
    expect(sniffContentType(head, "x.odt")).toBe("application/vnd.oasis.opendocument.text");
  });

  it("a zip is an office file only with the matching extension, else octet-stream", () => {
    const zip = withPrefix(bytes(0x50, 0x4b, 0x03, 0x04));
    expect(sniffContentType(zip, "Q3.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(sniffContentType(zip, "sheet.XLSX")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(sniffContentType(zip, "문서.hwpx")).toBe("application/hwp+zip");
    expect(sniffContentType(zip, "archive.zip")).toBe(OCTET_STREAM);
    expect(sniffContentType(zip, "Q3.pdf")).toBe(OCTET_STREAM);
  });

  it("a compound file is a legacy office file only with the matching extension", () => {
    const ole = withPrefix(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1));
    expect(sniffContentType(ole, "old.doc")).toBe("application/msword");
    expect(sniffContentType(ole, "old.xls")).toBe("application/vnd.ms-excel");
    expect(sniffContentType(ole, "보고서.hwp")).toBe("application/x-hwp");
    expect(sniffContentType(ole, "setup.msi")).toBe(OCTET_STREAM);
  });

  it.each([
    ["page.html", text("<!DOCTYPE html><html>")],
    ["image.svg", text('<svg xmlns="http://www.w3.org/2000/svg">')],
    ["note.txt", text("  <script>alert(1)</script>")],
    ["data.xml", text('<?xml version="1.0"?>')],
    ["run.sh", text("#!/bin/sh\necho hi\n")],
    ["notes.txt", text("#!/usr/bin/env node\n")],
    ["tool.exe", text("MZ\u0090\u0000")],
    ["tool.png", text("MZ\u0090\u0000")],
    ["tool", bytes(0x7f, 0x45, 0x4c, 0x46)],
    ["tool", bytes(0xcf, 0xfa, 0xed, 0xfe)],
    ["script.js", text("console.log(1)")],
    ["blob", bytes(0, 1, 2, 3, 0, 0, 255)],
    ["empty.txt", new Uint8Array(0)],
  ])("%s is stored as octet-stream", (name, head) => {
    expect(sniffContentType(head, name)).toBe(OCTET_STREAM);
  });

  it("text that is not valid UTF-8 is not labelled text", () => {
    expect(sniffContentType(bytes(0x68, 0x69, 0xc3, 0x28), "x.txt")).toBe(OCTET_STREAM);
  });

  it("a multi-byte character cut at the end of the sniffed head is still text", () => {
    const head = text(`${"a".repeat(SNIFF_BYTES - 1)}가`).slice(0, SNIFF_BYTES);
    expect(sniffContentType(head, "x.txt", { truncated: true })).toBe("text/plain");
  });

  it("the same bytes cut short in a COMPLETE file are not text", () => {
    const head = text("ab가").slice(0, 3);
    expect(sniffContentType(head, "x.txt", { truncated: false })).toBe(OCTET_STREAM);
  });
});

describe("the stored-type policy", () => {
  it("admits exactly the labelled types and octet-stream, and never markup", () => {
    for (const type of KLORN_DRIVE_LABELLED_TYPES) expect(klornStoredTypePolicy(type)).toBe(true);
    expect(klornStoredTypePolicy(OCTET_STREAM)).toBe(true);
    for (const type of ["text/html", "image/svg+xml", "application/javascript", "text/xml"]) {
      expect(klornStoredTypePolicy(type)).toBe(false);
    }
  });
});
