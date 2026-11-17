/**
 * A failed external converter answers a fixed sentence, never its stderr:
 * the route sends a FileConversionError's message to the client as is, and
 * stderr from converting someone's attachment can quote its paths or content.
 * The converter here is /bin/sh, so the child process is real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertEmailAttachment, FileConversionError } from "../mail/file-conversions.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

const attachment = {
  id: "att-1",
  filename: "headshot.png",
  mimeType: "image/png",
  size: PNG.length,
  contentText: null,
  summary: null,
  keyPoints: [],
  extractedFields: {},
  category: null,
  analysisStatus: "ANALYZED",
  analysisError: null,
};

async function failure(): Promise<FileConversionError> {
  try {
    await convertEmailAttachment({ target: "jpg", sourceBuffer: PNG, attachment });
  } catch (err) {
    if (err instanceof FileConversionError) return err;
    throw err;
  }
  throw new Error("conversion unexpectedly succeeded");
}

afterEach(() => vi.unstubAllEnvs());

describe("external converter failures", () => {
  it("a non-zero exit answers the exit code, never stderr", async () => {
    vi.stubEnv("EVE_DISABLE_CONVERTER_AUTODETECT", "1");
    vi.stubEnv("EVE_IMAGE_TO_JPG_BIN", "/bin/sh");
    vi.stubEnv("EVE_IMAGE_TO_JPG_ARGS", JSON.stringify(["-c", "echo CANARY-stderr >&2; exit 3"]));

    const err = await failure();

    expect(err.code).toBe("converter_failed");
    expect(err.message).toBe("The converter exited with code 3.");
  });

  it("malformed converter arguments answer a fixed sentence, not the parser's quote", async () => {
    vi.stubEnv("EVE_DISABLE_CONVERTER_AUTODETECT", "1");
    vi.stubEnv("EVE_IMAGE_TO_JPG_BIN", "/bin/sh");
    vi.stubEnv("EVE_IMAGE_TO_JPG_ARGS", "[CANARY-args");

    const err = await failure();

    expect(err.code).toBe("converter_misconfigured");
    expect(err.message).toBe("Converter arguments are misconfigured.");
  });

  it("a converter that cannot start answers a fixed sentence", async () => {
    vi.stubEnv("EVE_DISABLE_CONVERTER_AUTODETECT", "1");
    vi.stubEnv("EVE_IMAGE_TO_JPG_BIN", "/nonexistent/CANARY-bin");
    vi.stubEnv("EVE_IMAGE_TO_JPG_ARGS", JSON.stringify(["{input}", "{output}"]));

    const err = await failure();

    expect(err.code).toBe("converter_failed");
    expect(err.message).not.toContain("CANARY");
  });
});
