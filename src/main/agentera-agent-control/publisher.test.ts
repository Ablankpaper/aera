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
  type AgentAssetContext,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { AgentDraftStore } from "./draft-store";
import { canonicalizeEditableAgent } from "./manifest";
import {
  AgentPublisher,
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
const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
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
  let signingKeys: components["schemas"]["SigningKeySet"];
  let client: AgentPublicationClient;
  let publishInitial: Mock<AgentPublicationClient["publishInitial"]>;
  let publishNext: Mock<AgentPublicationClient["publishNext"]>;
  let publishWorkspaceInitial: Mock<
    AgentPublicationClient["publishWorkspaceInitial"]
  >;
  let publishWorkspaceNext: Mock<
    AgentPublicationClient["publishWorkspaceNext"]
  >;
  let cache: VerifiedAgentVersionCache;
  let cacheVersion: Mock<VerifiedAgentVersionCache["cacheVerifiedVersion"]>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-publisher-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    drafts = new AgentDraftStore({
      database,
      owner: {
        tenantId: "77777777-7777-4777-8777-777777777777",
        ownerId: "88888888-8888-4888-8888-888888888888",
      },
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
    signingKeys = fixture.signingKeys;
    trust = new AgenteraAgentTrustStore();
    trust.replaceKeys(ORIGIN, fixture.signingKeys, NOW.toISOString());
    publishInitial = vi
      .fn<AgentPublicationClient["publishInitial"]>()
      .mockResolvedValue(publication);
    publishNext = vi
      .fn<AgentPublicationClient["publishNext"]>()
      .mockResolvedValue(publication);
    publishWorkspaceInitial = vi
      .fn<AgentPublicationClient["publishWorkspaceInitial"]>()
      .mockResolvedValue(publication);
    publishWorkspaceNext = vi
      .fn<AgentPublicationClient["publishWorkspaceNext"]>()
      .mockResolvedValue(publication);
    client = {
      origin: ORIGIN,
      publishInitial,
      publishNext,
      publishWorkspaceInitial,
      publishWorkspaceNext,
    };
    cacheVersion = vi
      .fn<VerifiedAgentVersionCache["cacheVerifiedVersion"]>()
      .mockReturnValue(publication.version);
    cache = { cacheVerifiedVersion: cacheVersion };
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function publisher(
    context: AgentAssetContext = { scope: "USER" },
  ): AgentPublisher {
    return new AgentPublisher({
      drafts,
      client,
      trust,
      cache,
      context,
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
    expect(drafts.getDraft(DRAFT_ID).lastPublicationAttempt).toBeNull();
    await expect(service.confirmPublication(HANDLE_ID)).rejects.toMatchObject({
      code: "publication_confirmation_invalid",
    });
    expect(publishInitial).toHaveBeenCalledOnce();
  });

  it("refreshes signing keys once when a newly published version uses a rotated key", async () => {
    const staleTrust = new AgenteraAgentTrustStore();
    const refreshTrust = vi.fn(async () => {
      staleTrust.replaceKeys(ORIGIN, signingKeys, NOW.toISOString());
    });
    const service = new AgentPublisher({
      drafts,
      client,
      trust: staleTrust,
      cache,
      runtimeVersion: "v0.18.2-agentera.1",
      refreshTrust,
      randomUUID: () => HANDLE_ID,
    });

    await expect(
      service.confirmPublication(
        service.preparePublication(DRAFT_ID).publicationHandle,
      ),
    ).resolves.toMatchObject({ versionId: VERSION_ID });
    expect(refreshTrust).toHaveBeenCalledOnce();
    expect(cacheVersion).toHaveBeenCalledWith(publication.version);
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

  it("publishes an edited definition with its updated display name from the exact immutable base version", async () => {
    drafts.deleteDraft(DRAFT_ID);
    drafts.createDraft({
      sourceAgentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: BASE_VERSION_ID,
      displayName: "Renamed Research Agent",
      icon: null,
      manifest: manifest(),
      assets: assets(),
    });
    publication = {
      ...publication,
      definition: {
        ...publication.definition,
        display_name: "Renamed Research Agent",
      },
    };
    publishNext.mockResolvedValue(publication);
    const service = publisher();
    const preview = service.preparePublication(DRAFT_ID);
    await service.confirmPublication(preview.publicationHandle);
    expect(publishInitial).not.toHaveBeenCalled();
    expect(publishNext).toHaveBeenCalledOnce();
    expect(publishNext.mock.calls[0][0]).toBe(DEFINITION_ID);
    expect(publishNext.mock.calls[0][1]).toMatchObject({
      base_version_id: BASE_VERSION_ID,
      display_name: "Renamed Research Agent",
    });
  });

  it("rejects a next publication response that keeps the stale definition name", async () => {
    drafts.deleteDraft(DRAFT_ID);
    drafts.createDraft({
      sourceAgentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: BASE_VERSION_ID,
      displayName: "Renamed Research Agent",
      icon: null,
      manifest: manifest(),
      assets: assets(),
    });

    const service = publisher();
    await expect(
      service.confirmPublication(
        service.preparePublication(DRAFT_ID).publicationHandle,
      ),
    ).rejects.toMatchObject({ code: "published_content_mismatch" });
    expect(drafts.getDraft(DRAFT_ID).publishedRevision).toBeNull();
  });

  it.each(["owner", "admin"] as const)(
    "routes %s publication through the exact Workspace target",
    async (role) => {
      drafts.deleteDraft(DRAFT_ID);
      const context = {
        scope: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
        role,
      } as const;
      drafts = new AgentDraftStore({
        database,
        owner: {
          tenantId: "77777777-7777-4777-8777-777777777777",
          ownerId: "88888888-8888-4888-8888-888888888888",
        },
        context,
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

      const service = publisher(context);
      const preview = service.preparePublication(DRAFT_ID);
      expect(preview.targetScope).toBe("WORKSPACE");
      await service.confirmPublication(preview.publicationHandle);
      expect(publishWorkspaceInitial).toHaveBeenCalledWith(
        WORKSPACE_ID,
        expect.objectContaining({ display_name: "Research Agent" }),
        expect.any(String),
      );
      expect(publishInitial).not.toHaveBeenCalled();

      drafts.updateDraft({
        id: DRAFT_ID,
        expectedRevision: 1,
        displayName: "Renamed Workspace Agent",
        icon: null,
        manifest: manifest(),
        assets: assets(),
      });
      publication = {
        ...publication,
        definition: {
          ...publication.definition,
          display_name: "Renamed Workspace Agent",
        },
      };
      publishWorkspaceNext.mockResolvedValue(publication);
      const next = publisher(context);
      await next.confirmPublication(
        next.preparePublication(DRAFT_ID).publicationHandle,
      );
      expect(publishWorkspaceNext).toHaveBeenCalledWith(
        WORKSPACE_ID,
        DEFINITION_ID,
        expect.objectContaining({
          base_version_id: VERSION_ID,
          display_name: "Renamed Workspace Agent",
        }),
        expect.any(String),
      );
      expect(publishNext).not.toHaveBeenCalled();
    },
  );

  // @lat: [[agentera-agent-control-plane#Trusted Workspace Agent context#Role-gated publication]]
  it("rejects Member publication locally before any upload", () => {
    const member = publisher({
      scope: "WORKSPACE",
      workspaceId: WORKSPACE_ID,
      role: "member",
    });

    expect(() => member.preparePublication(DRAFT_ID)).toThrow(
      expect.objectContaining({ code: "workspace_forbidden" }),
    );
    expect(publishInitial).not.toHaveBeenCalled();
    expect(publishNext).not.toHaveBeenCalled();
    expect(publishWorkspaceInitial).not.toHaveBeenCalled();
    expect(publishWorkspaceNext).not.toHaveBeenCalled();
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
      owner: {
        tenantId: "77777777-7777-4777-8777-777777777777",
        ownerId: "88888888-8888-4888-8888-888888888888",
      },
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
    ).rejects.toMatchObject({ code: "published_content_mismatch" });
    expect(cacheVersion).not.toHaveBeenCalled();
    expect(drafts.getDraft(DRAFT_ID).publishedRevision).toBeNull();
  });

  it("records the exact local trust failure while keeping publication closed", async () => {
    publishInitial.mockResolvedValueOnce({
      ...publication,
      version: {
        ...publication.version,
        signature: `${publication.version.signature.slice(0, -1)}${
          publication.version.signature.endsWith("A") ? "B" : "A"
        }`,
      },
    });
    const service = publisher();
    const preview = service.preparePublication(DRAFT_ID);

    await expect(
      service.confirmPublication(preview.publicationHandle),
    ).rejects.toMatchObject({ code: "signature_verification_failed" });
    expect(cacheVersion).not.toHaveBeenCalled();
    expect(drafts.getDraft(DRAFT_ID).publishedRevision).toBeNull();
    expect(drafts.getDraft(DRAFT_ID).lastPublicationAttempt).toMatchObject({
      errorCode: "signature_invalid",
      errorSummary: "Published Agent signature verification failed.",
    });
  });

  it("keeps Runtime incompatibility distinct from signature verification", async () => {
    const service = new AgentPublisher({
      drafts,
      client,
      trust,
      cache,
      runtimeVersion: "v0.18.1",
      randomUUID: () => HANDLE_ID,
    });
    const preview = service.preparePublication(DRAFT_ID);

    await expect(
      service.confirmPublication(preview.publicationHandle),
    ).rejects.toMatchObject({ code: "runtime_incompatible" });
    expect(cacheVersion).not.toHaveBeenCalled();
    expect(drafts.getDraft(DRAFT_ID).lastPublicationAttempt).toMatchObject({
      errorCode: "runtime_incompatible",
      errorSummary: "Runtime version is incompatible.",
    });
  });

  it("reports a verified-version cache failure separately from signature and content failures", async () => {
    cacheVersion.mockImplementationOnce(() => {
      throw Object.assign(new Error("private cache path"), {
        code: "cache_corrupt",
      });
    });
    const service = publisher();
    const preview = service.preparePublication(DRAFT_ID);

    await expect(
      service.confirmPublication(preview.publicationHandle),
    ).rejects.toMatchObject({ code: "publication_cache_failed" });
    expect(drafts.getDraft(DRAFT_ID).publishedRevision).toBeNull();
    expect(drafts.getDraft(DRAFT_ID).lastPublicationAttempt).toMatchObject({
      errorCode: "cache_corrupt",
      errorSummary: "Verified Agent version cache failed.",
    });
  });
});
