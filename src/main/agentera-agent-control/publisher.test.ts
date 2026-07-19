// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  AgentDraftAssetInput,
  AgentEditableManifest,
} from "../../shared/agentera-agent-control";
import type { components } from "../../shared/agentera-cloud-api.generated";
import {
  AgenteraAgentControlClientError,
  type AgentPublication,
  type AgentVersion,
} from "./client";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { AgentDraftStore } from "./draft-store";
import { canonicalizeEditableAgent } from "./manifest";
import {
  AgentPublisher,
  AgentPublisherError,
  type AgentPublicationClient,
  type VerifiedAgentVersionCache,
} from "./publisher";
import { AgenteraAgentTrustStore } from "./trust";

const ORIGIN = "http://127.0.0.1:8086";
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const DEFINITION_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const HANDLE_ID = "44444444-4444-4444-8444-444444444444";
const BASE_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-07-19T18:00:00.000Z");
const KEY_ID = "agent-publisher-test-v1";
const SPKI_PREFIX_LENGTH = 12;

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function manifest(systemPrompt = "Research safely"): AgentEditableManifest {
  return {
    schemaVersion: 1,
    identity: { systemPrompt },
    assets: [
      {
        path: "knowledge/notes.md",
        kind: "knowledge",
        mediaType: "text/markdown",
      },
    ],
    modelConstraints: {
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    },
    tools: { allowed: ["files.read"], denied: ["shell.exec"] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: "v0.18.2-agentera.1",
      maximumVersionExclusive: "v0.19.0",
    },
  };
}

function assets(content = "# Notes\n"): AgentDraftAssetInput[] {
  return [{ path: "knowledge/notes.md", content }];
}

function signedPublication(): {
  publication: AgentPublication;
  signingKeys: components["schemas"]["SigningKeySet"];
} {
  const canonical = canonicalizeEditableAgent(manifest(), assets());
  const pair = generateKeyPairSync("ed25519");
  const publicDer = Buffer.from(
    pair.publicKey.export({ format: "der", type: "spki" }),
  );
  const manifestValue = JSON.parse(
    canonical.manifestBytes.toString("utf8"),
  ) as AgentVersion["manifest"];
  const bundleValue = JSON.parse(
    canonical.bundleBytes.toString("utf8"),
  ) as AgentVersion["bundle"];
  const signaturePayload = Buffer.from(
    [
      "agentera-agent-version-v1",
      DEFINITION_ID,
      VERSION_ID,
      "1",
      canonical.manifestDigest,
      canonical.bundleDigest,
    ].join("\0"),
    "utf8",
  );
  const version: AgentVersion = {
    id: VERSION_ID,
    definition_id: DEFINITION_ID,
    version_number: 1,
    manifest: manifestValue,
    bundle: bundleValue,
    content_digest: canonical.contentDigest,
    signing_key_id: KEY_ID,
    signature: sign(null, signaturePayload, pair.privateKey).toString(
      "base64url",
    ),
    runtime_minimum_version: "v0.18.2-agentera.1",
    runtime_maximum_version_exclusive: "v0.19.0",
    published_at: NOW.toISOString(),
  };
  return {
    publication: {
      definition: {
        id: DEFINITION_ID,
        display_name: "Research Agent",
        status: "active",
        latest_version_id: VERSION_ID,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      },
      version,
      replayed: false,
    },
    signingKeys: {
      keys: [
        {
          kid: KEY_ID,
          kty: "OKP",
          crv: "Ed25519",
          alg: "EdDSA",
          use: "sig",
          purpose: "agent_version",
          x: publicDer.subarray(SPKI_PREFIX_LENGTH).toString("base64url"),
        },
      ],
    },
  };
}

function snapshotTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile()) {
        result[relative(root, path)] = readFileSync(path, "utf8");
      }
    }
  };
  visit(root);
  return result;
}

describe("explicit Agent publication", () => {
  let root = "";
  let database: AgenteraControlPlaneDatabase;
  let drafts: AgentDraftStore;
  let trust: AgenteraAgentTrustStore;
  let publication: AgentPublication;
  let client: AgentPublicationClient;
  let publishInitial: Mock<AgentPublicationClient["publishInitial"]>;
  let publishNext: Mock<AgentPublicationClient["publishNext"]>;
  let cache: VerifiedAgentVersionCache;
  let cacheVersion: Mock<VerifiedAgentVersionCache["cacheVerifiedVersion"]>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-publisher-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    drafts = new AgentDraftStore({
      database,
      now: () => NOW,
      randomUUID: () => DRAFT_ID,
    });
    drafts.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Research Agent",
      icon: null,
      manifest: manifest(),
      assets: assets(),
    });
    const fixture = signedPublication();
    publication = fixture.publication;
    trust = new AgenteraAgentTrustStore();
    trust.replaceKeys(ORIGIN, fixture.signingKeys, NOW.toISOString());
    publishInitial = vi
      .fn<AgentPublicationClient["publishInitial"]>()
      .mockResolvedValue(publication);
    publishNext = vi
      .fn<AgentPublicationClient["publishNext"]>()
      .mockResolvedValue(publication);
    client = { origin: ORIGIN, publishInitial, publishNext };
    cacheVersion = vi
      .fn<VerifiedAgentVersionCache["cacheVerifiedVersion"]>()
      .mockReturnValue(publication.version);
    cache = { cacheVerifiedVersion: cacheVersion };
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function publisher(): AgentPublisher {
    return new AgentPublisher({
      drafts,
      client,
      trust,
      cache,
      runtimeVersion: "v0.18.2-agentera.1",
      randomUUID: () => HANDLE_ID,
    });
  }

  it("previews without network and publishes only through a one-use confirmation", async () => {
    const service = publisher();
    const preview = service.preparePublication(DRAFT_ID);
    expect(preview).toEqual({
      publicationHandle: HANDLE_ID,
      draftId: DRAFT_ID,
      revision: 1,
      targetScope: "USER",
      assetCounts: { skill: 0, sop: 0, knowledge: 1 },
      totalBytes: Buffer.byteLength("# Notes\n"),
    });
    expect(publishInitial).not.toHaveBeenCalled();
    expect(publishNext).not.toHaveBeenCalled();

    await expect(service.confirmPublication(HANDLE_ID)).resolves.toEqual({
      draftId: DRAFT_ID,
      revision: 1,
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      versionNumber: 1,
      contentDigest: publication.version.content_digest,
      publishedAt: NOW.toISOString(),
      replayed: false,
    });
    expect(publishInitial).toHaveBeenCalledOnce();
    expect(cacheVersion).toHaveBeenCalledWith(publication.version);
    expect(drafts.getDraft(DRAFT_ID).publishedRevision).toEqual({
      revision: 1,
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
    });
    await expect(service.confirmPublication(HANDLE_ID)).rejects.toMatchObject({
      code: "publication_confirmation_invalid",
    });
    expect(publishInitial).toHaveBeenCalledOnce();
  });

  it("binds a preview to the exact draft revision", async () => {
    const service = publisher();
    const preview = service.preparePublication(DRAFT_ID);
    drafts.updateDraft({
      id: DRAFT_ID,
      expectedRevision: 1,
      displayName: "Research Agent",
      icon: null,
      manifest: manifest("Changed after preview"),
      assets: assets(),
    });
    await expect(
      service.confirmPublication(preview.publicationHandle),
    ).rejects.toMatchObject({ code: "draft_conflict" });
    expect(publishInitial).not.toHaveBeenCalled();
  });

  it("publishes an edited definition from its exact immutable base version", async () => {
    drafts.deleteDraft(DRAFT_ID);
    drafts.createDraft({
      sourceAgentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: BASE_VERSION_ID,
      displayName: "Research Agent",
      icon: null,
      manifest: manifest(),
      assets: assets(),
    });
    const service = publisher();
    const preview = service.preparePublication(DRAFT_ID);
    await service.confirmPublication(preview.publicationHandle);
    expect(publishInitial).not.toHaveBeenCalled();
    expect(publishNext).toHaveBeenCalledOnce();
    expect(publishNext.mock.calls[0][0]).toBe(DEFINITION_ID);
    expect(publishNext.mock.calls[0][1]).toMatchObject({
      base_version_id: BASE_VERSION_ID,
    });
  });

  it("reuses the persisted idempotency key after restart and preserves draft assets on failure", async () => {
    const before = snapshotTree(database.paths.draftsPath);
    publishInitial.mockRejectedValueOnce(
      new AgenteraAgentControlClientError(0, "network_unavailable"),
    );
    const firstPublisher = publisher();
    const firstPreview = firstPublisher.preparePublication(DRAFT_ID);
    await expect(
      firstPublisher.confirmPublication(firstPreview.publicationHandle),
    ).rejects.toMatchObject({ code: "network_unavailable" });
    const firstKey = publishInitial.mock.calls[0][1];
    expect(snapshotTree(database.paths.draftsPath)).toEqual(before);
    expect(drafts.getDraft(DRAFT_ID).lastPublicationAttempt).toMatchObject({
      revision: 1,
      errorCode: "network_unavailable",
    });

    drafts = new AgentDraftStore({
      database,
      now: () => NOW,
      randomUUID: () => DRAFT_ID,
    });
    const restarted = publisher();
    const retryPreview = restarted.preparePublication(DRAFT_ID);
    await expect(
      restarted.confirmPublication(retryPreview.publicationHandle),
    ).resolves.toMatchObject({ versionId: VERSION_ID });
    expect(publishInitial.mock.calls[1][1]).toBe(firstKey);
  });

  it.each([
    ["session_revoked", 401],
    ["version_conflict", 409],
  ])("records the bounded %s failure without caching", async (code, status) => {
    publishInitial.mockRejectedValueOnce(
      new AgenteraAgentControlClientError(status, code),
    );
    const service = publisher();
    const preview = service.preparePublication(DRAFT_ID);
    await expect(
      service.confirmPublication(preview.publicationHandle),
    ).rejects.toMatchObject({ code });
    expect(cacheVersion).not.toHaveBeenCalled();
    const attempt = drafts.getDraft(DRAFT_ID).lastPublicationAttempt;
    expect(attempt?.errorCode).toBe(code);
    expect(attempt?.errorSummary).not.toContain("response");
  });

  it("rejects a server digest mismatch before cache or published state", async () => {
    publishInitial.mockResolvedValueOnce({
      ...publication,
      version: {
        ...publication.version,
        content_digest: "ab".repeat(32),
      },
    });
    const service = publisher();
    const preview = service.preparePublication(DRAFT_ID);
    await expect(
      service.confirmPublication(preview.publicationHandle),
    ).rejects.toBeInstanceOf(AgentPublisherError);
    expect(cacheVersion).not.toHaveBeenCalled();
    expect(drafts.getDraft(DRAFT_ID).publishedRevision).toBeNull();
  });
});
