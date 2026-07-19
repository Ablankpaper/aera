// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentDraftAssetInput,
  AgentEditableManifest,
} from "../src/shared/agentera-agent-control";
import {
  MAX_AGENT_ASSET_BYTES,
  MAX_AGENT_ASSET_COUNT,
  MAX_AGENT_BUNDLE_BYTES,
  MAX_AGENT_ICON_BYTES,
  MAX_AGENT_ICON_DIMENSION,
  canonicalizeEditableAgent,
  decodeEditableAgentManifest,
  readValidatedAgentAssetFile,
  validateAgentIcon,
} from "../src/main/agentera-agent-control/manifest";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

function editableManifest(): AgentEditableManifest {
  return {
    schemaVersion: 1,
    identity: { systemPrompt: "Agent identity" },
    assets: [
      {
        path: "skills/beta/SKILL.md",
        kind: "skill",
        mediaType: "text/markdown",
      },
      {
        path: "knowledge/alpha.md",
        kind: "knowledge",
        mediaType: "text/markdown",
      },
    ],
    modelConstraints: {
      allowedProviders: ["openai", "anthropic"],
      allowedModels: ["gpt-5.6", "claude-opus-5"],
    },
    tools: {
      allowed: ["web.search", "files.read"],
      denied: ["shell.exec"],
    },
    dependencies: [
      { agentDefinitionId: DEFINITION_ID, agentVersionId: VERSION_ID },
    ],
    runtimeCompatibility: {
      minimumVersion: "0.18.2-agentera.1",
      maximumVersionExclusive: "v0.19.0",
    },
  };
}

function editableAssets(): AgentDraftAssetInput[] {
  return [
    { path: "skills/beta/SKILL.md", content: "# Beta\n" },
    { path: "knowledge/alpha.md", content: "# Alpha\n" },
  ];
}

function oneAsset(
  path: string,
  content = "content",
): {
  manifest: AgentEditableManifest;
  assets: AgentDraftAssetInput[];
} {
  const manifest = editableManifest();
  manifest.assets = [{ path, kind: "knowledge", mediaType: "text/markdown" }];
  return { manifest, assets: [{ path, content }] };
}

function webPVP8X(width: number, height: number, animated: boolean): Buffer {
  const data = Buffer.alloc(10);
  if (animated) data[0] = 0x02;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  const output = Buffer.alloc(12 + 8 + data.length);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WEBP", 8);
  output.write("VP8X", 12);
  output.writeUInt32LE(data.length, 16);
  data.copy(output, 20);
  return output;
}

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentEra editable Agent manifest", () => {
  it("matches cloud canonical ordering, limits, and content digests", () => {
    const canonical = canonicalizeEditableAgent(
      editableManifest(),
      editableAssets(),
    );
    const permutedManifest = editableManifest();
    permutedManifest.assets.reverse();
    permutedManifest.modelConstraints.allowedProviders.reverse();
    permutedManifest.modelConstraints.allowedModels.reverse();
    permutedManifest.tools.allowed.reverse();
    const permuted = canonicalizeEditableAgent(
      permutedManifest,
      editableAssets().reverse(),
    );
    expect(permuted.manifestBytes).toEqual(canonical.manifestBytes);
    expect(permuted.bundleBytes).toEqual(canonical.bundleBytes);
    expect(canonical.manifestBytes.toString()).toBe(
      '{"assets":[{"kind":"knowledge","media_type":"text/markdown","path":"knowledge/alpha.md","sha256":"017b70af1737a855266fc9eb9b3f88917dc972f20d2a1c7d6baa03b85260e8b8"},{"kind":"skill","media_type":"text/markdown","path":"skills/beta/SKILL.md","sha256":"1a26417491f915994a558d790278bf0a7dde56e16dbb87effde011215c2fe713"}],"dependencies":[{"agent_definition_id":"11111111-1111-4111-8111-111111111111","agent_version_id":"22222222-2222-4222-8222-222222222222"}],"identity":{"system_prompt":"Agent identity"},"model_constraints":{"allowed_models":["claude-opus-5","gpt-5.6"],"allowed_providers":["anthropic","openai"]},"runtime_compatibility":{"maximum_version_exclusive":"v0.19.0","minimum_version":"v0.18.2-agentera.1"},"schema_version":1,"tools":{"allowed":["files.read","web.search"],"denied":["shell.exec"]}}',
    );
    expect(canonical.bundleBytes.toString()).toBe(
      '{"assets":[{"content":"# Alpha\\n","path":"knowledge/alpha.md"},{"content":"# Beta\\n","path":"skills/beta/SKILL.md"}]}',
    );
    expect(canonical.manifestDigest).toBe(
      createHash("sha256").update(canonical.manifestBytes).digest("hex"),
    );
    expect(canonical.bundleDigest).toBe(
      createHash("sha256").update(canonical.bundleBytes).digest("hex"),
    );
    expect(canonical.contentDigest).toBe(
      createHash("sha256")
        .update(canonical.manifestBytes)
        .update(Buffer.from([0]))
        .update(canonical.bundleBytes)
        .digest("hex"),
    );
  });

  it.each([
    "../escape.md",
    "/absolute.md",
    "C:/windows.md",
    "C:\\windows.md",
    "\\\\server\\share\\file.md",
    "skills\\windows.md",
    "skills/../escape.md",
    "./skills/dot.md",
    "https://example.com/remote.md",
    "skills/nul\0.md",
    ".env",
    "private/auth.json",
    "MEMORY.md",
    "USER.md",
    "sessions/session.json",
    "Curator/candidate.md",
    "credentials/token.txt",
    "CON",
    "knowledge/NUL.txt",
  ])("rejects unsafe asset path %j", (path) => {
    const fixture = oneAsset(path);
    expect(() =>
      canonicalizeEditableAgent(fixture.manifest, fixture.assets),
    ).toThrow(/invalid_agent_content/);
  });

  it("rejects Unicode-normalized duplicates and non-regular asset files", () => {
    const manifest = editableManifest();
    manifest.assets = [
      {
        path: "knowledge/e\u0301.md",
        kind: "knowledge",
        mediaType: "text/markdown",
      },
      {
        path: "knowledge/é.md",
        kind: "knowledge",
        mediaType: "text/markdown",
      },
    ];
    expect(() =>
      canonicalizeEditableAgent(manifest, [
        { path: "knowledge/e\u0301.md", content: "one" },
        { path: "knowledge/é.md", content: "two" },
      ]),
    ).toThrow(/invalid_agent_content/);

    const root = mkdtempSync(join(tmpdir(), "agentera-asset-file-"));
    roots.push(root);
    const outside = join(root, "outside");
    expect(() =>
      readValidatedAgentAssetFile(root, "device.txt", {
        lstat: () => ({ isFile: () => false, isSymbolicLink: () => false }),
        realpath: () => outside,
        readFile: () => Buffer.from("device"),
      }),
    ).toThrow(/regular file|invalid_agent_content/);
    expect(() =>
      readValidatedAgentAssetFile(root, "link.txt", {
        lstat: () => ({ isFile: () => true, isSymbolicLink: () => true }),
        realpath: () => outside,
        readFile: () => Buffer.from("link"),
      }),
    ).toThrow(/symlink|invalid_agent_content/);
  });

  it("strictly decodes editable JSON and rejects unknown, duplicate, and invalid UTF-8 input", () => {
    const raw = JSON.stringify(editableManifest());
    expect(decodeEditableAgentManifest(Buffer.from(raw))).toEqual(
      editableManifest(),
    );
    expect(() =>
      decodeEditableAgentManifest(
        Buffer.from(
          raw.replace(
            '{"schemaVersion":1',
            '{"schemaVersion":1,"unexpected":true',
          ),
        ),
      ),
    ).toThrow(/invalid_agent_content/);
    expect(() =>
      decodeEditableAgentManifest(
        Buffer.from(
          raw.replace(
            '{"schemaVersion":1',
            '{"schemaVersion":1,"schemaVersion":1',
          ),
        ),
      ),
    ).toThrow(/invalid_agent_content/);
    const invalidUtf8 = Buffer.concat([
      Buffer.from(raw.slice(0, 10)),
      Buffer.from([0xff]),
      Buffer.from(raw.slice(11)),
    ]);
    expect(() => decodeEditableAgentManifest(invalidUtf8)).toThrow(
      /invalid_agent_content/,
    );
  });

  it("rejects asset, bundle, manifest, dependency, runtime, and secret limits", () => {
    const tooMany = editableManifest();
    tooMany.assets = Array.from(
      { length: MAX_AGENT_ASSET_COUNT + 1 },
      (_, index) => ({
        path: `knowledge/${index}.md`,
        kind: "knowledge" as const,
        mediaType: "text/markdown" as const,
      }),
    );
    expect(() =>
      canonicalizeEditableAgent(
        tooMany,
        tooMany.assets.map(({ path }) => ({ path, content: "x" })),
      ),
    ).toThrow(/invalid_agent_content/);

    const oversized = oneAsset(
      "knowledge/large.md",
      "a".repeat(MAX_AGENT_ASSET_BYTES + 1),
    );
    expect(() =>
      canonicalizeEditableAgent(oversized.manifest, oversized.assets),
    ).toThrow(/invalid_agent_content/);

    const totalManifest = editableManifest();
    totalManifest.assets = Array.from({ length: 9 }, (_, index) => ({
      path: `knowledge/${index}.md`,
      kind: "knowledge" as const,
      mediaType: "text/markdown" as const,
    }));
    const totalAssets = totalManifest.assets.map(({ path }, index) => ({
      path,
      content: String.fromCharCode(65 + index).repeat(
        Math.floor(MAX_AGENT_BUNDLE_BYTES / 8),
      ),
    }));
    expect(() => canonicalizeEditableAgent(totalManifest, totalAssets)).toThrow(
      /invalid_agent_content/,
    );

    const hugeManifest = editableManifest();
    hugeManifest.identity.systemPrompt = "x".repeat(256 * 1024 + 1);
    expect(() =>
      canonicalizeEditableAgent(hugeManifest, editableAssets()),
    ).toThrow(/invalid_agent_content/);

    const invalidDependency = editableManifest() as unknown as Record<
      string,
      unknown
    >;
    invalidDependency.dependencies = [
      {
        agentDefinitionId: DEFINITION_ID,
        agentVersionId: VERSION_ID,
        command: "sh",
      },
    ];
    expect(() =>
      canonicalizeEditableAgent(
        invalidDependency as unknown as AgentEditableManifest,
        editableAssets(),
      ),
    ).toThrow(/invalid_agent_content/);

    const invalidRuntime = editableManifest();
    invalidRuntime.runtimeCompatibility.maximumVersionExclusive =
      "v0.18.2-agentera.1";
    expect(() =>
      canonicalizeEditableAgent(invalidRuntime, editableAssets()),
    ).toThrow(/runtime_incompatible/);

    const secret = oneAsset(
      "knowledge/config.md",
      "OPENAI_API_KEY=sk-this-is-a-real-looking-secret-value",
    );
    expect(() =>
      canonicalizeEditableAgent(secret.manifest, secret.assets),
    ).toThrow(/secret_detected/);

    const invalidUnicode = oneAsset("knowledge/bad.md", "\ud800");
    expect(() =>
      canonicalizeEditableAgent(invalidUnicode.manifest, invalidUnicode.assets),
    ).toThrow(/invalid_agent_content/);
  });

  it("accepts static bounded PNG/WebP icons and rejects animation, dimensions, bytes, and type mismatch", () => {
    expect(() => validateAgentIcon("image/png", VALID_PNG)).not.toThrow();
    expect(() =>
      validateAgentIcon("image/webp", webPVP8X(1, 1, false)),
    ).not.toThrow();

    const largePng = Buffer.from(VALID_PNG);
    largePng.writeUInt32BE(MAX_AGENT_ICON_DIMENSION + 1, 16);
    const animatedPng = Buffer.concat([
      VALID_PNG.subarray(0, 33),
      Buffer.from([0, 0, 0, 0, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 0]),
      VALID_PNG.subarray(33),
    ]);
    for (const [mediaType, data] of [
      ["image/png", Buffer.alloc(MAX_AGENT_ICON_BYTES + 1)],
      ["image/png", largePng],
      ["image/png", animatedPng],
      ["image/webp", webPVP8X(MAX_AGENT_ICON_DIMENSION + 1, 1, false)],
      ["image/webp", webPVP8X(1, 1, true)],
      ["image/webp", VALID_PNG],
      ["image/svg+xml", Buffer.from("<svg/>")],
    ] as const) {
      expect(() => validateAgentIcon(mediaType, data)).toThrow(
        /invalid_agent_content/,
      );
    }
  });
});
