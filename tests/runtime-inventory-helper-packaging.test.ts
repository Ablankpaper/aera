import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

const enabled = process.env.AGENTERA_RUNTIME_HELPER_BUILD_TEST === "1";
const buildTest = enabled ? it : it.skip;

buildTest(
  "limits the packaged Electron Node helper to native Node filesystem APIs",
  async () => {
    const main = await readFile("out/main/runtime-inventory-helper.js", "utf8");
    const chunkNames = await readdir("out/main/chunks");
    const helperChunks = chunkNames.filter(
      (name) => name.startsWith("inventory-") || name.startsWith("manifest-"),
    );
    const sources = await Promise.all(
      helperChunks.map((name) =>
        readFile(join("out/main/chunks", name), "utf8"),
      ),
    );
    const builtHelper = [main, ...sources].join("\n");

    expect(helperChunks).toHaveLength(2);
    expect(builtHelper).not.toContain("@electron-internal/extract-zip");
    expect(builtHelper).not.toContain('require("electron")');
    expect(builtHelper).toContain(
      'process.env[RUNTIME_INVENTORY_HELPER_MARKER] === "1"',
    );
    expect(builtHelper).toContain("AGENTERA_RUNTIME_INVENTORY_HELPER");
    expect(builtHelper).not.toContain("better-sqlite3");
  },
);
