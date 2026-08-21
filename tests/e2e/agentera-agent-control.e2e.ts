import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "playwright/test";

import type {
  AgentDraftDetail,
  AgenteraAgentControlResult,
  CreateAgentDraftInput,
  PublishedRevision,
} from "../../src/shared/agentera-agent-control";
import {
  agentControlExchangeDiagnostics,
  agentControlRequests,
  authenticateExistingAgentControlDevice,
  authenticateFirstAgentControlDevice,
  claimDefaultProfile,
  closeAgentControlHarness,
  cloudAgentControlCounts,
  createAgentControlHarness,
  deviceProcessDiagnostics,
  deviceProfilePath,
  encryptedDevicePrivateKey,
  failNextAgentControlRequest,
  invokeAgentera,
  launchAgentControlDevice,
  localAgentControlState,
  privateProfileSnapshot,
  startBoundConversation,
  type AgentControlDevice,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";

const PRIVATE_MARKERS = [
  ".env",
  "MEMORY.md",
  "USER.md",
  "sessions/authoring.json",
  "files/private.txt",
  "skills/local-authoring/SKILL.md",
  "curator/state.json",
  "adaptive/device-marker.txt",
] as const;

const DEVICE_A_MEMORY_SECRET = "DEVICE_A_NATIVE_MEMORY_SECRET_2026_07_19";
const DEVICE_A_SKILL_SECRET = "DEVICE_A_LEARNED_SKILL_SECRET_2026_07_19";
const PRIMARY_MODEL = "gpt-5.6";
const ALTERNATE_MODEL = "gpt-4.1-mini";

let harness: AgentControlHarness | null = null;
let deviceA: AgentControlDevice | null = null;
let deviceB: AgentControlDevice | null = null;
let deviceC: AgentControlDevice | null = null;
let modelServer: Server | null = null;
let modelBaseUrl = "";
const requestedModels: string[] = [];

async function startModelServer(): Promise<string> {
  modelServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [PRIMARY_MODEL, ALTERNATE_MODEL].map((id) => ({
              id,
              object: "model",
            })),
          }),
        );
        return;
      }
      if (
        request.method !== "POST" ||
        url.pathname !== "/v1/chat/completions"
      ) {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const payload = JSON.parse(body) as { model?: unknown; stream?: unknown };
      const model =
        typeof payload.model === "string" ? payload.model : PRIMARY_MODEL;
      requestedModels.push(model);
      if (payload.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "agent-model-choice-e2e",
            object: "chat.completion",
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "MODEL_CHOICE_OK" },
                finish_reason: "stop",
              },
            ],
          }),
        );
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      response.write(
        `data: ${JSON.stringify({
          id: "agent-model-choice-e2e",
          object: "chat.completion.chunk",
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "MODEL_CHOICE_OK" },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "agent-model-choice-e2e",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    modelServer!.once("error", rejectListen);
    modelServer!.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = modelServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

function unwrap<T>(result: AgenteraAgentControlResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Agent control failed: ${result.errorCode}; exchanges=${JSON.stringify(
        harness ? agentControlExchangeDiagnostics(harness) : [],
      )}; process=${JSON.stringify([
        ...deviceProcessDiagnostics(deviceA),
        ...deviceProcessDiagnostics(deviceB),
      ])}`,
    );
  }
  expect(result.ok).toBe(true);
  return result.data;
}

function draftInput(content: string): CreateAgentDraftInput {
  return {
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName: "Two-device research Agent",
    icon: null,
    manifest: {
      schemaVersion: 1,
      identity: { systemPrompt: "Use only the explicitly published base." },
      assets: [
        {
          path: "skills/research/SKILL.md",
          kind: "skill",
          mediaType: "text/markdown",
        },
        {
          path: "knowledge/research.md",
          kind: "knowledge",
          mediaType: "text/markdown",
        },
      ],
      modelConstraints: {
        allowedProviders: ["openai"],
        allowedModels: ["gpt-5.6"],
      },
      tools: { allowed: [], denied: [] },
      dependencies: [],
      runtimeCompatibility: {
        minimumVersion: "v0.18.2-agentera.1",
        maximumVersionExclusive: null,
      },
    },
    assets: [
      {
        path: "skills/research/SKILL.md",
        content: `---\nname: research\ndescription: Published research workflow\n---\n\n${content}\n`,
      },
      { path: "knowledge/research.md", content: `${content}\n` },
    ],
  };
}

interface FreshProfileReservationEvidence {
  operationId: string;
  profileId: string;
  runtimeProfileId: string;
  displayName: string;
}

async function decryptedProfileBindingState(
  device: AgentControlDevice,
): Promise<{
  bindings: unknown;
  freshProfileOperations: unknown;
}> {
  const envelope = JSON.parse(
    await readFile(
      join(device.userData, "agentera-auth", "profile-bindings.json"),
      "utf8",
    ),
  ) as { encryptedBindings?: unknown };
  if (typeof envelope.encryptedBindings !== "string") {
    throw new Error("Fresh Profile binding envelope is unavailable.");
  }
  const plaintext = await device.app.evaluate(
    ({ safeStorage }, encryptedBindings) =>
      safeStorage.decryptString(Buffer.from(encryptedBindings, "base64")),
    envelope.encryptedBindings,
  );
  const parsed = JSON.parse(plaintext) as Record<string, unknown>;
  return {
    bindings: parsed.bindings,
    freshProfileOperations: parsed.freshProfileOperations,
  };
}

async function freshProfileReservations(
  device: AgentControlDevice,
): Promise<FreshProfileReservationEvidence[]> {
  const parsed = await decryptedProfileBindingState(device);
  if (!Array.isArray(parsed.freshProfileOperations)) {
    throw new Error("Fresh Profile reservation state is invalid.");
  }
  return parsed.freshProfileOperations.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("Fresh Profile reservation entry is invalid.");
    }
    const entry = value as Record<string, unknown>;
    for (const key of [
      "operationId",
      "profileId",
      "runtimeProfileId",
      "displayName",
    ]) {
      if (typeof entry[key] !== "string") {
        throw new Error(`Fresh Profile reservation ${key} is invalid.`);
      }
    }
    return {
      operationId: entry.operationId as string,
      profileId: entry.profileId as string,
      runtimeProfileId: entry.runtimeProfileId as string,
      displayName: entry.displayName as string,
    };
  });
}

async function boundProfilePaths(
  device: AgentControlDevice,
): Promise<string[]> {
  const parsed = await decryptedProfileBindingState(device);
  if (!Array.isArray(parsed.bindings)) {
    throw new Error("Profile binding state is invalid.");
  }
  return parsed.bindings.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("Profile binding entry is invalid.");
    }
    const profilePath = (value as Record<string, unknown>).profilePath;
    if (typeof profilePath !== "string") {
      throw new Error("Profile binding path is invalid.");
    }
    return resolve(profilePath);
  });
}

async function prepareInterruptedManagedRuntime(
  device: Pick<AgentControlDevice, "hermesHome" | "userData">,
  runtimeSourceRoot: string,
  markerPath: string,
  tracePath: string,
): Promise<() => Promise<void>> {
  const source = resolve(runtimeSourceRoot);
  await readFile(join(source, "hermes_constants.py"));
  const currentPointer = JSON.parse(
    await readFile(join(device.userData, "runtime", "current.json"), "utf8"),
  ) as { versionDirectory?: unknown };
  if (typeof currentPointer.versionDirectory !== "string") {
    throw new Error("Managed Runtime current pointer is unavailable.");
  }
  const pythonWrapper = join(
    device.userData,
    "runtime",
    "versions",
    currentPointer.versionDirectory,
    "python",
    "bin",
    "python3",
  );
  const originalPython = `${pythonWrapper}.e2e-original`;
  await rename(pythonWrapper, originalPython);
  const sourcePython = join(source, ".venv", "bin", "python");
  const wrapper = `#!/bin/sh
set -eu
trace_file="\${AGENTERA_E2E_RUNTIME_TRACE_FILE:-${tracePath}}"
trace() {
  if [ -n "$trace_file" ]; then
    printf '%s\\n' "$*" >> "$trace_file"
  fi
}
  trace "wrapper pid=$$ stage=entry HERMES_HOME=\${HERMES_HOME:-} HOME=\${HOME:-} PYTHONPATH=\${PYTHONPATH:-} PWD=\${PWD:-} sourcePython=${sourcePython} args=$*"
set +e
(cd "${source}" && "${sourcePython}" -c 'import os, hermes_constants; print("probe hermes_constants=" + str(hermes_constants.__file__)); print("probe HERMES_HOME=" + str(os.environ.get("HERMES_HOME"))); print("probe default_root=" + str(hermes_constants.get_default_hermes_root()))') >> "$trace_file" 2>&1
probe_status=$?
set -e
trace "wrapper pid=$$ stage=probe-exit status=$probe_status"
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "hermes_cli.main" ] && [ "\${3:-}" = "profile" ] && [ "\${4:-}" = "create" ] && [ ! -e "\${AGENTERA_E2E_INTERRUPT_PROFILE_CREATE_ONCE_MARKER:-}" ]; then
  profile="\${5:-}"
  if [ -z "$profile" ]; then exit 64; fi
  export PYTHONPATH="${source}:\${PYTHONPATH:-}"
  set +e
  (cd "${source}" && "${sourcePython}" -c 'import os, hermes_constants, hermes_cli.profiles; print("profile-probe hermes_constants=" + str(hermes_constants.__file__)); print("profile-probe profiles=" + str(hermes_cli.profiles.__file__)); print("profile-probe HERMES_HOME=" + str(os.environ.get("HERMES_HOME"))); print("profile-probe default_root=" + str(hermes_constants.get_default_hermes_root())); print("profile-probe profiles_root=" + str(hermes_cli.profiles._get_profiles_root()))') >> "$trace_file" 2>&1
  profile_probe_status=$?
  set -e
  trace "wrapper pid=$$ stage=profile-probe-exit status=$profile_probe_status"
  trace "wrapper pid=$$ stage=before-profile-create HERMES_HOME=\${HERMES_HOME:-} HOME=\${HOME:-} PYTHONPATH=\${PYTHONPATH:-} PWD=\${PWD:-}"
  set +e
  (cd "${source}" && "${sourcePython}" "$@")
  source_status=$?
  set -e
  trace "wrapper pid=$$ stage=after-profile-create status=$source_status HERMES_HOME=\${HERMES_HOME:-}"
  if [ "$source_status" -ne 0 ]; then exit "$source_status"; fi
  staging_target="\${HERMES_HOME}/profiles/$profile"
  if [ ! -d "$staging_target" ]; then exit 70; fi
  trace "wrapper pid=$$ stage=staging-profile-created target=$staging_target entries=$(find "$staging_target" -mindepth 1 -maxdepth 1 -print | sort | tr '\\n' ',')"
  target="\${AGENTERA_E2E_DURABLE_HERMES_HOME}/profiles/$profile"
  trace "wrapper pid=$$ stage=durable-before target=$target entries=$(if [ -d "$target" ]; then find "$target" -mindepth 1 -maxdepth 1 -print | sort | tr '\\n' ','; else printf '<missing>'; fi)"
  mkdir -p "$target/sessions" "$target/skills"
  : > "$target/.env"
  printf '%s\\n' '{"name":"interrupted-e2e-profile"}' > "$target/profile-meta.json"
  printf '%s\\n' '# Interrupted fresh Profile scaffold' > "$target/SOUL.md"
  trace "wrapper pid=$$ stage=durable-scaffold-created target=$target entries=$(find "$target" -mindepth 1 -maxdepth 1 -print | sort | tr '\\n' ',')"
  : > "\${AGENTERA_E2E_INTERRUPT_PROFILE_CREATE_ONCE_MARKER}"
  exit 75
fi
export PYTHONPATH="${source}:\${PYTHONPATH:-}"
trace "wrapper pid=$$ stage=before-normal-exec HERMES_HOME=\${HERMES_HOME:-} HOME=\${HOME:-} PYTHONPATH=\${PYTHONPATH:-} PWD=\${PWD:-}"
(cd "${source}" && exec "${sourcePython}" "$@")
`;
  await writeFile(pythonWrapper, wrapper, { encoding: "utf8", mode: 0o700 });
  await chmod(pythonWrapper, 0o700);
  return async () => {
    await rm(pythonWrapper, { force: true });
    await rename(originalPython, pythonWrapper);
  };
}

async function publish(
  device: AgentControlDevice,
  draftId: string,
): Promise<PublishedRevision> {
  const preview = unwrap(
    await invokeAgentera(device, "preparePublication", draftId),
  );
  const confirmed = await invokeAgentera<PublishedRevision>(
    device,
    "confirmPublication",
    preview.publicationHandle,
  );
  if (!confirmed.ok) {
    const detail = await invokeAgentera<AgentDraftDetail>(
      device,
      "getDraft",
      draftId,
    );
    throw new Error(
      `Publication failed: ${confirmed.errorCode}; attempt=${JSON.stringify(
        detail.ok ? detail.data.lastPublicationAttempt : null,
      )}; exchanges=${JSON.stringify(
        harness ? agentControlExchangeDiagnostics(harness) : [],
      )}`,
    );
  }
  return confirmed.data;
}

async function updateForVersionTwo(
  device: AgentControlDevice,
  draftId: string,
): Promise<AgentDraftDetail> {
  const current = unwrap<AgentDraftDetail>(
    await invokeAgentera(device, "getDraft", draftId),
  );
  const {
    sourceAgentDefinitionId: _sourceAgentDefinitionId,
    baseAgentVersionId: _baseAgentVersionId,
    ...next
  } = draftInput("Published base version two");
  return unwrap(
    await invokeAgentera(device, "updateDraft", {
      ...next,
      id: current.id,
      expectedRevision: current.revision,
    }),
  );
}

async function writeDeviceALearning(profilePath: string): Promise<void> {
  await writeFile(
    join(profilePath, "MEMORY.md"),
    `# Native local Memory\n${DEVICE_A_MEMORY_SECRET}\n`,
    "utf8",
  );
  const learnedSkill = join(profilePath, "skills/learned-local/SKILL.md");
  await mkdir(dirname(learnedSkill), { recursive: true });
  await writeFile(
    learnedSkill,
    `# Native learned Skill\n${DEVICE_A_SKILL_SECRET}\n`,
    "utf8",
  );
}

test.beforeAll(async () => {
  modelBaseUrl = await startModelServer();
  harness = await createAgentControlHarness({ emptyDevices: ["C"] });
  harness.deviceRoots.C.hermesHome = join(harness.root, "device-c", ".hermes");
  await mkdir(harness.deviceRoots.C.hermesHome, { recursive: true });
});

test.afterAll(async () => {
  await closeAgentControlHarness(harness);
  await new Promise<void>(
    (resolveClose) =>
      modelServer?.close(() => resolveClose()) ?? resolveClose(),
  );
  modelServer = null;
  harness = null;
  deviceA = null;
  deviceB = null;
  deviceC = null;
});

// @lat: [[agentera-agent-control-plane#Release gate#Two-device boundary]]
// @lat: [[agentera-agent-control-plane#Release gate]]
// @lat: [[agentera-self-evolution#Release gate]]
test("shares immutable Agent versions while every Hermes adaptive state remains device-local", async () => {
  if (!harness) throw new Error("Agent control E2E harness is unavailable.");

  const compatibleModelConfig = [
    "model:",
    "  provider: openai",
    `  default: ${PRIMARY_MODEL}`,
    `  base_url: "${modelBaseUrl}"`,
    "",
  ].join("\n");
  const modelCatalog = `${JSON.stringify(
    [PRIMARY_MODEL, ALTERNATE_MODEL].map((model, index) => ({
      id: `agent-model-choice-${index + 1}`,
      name: model,
      provider: "openai",
      model,
      baseUrl: modelBaseUrl,
      createdAt: 1_787_274_971_000 + index,
    })),
    null,
    2,
  )}\n`;
  await Promise.all([
    writeFile(
      join(harness.deviceRoots.A.hermesHome, "config.yaml"),
      compatibleModelConfig,
      "utf8",
    ),
    writeFile(
      join(harness.deviceRoots.B.hermesHome, "config.yaml"),
      compatibleModelConfig,
      "utf8",
    ),
    writeFile(
      join(harness.deviceRoots.C.hermesHome, "config.yaml"),
      compatibleModelConfig,
      "utf8",
    ),
    writeFile(
      join(harness.deviceRoots.A.hermesHome, "models.json"),
      modelCatalog,
      "utf8",
    ),
    writeFile(
      join(harness.deviceRoots.B.hermesHome, "models.json"),
      modelCatalog,
      "utf8",
    ),
    writeFile(
      join(harness.deviceRoots.C.hermesHome, "models.json"),
      modelCatalog,
      "utf8",
    ),
  ]);
  deviceA = await launchAgentControlDevice(harness, "A");
  await authenticateFirstAgentControlDevice(harness, deviceA);
  await claimDefaultProfile(deviceA);
  const modelSetupLater = deviceA.page.getByRole("button", {
    name: /稍后|Later/i,
  });
  const chatInput = deviceA.page.locator("textarea.chat-input");
  await expect
    .poll(
      async () =>
        (await modelSetupLater.isVisible()) || (await chatInput.isEnabled()),
    )
    .toBe(true);
  if (await modelSetupLater.isVisible()) await modelSetupLater.click();
  await expect(chatInput).toBeEnabled();
  await chatInput.fill("帮我创建一个叫林二的智能体，负责整理客户资料");
  await deviceA.page.locator("button.chat-send-btn").click();
  const creationGuide = deviceA.page.locator(".chat-agent-creation");
  await expect(creationGuide).toHaveClass(/chat-agent-creation--pending/);
  await expect(creationGuide.locator("input")).toHaveValue("林二");
  await expect(creationGuide.locator("textarea")).toHaveValue("整理客户资料");
  await creationGuide.locator(".chat-agent-creation-primary").click();
  await expect(creationGuide).toHaveClass(/chat-agent-creation--created/);
  await expect(creationGuide).toContainText("林二");
  const guidedDrafts = unwrap<AgentDraftDetail[]>(
    await invokeAgentera(deviceA, "listDrafts"),
  );
  const guidedDraft = guidedDrafts.find(
    ({ displayName }) => displayName === "林二",
  );
  expect(guidedDraft).toBeTruthy();
  const controlDatabase = new DatabaseSync(
    join(deviceA.userData, "agentera-control-plane", "control-plane.db"),
    { readOnly: true },
  );
  try {
    expect(
      controlDatabase
        .prepare(
          `SELECT id, display_name, target_scope, workspace_id, organization_id,
                  manifest_json
           FROM agent_drafts
           WHERE display_name = ?`,
        )
        .get("林二"),
    ).toMatchObject({
      id: guidedDraft!.id,
      display_name: "林二",
      target_scope: "USER",
      workspace_id: null,
      organization_id: null,
      manifest_json: expect.stringContaining("整理客户资料"),
    });
  } finally {
    controlDatabase.close();
  }
  await creationGuide.locator(".chat-agent-creation-primary").click();
  await expect(deviceA.page.getByTestId("personal-agent-grid")).toContainText(
    "林二",
  );

  deviceB = await launchAgentControlDevice(harness, "B");
  await authenticateExistingAgentControlDevice(harness, deviceB);
  await claimDefaultProfile(deviceB);

  expect(deviceA.userData).not.toBe(deviceB.userData);
  expect(deviceA.hermesHome).not.toBe(deviceB.hermesHome);
  expect(await encryptedDevicePrivateKey(deviceA)).not.toBe(
    await encryptedDevicePrivateKey(deviceB),
  );

  const created = unwrap<AgentDraftDetail>(
    await invokeAgentera(
      deviceA,
      "createDraft",
      draftInput("Published base version one"),
    ),
  );
  await expect
    .poll(() => cloudAgentControlCounts(harness))
    .toMatchObject({ definitions: 0, versions: 0, installations: 0 });

  const versionOne = await publish(deviceA, created.id);
  await expect
    .poll(() => cloudAgentControlCounts(harness))
    .toMatchObject({ definitions: 1, versions: 1, installations: 0 });

  const runtimeSourceRoot =
    process.env.AGENTERA_E2E_RUNTIME_SOURCE_ROOT?.trim();
  if (!runtimeSourceRoot) {
    throw new Error(
      "AGENTERA_E2E_RUNTIME_SOURCE_ROOT is required for the interrupted staging E2E.",
    );
  }
  const interruptMarker = join(
    harness.root,
    "device-c-profile-create-interrupted.once",
  );
  const runtimeTracePath = join(harness.root, "device-c-runtime-wrapper.log");
  const defaultRootMarkers = [
    "config.yaml",
    "models.json",
    "model-definitions.json",
    ".env",
  ] as const;
  deviceC = await launchAgentControlDevice(harness, "C", {
    environment: {
      HOME: dirname(harness.deviceRoots.C.hermesHome),
      AGENTERA_E2E_INTERRUPT_PROFILE_CREATE_ONCE_MARKER: interruptMarker,
      AGENTERA_E2E_DURABLE_HERMES_HOME: harness.deviceRoots.C.hermesHome,
    },
  });
  await authenticateExistingAgentControlDevice(harness, deviceC);
  await claimDefaultProfile(deviceC);
  const restoreManagedPython = await prepareInterruptedManagedRuntime(
    deviceC,
    runtimeSourceRoot,
    interruptMarker,
    runtimeTracePath,
  );
  const defaultRootBefore = await privateProfileSnapshot(
    deviceC.hermesHome,
    defaultRootMarkers,
  );
  const interruptedInstall = await invokeAgentera(deviceC, "installVersion", {
    definitionId: versionOne.definitionId,
    versionId: versionOne.versionId,
    profileName: "device-c-recovery",
  });
  expect(interruptedInstall.ok).toBe(false);
  const defaultRootAfterFailure = await privateProfileSnapshot(
    deviceC.hermesHome,
    defaultRootMarkers,
  );
  if (
    JSON.stringify(defaultRootAfterFailure) !==
    JSON.stringify(defaultRootBefore)
  ) {
    throw new Error(
      `Default Hermes root changed during interrupted attempt: ${JSON.stringify(
        {
          before: defaultRootBefore,
          after: defaultRootAfterFailure,
        },
      )}`,
    );
  }
  const interruptedState = await localAgentControlState(deviceC);
  if (interruptedState.installations.length === 0) {
    throw new Error(
      `Interrupted install did not persist locally: ${JSON.stringify({
        result: interruptedInstall,
        process: deviceProcessDiagnostics(deviceC),
      })}`,
    );
  }
  expect(interruptedState.installations).toEqual([
    expect.objectContaining({
      status: "pending",
      retryCode: "profile_creation_failed",
    }),
  ]);
  const reservationsBeforeRestart = await freshProfileReservations(deviceC);
  expect(reservationsBeforeRestart).toHaveLength(1);
  const reservation = reservationsBeforeRestart[0];
  expect(reservation.displayName).toBe("device-c-recovery");
  const interruptedProfilePath = deviceProfilePath(
    deviceC,
    reservation.profileId,
  );
  const interruptedScaffold = await privateProfileSnapshot(
    interruptedProfilePath,
    [".env", "SOUL.md", "profile-meta.json", "sessions", "skills"],
  );
  expect(interruptedScaffold).not.toHaveProperty("MEMORY.md");
  const interruptedEntries = (await readdir(interruptedProfilePath)).sort();
  const expectedInterruptedEntries = [
    ".env",
    "SOUL.md",
    "profile-meta.json",
    "sessions",
    "skills",
  ];
  if (
    JSON.stringify(interruptedEntries) !==
    JSON.stringify(expectedInterruptedEntries)
  ) {
    let runtimeTrace = "<trace unavailable>";
    try {
      runtimeTrace = await readFile(runtimeTracePath, "utf8");
    } catch (error) {
      runtimeTrace = `<trace read failed: ${String(error)}>`;
    }
    throw new Error(
      `Interrupted Profile contains unexpected entries: ${JSON.stringify({
        interruptedProfilePath,
        interruptedEntries,
        expectedInterruptedEntries,
        runtimeTrace,
      })}`,
    );
  }
  const foreignProfilePath = deviceProfilePath(deviceC, "foreign-profile");
  await mkdir(foreignProfilePath, { recursive: true });
  await writeFile(
    join(foreignProfilePath, "MEMORY.md"),
    "FOREIGN_PROFILE_MUST_REMAIN_UNTOUCHED\n",
    "utf8",
  );
  const foreignBeforeRetry = await privateProfileSnapshot(foreignProfilePath, [
    "MEMORY.md",
  ]);

  await restoreManagedPython();

  await deviceC.app.close();
  const restoreManagedPythonAfterRestart =
    await prepareInterruptedManagedRuntime(
      {
        userData: harness.deviceRoots.C.userData,
        hermesHome: harness.deviceRoots.C.hermesHome,
      },
      runtimeSourceRoot,
      interruptMarker,
      runtimeTracePath,
    );
  deviceC = await launchAgentControlDevice(harness, "C", {
    environment: {
      HOME: dirname(harness.deviceRoots.C.hermesHome),
      AGENTERA_E2E_INTERRUPT_PROFILE_CREATE_ONCE_MARKER: interruptMarker,
      AGENTERA_E2E_DURABLE_HERMES_HOME: harness.deviceRoots.C.hermesHome,
      AGENTERA_E2E_RUNTIME_TRACE_FILE: runtimeTracePath,
    },
  });
  await authenticateExistingAgentControlDevice(harness, deviceC);
  await claimDefaultProfile(deviceC);
  const defaultRootBeforeRetry = await privateProfileSnapshot(
    deviceC.hermesHome,
    defaultRootMarkers,
  );
  if (
    JSON.stringify(defaultRootBeforeRetry) !== JSON.stringify(defaultRootBefore)
  ) {
    throw new Error(
      `Default Hermes root changed during restart before retry: ${JSON.stringify(
        {
          before: defaultRootBefore,
          after: defaultRootBeforeRetry,
        },
      )}`,
    );
  }
  const retryAfterRestart = await invokeAgentera(
    deviceC,
    "retryPendingInstallation",
    {
      id: interruptedState.installations[0].id,
      target: { kind: "fresh", profileName: "device-c-recovery" },
    },
  );
  if (!retryAfterRestart.ok) {
    const failedRetryState = await localAgentControlState(deviceC);
    const failedOperationDatabase = new DatabaseSync(
      join(deviceC.userData, "agentera-control-plane", "control-plane.db"),
      { readOnly: true },
    );
    let failedOperation: unknown;
    try {
      failedOperation = failedOperationDatabase
        .prepare(
          `SELECT operation_id, agent_installation_id, target_profile_id,
                  target_kind, display_name, phase, revision,
                  runtime_profile_id, retry_code
           FROM installation_operations
           WHERE agent_installation_id = ?`,
        )
        .get(interruptedState.installations[0].id);
    } finally {
      failedOperationDatabase.close();
    }
    const runtimeTrace = await readFile(runtimeTracePath, "utf8").catch(
      (error) => `<trace read failed: ${String(error)}>`,
    );
    const profileEntries = await readdir(interruptedProfilePath).catch(
      () => [],
    );
    const markerEntries = await Promise.all(
      ["auth.json", "MEMORY.md", "USER.md", "files", "curator", ".curator"].map(
        async (marker) => ({
          marker,
          entries: await readdir(join(interruptedProfilePath, marker)).catch(
            () => [],
          ),
        }),
      ),
    );
    throw new Error(
      `Retry failed after fresh Profile staging: ${JSON.stringify({
        result: retryAfterRestart,
        failedRetryState,
        failedOperation,
        profileEntries,
        markerEntries,
        runtimeTrace,
        process: deviceProcessDiagnostics(deviceC),
        rawProcessOutput: deviceC.processOutput.slice(-16_000),
      })}`,
    );
  }
  if (retryAfterRestart.ok) {
    expect(retryAfterRestart.data.status).toBe("active");
  }
  await restoreManagedPythonAfterRestart();
  const recoveredState = await localAgentControlState(deviceC);
  expect(recoveredState.installations).toEqual([
    expect.objectContaining({
      id: interruptedState.installations[0].id,
      status: "active",
      runtimeProfileId: reservation.runtimeProfileId,
    }),
  ]);
  expect(await freshProfileReservations(deviceC)).toEqual([]);
  const operationDatabase = new DatabaseSync(
    join(deviceC.userData, "agentera-control-plane", "control-plane.db"),
    { readOnly: true },
  );
  try {
    expect(
      operationDatabase
        .prepare(
          `SELECT operation_id, target_profile_id, runtime_profile_id, phase
           FROM installation_operations
           WHERE agent_installation_id = ?`,
        )
        .get(interruptedState.installations[0].id),
    ).toEqual({
      operation_id: reservation.operationId,
      target_profile_id: reservation.profileId,
      runtime_profile_id: reservation.runtimeProfileId,
      phase: "committed",
    });
  } finally {
    operationDatabase.close();
  }
  expect(
    await privateProfileSnapshot(deviceC.hermesHome, defaultRootMarkers),
  ).toEqual(defaultRootBefore);
  expect(
    await privateProfileSnapshot(foreignProfilePath, ["MEMORY.md"]),
  ).toEqual(foreignBeforeRetry);
  expect(
    await privateProfileSnapshot(interruptedProfilePath, ["MEMORY.md"]),
  ).toEqual({
    "MEMORY.md": null,
  });
  expect(await boundProfilePaths(deviceC)).not.toContain(
    resolve(foreignProfilePath),
  );
  expect(
    (await readdir(join(deviceC.hermesHome, "profiles"))).filter((name) =>
      name.startsWith(`${reservation.profileId}-`),
    ),
  ).toEqual([]);

  const aProfile = deviceProfilePath(deviceA, "default");
  const aBeforeClaim = await privateProfileSnapshot(aProfile, PRIVATE_MARKERS);
  const aInstallation = unwrap(
    await invokeAgentera(deviceA, "claimVersion", {
      definitionId: versionOne.definitionId,
      versionId: versionOne.versionId,
      localProfileId: "default",
      confirmation: "claim-existing-profile",
    }),
  );
  expect(await privateProfileSnapshot(aProfile, PRIVATE_MARKERS)).toEqual(
    aBeforeClaim,
  );

  const discovered = unwrap(await invokeAgentera(deviceB, "listDefinitions"));
  expect(discovered).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: versionOne.definitionId,
        latestVersionId: versionOne.versionId,
      }),
    ]),
  );

  const beforeFailedInstallA = await privateProfileSnapshot(
    aProfile,
    PRIVATE_MARKERS,
  );
  const beforeFailedInstallB = await privateProfileSnapshot(
    deviceProfilePath(deviceB, "default"),
    PRIVATE_MARKERS,
  );
  failNextAgentControlRequest(harness, "/api/v1/agent-installations");
  const failedInstall = await invokeAgentera(deviceB, "installVersion", {
    definitionId: versionOne.definitionId,
    versionId: versionOne.versionId,
    profileName: "device-b-agent",
  });
  expect(failedInstall.ok).toBe(false);
  expect(await privateProfileSnapshot(aProfile, PRIVATE_MARKERS)).toEqual(
    beforeFailedInstallA,
  );
  expect(
    await privateProfileSnapshot(
      deviceProfilePath(deviceB, "default"),
      PRIVATE_MARKERS,
    ),
  ).toEqual(beforeFailedInstallB);

  // Retry the exact target so the persisted creation intent can safely reuse
  // its idempotency key after the injected transient Cloud failure.
  const bInstallationResult = await invokeAgentera(deviceB, "installVersion", {
    definitionId: versionOne.definitionId,
    versionId: versionOne.versionId,
    profileName: "device-b-agent",
  });
  if (!bInstallationResult.ok) {
    const pending = await invokeAgentera(deviceB, "listInstallations");
    const freshProfile = await privateProfileSnapshot(
      deviceProfilePath(deviceB, "device-b-agent"),
      [
        ".env",
        "auth.json",
        "MEMORY.md",
        "USER.md",
        "sessions",
        "files",
        "skills",
        "curator",
        ".curator",
        "config.yaml",
        "profile-meta.json",
      ],
    );
    throw new Error(
      `Device B installation failed: ${bInstallationResult.errorCode}; local=${JSON.stringify(
        pending,
      )}; freshProfile=${JSON.stringify(freshProfile)}; exchanges=${JSON.stringify(
        agentControlExchangeDiagnostics(harness),
      )}; process=${JSON.stringify(deviceProcessDiagnostics(deviceB))}`,
    );
  }
  const bInstallation = bInstallationResult.data;
  const bProfile = deviceProfilePath(deviceB, "device-b-agent");
  await writeFile(join(bProfile, "config.yaml"), compatibleModelConfig, "utf8");
  const bAdaptiveMarker = join(bProfile, "adaptive/device-marker.txt");
  await mkdir(dirname(bAdaptiveMarker), { recursive: true });
  await writeFile(bAdaptiveMarker, "DEVICE_B_ADAPTIVE_MARKER\n", "utf8");

  expect(aInstallation.id).not.toBe(bInstallation.id);
  expect(aInstallation.runtimeProfileId).not.toBe(
    bInstallation.runtimeProfileId,
  );
  expect(aProfile).not.toBe(bProfile);
  expect(
    await readFile(join(aProfile, "adaptive/device-marker.txt"), "utf8"),
  ).not.toBe(await readFile(bAdaptiveMarker, "utf8"));

  await startBoundConversation(deviceA, "default", "device-a-v1");
  await startBoundConversation(deviceB, "device-b-agent", "device-b-v1");
  await expect
    .poll(async () => (await localAgentControlState(deviceA)).bindings.length)
    .toBe(1);
  await expect
    .poll(async () => (await localAgentControlState(deviceB)).bindings.length)
    .toBe(1);
  const aV1 = await localAgentControlState(deviceA);
  const bV1 = await localAgentControlState(deviceB);
  expect(aV1.bindings[0]).toMatchObject({
    agentVersionId: versionOne.versionId,
    agentInstallationId: aInstallation.id,
  });
  expect(bV1.bindings[0]).toMatchObject({
    agentVersionId: versionOne.versionId,
    agentInstallationId: bInstallation.id,
  });
  expect(aV1.bindings[0].localAdaptiveStateRevision).not.toBe(
    bV1.bindings[0].localAdaptiveStateRevision,
  );

  // A signed legacy fixed policy remains part of the immutable publication
  // record, but Desktop exposes the complete current-owner catalog and lets
  // this installed Agent start a new immutable segment with either model.
  const beforeSwitch = await deviceA.page.evaluate(() =>
    window.agenteraGlobalProfile.prepareConversationContext({
      runId: "device-a-v1",
      profile: "default",
    }),
  );
  expect(beforeSwitch.agentConversation).toMatchObject({
    policyMode: "user_select",
    switchDisabledCode: null,
  });
  expect(
    beforeSwitch.agentConversation?.catalog.routes.map(({ model }) => model),
  ).toEqual(expect.arrayContaining([PRIMARY_MODEL, ALTERNATE_MODEL]));
  const alternate = beforeSwitch.agentConversation?.catalog.routes.find(
    ({ model }) => model === ALTERNATE_MODEL,
  );
  expect(alternate).toBeTruthy();
  let switched: { events: Array<{ state: string; to: { model: string } }> };
  try {
    switched = await deviceA.page.evaluate(
      async ({ selection }) => {
        const events: Array<{ state: string; to: { model: string } }> = [];
        const dispose = window.hermesAPI.onChatAgentSegment((_runId, event) => {
          events.push(event);
        });
        try {
          await window.hermesAPI.sendMessage(
            "Use the newly selected model for this isolated Agent.",
            "default",
            undefined,
            [],
            undefined,
            undefined,
            "device-a-v1",
            undefined,
            selection,
          );
          return { events };
        } finally {
          dispose();
        }
      },
      { selection: alternate!.selection },
    );
  } catch (error) {
    throw new Error(
      `Model switch failed: ${error instanceof Error ? error.message : String(error)}; processOutput=${deviceA.processOutput.slice(-12000)}`,
    );
  }
  expect(switched.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        state: "active",
        to: expect.objectContaining({ model: ALTERNATE_MODEL }),
      }),
    ]),
  );
  expect(requestedModels).toContain(ALTERNATE_MODEL);
  const afterSwitch = await deviceA.page.evaluate(() =>
    window.agenteraGlobalProfile.prepareConversationContext({
      runId: "device-a-v1",
      profile: "default",
    }),
  );
  expect(afterSwitch.agentConversation).toMatchObject({
    policyMode: "user_select",
    activeRoute: { model: ALTERNATE_MODEL },
    activeSegmentOrdinal: 2,
    switchDisabledCode: null,
  });

  const bBeforeLearning = await privateProfileSnapshot(
    bProfile,
    PRIVATE_MARKERS,
  );
  await writeDeviceALearning(aProfile);
  expect(await privateProfileSnapshot(bProfile, PRIVATE_MARKERS)).toEqual(
    bBeforeLearning,
  );
  await expect(
    readFile(join(bProfile, "skills/learned-local/SKILL.md"), "utf8"),
  ).rejects.toThrow();

  await updateForVersionTwo(deviceA, created.id);
  const versionTwo = await publish(deviceA, created.id);
  expect(versionTwo.versionNumber).toBe(2);

  const bPrivateAfterLearning = await privateProfileSnapshot(
    bProfile,
    PRIVATE_MARKERS,
  );
  failNextAgentControlRequest(
    harness,
    `/api/v1/agent-installations/${bInstallation.id}/select-version`,
  );
  const failedUpdate = await invokeAgentera(
    deviceB,
    "selectInstallationVersion",
    {
      id: bInstallation.id,
      versionId: versionTwo.versionId,
      localProfileId: "device-b-agent",
    },
  );
  expect(failedUpdate.ok).toBe(false);
  expect(await privateProfileSnapshot(bProfile, PRIVATE_MARKERS)).toEqual(
    bPrivateAfterLearning,
  );

  const successfulUpdate = await invokeAgentera(
    deviceB,
    "selectInstallationVersion",
    {
      id: bInstallation.id,
      versionId: versionTwo.versionId,
      localProfileId: "device-b-agent",
    },
  );
  if (!successfulUpdate.ok) {
    throw new Error(
      `Agent control update failed: ${successfulUpdate.errorCode}; local=${JSON.stringify(
        await localAgentControlState(deviceB),
      )}; exchanges=${JSON.stringify(
        agentControlExchangeDiagnostics(harness),
      )}; process=${JSON.stringify(deviceProcessDiagnostics(deviceB))}`,
    );
  }
  const oldBinding = (await localAgentControlState(deviceB)).bindings[0];
  expect(oldBinding.agentVersionId).toBe(versionOne.versionId);
  await startBoundConversation(deviceB, "device-b-agent", "device-b-v2");
  await expect
    .poll(async () => (await localAgentControlState(deviceB)).bindings.length)
    .toBe(2);
  const bUpdated = await localAgentControlState(deviceB);
  expect(
    bUpdated.bindings.find(
      (binding) => binding.conversationKey === "device-b-v2",
    )?.agentVersionId,
  ).toBe(versionTwo.versionId);
  expect(
    bUpdated.bindings.find(
      (binding) => binding.conversationKey === "device-b-v1",
    )?.agentVersionId,
  ).toBe(versionOne.versionId);

  failNextAgentControlRequest(
    harness,
    `/api/v1/agent-installations/${bInstallation.id}/archive`,
  );
  const failedArchive = await invokeAgentera(
    deviceB,
    "archiveInstallation",
    bInstallation.id,
  );
  expect(failedArchive.ok).toBe(false);
  expect(await privateProfileSnapshot(bProfile, PRIVATE_MARKERS)).toEqual(
    bPrivateAfterLearning,
  );
  unwrap(
    await invokeAgentera(deviceB, "archiveInstallation", bInstallation.id),
  );
  expect(await privateProfileSnapshot(bProfile, PRIVATE_MARKERS)).toEqual(
    bPrivateAfterLearning,
  );

  const finalA = await localAgentControlState(deviceA);
  const finalB = await localAgentControlState(deviceB);
  expect(finalA.installations).toHaveLength(1);
  expect(finalB.installations).toHaveLength(1);
  expect(finalA.projectionRoots[0]).not.toBe(finalB.projectionRoots[0]);

  await expect
    .poll(() => cloudAgentControlCounts(harness))
    .toMatchObject({
      definitions: 1,
      versions: 2,
      // Device C is a third device in this recovery scenario; its recovered
      // installation is intentionally included in the shared Cloud count.
      installations: 3,
      // The model switch is an immutable Agent segment transition, so it
      // creates one additional sanitized Runtime binding while preserving
      // the original segment bindings for both devices.
      runtimeBindings: 4,
    });

  const requests = agentControlRequests(harness);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.some((request) => request.path === "/api/agents")).toBe(
    false,
  );
  const captured = JSON.stringify(requests);
  for (const forbidden of [
    DEVICE_A_MEMORY_SECRET,
    DEVICE_A_SKILL_SECRET,
    createHash("sha256").update(DEVICE_A_MEMORY_SECRET).digest("hex"),
    createHash("sha256").update(DEVICE_A_SKILL_SECRET).digest("hex"),
    "refreshToken",
    "offlineEntitlement",
    "devicePrivateKey",
    "profilePath",
    "filePath",
    "curator/state.json",
    "sessions/authoring.json",
  ]) {
    expect(captured).not.toContain(forbidden);
  }
});
