/**
 * A minimal ZIP reader for tests: walks the end-of-central-directory record
 * and the central directory, inflates each entry and checks its CRC-32 and
 * sizes against the local header. Enough to prove what vault/zip-writer.ts
 * writes is a well-formed archive, without adding an unzip dependency.
 */

import { crc32, inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const CENTRAL_FIXED_BYTES = 46;
const LOCAL_FIXED_BYTES = 30;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  content: Buffer;
}

export function readZip(archive: Buffer): Map<string, ZipEntry> {
  const eocd = archive.length - EOCD_MIN_BYTES;
  if (eocd < 0 || archive.readUInt32LE(eocd) !== EOCD_SIGNATURE) {
    throw new Error("no end-of-central-directory record at the end of the archive");
  }
  const count = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize !== eocd)
    throw new Error("central directory does not end at EOCD");

  const entries = new Map<string, ZipEntry>();
  let at = centralOffset;
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new Error(`bad central entry ${i}`);
    const flags = archive.readUInt16LE(at + 8);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const compressedSize = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const localOffset = archive.readUInt32LE(at + 42);
    const name = archive
      .subarray(at + CENTRAL_FIXED_BYTES, at + CENTRAL_FIXED_BYTES + nameLength)
      .toString("utf8");
    at += CENTRAL_FIXED_BYTES + nameLength + extraLength + commentLength;

    if (archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE)
      throw new Error(`bad local header for ${name}`);
    const localName = archive
      .subarray(
        localOffset + LOCAL_FIXED_BYTES,
        localOffset + LOCAL_FIXED_BYTES + archive.readUInt16LE(localOffset + 26),
      )
      .toString("utf8");
    if (localName !== name) throw new Error(`local name ${localName} differs from central ${name}`);
    if (archive.readUInt32LE(localOffset + 14) !== crc)
      throw new Error(`local CRC differs for ${name}`);
    const dataStart =
      localOffset +
      LOCAL_FIXED_BYTES +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    if (method === METHOD_DEFLATE) content = inflateRawSync(raw);
    else if (method === METHOD_STORE) content = Buffer.from(raw);
    else throw new Error(`unsupported method ${method} for ${name}`);
    if (content.length !== size) throw new Error(`size mismatch for ${name}`);
    if (crc32(content) !== crc) throw new Error(`CRC mismatch for ${name}`);
    if (entries.has(name)) throw new Error(`duplicate entry ${name}`);
    entries.set(name, { name, flags, method, content });
  }
  return entries;
}

/** Every entry's text, keyed by name. */
export function zipTexts(archive: Buffer): Map<string, string> {
  return new Map(
    [...readZip(archive)].map(([name, entry]) => [name, entry.content.toString("utf8")]),
  );
}
