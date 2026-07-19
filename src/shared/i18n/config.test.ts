import { describe, expect, it } from "vitest";

import { resolveSystemLocale } from "./config";

describe("system locale resolution", () => {
  it.each([
    ["zh-CN", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-TW", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],
    ["pt-BR", "pt-BR"],
    ["pt-PT", "pt-PT"],
    ["en-US", "en"],
  ] as const)("maps %s to %s", (systemLocale, expected) => {
    expect(resolveSystemLocale(systemLocale)).toBe(expected);
  });
});
