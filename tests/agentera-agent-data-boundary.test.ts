// @vitest-environment node

import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDraft } from "../src/shared/agentera-agent-control";
import { AgenteraAgentControlClientError } from "../src/main/agentera-agent-control/client";
import {
  AgentPublisher,
  type AgentPublicationClient,
  type AgentPublicationDraftStore,
} from "../src/main/agentera-agent-control/publisher";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const HANDLE_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-19T19:00:00.000Z";
const roots: string[] = [];

function hashTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile()) {
        result[relative(root, path)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
    }
  };
  visit(root);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Agent publication private-data boundary", () => {
  it("has no Profile enumeration, legacy sync, or Hermes private-file dependency", () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const publisherSource = readFileSync(
      join(projectRoot, "src/main/agentera-agent-control/publisher.ts"),
      "utf8",
    ).toLowerCase();
    for (const forbidden of [
      "agent-sync",
      '"/api/agents"',
      "hermes one",
      "hermes_home",
      "memory.md",
      "user.md",
      "readdirsync",
      "opendir",
      "../profiles",
      "../sessions",
      'from "../db"',
    ]) {
      expect(publisherSource).not.toContain(forbidden);
    }
  });

  it("uses only explicitly selected draft bytes and leaves HERMES_HOME unchanged on failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-data-boundary-"));
    roots.push(root);
    const hermesHome = join(root, "hermes-home");
    cpSync(join(__dirname, "fixtures", "hermes-profile-boundary"), hermesHome, {
      recursive: true,
    });
    const before = hashTree(hermesHome);
    const previousHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = hermesHome;
    try {
      const draft: AgentDraft = {
        id: DRAFT_ID,
        sourceAgentDefinitionId: null,
        baseAgentVersionId: null,
        displayName: "Boundary Agent",
        icon: null,
        manifest: {
          schemaVersion: 1,
          identity: { systemPrompt: "Use selected public knowledge only" },
          assets: [
            {
              path: "knowledge/public.md",
              kind: "knowledge",
              mediaType: "text/markdown",
            },
          ],
          modelConstraints: {
            allowedProviders: ["openai"],
            allowedModels: ["gpt-5.6"],
          },
          tools: { allowed: ["files.read"], denied: [] },
          dependencies: [],
          runtimeCompatibility: {
            minimumVersion: "v0.18.2-agentera.1",
            maximumVersionExclusive: null,
          },
        },
        assets: [
          {
            path: "knowledge/public.md",
            kind: "knowledge",
            mediaType: "text/markdown",
            sizeBytes: 9,
            sha256:
              "b72f1bcd8e80d50840a8861f71c0f6c2a3ca3d37883f190d7bf1286a0c466bde",
          },
        ],
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        lastPublicationAttempt: null,
        publishedRevision: null,
      };
      const allowedStore: AgentPublicationDraftStore = {
        getDraft: vi.fn(() => draft),
        readAsset: vi.fn(() => Buffer.from("# Public\n")),
        beginPublicationAttempt: vi.fn(() => ({
          revision: 1,
          attemptedAt: NOW,
          idempotencyKey: ATTEMPT_ID,
        })),
        recordPublicationFailure: vi.fn(),
        markPublished: vi.fn(),
      };
      const guardedStore = new Proxy(allowedStore, {
        get(target, property, receiver) {
          if (typeof property === "string" && !(property in target)) {
            throw new Error(`unexpected draft-store capability: ${property}`);
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const client: AgentPublicationClient = {
        origin: "http://127.0.0.1:8086",
        publishInitial: vi
          .fn()
          .mockRejectedValue(
            new AgenteraAgentControlClientError(0, "network_unavailable"),
          ),
        publishNext: vi.fn(),
      };
      const publisher = new AgentPublisher({
        drafts: guardedStore,
        client,
        trust: { verifyVersion: vi.fn() },
        cache: { cacheVerifiedVersion: vi.fn() },
        runtimeVersion: "v0.18.2-agentera.1",
        randomUUID: () => HANDLE_ID,
      });
      const preview = publisher.preparePublication(DRAFT_ID);
      await expect(
        publisher.confirmPublication(preview.publicationHandle),
      ).rejects.toMatchObject({ code: "network_unavailable" });
      expect(allowedStore.readAsset).toHaveBeenCalledWith(
        DRAFT_ID,
        "knowledge/public.md",
      );
      expect(hashTree(hermesHome)).toEqual(before);
    } finally {
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previousHermesHome;
    }
  });
});
