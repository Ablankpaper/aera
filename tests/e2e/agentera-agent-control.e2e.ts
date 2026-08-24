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
import { createServer, get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "playwright/test";
import { parse as parseYaml } from "yaml";

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

// A packaged run installs and verifies the signed Runtime Seed for four
// isolated Electron devices. The global 240-second budget can cancel the
// fourth healthy installation before this acceptance reaches model routing.
test.setTimeout(600_000);

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
const SECOND_PROVIDER_NAME = "E2E Provider B";
const SECOND_PROVIDER_MODEL = "claude-sonnet-4-6";
const SECOND_PROVIDER_API_KEY = "e2e-provider-b-profile-only-key";
const SECOND_PROVIDER_ENV_KEY = "CUSTOM_PROVIDER_E2E_PROVIDER_B_KEY";
const GLOBAL_TOOL_PROMPT = "AERA_BETA38_GLOBAL_TOOL_REGRESSION";
const GLOBAL_TOOL_RESULT = "AERA_BETA38_TOOL_OK";
const GLOBAL_TOOL_CALL_ID = "call_aera_beta38_global_tool";
const IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let harness: AgentControlHarness | null = null;
let deviceA: AgentControlDevice | null = null;
let deviceB: AgentControlDevice | null = null;
let deviceC: AgentControlDevice | null = null;
const modelServers: Server[] = [];
let modelBaseUrl = "";
let secondModelBaseUrl = "";
const requestedModelRoutes: Array<{
  provider: string;
  model: string;
  credentialAccepted: boolean;
}> = [];
const modelServerRequests: Array<{
  provider: string;
  method: string;
  path: string;
}> = [];
const providerRequestBodies: string[] = [];
let unauthorizedModelRequests = 0;
let globalToolCallRequests = 0;
let globalToolFinalRequests = 0;
let imageModelRequests = 0;

async function readFailureEvidence(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).slice(-16_000);
  } catch (error) {
    return `<unavailable: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

async function gatewayFailureEvidence(
  device: AgentControlDevice,
  profileId: string,
  port?: number,
): Promise<string> {
  const profileRoot = deviceProfilePath(device, profileId);
  const pidPath = join(profileRoot, "gateway.pid");
  let pidLiveness = "unavailable";
  try {
    const parsed = JSON.parse(await readFile(pidPath, "utf8")) as {
      pid?: unknown;
    };
    if (typeof parsed.pid === "number") {
      try {
        process.kill(parsed.pid, 0);
        pidLiveness = `alive:${parsed.pid}`;
      } catch (error) {
        pidLiveness = `not-alive:${parsed.pid}:${error instanceof Error ? error.message : String(error)}`;
      }
    }
  } catch (error) {
    pidLiveness = `unreadable:${error instanceof Error ? error.message : String(error)}`;
  }
  const files = [
    join(profileRoot, "gateway-stderr.log"),
    join(profileRoot, "gateway.log"),
    pidPath,
    join(device.userData, "gateway-process-ownership.json"),
  ];
  const entries = await Promise.all(
    files.map(async (path) => `${path}\n${await readFailureEvidence(path)}`),
  );
  return [
    `processOutput\n${device.processOutput.slice(-16_000)}`,
    `gatewayPort\n${port ?? "unknown"}`,
    `pidLiveness\n${pidLiveness}`,
    ...entries,
  ].join("\n---\n");
}

/**
 * Named Hermes Profiles do not use the device's default API port.  The
 * Desktop allocator persists the collision-free port in the Profile's
 * config.yaml before launching its Gateway.  Read that source of truth rather
 * than assuming the device-level default (which made the 401 health assertion
 * probe the wrong listener).
 */
async function readGatewayPort(
  device: AgentControlDevice,
  profileId: string,
): Promise<number> {
  const configPath = join(deviceProfilePath(device, profileId), "config.yaml");
  const config = parseYaml(await readFile(configPath, "utf8")) as {
    platforms?: {
      api_server?: {
        extra?: { port?: unknown };
      };
    };
  };
  const port = config.platforms?.api_server?.extra?.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port >= 65_536
  ) {
    throw new Error(
      `Gateway port is missing from ${configPath}; profile=${profileId}`,
    );
  }
  return port;
}

async function probeGatewayHealth(port: number): Promise<{
  status: number;
  error: string;
}> {
  return new Promise((resolveProbe) => {
    const request = httpGet(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        agent: false,
        headers: { connection: "close" },
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolveProbe({ status: response.statusCode ?? 0, error: "" }),
        );
      },
    );
    request.setTimeout(3_000, () => {
      request.destroy(new Error("health probe timed out"));
    });
    request.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      resolveProbe({
        status: 0,
        error: code ? `${code}: ${error.message}` : error.message,
      });
    });
  });
}

async function startModelServer(
  provider: string,
  models: readonly string[],
  options: {
    expectedApiKey?: string;
    strictRequestRoute?: boolean;
  } = {},
): Promise<string> {
  const modelServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      modelServerRequests.push({
        provider,
        method: request.method || "",
        path: url.pathname,
      });
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: models.map((id) => ({
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
      providerRequestBodies.push(body);
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: unknown; content?: unknown }>;
        model?: unknown;
        stream?: unknown;
        tools?: Array<{ function?: { name?: unknown } }>;
      };
      const model =
        typeof payload.model === "string" ? payload.model : models[0];
      const credentialAccepted = options.expectedApiKey
        ? request.headers.authorization === `Bearer ${options.expectedApiKey}`
        : true;
      requestedModelRoutes.push({ provider, model, credentialAccepted });
      if (!credentialAccepted) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Invalid API key",
              type: "authentication_error",
            },
          }),
        );
        return;
      }
      if (unauthorizedModelRequests > 0) {
        unauthorizedModelRequests -= 1;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Invalid API key",
              type: "authentication_error",
            },
          }),
        );
        return;
      }
      const serializedMessages = JSON.stringify(payload.messages ?? []);
      if (serializedMessages.includes("data:image/png;base64,")) {
        imageModelRequests += 1;
      }
      const isGlobalToolTurn = serializedMessages.includes(GLOBAL_TOOL_PROMPT);
      const hasGlobalToolResult = (payload.messages ?? []).some(
        (message) =>
          message.role === "tool" &&
          JSON.stringify(message.content).includes(GLOBAL_TOOL_RESULT),
      );
      if (isGlobalToolTurn && !hasGlobalToolResult) {
        const exposesTerminal = (payload.tools ?? []).some(
          (tool) => tool.function?.name === "terminal",
        );
        if (!exposesTerminal) {
          response
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ error: { message: "terminal is missing" } }));
          return;
        }
        globalToolCallRequests += 1;
        const toolCall = {
          index: 0,
          id: GLOBAL_TOOL_CALL_ID,
          type: "function",
          function: {
            name: "terminal",
            arguments: JSON.stringify({
              command: `printf ${GLOBAL_TOOL_RESULT}`,
              timeout: 30,
            }),
          },
        };
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
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [toolCall],
                  },
                  finish_reason: "tool_calls",
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
                delta: { role: "assistant", tool_calls: [toolCall] },
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
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
        return;
      }
      if (isGlobalToolTurn && hasGlobalToolResult) {
        globalToolFinalRequests += 1;
      }
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
    modelServer.once("error", rejectListen);
    modelServer.listen(0, options.strictRequestRoute ? "::" : "127.0.0.1", () =>
      resolveListen(),
    );
  });
  modelServers.push(modelServer);
  const address = modelServer.address() as AddressInfo;
  // IPv6-mapped loopback reaches the run-owned local server, but neither
  // Desktop nor Runtime classifies it as a no-key loopback shortcut. Provider
  // B therefore exercises the real secretless request route: Main projects a
  // named Provider and its dedicated key into the isolated Agent Profile,
  // then Runtime resolves that Profile-local key from the four public route
  // fields. No public DNS or live provider is required.
  return options.strictRequestRoute
    ? `http://[::ffff:7f00:1]:${address.port}/v1`
    : `http://127.0.0.1:${address.port}/v1`;
}

function unwrap<T>(result: AgenteraAgentControlResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Agent control failed: ${result.errorCode}; exchanges=${JSON.stringify(
        harness ? agentControlExchangeDiagnostics(harness) : [],
      )}; process=${JSON.stringify([
        ...deviceProcessDiagnostics(deviceA),
        ...deviceProcessDiagnostics(deviceB),
      ])}; raw=${JSON.stringify(
        [deviceA, deviceB]
          .filter((device): device is AgentControlDevice => device !== null)
          .map((device) => ({
            name: device.name,
            output: device.processOutput.slice(-16_000),
          })),
      )}`,
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
  [modelBaseUrl, secondModelBaseUrl] = await Promise.all([
    startModelServer("provider-a", [PRIMARY_MODEL, ALTERNATE_MODEL]),
    startModelServer("provider-b", [SECOND_PROVIDER_MODEL], {
      expectedApiKey: SECOND_PROVIDER_API_KEY,
      strictRequestRoute: true,
    }),
  ]);
  harness = await createAgentControlHarness({ emptyDevices: ["C"] });
  harness.deviceRoots.C.hermesHome = join(harness.root, "device-c", ".hermes");
  await mkdir(harness.deviceRoots.C.hermesHome, { recursive: true });
});

test.afterAll(async () => {
  await closeAgentControlHarness(harness);
  await Promise.all(
    modelServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolveClose) =>
            server.close(() => resolveClose()),
          ),
      ),
  );
  requestedModelRoutes.splice(0);
  modelServerRequests.splice(0);
  unauthorizedModelRequests = 0;
  globalToolCallRequests = 0;
  globalToolFinalRequests = 0;
  imageModelRequests = 0;
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
  const primaryModelCatalog = [PRIMARY_MODEL, ALTERNATE_MODEL].map(
    (model, index) => ({
      id: `agent-model-choice-${index + 1}`,
      name: model,
      provider: "openai",
      model,
      baseUrl: modelBaseUrl,
      createdAt: 1_787_274_971_000 + index,
    }),
  );
  const modelCatalog = `${JSON.stringify(primaryModelCatalog, null, 2)}\n`;
  const providerCredential = `${SECOND_PROVIDER_ENV_KEY}=${SECOND_PROVIDER_API_KEY}\n`;
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
  // External source-backed Runtime startup can finish the first renderer
  // paint before the one-per-launch model reminder mounts. Drain that modal
  // before sending so the acceptance step is testing Agent creation rather
  // than racing Radix's focus overlay.
  const startupPrompt = deviceA.page.locator(".startup-model-prompt");
  await startupPrompt
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(async () => {
      await startupPrompt
        .getByRole("button", { name: /稍后|Later/iu })
        .click({ force: true });
    })
    .catch(() => undefined);
  await expect(deviceA.page.locator(".app-modal-overlay")).toHaveCount(0);
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

  deviceB = await launchAgentControlDevice(harness, "B", {
    environment: {
      // The strict local endpoint must never use the developer machine's
      // proxy, and the deliberately wrong global key proves Runtime uses the
      // isolated Agent Profile's named-provider credential instead.
      NO_PROXY: "*",
      no_proxy: "*",
      OPENAI_API_KEY: "e2e-global-openai-key-must-not-be-used",
    },
  });
  await authenticateExistingAgentControlDevice(harness, deviceB);
  await claimDefaultProfile(deviceB);

  // Configure provider B through the same coordinated Main contract as the
  // Settings surface. Authentication mounts an owner-scoped account Profile
  // (`aera-space-*`), so writing a physical default-profile fixture here would
  // not exercise the real account -> isolated Agent projection boundary.
  const sourceAccountCatalog = await deviceB.page.evaluate(() =>
    window.hermesAPI.getOwnerModelRouteCatalog(),
  );
  const providerBMutation = await deviceB.page.evaluate(
    async ({ catalog, providerName, baseUrl, apiKey, model }) =>
      window.hermesAPI.mutateModelConfiguration({
        intent: "upsert",
        expectedCatalogRevision: catalog.revision,
        requestedProfileId: catalog.targetProfileId,
        provider: "custom",
        providerLabel: providerName,
        baseUrl,
        apiMode: "chat_completions",
        apiKey,
        models: [{ model, displayName: model }],
        activeModel: model,
      }),
    {
      catalog: sourceAccountCatalog,
      providerName: SECOND_PROVIDER_NAME,
      baseUrl: secondModelBaseUrl,
      apiKey: SECOND_PROVIDER_API_KEY,
      model: SECOND_PROVIDER_MODEL,
    },
  );
  expect(providerBMutation.status).toMatch(/^committed/u);
  expect(
    await deviceB.page.evaluate(
      async ({ profile, provider, model, baseUrl }) => {
        await window.hermesAPI.setModelConfig(
          provider,
          model,
          baseUrl,
          profile,
        );
        return window.hermesAPI.getModelConfig(profile);
      },
      {
        profile: sourceAccountCatalog.targetProfileId,
        provider: "openai",
        model: PRIMARY_MODEL,
        baseUrl: modelBaseUrl,
      },
    ),
  ).toMatchObject({
    provider: "openai",
    model: PRIMARY_MODEL,
    baseUrl: modelBaseUrl,
  });

  const globalToolTurn = await deviceB.page.evaluate(
    async ({ profile, prompt }) => {
      try {
        const result = await window.hermesAPI.sendMessage(
          prompt,
          profile,
          undefined,
          undefined,
          undefined,
          undefined,
          "device-b-global-tool",
        );
        return { ok: true as const, result };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      profile: sourceAccountCatalog.targetProfileId,
      prompt: GLOBAL_TOOL_PROMPT,
    },
  );
  if (!globalToolTurn.ok) {
    const gatewayPort = await readGatewayPort(
      deviceB,
      sourceAccountCatalog.targetProfileId,
    ).catch(() => undefined);
    const gatewayEvidence = await gatewayFailureEvidence(
      deviceB,
      sourceAccountCatalog.targetProfileId,
      gatewayPort,
    );
    throw new Error(
      `Global default-model tool turn failed: ${globalToolTurn.error}; profile=${sourceAccountCatalog.targetProfileId}; toolCallRequests=${globalToolCallRequests}; toolFinalRequests=${globalToolFinalRequests}; modelServerRequests=${JSON.stringify(modelServerRequests)}; requestedModelRoutes=${JSON.stringify(requestedModelRoutes)}; gatewayEvidence=${gatewayEvidence}`,
    );
  }
  expect(globalToolTurn.result.response).toContain("MODEL_CHOICE_OK");
  expect(globalToolCallRequests).toBe(1);
  expect(globalToolFinalRequests).toBe(1);

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

  // The interruption fixture needs Runtime source code to replace only the
  // managed Python wrapper on device C. Keep that source independent from
  // AGENTERA_E2E_RUNTIME_SOURCE_ROOT, which deliberately switches A/B/D to an
  // external Runtime. Candidate acceptance sets only the fixture variable so
  // every device still executes the signed packaged Seed.
  const runtimeSourceRoot =
    process.env.AGENTERA_E2E_RUNTIME_FIXTURE_SOURCE_ROOT?.trim() ||
    process.env.AGENTERA_E2E_RUNTIME_SOURCE_ROOT?.trim();
  if (!runtimeSourceRoot) {
    throw new Error(
      "AGENTERA_E2E_RUNTIME_FIXTURE_SOURCE_ROOT (or the legacy AGENTERA_E2E_RUNTIME_SOURCE_ROOT) is required for the interrupted staging E2E.",
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

  // Install a second, independent Agent on the same Electron device. This is
  // the boundary a two-device test alone cannot prove: both Agents share one
  // Main process but must keep separate Profiles, gateways, credentials,
  // conversations, and provider failures.
  const peerDraft = unwrap<AgentDraftDetail>(
    await invokeAgentera(deviceA, "createDraft", {
      ...draftInput("Published same-device peer Agent"),
      displayName: "Same-device peer Agent",
    }),
  );
  const peerVersion = await publish(deviceA, peerDraft.id);
  const peerInstallation = unwrap(
    await invokeAgentera(deviceB, "installVersion", {
      definitionId: peerVersion.definitionId,
      versionId: peerVersion.versionId,
      profileName: "device-b-peer-agent",
    }),
  );
  const peerProfile = deviceProfilePath(deviceB, "device-b-peer-agent");
  await writeFile(
    join(peerProfile, "config.yaml"),
    compatibleModelConfig,
    "utf8",
  );

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
  await startBoundConversation(
    deviceB,
    "device-b-peer-agent",
    "device-b-peer-v1",
  );
  await expect
    .poll(async () => (await localAgentControlState(deviceA)).bindings.length)
    .toBe(1);
  await expect
    .poll(async () => (await localAgentControlState(deviceB)).bindings.length)
    .toBe(2);
  const aV1 = await localAgentControlState(deviceA);
  const bV1 = await localAgentControlState(deviceB);
  expect(aV1.bindings[0]).toMatchObject({
    agentVersionId: versionOne.versionId,
    agentInstallationId: aInstallation.id,
  });
  const bPrimaryV1 = bV1.bindings.find(
    (binding) => binding.conversationKey === "device-b-v1",
  );
  const bPeerV1 = bV1.bindings.find(
    (binding) => binding.conversationKey === "device-b-peer-v1",
  );
  expect(bPrimaryV1).toMatchObject({
    agentVersionId: versionOne.versionId,
    agentInstallationId: bInstallation.id,
  });
  expect(bPeerV1).toMatchObject({
    agentVersionId: peerVersion.versionId,
    agentInstallationId: peerInstallation.id,
  });
  expect(peerInstallation.runtimeProfileId).not.toBe(
    bInstallation.runtimeProfileId,
  );
  expect(peerProfile).not.toBe(bProfile);
  expect(await readFile(join(peerProfile, ".env"), "utf8")).not.toContain(
    SECOND_PROVIDER_API_KEY,
  );
  expect(aV1.bindings[0].localAdaptiveStateRevision).not.toBe(
    bPrimaryV1?.localAdaptiveStateRevision,
  );

  // A signed legacy fixed policy remains part of the immutable publication
  // record, but Desktop exposes the complete current-owner catalog. Exercise
  // one isolated Agent Profile through provider A/model A -> provider A/model
  // B -> provider B/model C so a same-provider-only E2E cannot hide missing
  // credential/metadata projection into that Profile.
  const beforeSwitch = await deviceB.page.evaluate(() =>
    window.agenteraGlobalProfile.prepareConversationContext({
      runId: "device-b-v1",
      profile: "device-b-agent",
    }),
  );
  expect(beforeSwitch.agentConversation).toMatchObject({
    policyMode: "user_select",
    switchDisabledCode: null,
  });
  const catalogModels =
    beforeSwitch.agentConversation?.catalog.routes.map(({ model }) => model) ??
    [];
  if (!catalogModels.includes(SECOND_PROVIDER_MODEL)) {
    const [persistedModels, persistedProviders, persistedEnv] =
      await Promise.all([
        readFile(join(deviceB.hermesHome, "models.json"), "utf8"),
        readFile(join(deviceB.hermesHome, "providers.json"), "utf8").catch(
          () => "<missing>",
        ),
        readFile(join(deviceB.hermesHome, ".env"), "utf8").catch(() => ""),
      ]);
    throw new Error(
      `Cross-provider fixture is absent from the owner catalog: ${JSON.stringify(
        {
          catalog: beforeSwitch.agentConversation?.catalog,
          persistedModels: JSON.parse(persistedModels) as unknown,
          persistedProviders:
            persistedProviders === "<missing>"
              ? persistedProviders
              : (JSON.parse(persistedProviders) as unknown),
          persistedEnvKeys: persistedEnv
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"))
            .map((line) => line.split("=", 1)[0]),
          processOutput: deviceB.processOutput.slice(-16_000),
        },
      )}`,
    );
  }
  expect(catalogModels).toEqual(
    expect.arrayContaining([
      PRIMARY_MODEL,
      ALTERNATE_MODEL,
      SECOND_PROVIDER_MODEL,
    ]),
  );
  const alternate = beforeSwitch.agentConversation?.catalog.routes.find(
    ({ model }) => model === ALTERNATE_MODEL,
  );
  expect(alternate).toBeTruthy();
  let switched: { events: Array<{ state: string; to: { model: string } }> };
  try {
    switched = await deviceB.page.evaluate(
      async ({ selection }) => {
        const events: Array<{ state: string; to: { model: string } }> = [];
        const dispose = window.hermesAPI.onChatAgentSegment((_runId, event) => {
          events.push(event);
        });
        try {
          await window.hermesAPI.sendMessage(
            "Use the newly selected model for this isolated Agent.",
            "device-b-agent",
            undefined,
            [],
            undefined,
            undefined,
            "device-b-v1",
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
      `Same-provider model switch failed: ${error instanceof Error ? error.message : String(error)}; selectedRoute=${JSON.stringify(
        {
          provider: alternate!.provider,
          model: alternate!.model,
          baseUrl: alternate!.baseUrl,
          apiMode: alternate!.apiMode,
          sourceProfileId: alternate!.sourceProfileId,
        },
      )}; processOutput=${deviceB.processOutput.slice(-12000)}`,
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
  expect(requestedModelRoutes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: "provider-a",
        model: ALTERNATE_MODEL,
      }),
    ]),
  );

  const beforeProviderSwitch = await deviceB.page.evaluate(() =>
    window.agenteraGlobalProfile.prepareConversationContext({
      runId: "device-b-v1",
      profile: "device-b-agent",
    }),
  );
  const secondProvider =
    beforeProviderSwitch.agentConversation?.catalog.routes.find(
      ({ model, baseUrl }) =>
        model === SECOND_PROVIDER_MODEL && baseUrl === secondModelBaseUrl,
    );
  expect(secondProvider).toBeTruthy();
  expect(secondProvider?.sourceProfileId).toBe(
    sourceAccountCatalog.targetProfileId,
  );
  const bConfigBeforeProviderSwitch = await readFile(
    join(bProfile, "config.yaml"),
    "utf8",
  );
  const bEnvBeforeProviderSwitch = await readFile(
    join(bProfile, ".env"),
    "utf8",
  );
  expect(bEnvBeforeProviderSwitch).not.toContain(SECOND_PROVIDER_API_KEY);

  let providerSwitched: {
    events: Array<{
      state: string;
      to: { provider: string; model: string; baseUrl: string };
    }>;
  };
  try {
    providerSwitched = await deviceB.page.evaluate(
      async ({ selection }) => {
        const events: Array<{
          state: string;
          to: { provider: string; model: string; baseUrl: string };
        }> = [];
        const dispose = window.hermesAPI.onChatAgentSegment((_runId, event) => {
          events.push(event);
        });
        try {
          await window.hermesAPI.sendMessage(
            "Switch this isolated Agent to provider B and model C.",
            "device-b-agent",
            undefined,
            [],
            undefined,
            undefined,
            "device-b-v1",
            undefined,
            selection,
          );
          return { events };
        } finally {
          dispose();
        }
      },
      { selection: secondProvider!.selection },
    );
  } catch (error) {
    const gatewayPort = await readGatewayPort(deviceB, "device-b-agent").catch(
      () => undefined,
    );
    const gatewayEvidence = await gatewayFailureEvidence(
      deviceB,
      "device-b-agent",
      gatewayPort,
    );
    throw new Error(
      `Cross-provider model switch failed: ${error instanceof Error ? error.message : String(error)}; selectedRoute=${JSON.stringify(secondProvider)}; processOutput=${deviceB.processOutput.slice(-16000)}; modelServerRequests=${JSON.stringify(modelServerRequests)}; gatewayEvidence=${gatewayEvidence}`,
    );
  }
  expect(providerSwitched.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        state: "active",
        to: expect.objectContaining({
          provider: "custom:e2e-provider-b",
          model: SECOND_PROVIDER_MODEL,
          baseUrl: secondModelBaseUrl,
        }),
      }),
    ]),
  );
  expect(requestedModelRoutes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: "provider-b",
        model: SECOND_PROVIDER_MODEL,
        credentialAccepted: true,
      }),
    ]),
  );

  const bConfigAfterProviderSwitch = parseYaml(
    await readFile(join(bProfile, "config.yaml"), "utf8"),
  ) as {
    model?: { provider?: unknown; default?: unknown; base_url?: unknown };
    providers?: Record<
      string,
      {
        api?: unknown;
        key_env?: unknown;
        default_model?: unknown;
        models?: unknown;
      }
    >;
  };
  expect(bConfigBeforeProviderSwitch).toContain(`default: ${PRIMARY_MODEL}`);
  // The public catalog keeps the historical `openai` identity (see the
  // conversation assertions below), but Hermes cannot start a bare
  // `openai` provider for a loopback OpenAI-compatible endpoint.  Startup
  // migration therefore persists the Runtime-native `custom` identity while
  // preserving the selected model and endpoint.
  expect(bConfigAfterProviderSwitch.model).toMatchObject({
    provider: "custom",
    default: PRIMARY_MODEL,
    base_url: modelBaseUrl,
  });
  expect(
    bConfigAfterProviderSwitch.providers?.["e2e-provider-b"],
  ).toMatchObject({
    api: secondModelBaseUrl,
    key_env: SECOND_PROVIDER_ENV_KEY,
  });
  expect(
    bConfigAfterProviderSwitch.providers?.["e2e-provider-b"]?.default_model,
  ).toBeUndefined();
  expect(
    bConfigAfterProviderSwitch.providers?.["e2e-provider-b"]?.models,
  ).toBeUndefined();
  const projectedProviderCatalog = JSON.parse(
    await readFile(join(bProfile, "providers.json"), "utf8"),
  ) as { providers?: Array<{ name?: unknown; baseUrl?: unknown }> };
  expect(projectedProviderCatalog.providers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: SECOND_PROVIDER_NAME,
        baseUrl: secondModelBaseUrl,
      }),
    ]),
  );
  expect(await readFile(join(bProfile, ".env"), "utf8")).toContain(
    providerCredential.trim(),
  );

  const afterProviderSwitch = await deviceB.page.evaluate(() =>
    window.agenteraGlobalProfile.prepareConversationContext({
      runId: "device-b-v1",
      profile: "device-b-agent",
    }),
  );
  expect(afterProviderSwitch.agentConversation).toMatchObject({
    policyMode: "user_select",
    activeRoute: {
      provider: "custom:e2e-provider-b",
      model: SECOND_PROVIDER_MODEL,
      baseUrl: secondModelBaseUrl,
    },
    activeSegmentOrdinal: 3,
    switchDisabledCode: null,
  });

  // A model chosen for an installed user-select Agent must remain the user's
  // current route when a brand-new conversation is opened.  In particular,
  // the Agent's creation-time model (provider A / PRIMARY_MODEL) must not be
  // silently resurrected merely because the new conversation has no existing
  // segment to resume.
  const freshConversationRouteStart = requestedModelRoutes.length;
  const freshConversationTurn = await deviceB.page.evaluate(
    async ({ profile, runId }) => {
      try {
        const result = await window.hermesAPI.sendMessage(
          "Start a fresh conversation on the currently selected provider.",
          profile,
          undefined,
          undefined,
          undefined,
          undefined,
          runId,
        );
        return { ok: true as const, result };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { profile: "device-b-agent", runId: "device-b-v3" },
  );
  expect(
    freshConversationTurn,
    `fresh conversation send failed: ${JSON.stringify(freshConversationTurn)}; ` +
      `modelRoutes=${JSON.stringify(requestedModelRoutes.slice(freshConversationRouteStart))}; ` +
      `process=${deviceB.processOutput.slice(-12000)}`,
  ).toMatchObject({
    ok: true,
    result: { response: expect.stringContaining("MODEL_CHOICE_OK") },
  });
  expect(requestedModelRoutes.slice(freshConversationRouteStart)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: "provider-b",
        model: SECOND_PROVIDER_MODEL,
        credentialAccepted: true,
      }),
    ]),
  );
  const freshConversationContext = await deviceB.page.evaluate(
    ({ profile, runId }) =>
      window.agenteraGlobalProfile.prepareConversationContext({
        runId,
        profile,
      }),
    { profile: "device-b-agent", runId: "device-b-v3" },
  );
  expect(freshConversationContext.agentConversation).toMatchObject({
    policyMode: "user_select",
    activeRoute: {
      provider: "custom:e2e-provider-b",
      model: SECOND_PROVIDER_MODEL,
      baseUrl: secondModelBaseUrl,
    },
    switchDisabledCode: null,
  });

  const imageTurn = await deviceB.page.evaluate(
    async ({ profile, runId, attachment }) => {
      try {
        const result = await window.hermesAPI.sendMessage(
          "Describe this test image through the selected Provider.",
          profile,
          undefined,
          undefined,
          [attachment],
          undefined,
          runId,
        );
        return { ok: true as const, result };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      profile: "device-b-agent",
      runId: "device-b-v1",
      attachment: {
        id: "beta38-model-switch-image",
        kind: "image" as const,
        name: "pixel.png",
        mime: "image/png",
        size: 68,
        dataUrl: IMAGE_DATA_URL,
      },
    },
  );
  expect(imageTurn).toMatchObject({
    ok: true,
    result: { response: expect.stringContaining("MODEL_CHOICE_OK") },
  });
  expect(imageModelRequests).toBe(1);
  const localRecordPath = join(
    deviceB.userData,
    "agentera-control-plane",
    "control-plane.db",
  );
  const localRecordDatabase = new DatabaseSync(localRecordPath, {
    readOnly: true,
  });
  try {
    const durableDefinitionVersionInstallationRecords = JSON.stringify([
      localRecordDatabase
        .prepare("SELECT * FROM cached_agent_versions WHERE version_id = ?")
        .get(versionOne.versionId),
      localRecordDatabase
        .prepare(
          `SELECT * FROM local_agent_installations
           WHERE agent_installation_id = ?`,
        )
        .get(bInstallation.id),
    ]);
    for (const requestOnlyValue of [
      SECOND_PROVIDER_MODEL,
      secondModelBaseUrl,
      SECOND_PROVIDER_API_KEY,
    ]) {
      expect(durableDefinitionVersionInstallationRecords).not.toContain(
        requestOnlyValue,
      );
    }
    const bindingAndSegmentRecords = JSON.stringify([
      ...localRecordDatabase
        .prepare("SELECT binding_json FROM runtime_bindings")
        .all(),
      ...localRecordDatabase
        .prepare("SELECT route_json FROM conversation_segments")
        .all(),
    ]);
    expect(bindingAndSegmentRecords).not.toContain(SECOND_PROVIDER_API_KEY);
  } finally {
    localRecordDatabase.close();
  }
  const databaseFiles = (await readdir(dirname(localRecordPath))).filter(
    (name) => name.startsWith("control-plane.db"),
  );
  for (const name of databaseFiles) {
    expect(
      (await readFile(join(dirname(localRecordPath), name))).includes(
        Buffer.from(SECOND_PROVIDER_API_KEY),
      ),
    ).toBe(false);
  }
  for (const requestBody of providerRequestBodies) {
    expect(requestBody).not.toContain(SECOND_PROVIDER_API_KEY);
    expect(requestBody).not.toMatch(/"(?:api_key|aera_model_route)"\s*:/u);
  }
  const unchangedDeviceAConversation = await deviceA.page.evaluate(() =>
    window.agenteraGlobalProfile.prepareConversationContext({
      runId: "device-a-v1",
      profile: "default",
    }),
  );
  expect(unchangedDeviceAConversation.agentConversation).toMatchObject({
    activeRoute: { provider: "openai", model: PRIMARY_MODEL },
    activeSegmentOrdinal: 1,
  });

  // A provider can reject one request after the Agent/Gateway has already
  // been running (for example, a revoked static key). The failure must stay
  // local to that turn: do not restart the bound Gateway, poison its port, or
  // make the next turn unusable.
  unauthorizedModelRequests = 1;
  const failedAuthTurn = await deviceB.page.evaluate(
    async ({ profile, runId }) => {
      const errors: unknown[] = [];
      const dispose = window.hermesAPI.onChatError((eventRunId, event) => {
        if (eventRunId === runId) errors.push(event);
      });
      try {
        await window.hermesAPI.sendMessage(
          "Trigger one provider authentication failure.",
          profile,
          undefined,
          undefined,
          undefined,
          undefined,
          runId,
        );
        return { ok: true, error: "", errors };
      } catch (error) {
        // The IPC event is delivered independently of the invoke rejection;
        // yield once so the real Preload listener has observed it.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          errors,
        };
      } finally {
        dispose();
      }
    },
    { profile: "device-b-agent", runId: "device-b-v1" },
  );
  expect(failedAuthTurn.ok).toBe(false);
  expect(failedAuthTurn.error).toMatch(
    /401|authentication|credential|API error/iu,
  );
  // The invoke/rejection channel is independent from `chat-error`; it must
  // carry only the same stable code and never the provider response, key, or
  // local Runtime path.
  // Electron prefixes rejected IPC Errors with its transport context; the
  // only application detail allowed after that prefix is the stable code.
  expect(failedAuthTurn.error).toMatch(
    /^Error invoking remote method 'send-message': Error: provider_authentication_rejected$/u,
  );
  expect(failedAuthTurn.error).not.toContain(SECOND_PROVIDER_API_KEY);
  expect(failedAuthTurn.error).not.toMatch(
    /(?:\/Users\/|\\Users\\|\.hermes[\\/])/iu,
  );
  expect(failedAuthTurn.errors).toEqual(
    expect.arrayContaining([{ code: "provider_authentication_rejected" }]),
  );
  expect(JSON.stringify(failedAuthTurn.errors)).not.toContain(
    SECOND_PROVIDER_API_KEY,
  );
  expect(JSON.stringify(failedAuthTurn.errors)).not.toMatch(
    /(?:\/Users\/|\\Users\\|\.hermes[\\/])/iu,
  );
  expect(deviceB.processOutput).not.toContain(SECOND_PROVIDER_API_KEY);
  for (const profile of ["device-b-agent", "device-b-peer-agent"]) {
    const gatewayLogs = await Promise.all(
      ["gateway-stderr.log", "gateway.log"].map((name) =>
        readFile(join(deviceProfilePath(deviceB, profile), name), "utf8").catch(
          () => "",
        ),
      ),
    );
    expect(gatewayLogs.join("\n")).not.toContain(SECOND_PROVIDER_API_KEY);
  }
  // Use a fresh non-browser HTTP connection. Renderer fetch carries an Origin
  // header, while Electron's global fetch pool can reuse a socket that the
  // preceding SSE response just closed; neither condition proves the Gateway
  // listener is down.
  const gatewayPort = await readGatewayPort(deviceB, "device-b-agent");
  const peerGatewayPort = await readGatewayPort(deviceB, "device-b-peer-agent");
  expect(peerGatewayPort).not.toBe(gatewayPort);
  const gatewayHealthAfter401 = await probeGatewayHealth(gatewayPort);
  expect(
    gatewayHealthAfter401.status,
    `${gatewayHealthAfter401.error}\n${await gatewayFailureEvidence(
      deviceB,
      "device-b-agent",
      gatewayPort,
    )}`,
  ).toBe(200);
  const peerGatewayHealthAfter401 = await probeGatewayHealth(peerGatewayPort);
  expect(
    peerGatewayHealthAfter401.status,
    `${peerGatewayHealthAfter401.error}\n${await gatewayFailureEvidence(
      deviceB,
      "device-b-peer-agent",
      peerGatewayPort,
    )}`,
  ).toBe(200);

  const peerRouteStart = requestedModelRoutes.length;
  const peerTurnAfterPrimary401 = await deviceB.page.evaluate(async () => {
    try {
      const result = await window.hermesAPI.sendMessage(
        "Continue the peer Agent after the other Agent provider failure.",
        "device-b-peer-agent",
        undefined,
        undefined,
        undefined,
        undefined,
        "device-b-peer-v1",
      );
      return { ok: true as const, response: result.response };
    } catch (error) {
      return {
        ok: false as const,
        response: error instanceof Error ? error.message : String(error),
      };
    }
  });
  expect(peerTurnAfterPrimary401).toMatchObject({
    ok: true,
    response: expect.stringContaining("MODEL_CHOICE_OK"),
  });
  expect(requestedModelRoutes.slice(peerRouteStart)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: "provider-a",
        model: PRIMARY_MODEL,
        credentialAccepted: true,
      }),
    ]),
  );
  const peerContextAfterPrimary401 = await deviceB.page.evaluate(() =>
    window.agenteraGlobalProfile.prepareConversationContext({
      runId: "device-b-peer-v1",
      profile: "device-b-peer-agent",
    }),
  );
  expect(peerContextAfterPrimary401.agentConversation).toMatchObject({
    policyMode: "user_select",
    activeRoute: { provider: "openai", model: PRIMARY_MODEL },
    activeSegmentOrdinal: 1,
    switchDisabledCode: null,
  });
  expect(await readFile(join(peerProfile, ".env"), "utf8")).not.toContain(
    SECOND_PROVIDER_API_KEY,
  );

  const recoveredTurn = await deviceB.page.evaluate(
    async ({ profile, runId }) => {
      try {
        const result = await window.hermesAPI.sendMessage(
          "Continue after the provider authentication failure.",
          profile,
          undefined,
          undefined,
          undefined,
          undefined,
          runId,
        );
        return { ok: true, response: result.response };
      } catch (error) {
        return {
          ok: false,
          response: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { profile: "device-b-agent", runId: "device-b-v1" },
  );
  expect(recoveredTurn.ok).toBe(true);
  expect(recoveredTurn.response).toContain("MODEL_CHOICE_OK");
  const afterSwitch = await deviceB.page.evaluate(() =>
    window.agenteraGlobalProfile.prepareConversationContext({
      runId: "device-b-v1",
      profile: "device-b-agent",
    }),
  );
  expect(afterSwitch.agentConversation).toMatchObject({
    policyMode: "user_select",
    activeRoute: {
      provider: "custom:e2e-provider-b",
      model: SECOND_PROVIDER_MODEL,
    },
    activeSegmentOrdinal: 3,
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
  const oldBindings = await localAgentControlState(deviceB);
  const oldBinding = oldBindings.bindings.find(
    (binding) => binding.conversationKey === "device-b-v1",
  );
  expect(oldBinding).toMatchObject({
    agentVersionId: versionOne.versionId,
    agentInstallationId: bInstallation.id,
  });
  await startBoundConversation(deviceB, "device-b-agent", "device-b-v2");
  await expect
    .poll(async () => (await localAgentControlState(deviceB)).bindings.length)
    .toBe(6);
  const bUpdated = await localAgentControlState(deviceB);
  expect(bUpdated.bindings).toHaveLength(6);
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
  const switchBindings = bUpdated.bindings.filter((binding) =>
    binding.conversationKey.startsWith("aera-segment:"),
  );
  expect(switchBindings).toHaveLength(2);
  expect(
    switchBindings.every(
      (binding) =>
        binding.agentVersionId === versionOne.versionId &&
        binding.agentInstallationId === bInstallation.id &&
        binding.runtimeProfileId === bInstallation.runtimeProfileId,
    ),
  ).toBe(true);
  expect(new Set(bUpdated.bindings.map((binding) => binding.id)).size).toBe(6);

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
  expect(finalB.installations).toHaveLength(2);
  expect(finalA.projectionRoots[0]).not.toBe(finalB.projectionRoots[0]);

  await expect
    .poll(() => cloudAgentControlCounts(harness))
    .toMatchObject({
      definitions: 2,
      versions: 3,
      // Device C is a third device in this recovery scenario; its recovered
      // installation is intentionally included in the shared Cloud count.
      installations: 4,
      // The two model switches are immutable Agent segment transitions, and
      // the fresh post-switch conversation gets its own binding; all remain
      // sanitized while the original segment bindings stay immutable.
      runtimeBindings: 7,
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
    SECOND_PROVIDER_API_KEY,
    SECOND_PROVIDER_MODEL,
    secondModelBaseUrl,
  ]) {
    expect(captured).not.toContain(forbidden);
  }
});
