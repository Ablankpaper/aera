import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const preloadSrc = readFileSync(join(ROOT, "src/preload/index.ts"), "utf-8");
const preloadTypes = readFileSync(
  join(ROOT, "src/preload/index.d.ts"),
  "utf-8",
);

/**
 * Extract method names from the hermesAPI object in preload/index.ts.
 * Matches lines like `  methodName: (...` or `  methodName: ()`.
 */
function extractPreloadMethods(src: string): string[] {
  const objectMatch = src.match(/const\s+hermesAPI\s*=\s*\{([\s\S]*?)^\};/m);
  if (!objectMatch) return [];
  const methods: string[] = [];
  const re = /^\s{2}(\w+)\s*:\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(objectMatch[1])) !== null) {
    methods.push(m[1]);
  }
  return [...new Set(methods)];
}

/**
 * Extract method names from the HermesAPI interface in index.d.ts.
 */
function extractTypeMethods(src: string): string[] {
  const methods: string[] = [];
  // Match lines inside `interface HermesAPI { ... }`
  const interfaceMatch = src.match(/interface\s+HermesAPI\s*\{([\s\S]*?)^\}/m);
  if (!interfaceMatch) return [];
  const body = interfaceMatch[1];
  const re = /^\s{2}(\w+)\s*[:(]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    methods.push(m[1]);
  }
  return [...new Set(methods)];
}

const preloadMethods = extractPreloadMethods(preloadSrc);
const typeMethods = extractTypeMethods(preloadTypes);

function extractAgenteraPreloadMethods(src: string): string[] {
  const objectMatch = src.match(
    /const\s+agenteraAuthAPI\s*=\s*\{([\s\S]*?)^\};/m,
  );
  if (!objectMatch) return [];
  return [...objectMatch[1].matchAll(/^\s{2}(\w+)\s*:\s*\(/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraTypeMethods(src: string): string[] {
  const interfaceMatch = src.match(
    /interface\s+AgenteraAuthAPI\s*\{([\s\S]*?)^\}/m,
  );
  if (!interfaceMatch) return [];
  return [...interfaceMatch[1].matchAll(/^\s{2}(\w+)\s*[:(]/gm)].map(
    (match) => match[1],
  );
}

const agenteraPreloadMethods = extractAgenteraPreloadMethods(preloadSrc);
const agenteraTypeMethods = extractAgenteraTypeMethods(preloadTypes);

function extractAgenteraRuntimeAccessMethods(src: string): string[] {
  const objectMatch = src.match(
    /const\s+agenteraRuntimeAccessAPI\s*=\s*\{([\s\S]*?)^\};/m,
  );
  if (!objectMatch) return [];
  return [...objectMatch[1].matchAll(/^\s{2}(\w+)\s*:\s*\(/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraGlobalProfileMethods(src: string): string[] {
  const objectMatch = src.match(
    /const\s+agenteraGlobalProfileAPI\s*=\s*\{([\s\S]*?)^\};/m,
  );
  if (!objectMatch) return [];
  return [...objectMatch[1].matchAll(/^\s{2}(\w+)\s*:\s*\(/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraGlobalProfileTypeMethods(src: string): string[] {
  const interfaceMatch = src.match(
    /interface\s+AgenteraGlobalProfileAPI\s*\{([\s\S]*?)^\}/m,
  );
  if (!interfaceMatch) return [];
  return [...interfaceMatch[1].matchAll(/^\s{2}(\w+)\s*[:(]/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraRuntimeAccessTypeMethods(src: string): string[] {
  const interfaceMatch = src.match(
    /interface\s+AgenteraRuntimeAccessAPI\s*\{([\s\S]*?)^\}/m,
  );
  if (!interfaceMatch) return [];
  return [...interfaceMatch[1].matchAll(/^\s{2}(\w+)\s*[:(]/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraRuntimeDistributionMethods(src: string): string[] {
  const objectMatch = src.match(
    /const\s+agenteraRuntimeDistributionAPI\s*=\s*\{([\s\S]*?)^\};/m,
  );
  if (!objectMatch) return [];
  return [...objectMatch[1].matchAll(/^\s{2}(\w+)\s*:\s*\(/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraRuntimeDistributionTypeMethods(src: string): string[] {
  const interfaceMatch = src.match(
    /interface\s+AgenteraRuntimeDistributionAPI\s*\{([\s\S]*?)^\}/m,
  );
  if (!interfaceMatch) return [];
  return [...interfaceMatch[1].matchAll(/^\s{2}(\w+)\s*[:(]/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraAgentMethods(src: string): string[] {
  const objectMatch = src.match(
    /const\s+agenteraAgentsAPI\s*=\s*\{([\s\S]*?)^\};/m,
  );
  if (!objectMatch) return [];
  return [...objectMatch[1].matchAll(/^\s{2}(\w+)\s*:\s*\(/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraAgentTypeMethods(src: string): string[] {
  const interfaceMatch = src.match(
    /interface\s+AgenteraAgentsAPI\s*\{([\s\S]*?)^\}/m,
  );
  if (!interfaceMatch) return [];
  return [...interfaceMatch[1].matchAll(/^\s{2}(\w+)\s*[:(]/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraWorkspaceMethods(src: string): string[] {
  const objectMatch = src.match(
    /const\s+agenteraWorkspaceAPI\s*=\s*\{([\s\S]*?)^\};/m,
  );
  if (!objectMatch) return [];
  return [...objectMatch[1].matchAll(/^\s{2}(\w+)\s*:\s*\(/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraWorkspaceTypeMethods(src: string): string[] {
  const interfaceMatch = src.match(
    /interface\s+AgenteraWorkspaceAPI\s*\{([\s\S]*?)^\}/m,
  );
  if (!interfaceMatch) return [];
  return [...interfaceMatch[1].matchAll(/^\s{2}(\w+)\s*[:(]/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraProductSpaceMethods(src: string): string[] {
  const objectMatch = src.match(
    /const\s+agenteraProductSpaceAPI\s*=\s*\{([\s\S]*?)^\};/m,
  );
  if (!objectMatch) return [];
  return [...objectMatch[1].matchAll(/^\s{2}(\w+)\s*:\s*\(/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraProductSpaceTypeMethods(src: string): string[] {
  const interfaceMatch = src.match(
    /interface\s+AgenteraProductSpaceAPI\s*\{([\s\S]*?)^\}/m,
  );
  if (!interfaceMatch) return [];
  return [...interfaceMatch[1].matchAll(/^\s{2}(\w+)\s*[:(]/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraOrganizationMethods(src: string): string[] {
  const objectMatch = src.match(
    /const\s+agenteraOrganizationAPI\s*=\s*\{([\s\S]*?)^\};/m,
  );
  if (!objectMatch) return [];
  return [...objectMatch[1].matchAll(/^\s{2}(\w+)\s*:\s*\(/gm)].map(
    (match) => match[1],
  );
}

function extractAgenteraOrganizationTypeMethods(src: string): string[] {
  const interfaceMatch = src.match(
    /interface\s+AgenteraOrganizationAPI\s*\{([\s\S]*?)^\}/m,
  );
  if (!interfaceMatch) return [];
  return [...interfaceMatch[1].matchAll(/^\s{2}(\w+)\s*[:(]/gm)].map(
    (match) => match[1],
  );
}

describe("Preload API Surface", () => {
  it("preload exposes methods", () => {
    expect(preloadMethods.length).toBeGreaterThan(30);
  });

  it("type declarations define methods", () => {
    expect(typeMethods.length).toBeGreaterThan(30);
  });

  it("every preload method has a type declaration", () => {
    const missing = preloadMethods.filter((m) => !typeMethods.includes(m));
    expect(missing).toEqual([]);
  });

  it("every type declaration has a preload implementation", () => {
    const missing = typeMethods.filter((m) => !preloadMethods.includes(m));
    expect(missing).toEqual([]);
  });
});

describe("Aera product-auth preload namespace", () => {
  const expected = [
    "getState",
    "startLogin",
    "restartLogin",
    "cancelLogin",
    "copyLoginLink",
    "retryOnline",
    "logout",
    "openPortal",
    "getUserProfile",
    "updateUserProfile",
    "onUserProfileChanged",
    "onStateChanged",
  ];

  it("exposes only the reviewed namespaced methods", () => {
    expect(agenteraPreloadMethods).toEqual(expected);
    expect(agenteraTypeMethods).toEqual(expected);
  });

  it("never declares product tokens, device keys, codes, or verifiers", () => {
    const namespace = preloadTypes.match(
      /interface\s+AgenteraAuthAPI\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    expect(namespace).toBeDefined();
    expect(namespace).not.toMatch(
      /accessToken|refreshToken|offlineEntitlement|privateKey|code|verifier|encrypted/i,
    );
  });
});

describe("Aera Runtime-access preload namespace", () => {
  const expected = [
    "probeInstallFiles",
    "runStartupPreflight",
    "resolveAccountProfile",
    "inspectActiveProfile",
    "bindActiveProfile",
    "createFreshProfile",
    "listUnboundProfiles",
    "inspectCurrentConnection",
    "bindCurrentConnection",
    "switchToLocal",
  ];

  it("exposes only the reviewed ownership and preflight methods", () => {
    expect(extractAgenteraRuntimeAccessMethods(preloadSrc)).toEqual(expected);
    expect(extractAgenteraRuntimeAccessTypeMethods(preloadTypes)).toEqual(
      expected,
    );
  });

  it("does not declare owner IDs, credentials, Profile paths, or product secrets", () => {
    const namespace = preloadTypes.match(
      /interface\s+AgenteraRuntimeAccessAPI\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    expect(namespace).toBeDefined();
    expect(namespace).not.toMatch(
      /ownerId|tenantId|installationId|profilePath|remoteUrl|ssh|apiKey|accessToken|refreshToken|offlineEntitlement|privateKey/i,
    );
  });
});

describe("Aera global-profile preload namespace", () => {
  const expected = [
    "get",
    "setEntry",
    "removeEntry",
    "listHistory",
    "rollback",
    "prepareConversationContext",
    "extractCandidates",
    "confirmCandidates",
    "rejectCandidates",
    "onChanged",
  ];

  it("exposes one conversation-scoped context preparer without profile bytes", () => {
    expect(extractAgenteraGlobalProfileMethods(preloadSrc)).toEqual(expected);
    expect(extractAgenteraGlobalProfileTypeMethods(preloadTypes)).toEqual(
      expected,
    );
    const namespace = preloadTypes.match(
      /interface\s+AgenteraGlobalProfileAPI\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    expect(namespace).toBeDefined();
    expect(namespace).not.toMatch(/renderedSnapshot|snapshotSha256|userId/i);
  });
});

describe("Aera Runtime-distribution preload namespace", () => {
  const expected = [
    "getState",
    "checkForUpdate",
    "downloadConfirmed",
    "cancelDownload",
    "restartToApply",
    "retryRepair",
    "onStateChanged",
  ];

  it("exposes only the reviewed lifecycle methods", () => {
    expect(extractAgenteraRuntimeDistributionMethods(preloadSrc)).toEqual(
      expected,
    );
    expect(extractAgenteraRuntimeDistributionTypeMethods(preloadTypes)).toEqual(
      expected,
    );
  });

  it("does not declare URLs, paths, signatures, keys, tokens, or owner identity", () => {
    const namespace = preloadTypes.match(
      /interface\s+AgenteraRuntimeDistributionAPI\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    expect(namespace).toBeDefined();
    expect(namespace).not.toMatch(
      /url|path|signature|publicKey|privateKey|token|ownerId|tenantId|installationId/i,
    );
  });
});

describe("Aera Agent-control preload namespace", () => {
  const expected = [
    "getState",
    "listDrafts",
    "getDraft",
    "createDraft",
    "updateDraft",
    "deleteDraft",
    "discardUnpublishedDraft",
    "listAuthoringCapabilities",
    "prepareInstalledSkillSnapshot",
    "confirmInstalledSkillSnapshot",
    "prepareMcpRequirement",
    "confirmMcpRequirement",
    "listCapabilityBindings",
    "confirmCapabilityBindings",
    "preparePublication",
    "confirmPublication",
    "prepareOrganizationSubmission",
    "confirmOrganizationSubmission",
    "listOrganizationSubmissionList",
    "listOrganizationSubmissions",
    "disconnectOrganizationSubmissionReference",
    "getOrganizationSubmission",
    "prepareOrganizationReview",
    "confirmOrganizationReview",
    "prepareOrganizationWithdrawal",
    "confirmOrganizationWithdrawal",
    "listDefinitions",
    "listOfficialAgents",
    "getOfficialAgentDetail",
    "prepareOfficialInstall",
    "confirmOfficialInstall",
    "refreshOfficialUpdates",
    "applyOfficialUpdate",
    "listVersions",
    "listInstallations",
    "installVersion",
    "claimVersion",
    "retryPendingInstallation",
    "selectInstallationVersion",
    "repairInstallationModel",
    "archiveInstallation",
    "listEligibleExperienceSkills",
    "prepareExperienceCandidate",
    "submitExperienceCandidate",
    "listMyExperienceCandidates",
    "listExperienceReviewQueue",
    "getExperienceCandidate",
    "reviewExperienceCandidate",
    "prepareExperienceCandidateImport",
    "confirmExperienceCandidateImport",
    "listEligibleOrganizationExperienceSkills",
    "prepareOrganizationExperienceCandidate",
    "submitOrganizationExperienceCandidate",
    "listMyOrganizationExperienceCandidates",
    "listOrganizationExperienceReviewQueue",
    "getOrganizationExperienceCandidate",
    "reviewOrganizationExperienceCandidate",
    "prepareOrganizationExperienceImport",
    "confirmOrganizationExperienceImport",
    "onStateChanged",
  ];

  it("exposes exactly one separately reviewed Agent control surface", () => {
    expect(extractAgenteraAgentMethods(preloadSrc)).toEqual(expected);
    expect(extractAgenteraAgentTypeMethods(preloadTypes)).toEqual(expected);
    expect(preloadSrc).toContain(
      'contextBridge.exposeInMainWorld("agenteraAgents", agenteraAgentsAPI)',
    );
  });

  it("exposes the experience candidate import methods only through Agent control", () => {
    expect(extractAgenteraAgentMethods(preloadSrc)).toEqual(
      expect.arrayContaining([
        "prepareExperienceCandidateImport",
        "confirmExperienceCandidateImport",
      ]),
    );
    expect(extractAgenteraAgentTypeMethods(preloadTypes)).toEqual(
      expect.arrayContaining([
        "prepareExperienceCandidateImport",
        "confirmExperienceCandidateImport",
      ]),
    );
  });

  it("does not declare credentials, signing material, owner identity, paths, or raw cloud details", () => {
    const namespace = preloadTypes.match(
      /interface\s+AgenteraAgentsAPI\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    expect(namespace).toBeDefined();
    expect(namespace).not.toMatch(
      /accessToken|refreshToken|offlineEntitlement|privateKey|publicKey|signature|ownerId|tenantId|deviceId|workspaceId|profilePath|runtimeProfileId|sourceRelativePath|\bsnapshot\b|filePath|remoteUrl|environment|rawResponse|responseText/i,
    );
  });
});

describe("Aera Workspace preload namespace", () => {
  const expected = [
    "getState",
    "refresh",
    "select",
    "create",
    "rename",
    "archive",
    "restore",
    "listMembers",
    "changeMemberRole",
    "removeMember",
    "leave",
    "listInvitations",
    "createInvitation",
    "revokeInvitation",
    "acceptInvitation",
    "getPendingInvitation",
    "dismissPendingInvitation",
    "onStateChanged",
    "onInvitationReceived",
  ];

  it("exposes exactly one separately reviewed Workspace control surface", () => {
    expect(extractAgenteraWorkspaceMethods(preloadSrc)).toEqual(expected);
    expect(extractAgenteraWorkspaceTypeMethods(preloadTypes)).toEqual(expected);
    expect(preloadSrc).toMatch(
      /contextBridge\.exposeInMainWorld\(\s*"agenteraWorkspace",\s*agenteraWorkspaceAPI,?\s*\)/,
    );
  });

  it("does not expose credentials, generic transport, database, Profile, or Runtime controls", () => {
    const namespace = preloadTypes.match(
      /interface\s+AgenteraWorkspaceAPI\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    expect(namespace).toBeDefined();
    expect(namespace).not.toMatch(
      /accessToken|refreshToken|offlineEntitlement|headers|authorization|databasePath|profilePath|sessionId|runtimeBinding|genericUrl/i,
    );
  });
});

describe("Aera Product Space preload namespace", () => {
  const expected = ["getState", "refresh", "select", "onStateChanged"];

  it("exposes exactly the global selection surface", () => {
    expect(extractAgenteraProductSpaceMethods(preloadSrc)).toEqual(expected);
    expect(extractAgenteraProductSpaceTypeMethods(preloadTypes)).toEqual(
      expected,
    );
    expect(preloadSrc).toMatch(
      /contextBridge\.exposeInMainWorld\(\s*"agenteraProductSpace",\s*agenteraProductSpaceAPI,?\s*\)/,
    );
  });

  it("does not expose Profile, Runtime, account, credentials, or generic transport", () => {
    const namespace = preloadTypes.match(
      /interface\s+AgenteraProductSpaceAPI\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    expect(namespace).toBeDefined();
    expect(namespace).not.toMatch(
      /profile|runtime|ownerId|userId|token|headers|authorization|url|database/i,
    );
  });

  it("returns a removable state listener", () => {
    expect(preloadSrc).toContain(
      'ipcRenderer.removeListener(\n        "agentera-product-space-state-changed",',
    );
  });
});

describe("Aera Organization preload namespace", () => {
  const expected = [
    "getState",
    "refresh",
    "create",
    "rename",
    "archive",
    "restore",
    "transferOwner",
    "dissolve",
    "listMembers",
    "patchMember",
    "removeMember",
    "leave",
    "listDepartments",
    "createDepartment",
    "renameDepartment",
    "archiveDepartment",
    "restoreDepartment",
    "listInvitations",
    "createInvitation",
    "revokeInvitation",
    "acceptInvitation",
    "submitInvitationLink",
    "getPendingInvitation",
    "dismissPendingInvitation",
    "getCurrentPolicy",
    "listPolicySnapshots",
    "publishPolicy",
    "getPolicySnapshot",
    "listAuditEvents",
    "onStateChanged",
    "onInvitationReceived",
  ];

  it("exposes exactly the reviewed enterprise control surface", () => {
    expect(extractAgenteraOrganizationMethods(preloadSrc)).toEqual(expected);
    expect(extractAgenteraOrganizationTypeMethods(preloadTypes)).toEqual(
      expected,
    );
    expect(preloadSrc).toMatch(
      /contextBridge\.exposeInMainWorld\(\s*"agenteraOrganization",\s*agenteraOrganizationAPI,?\s*\)/,
    );
  });

  it("does not expose Profile, Runtime, credentials, transport, or server authority", () => {
    const namespace = preloadTypes.match(
      /interface\s+AgenteraOrganizationAPI\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    expect(namespace).toBeDefined();
    expect(namespace).not.toMatch(
      /profilePath|runtimeBinding|sessionId|memory|accessToken|refreshToken|headers|authorization|cloudOrigin|databasePath|actorId/i,
    );
  });

  it("returns removable state and invitation listeners", () => {
    expect(preloadSrc).toContain(
      'ipcRenderer.removeListener(\n        "agentera-organization-state-changed",',
    );
    expect(preloadSrc).toContain(
      'ipcRenderer.removeListener(\n        "agentera-organization-invitation-received",',
    );
  });
});

// ─── New APIs exist ─────────────────────────────────────

describe("New APIs from v0.8/v0.9 features", () => {
  it("has backup/import APIs", () => {
    expect(preloadMethods).toContain("runHermesBackup");
    expect(preloadMethods).toContain("runHermesImport");
    expect(typeMethods).toContain("runHermesBackup");
    expect(typeMethods).toContain("runHermesImport");
  });

  it("has log viewer API", () => {
    expect(preloadMethods).toContain("readLogs");
    expect(typeMethods).toContain("readLogs");
  });

  it("has debug dump API", () => {
    expect(preloadMethods).toContain("runHermesDump");
    expect(typeMethods).toContain("runHermesDump");
  });

  it("has MCP server list API", () => {
    expect(preloadMethods).toContain("listMcpServers");
    expect(typeMethods).toContain("listMcpServers");
    expect(preloadMethods).toContain("addMcpServer");
    expect(typeMethods).toContain("addMcpServer");
    expect(preloadMethods).toContain("removeMcpServer");
    expect(typeMethods).toContain("removeMcpServer");
    expect(preloadMethods).toContain("setMcpServerEnabled");
    expect(typeMethods).toContain("setMcpServerEnabled");
    expect(preloadMethods).toContain("testMcpServer");
    expect(typeMethods).toContain("testMcpServer");
    expect(preloadMethods).toContain("listMcpCatalog");
    expect(typeMethods).toContain("listMcpCatalog");
    expect(preloadMethods).toContain("installMcpCatalogEntry");
    expect(typeMethods).toContain("installMcpCatalogEntry");
  });

  it("has memory provider discovery API", () => {
    expect(preloadMethods).toContain("discoverMemoryProviders");
    expect(typeMethods).toContain("discoverMemoryProviders");
  });

  it("has dashboard transport probe APIs", () => {
    expect(preloadMethods).toContain("dashboardStatus");
    expect(typeMethods).toContain("dashboardStatus");
    expect(preloadMethods).toContain("startDashboard");
    expect(typeMethods).toContain("startDashboard");
    expect(preloadMethods).toContain("stopDashboard");
    expect(typeMethods).toContain("stopDashboard");
    expect(preloadMethods).toContain("setConnectionChatTransports");
    expect(typeMethods).toContain("setConnectionChatTransports");
    expect(preloadMethods).toContain("probeRemoteAuthMode");
    expect(typeMethods).toContain("probeRemoteAuthMode");
    expect(preloadMethods).toContain("remoteOAuthLogin");
    expect(typeMethods).toContain("remoteOAuthLogin");
    expect(preloadMethods).toContain("remoteOAuthLogout");
    expect(typeMethods).toContain("remoteOAuthLogout");
    expect(preloadMethods).toContain("remoteOAuthSessionState");
    expect(typeMethods).toContain("remoteOAuthSessionState");
    expect(preloadMethods).toContain("freshDashboardWsUrl");
    expect(typeMethods).toContain("freshDashboardWsUrl");
  });
});

// ─── Legacy APIs still present ──────────────────────────

describe("Legacy APIs preserved (backward compat)", () => {
  const requiredMethods = [
    // Installation
    "checkInstall",
    "startInstall",
    "onInstallProgress",
    // Hermes engine
    "getHermesVersion",
    "refreshHermesVersion",
    "runHermesDoctor",
    "runHermesUpdate",
    // Config
    "getEnv",
    "setEnv",
    "getConfig",
    "setConfig",
    "getHermesHome",
    "getModelConfig",
    "setModelConfig",
    // Chat
    "sendMessage",
    "abortChat",
    "onChatChunk",
    "onChatReasoningChunk",
    "onChatDone",
    "onChatSessionStarted",
    "onChatToolProgress",
    "onChatUsage",
    "onChatError",
    // Gateway
    "startGateway",
    "stopGateway",
    "restartGateway",
    "gatewayStatus",
    "getPlatformEnabled",
    "setPlatformEnabled",
    // Sessions
    "listSessions",
    "getSessionMessages",
    "recordSessionContinuation",
    "recordSessionLocalError",
    "deleteSessions",
    // Profiles
    "listProfiles",
    "createProfile",
    "deleteProfile",
    "setActiveProfile",
    // Memory
    "readMemory",
    "addMemoryEntry",
    "updateMemoryEntry",
    "removeMemoryEntry",
    "writeUserProfile",
    // Soul
    "readSoul",
    "writeSoul",
    "resetSoul",
    // Tools
    "getToolsets",
    "setToolsetEnabled",
    // Skills
    "listInstalledSkills",
    "listBundledSkills",
    "getSkillContent",
    "installSkill",
    "uninstallSkill",
    // Models
    "listModels",
    "addModel",
    "removeModel",
    "updateModel",
    "onModelLibraryChanged",
    // Credential pool
    "getCredentialPool",
    "setCredentialPool",
    // Claw3D
    "claw3dStatus",
    "claw3dSetup",
    // Cron
    "listCronJobs",
    "createCronJob",
    "removeCronJob",
    "pauseCronJob",
    "resumeCronJob",
    "triggerCronJob",
    // Shell
    "openExternal",
    "openTerminal",
  ];

  for (const method of requiredMethods) {
    it(`preload has ${method}`, () => {
      expect(preloadMethods).toContain(method);
    });

    it(`type declaration has ${method}`, () => {
      expect(typeMethods).toContain(method);
    });
  }
});

// ─── IPC channel consistency ────────────────────────────

describe("IPC channel consistency", () => {
  it("preload invoke calls use quoted string channel names", () => {
    const invokeChannels = [
      ...preloadSrc.matchAll(/ipcRenderer\.invoke\(\s*["']([^"']+)["']/g),
    ].map((m) => m[1]);
    expect(invokeChannels.length).toBeGreaterThan(30);
    // Every channel should be kebab-case
    for (const ch of invokeChannels) {
      expect(ch).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("preload on/removeListener calls use quoted string channel names", () => {
    const onChannels = [
      ...preloadSrc.matchAll(/ipcRenderer\.on\(\s*["']([^"']+)["']/g),
    ].map((m) => m[1]);
    expect(onChannels.length).toBeGreaterThan(0);
    for (const ch of onChannels) {
      expect(ch).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
