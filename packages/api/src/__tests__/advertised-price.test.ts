import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADVERTISED_PRO_PRICE_WEB } from "../billing/advertised-price.js";

/**
 * The API restates the advertised price because it cannot import it:
 * `@klorn/contract` is type-only by design, and the web package is not in the
 * API's deployment. A second copy nobody checks is exactly the drift that
 * produced both pricing incidents — so this is the check that makes it a
 * cache instead of a second source of truth.
 *
 * Reading the file rather than importing it is deliberate: `packages/web` is
 * a Next app with its own tsconfig and module resolution, and importing
 * across that boundary in a vitest run is more fragile than reading one
 * string out of one file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PRICING_TS = resolve(HERE, "../../../web/src/lib/pricing.ts");

function webPrice(): string {
  const source = readFileSync(PRICING_TS, "utf8");
  const match = source.match(/export const PRO_PRICE_WEB\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error(
      `PRO_PRICE_WEB not found in ${PRICING_TS} — if it moved or was renamed, ` +
        `update this test and packages/api/src/billing/advertised-price.ts together`,
    );
  }
  return match[1];
}

describe("ADVERTISED_PRO_PRICE_WEB", () => {
  it("matches PRO_PRICE_WEB in the web package", () => {
    expect(ADVERTISED_PRO_PRICE_WEB).toBe(webPrice());
  });

  it("is a price the Paddle check can parse", async () => {
    const { parseAdvertisedAmount } = await import("../billing/paddle-price-check.js");
    expect(parseAdvertisedAmount(ADVERTISED_PRO_PRICE_WEB)).toBeGreaterThan(0);
  });
});
