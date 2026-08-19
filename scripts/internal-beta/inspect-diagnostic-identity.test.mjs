import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "./inspect-diagnostic-identity.mjs";

test("writes one path-free installed application identity", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-inspect-identity-"));
  try {
    const app = join(root, "Aera.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(app, "Contents", "MacOS", "Aera"), "executable");
    chmodSync(join(app, "Contents", "MacOS", "Aera"), 0o755);
    writeFileSync(join(app, "Contents", "Resources", "app.asar"), "asar");
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      "<key>CFBundleIdentifier</key><string>com.example.aera</string><key>CFBundleShortVersionString</key><string>0.7.4-internal-beta.33</string>",
    );
    const output = join(root, "identity.json");
    assert.equal(
      main(["--app", app, "--platform", "darwin", "--output", output]),
      0,
    );
    const identity = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(Object.keys(identity).sort(), [
      "architecture",
      "bundleId",
      "executableSha256",
      "packageSha256",
      "platform",
      "version",
    ]);
    assert.doesNotMatch(
      JSON.stringify(identity),
      new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
