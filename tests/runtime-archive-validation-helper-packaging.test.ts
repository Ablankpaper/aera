import { readdir, readFile } from "node:fs/promises";

import { expect, it } from "vitest";

const enabled = process.env.AGENTERA_RUNTIME_ARCHIVE_HELPER_BUILD_TEST === "1";
const buildTest = enabled ? it : it.skip;

buildTest(
  "limits the packaged archive-validation helper to Runtime-safe dependencies",
  async () => {
    const main = await readFile(
      "out/main/runtime-archive-validation-helper.js",
      "utf8",
    );
    const chunkNames = await readdir("out/main/chunks");
    const helperChunks = chunkNames.filter((name) =>
      /^(archive-validation|index-|inventory-|manifest-)/u.test(name),
    );
    const sources = await Promise.all(
      helperChunks.map((name) => readFile(`out/main/chunks/${name}`, "utf8")),
    );
    const builtHelper = [main, ...sources].join("\n");

    expect(builtHelper).not.toContain("better-sqlite3");
    expect(builtHelper).not.toContain("@electron-internal/extract-zip");
    expect(builtHelper).toContain("fromRandomAccessReaderPromise");
    expect(builtHelper).toContain("AGENTERA_RUNTIME_ARCHIVE_VALIDATION_HELPER");
  },
);
