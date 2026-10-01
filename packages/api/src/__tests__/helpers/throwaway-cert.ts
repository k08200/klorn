/**
 * Throwaway TLS identities for wire tests, generated with the openssl binary at
 * run time into a temp directory (nothing is committed, nothing is trusted outside
 * the test). A missing openssl is a loud failure, never a silent skip: the tests
 * that use this prove certificate verification, and a skipped proof is no proof.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Identity {
  key: Buffer;
  cert: Buffer;
}

export function makeCertDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeCertDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
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
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
      ].concat(["-days", "2", "-config", config]),
      { stdio: "ignore" },
    );
  } catch (err) {
    throw new Error(
      `a wire test needs the openssl binary to make a throwaway certificate: ${String(err)}`,
    );
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}
