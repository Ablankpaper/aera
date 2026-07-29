import {
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { AgenteraAuthStore, type InstallationIdentity } from "./store";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function generateDeviceIdentity(): InstallationIdentity {
  const keyPair = generateKeyPairSync("ed25519");
  const publicDer = keyPair.publicKey.export({
    format: "der",
    type: "spki",
  }) as Buffer;
  const privateDer = keyPair.privateKey.export({
    format: "der",
    type: "pkcs8",
  }) as Buffer;
  if (
    publicDer.length !== ED25519_SPKI_PREFIX.length + 32 ||
    !publicDer
      .subarray(0, ED25519_SPKI_PREFIX.length)
      .equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error(
      "Node returned an unsupported Ed25519 public-key encoding.",
    );
  }
  return {
    installationId: randomUUID(),
    devicePublicKey: publicDer
      .subarray(ED25519_SPKI_PREFIX.length)
      .toString("base64url"),
    devicePrivateKey: privateDer.toString("base64"),
  };
}

/** Return the stable installation identity, creating it only on first use. */
export function getOrCreateAgenteraDeviceIdentity(
  store: AgenteraAuthStore,
): InstallationIdentity {
  const existing = store.getInstallation();
  if (existing) return existing;
  const generated = generateDeviceIdentity();
  store.saveInstallation(generated);
  return generated;
}

/** Sign one already-hashed protocol digest without exporting key material. */
export function signAgenteraDeviceDigest(
  devicePrivateKey: string,
  digest: Uint8Array,
): string {
  if (digest.byteLength !== 32) {
    throw new Error("Aera device signatures require a SHA-256 digest.");
  }
  const privateDer = Buffer.from(devicePrivateKey, "base64");
  if (
    privateDer.length === 0 ||
    privateDer.toString("base64") !== devicePrivateKey
  ) {
    throw new Error("Aera device private key is corrupt.");
  }
  const privateKey = createPrivateKey({
    key: privateDer,
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(digest), privateKey).toString("base64url");
}
