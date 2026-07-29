import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Aera splash wordmark styles", () => {
  it("keeps vertical paint space for descending glyphs", () => {
    const styles = readFileSync("src/renderer/src/assets/main.css", "utf8");
    const wordmark = styles.match(/\.splash-wordmark\s*\{([\s\S]*?)\}/)?.[1];

    expect(wordmark).toContain("padding-block: 0.08em 0.2em");
  });
});
