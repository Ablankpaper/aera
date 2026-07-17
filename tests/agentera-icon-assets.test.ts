import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readAsset = (path: string): Buffer => readFileSync(path);

function pngSize(path: string): { width: number; height: number } {
  const data = readAsset(path);
  expect(data.subarray(1, 4).toString("ascii")).toBe("PNG");
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

function pngHasAlpha(path: string): boolean {
  const colorType = readAsset(path).readUInt8(25);
  return colorType === 4 || colorType === 6;
}

describe("AgentEra icon assets", () => {
  // @lat: [[agentera-branding#Naming contract#Desktop identity]]
  it("uses the approved source and generated platform assets", () => {
    expect(
      createHash("sha256")
        .update(readAsset("assets/agentera-icon.png"))
        .digest("hex"),
    ).toBe("69c288f19128c275f5f574e995ae9544f18ff564e847339cf47d5345e231d882");
    expect(pngSize("build/icon.png")).toEqual({ width: 1024, height: 1024 });
    expect(pngSize("resources/icon.png")).toEqual({
      width: 512,
      height: 512,
    });
    expect(pngSize("src/renderer/src/assets/iconv2.png")).toEqual({
      width: 512,
      height: 512,
    });
    expect(pngHasAlpha("src/renderer/src/assets/iconv2.png")).toBe(true);
    expect(readAsset("build/icon.icns").subarray(0, 4).toString("ascii")).toBe(
      "icns",
    );
    expect([...readAsset("build/icon.ico").subarray(0, 4)]).toEqual([
      0, 0, 1, 0,
    ]);
  });
});
