import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractDesktopUpdateZip } from "../src/main/app/internal-beta-updater";

interface Entry {
  name: string;
  body: Buffer;
  mode: number;
  type: "file" | "symlink";
}

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    let next = (crc ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      next = (next & 1) === 0 ? next >>> 1 : 0xedb88320 ^ (next >>> 1);
    }
    crc = (crc >>> 8) ^ next;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipBuffer(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = entry.body;
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    const fileType = entry.type === "symlink" ? 0o120000 : 0o100000;
    central.writeUInt32LE(((fileType | entry.mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

describe("safe ZIP extraction", () => {
  it("rejects a symlink that points outside the extraction root", async () => {
    const root = await mkdtemp(join(tmpdir(), "aera-safe-zip-test-"));
    workspaces.push(root);
    const outside = join(root, "outside");
    const destination = join(root, "destination");
    await mkdir(outside);
    const archive = join(root, "malicious.zip");
    await writeFile(
      archive,
      zipBuffer([
        {
          name: "link",
          body: Buffer.from("../outside"),
          mode: 0o755,
          type: "symlink",
        },
      ]),
    );

    await expect(
      extractDesktopUpdateZip(archive, destination),
    ).rejects.toThrow();
  });

  it("extracts a valid archive through the production default extractor", async () => {
    const root = await mkdtemp(join(tmpdir(), "aera-safe-zip-test-"));
    workspaces.push(root);
    const archive = join(root, "valid.zip");
    const destination = join(root, "destination");
    await mkdir(destination);
    await writeFile(
      archive,
      zipBuffer([
        {
          name: "Aera.app/Contents/Resources/app.asar",
          body: Buffer.from("asar"),
          mode: 0o644,
          type: "file",
        },
      ]),
    );

    await expect(
      extractDesktopUpdateZip(archive, destination),
    ).resolves.toBeUndefined();
    await expect(
      readFile(
        join(destination, "Aera.app", "Contents", "Resources", "app.asar"),
        "utf8",
      ),
    ).resolves.toBe("asar");
  });
});
