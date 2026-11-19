/**
 * web-push 4 (ESM-only) still produces a Web Push request a browser can read:
 * the payload decrypts with the subscription's keys (RFC 8291, aes128gcm,
 * decrypted here independently with node:crypto, not with web-push's http_ece),
 * the VAPID JWT verifies against the VAPID public key (RFC 8292, ES256), the
 * TTL / Topic / Urgency headers are set, and sendNotification uses the `agent`
 * it is given (Klorn passes its SSRF-safe agent). Throwaway keys, a loopback
 * TLS server; no real push endpoint.
 */

import crypto from "node:crypto";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as webPush from "web-push";
import {
  type Identity,
  makeCertDir,
  makeIdentity,
  opensslAvailable,
  removeCertDir,
} from "./helpers/throwaway-cert.js";

const b64u = (buf: Buffer) => buf.toString("base64url");
const fromB64u = (text: string) => Buffer.from(text, "base64url");

function subscriptionKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) =>
  Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));

/** RFC 8291 decryption of a single-record aes128gcm body. */
function decrypt(body: Buffer, ecdh: crypto.ECDH, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const shared = ecdh.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    ecdh.getPublicKey(),
    senderPublic,
  ]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  const delimiter = padded.lastIndexOf(2);
  return padded.subarray(0, delimiter).toString("utf8");
}

/** Verify an ES256 VAPID JWT against the raw (uncompressed point) VAPID public key. */
function verifyJwt(jwt: string, publicKey: string) {
  const [header, claims, signature] = jwt.split(".");
  const point = fromB64u(publicKey);
  const key = crypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
    },
    format: "jwk",
  });
  const valid = crypto.verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key, dsaEncoding: "ieee-p1363" },
    fromB64u(signature),
  );
  return {
    valid,
    header: JSON.parse(fromB64u(header).toString()),
    claims: JSON.parse(fromB64u(claims).toString()),
  };
}

const vapid = webPush.generateVAPIDKeys();
const SUBJECT = "mailto:ops@example.com";
const PAYLOAD = JSON.stringify({ title: "Meeting moved", body: "Now at 15:00", deliveryId: "d-1" });
const TOPIC = crypto.createHash("sha256").update("d-1").digest("base64url").slice(0, 32);

describe("web-push 4: request details", () => {
  it("encrypts a payload the subscription's keys decrypt, and signs a VAPID JWT that verifies", () => {
    const { ecdh, auth, keys } = subscriptionKeys();
    const details = webPush.generateRequestDetails(
      { endpoint: "https://push.example.test/send/abc", keys },
      PAYLOAD,
      {
        vapidDetails: {
          subject: SUBJECT,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
        TTL: 60,
        topic: TOPIC,
        urgency: "high",
      },
    );
    const headers = details.headers as Record<string, string>;

    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe(60);
    expect(headers.Topic).toBe(TOPIC);
    expect(headers.Urgency).toBe("high");
    expect(decrypt(details.body as Buffer, ecdh, auth)).toBe(PAYLOAD);

    const match = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization);
    expect(match?.[2]).toBe(vapid.publicKey);
    const jwt = verifyJwt(match?.[1] ?? "", vapid.publicKey);
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(jwt.claims.aud).toBe("https://push.example.test");
    expect(jwt.claims.sub).toBe(SUBJECT);
    const secondsLeft = jwt.claims.exp - Date.now() / 1000;
    expect(secondsLeft).toBeGreaterThan(0);
    expect(secondsLeft).toBeLessThanOrEqual(24 * 3600);
  });

  it("still refuses a topic longer than 32 characters", () => {
    const { keys } = subscriptionKeys();
    expect(() =>
      webPush.generateRequestDetails({ endpoint: "https://push.example.test/x", keys }, "x", {
        vapidDetails: {
          subject: SUBJECT,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
        topic: "a".repeat(33),
      }),
    ).toThrow();
  });
});

const HAS_OPENSSL = opensslAvailable();
let certDir = "";
let identity: Identity;

describe.skipIf(!HAS_OPENSSL)("web-push 4: sendNotification over TLS with the given agent", () => {
  let server: https.Server;
  const received: Array<{ headers: Record<string, unknown>; body: Buffer; url?: string }> = [];

  beforeAll(async () => {
    certDir = makeCertDir("klorn-webpush-");
    identity = makeIdentity(certDir, "push", "DNS:localhost,IP:127.0.0.1");
    server = https.createServer({ key: identity.key, cert: identity.cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url });
        res.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (certDir) removeCertDir(certDir);
  });

  it("delivers through the agent it is given; without it the self-signed server is refused", async () => {
    const { port } = server.address() as AddressInfo;
    const endpoint = `https://localhost:${port}/push/sub-1?x=1`;
    const { ecdh, auth, keys } = subscriptionKeys();
    webPush.setVapidDetails(SUBJECT, vapid.publicKey, vapid.privateKey);

    const trusting = new https.Agent({ ca: identity.cert });
    const sent = await webPush.sendNotification({ endpoint, keys }, PAYLOAD, {
      topic: TOPIC,
      agent: trusting,
    });
    expect(sent.statusCode).toBe(201);
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe("/push/sub-1?x=1");
    expect(received[0].headers.topic).toBe(TOPIC);
    expect(decrypt(received[0].body, ecdh, auth)).toBe(PAYLOAD);

    await expect(
      webPush.sendNotification({ endpoint, keys }, PAYLOAD, { topic: TOPIC }),
    ).rejects.toThrow();
    expect(received).toHaveLength(1);
  });
});
