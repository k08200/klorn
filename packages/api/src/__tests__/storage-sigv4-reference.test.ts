/**
 * Pins the tests' own SigV4 implementation to the worked examples in the AWS S3
 * documentation ("Authenticating Requests: Using the Authorization Header" and
 * "Using Query Parameters"), and the signing library to the same answers. The
 * stand-in S3 server verifies every request with this reference, so it has to be
 * right before anything else can be trusted.
 */

import { AwsV4Signer } from "aws4fetch";
import { describe, expect, it } from "vitest";
import { referenceSignature, uriEncode } from "./helpers/sigv4-reference.js";

// The credentials AWS uses in its documentation examples. Not real.
const EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "s3",
  datetime: "20130524T000000Z",
  host: "examplebucket.s3.amazonaws.com",
} as const;

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("uriEncode", () => {
  it("leaves only the unreserved characters alone", () => {
    expect(uriEncode("AZaz09-_.~")).toBe("AZaz09-_.~");
    expect(uriEncode("a b/c*'()!;=\"")).toBe("a%20b%2Fc%2A%27%28%29%21%3B%3D%22");
    expect(uriEncode("a/b", false)).toBe("a/b");
    expect(uriEncode("보")).toBe("%EB%B3%B4");
  });
});

describe("referenceSignature against the AWS documentation", () => {
  it("reproduces the header-signed GET Object example", () => {
    const signature = referenceSignature({
      ...EXAMPLE,
      method: "GET",
      path: "/test.txt",
      query: [],
      headers: {
        host: EXAMPLE.host,
        range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": EXAMPLE.datetime,
      },
      payloadHash: EMPTY_SHA256,
    });
    expect(signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("reproduces the header-signed List Objects example (query parameters)", () => {
    const signature = referenceSignature({
      ...EXAMPLE,
      method: "GET",
      path: "/",
      query: [
        ["max-keys", "2"],
        ["prefix", "J"],
      ],
      headers: {
        host: EXAMPLE.host,
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": EXAMPLE.datetime,
      },
      payloadHash: EMPTY_SHA256,
    });
    expect(signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  it("reproduces the presigned URL example", () => {
    const signature = referenceSignature({
      ...EXAMPLE,
      method: "GET",
      path: "/test.txt",
      query: [
        ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
        ["X-Amz-Credential", `${EXAMPLE.accessKeyId}/20130524/us-east-1/s3/aws4_request`],
        ["X-Amz-Date", EXAMPLE.datetime],
        ["X-Amz-Expires", "86400"],
        ["X-Amz-SignedHeaders", "host"],
      ],
      headers: { host: EXAMPLE.host },
      payloadHash: "UNSIGNED-PAYLOAD",
    });
    expect(signature).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });
});

describe("aws4fetch on this runtime", () => {
  it("presigns the AWS documentation example to the published signature", async () => {
    const url = new URL(`https://${EXAMPLE.host}/test.txt`);
    url.searchParams.set("X-Amz-Expires", "86400");
    const signed = await new AwsV4Signer({
      method: "GET",
      url: url.toString(),
      accessKeyId: EXAMPLE.accessKeyId,
      secretAccessKey: EXAMPLE.secretAccessKey,
      region: EXAMPLE.region,
      service: EXAMPLE.service,
      datetime: EXAMPLE.datetime,
      signQuery: true,
    }).sign();
    expect(signed.url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
});
