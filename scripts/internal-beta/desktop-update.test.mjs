/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildDesktopUpdateManifest,
  canonicalDesktopUpdateJSONStringify,
  signDesktopUpdateManifest,
  verifyDesktopUpdateBundle,
} from "./desktop-update.mjs";

const VERSION = "0.7.4-internal-beta.38";
const BASE_URL = "https://47.100.169.193/desktop-updates/internal-beta";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aera-desktop-update-"));
  const artifactsDirectory = join(root, "artifacts");
  await mkdir(artifactsDirectory);
  await writeFile(
    join(artifactsDirectory, `Aera-Internal-Beta-${VERSION}-macos-arm64.zip`),
    "mac-update-bytes",
  );
  await writeFile(
    join(
      artifactsDirectory,
      `Aera-Internal-Beta-${VERSION}-windows-x64-app.zip`,
    ),
    "windows-update-bytes",
  );
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const publicKeyPath = join(root, "public.pem");
  await writeFile(publicKeyPath, publicKey);
  const manifest = await buildDesktopUpdateManifest({
    artifactsDirectory,
    baseUrl: BASE_URL,
    publishedAt: "2026-07-29T08:00:00Z",
    releaseNotes: "在线更新闭环与短信频控修复。",
    version: VERSION,
  });
  const manifestBytes = Buffer.from(
    canonicalDesktopUpdateJSONStringify(manifest),
  );
  const signature = signDesktopUpdateManifest(manifestBytes, privateKey);
  const manifestPath = join(root, "desktop-update-manifest.json");
  const signaturePath = join(root, "desktop-update-manifest.sig");
  await writeFile(manifestPath, manifestBytes);
  await writeFile(
    signaturePath,
    canonicalDesktopUpdateJSONStringify(signature),
  );
  return {
    artifactsDirectory,
    manifestPath,
    publicKeyPath,
    root,
    signaturePath,
  };
}

test("builds and verifies a signed macOS ZIP and Windows app ZIP update channel", async () => {
  const setup = await fixture();
  try {
    const manifest = await verifyDesktopUpdateBundle({
      artifactsDirectory: setup.artifactsDirectory,
      baseUrl: BASE_URL,
      manifest: setup.manifestPath,
      publicKey: setup.publicKeyPath,
      signature: setup.signaturePath,
      version: VERSION,
    });
    assert.equal(manifest.version, VERSION);
    assert.deepEqual(
      manifest.artifacts.map(({ platform, kind, name }) => ({
        platform,
        kind,
        name,
      })),
      [
        {
          platform: "darwin",
          kind: "zip",
          name: `Aera-Internal-Beta-${VERSION}-macos-arm64.zip`,
        },
        {
          platform: "win32",
          kind: "app_zip",
          name: `Aera-Internal-Beta-${VERSION}-windows-x64-app.zip`,
        },
      ],
    );
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("rejects changed metadata and changed installer bytes", async () => {
  const setup = await fixture();
  try {
    const raw = JSON.parse(await readFile(setup.manifestPath, "utf8"));
    raw.release_notes = "tampered";
    await writeFile(
      setup.manifestPath,
      canonicalDesktopUpdateJSONStringify(raw),
    );
    await assert.rejects(
      verifyDesktopUpdateBundle({
        artifactsDirectory: setup.artifactsDirectory,
        baseUrl: BASE_URL,
        manifest: setup.manifestPath,
        publicKey: setup.publicKeyPath,
        signature: setup.signaturePath,
        version: VERSION,
      }),
      /signature is invalid/u,
    );

    const clean = await fixture();
    try {
      await writeFile(
        join(
          clean.artifactsDirectory,
          `Aera-Internal-Beta-${VERSION}-windows-x64-app.zip`,
        ),
        "changed-windows-update-bytes",
      );
      await assert.rejects(
        verifyDesktopUpdateBundle({
          artifactsDirectory: clean.artifactsDirectory,
          baseUrl: BASE_URL,
          manifest: clean.manifestPath,
          publicKey: clean.publicKeyPath,
          signature: clean.signaturePath,
          version: VERSION,
        }),
        /artifact differs/u,
      );
    } finally {
      await rm(clean.root, { recursive: true, force: true });
    }
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});
