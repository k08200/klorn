/**
 * A minimal streaming ZIP writer (PKWARE APPNOTE 6.3, no ZIP64, no
 * encryption) for the Klorn Vault download. Each `entry()` returns the bytes
 * of one local header plus its data, ready to stream; `finish()` returns the
 * central directory and the end record. Nothing touches the file system, so
 * the archive exists only in transit.
 *
 * Written here rather than added as a dependency: the export only ever writes
 * small UTF-8 text files whose names this server built, and node:zlib already
 * provides deflate and CRC-32. Entries are deflated when that makes them
 * smaller, else stored. Sizes stay far below the 4 GiB / 65,535-entry limits
 * that would need ZIP64 (the export's own caps, vault/vault-limits.ts); the
 * writer refuses to cross them anyway.
 *
 * assertSafeEntryName is the zip-slip guard: no absolute path, drive letter,
 * backslash, empty or dot segment, or control character, so no extractor can
 * resolve an entry outside the folder it extracts into.
 */

import { crc32, deflateRawSync } from "node:zlib";

export const ZIP_MAX_ENTRIES = 65_000;
const ZIP_MAX_OFFSET = 0xffff_ffff;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const LOCAL_FIXED_BYTES = 30;
const CENTRAL_FIXED_BYTES = 46;
const EOCD_BYTES = 22;
const VERSION_NEEDED = 20;
// Made by: Unix (3), spec 2.0, so extractors apply the mode below.
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
// Regular file, rw-r--r--.
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;
const MAX_NAME_BYTES = 0xffff;
const DOS_EPOCH_YEAR = 1980;

const CONTROL_CHARS = /\p{Cc}/u;
const DRIVE_LETTER = /^[a-zA-Z]:/;

/** Throws unless `name` is a relative path no extractor can resolve outside its folder. */
export function assertSafeEntryName(name: string): void {
  if (name.length === 0 || Buffer.byteLength(name) > MAX_NAME_BYTES) {
    throw new Error("zip: entry name empty or too long");
  }
  if (name.startsWith("/") || name.includes("\\") || DRIVE_LETTER.test(name)) {
    throw new Error("zip: entry name is not a relative path");
  }
  if (CONTROL_CHARS.test(name)) throw new Error("zip: entry name has a control character");
  const segments = name.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error("zip: entry name has an empty or dot segment");
  }
}

interface CentralRecord {
  name: Buffer;
  crc: number;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

export class ZipWriter {
  readonly #time: number;
  readonly #date: number;
  readonly #records: CentralRecord[] = [];
  readonly #names = new Set<string>();
  #offset = 0;
  #finished = false;

  constructor(modifiedAt: Date) {
    const year = Math.max(DOS_EPOCH_YEAR, modifiedAt.getUTCFullYear());
    this.#date =
      ((year - DOS_EPOCH_YEAR) << 9) |
      ((modifiedAt.getUTCMonth() + 1) << 5) |
      modifiedAt.getUTCDate();
    this.#time =
      (modifiedAt.getUTCHours() << 11) |
      (modifiedAt.getUTCMinutes() << 5) |
      Math.floor(modifiedAt.getUTCSeconds() / 2);
  }

  /** Bytes returned so far (entries, plus the end once finished). */
  get bytesWritten(): number {
    return this.#offset;
  }

  get entryCount(): number {
    return this.#records.length;
  }

  /** The local header and data of one UTF-8 text file. */
  entry(name: string, text: string): Buffer {
    if (this.#finished) throw new Error("zip: archive already finished");
    assertSafeEntryName(name);
    if (this.#names.has(name)) throw new Error("zip: duplicate entry name");
    if (this.#records.length >= ZIP_MAX_ENTRIES) throw new Error("zip: too many entries");

    const data = Buffer.from(text, "utf8");
    const deflated = deflateRawSync(data);
    const method = deflated.length < data.length ? METHOD_DEFLATE : METHOD_STORE;
    const payload = method === METHOD_DEFLATE ? deflated : data;
    const nameBytes = Buffer.from(name, "utf8");
    const record: CentralRecord = {
      name: nameBytes,
      crc: crc32(data),
      method,
      compressedSize: payload.length,
      size: data.length,
      offset: this.#offset,
    };
    const out = Buffer.concat([this.#localHeader(record), nameBytes, payload]);
    if (this.#offset + out.length > ZIP_MAX_OFFSET) throw new Error("zip: archive too large");
    this.#names.add(name);
    this.#records.push(record);
    this.#offset += out.length;
    return out;
  }

  /** The central directory and end record. The archive is complete after this. */
  finish(): Buffer {
    if (this.#finished) throw new Error("zip: archive already finished");
    this.#finished = true;
    const central = Buffer.concat(this.#records.flatMap((r) => [this.#centralHeader(r), r.name]));
    const end = Buffer.alloc(EOCD_BYTES);
    end.writeUInt32LE(EOCD_SIGNATURE, 0);
    end.writeUInt16LE(this.#records.length, 8);
    end.writeUInt16LE(this.#records.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(this.#offset, 16);
    const out = Buffer.concat([central, end]);
    this.#offset += out.length;
    return out;
  }

  #localHeader(r: CentralRecord): Buffer {
    const h = Buffer.alloc(LOCAL_FIXED_BYTES);
    h.writeUInt32LE(LOCAL_SIGNATURE, 0);
    h.writeUInt16LE(VERSION_NEEDED, 4);
    h.writeUInt16LE(FLAG_UTF8, 6);
    h.writeUInt16LE(r.method, 8);
    h.writeUInt16LE(this.#time, 10);
    h.writeUInt16LE(this.#date, 12);
    h.writeUInt32LE(r.crc, 14);
    h.writeUInt32LE(r.compressedSize, 18);
    h.writeUInt32LE(r.size, 22);
    h.writeUInt16LE(r.name.length, 26);
    h.writeUInt16LE(0, 28);
    return h;
  }

  #centralHeader(r: CentralRecord): Buffer {
    const h = Buffer.alloc(CENTRAL_FIXED_BYTES);
    h.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    h.writeUInt16LE(VERSION_MADE_BY, 4);
    h.writeUInt16LE(VERSION_NEEDED, 6);
    h.writeUInt16LE(FLAG_UTF8, 8);
    h.writeUInt16LE(r.method, 10);
    h.writeUInt16LE(this.#time, 12);
    h.writeUInt16LE(this.#date, 14);
    h.writeUInt32LE(r.crc, 16);
    h.writeUInt32LE(r.compressedSize, 20);
    h.writeUInt32LE(r.size, 24);
    h.writeUInt16LE(r.name.length, 28);
    // extra, comment, disk start, internal attributes: all zero.
    h.writeUInt32LE(EXTERNAL_ATTRS, 38);
    h.writeUInt32LE(r.offset, 42);
    return h;
  }
}
