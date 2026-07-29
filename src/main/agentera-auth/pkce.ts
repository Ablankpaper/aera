import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

export interface AgenteraPkceAttempt {
  state: string;
  verifier: string;
  challenge: string;
}

export type AgenteraRandomBytes = (size: number) => Buffer;

function requireRandomBytes(value: Buffer, expectedSize: number): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== expectedSize) {
    throw new Error("Aera PKCE random source returned invalid entropy.");
  }
  return value;
}

/** Create fresh 256-bit state and verifier values for one browser attempt. */
export function createAgenteraPkceAttempt(
  randomBytes: AgenteraRandomBytes = nodeRandomBytes,
): AgenteraPkceAttempt {
  const state = requireRandomBytes(randomBytes(32), 32).toString("base64url");
  const verifier = requireRandomBytes(randomBytes(32), 32).toString(
    "base64url",
  );
  const challenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return { state, verifier, challenge };
}
