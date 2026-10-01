/**
 * Throwaway TLS identities for wire tests, generated with the openssl binary at
 * run time into a temp directory (nothing is committed, nothing is trusted outside
 * the test).
 *
 * Portable across LibreSSL (macOS) and OpenSSL 1.1 and 3.x (CI images): the key and
 * certificate come from one `req -x509 -newkey` call driven by a config file (no
 * `-addext`, which older LibreSSL lacks), the unencrypted-key flag is tried as `-nodes`
 * first (accepted by all of them, a deprecated alias in OpenSSL 3) and as `-noenc`
 * if that is refused, and the failure text of openssl is part of the error.
 *
 * A missing openssl is detected up front with `opensslAvailable()`; the wire tests
 * that need it skip with a message instead of failing, so a runner without the
 * binary stays green. Every other failure (the binary exists but cannot make a
 * certificate) is loud: a skipped proof is no proof, but a broken tool is a bug.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Identity {
  key: Buffer;
  cert: Buffer;
}

/** Is there an `openssl` on the PATH that runs? */
export function opensslAvailable(): boolean {
  try {
    return spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export function makeCertDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeCertDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The unencrypted-key flag, in the order to try it. */
const NO_PASSPHRASE_FLAGS = ["-nodes", "-noenc"] as const;

function runOpenssl(args: readonly string[]): string | null {
  try {
    execFileSync("openssl", [...args], { stdio: ["ignore", "ignore", "pipe"] });
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    return String(stderr ?? err).slice(0, 300);
  }
}

/** A self-signed identity valid for `altNames` (an openssl subjectAltName list). */
export function makeIdentity(dir: string, name: string, altNames: string): Identity {
  const config = path.join(dir, `${name}.cnf`);
  fs.writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3",
      "prompt = no",
      "[dn]",
      `CN = ${name}`,
      "[v3]",
      `subjectAltName = ${altNames}`,
    ].join("\n"),
  );
  const keyFile = path.join(dir, `${name}.key.pem`);
  const certFile = path.join(dir, `${name}.cert.pem`);

  const failures: string[] = [];
  for (const flag of NO_PASSPHRASE_FLAGS) {
    const failure = runOpenssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      flag,
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "2",
      "-config",
      config,
    ]);
    if (failure === null) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    }
    failures.push(`${flag}: ${failure}`);
  }
  throw new Error(`openssl could not make a throwaway certificate (${failures.join(" | ")})`);
}
