/**
 * Small byte and error helpers shared by the storage tests (step D1).
 */

import { Readable } from "node:stream";
import { StorageError } from "../../storage/errors.js";

/** A stream that yields one chunk of each given size, filled with `fill`. */
export function chunksOf(sizes: readonly number[], fill = 7): AsyncIterable<Uint8Array> {
  return Readable.from(
    sizes.map((size) => new Uint8Array(size).fill(fill)),
    { objectMode: true },
  );
}

/** A stream over the given chunks, in order. */
export function streamOf(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  return Readable.from(parts, { objectMode: true });
}

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of source) parts.push(chunk);
  return Buffer.concat(parts);
}

export async function textOf(source: AsyncIterable<Uint8Array>): Promise<string> {
  return Buffer.from(await collect(source)).toString("utf8");
}

/** The StorageError code a synchronous call throws, or "no-error". */
export function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof StorageError) return err.code;
    throw err;
  }
  return "no-error";
}

/** The StorageError code an async call rejects with, or "no-error". */
export async function codeOfAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof StorageError) return err.code;
    throw err;
  }
  return "no-error";
}
