import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { safeWriteFile } from "../src/main/utils";

const TEST_DIR = join(tmpdir(), `hermes-safe-write-${Date.now()}`);

describe("safeWriteFile", () => {
  it("creates parent directories before writing", () => {
    const filePath = join(TEST_DIR, "nested", "config.yaml");

    safeWriteFile(filePath, "provider: openai\n");

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("provider: openai\n");
  });

  it("replaces an existing file through a same-directory temp file", () => {
    const dir = join(TEST_DIR, "replace");
    const filePath = join(dir, "models.json");
    mkdirSync(dir, { recursive: true });

    safeWriteFile(filePath, "old");
    safeWriteFile(filePath, "new");

    expect(readFileSync(filePath, "utf-8")).toBe("new");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("flushes the temporary file, target, and parent after replacement", () => {
    const dir = join(TEST_DIR, "durable");
    const filePath = join(dir, "config.yaml");
    mkdirSync(dir, { recursive: true });
    const events: string[] = [];
    const adapter = {
      writeTemporary(target: string, content: string | Uint8Array): string {
        const temporary = `${target}.injected-temp`;
        events.push(`write:${target}`);
        writeFileSync(temporary, content);
        return temporary;
      },
      replace(temporary: string, target: string): void {
        events.push(`replace:${target}`);
        rmSync(target, { force: true });
        renameSync(temporary, target);
      },
      flushTarget(target: string): void {
        events.push(`flush-target:${target}`);
      },
      flushParent(parent: string): void {
        events.push(`flush-parent:${parent}`);
      },
    };

    safeWriteFile(filePath, "durable\n", undefined, adapter);

    expect(readFileSync(filePath, "utf8")).toBe("durable\n");
    expect(events).toEqual([
      `write:${filePath}`,
      `replace:${filePath}`,
      `flush-target:${filePath}`,
      `flush-parent:${dir}`,
    ]);
  });
});
