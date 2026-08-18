/* eslint-disable @typescript-eslint/explicit-function-return-type */

import {
  buildMacLogQueries,
  formatMacLogTimestamp,
  runBoundedCommand,
} from "./aera-diagnostic-core.mjs";
import { redactText } from "./aera-diagnostic-redaction.mjs";

const HEX_ID = /^[0-9a-f]{12}$/i;
const SOURCES = new Set([
  "main",
  "preload",
  "renderer",
  "runtime",
  "owner",
  "updater",
  "system",
]);
const EVENTS = new Set([
  "main_started",
  "preload_started",
  "renderer_started",
  "runtime_started",
  "model_configuration_unavailable",
  "model_save_rejected",
  "model_save_committed",
  "model_save_rolled_back",
  "model_recovery_started",
  "model_recovery_finished",
  "transition_started",
  "transition_finished",
  "transition_failed",
  "update_stage",
  "update_failed",
  "update_rolled_back",
]);
const CODES = new Set([
  "native_module_abi_mismatch",
  "native_module_architecture_mismatch",
  "native_module_load_failed",
  "model_configuration_database_unavailable",
  "model_configuration_schema_unsupported",
  "model_configuration_recovery_required",
  "route_catalog_repair_required",
  "model_save_validation_failed",
  "model_save_stale_catalog_revision",
  "model_save_credential_failed",
  "model_save_provider_failed",
  "model_save_model_library_failed",
  "model_save_native_route_failed",
  "model_save_activation_failed",
  "model_save_verification_failed",
  "model_save_rollback_failed",
  "model_rollback_refresh_failed",
  "owner_transition_timeout",
  "owner_transition_failed",
  "provider_authentication_rejected",
  "provider_forbidden",
  "provider_not_found",
  "provider_rate_limited",
  "provider_upstream_error",
  "provider_network_error",
  "provider_timeout",
  "provider_cancelled",
  "update_origin_unavailable",
  "update_download_failed",
  "update_integrity_failed",
  "update_extraction_failed",
  "update_swap_failed",
  "update_startup_failed",
  "update_health_timeout",
  "update_rollback_failed",
  "transport_failed",
  "metadata_invalid",
]);
const UPDATE_STAGES = new Set([
  "stable-index",
  "stable-index-signature",
  "stable-index-verification",
  "manifest",
  "manifest-signature",
  "manifest-verification",
  "checking",
  "manifest_verified",
  "downloading",
  "download_completed",
  "artifact_verified",
  "extracting",
  "extraction_completed",
  "staging",
  "backup_created",
  "swapping",
  "restarting",
  "health_wait",
  "healthy",
  "rolling_back",
  "rolled_back",
]);

function safeId(value) {
  return HEX_ID.test(String(value || ""))
    ? String(value).toLowerCase()
    : undefined;
}

export function normalizeDiagnosticEvent(input) {
  const event = String(input?.event || "");
  const source = String(input?.source || "").toLowerCase();
  if (!EVENTS.has(event) || !SOURCES.has(source)) return null;
  const result = {
    at: Number.isFinite(Date.parse(input.at))
      ? new Date(input.at).toISOString()
      : null,
    source,
    pid:
      Number.isInteger(Number(input.pid)) && Number(input.pid) > 0
        ? Number(input.pid)
        : null,
    event,
  };
  if (CODES.has(input.code)) result.code = input.code;
  for (const field of ["diagnosticId", "operationId", "transitionId"]) {
    const value = safeId(input[field]);
    if (value) result[field] = value;
  }
  if (UPDATE_STAGES.has(input.stage)) result.stage = input.stage;
  if (result.at == null) delete result.at;
  if (result.pid == null) delete result.pid;
  return result;
}

function valueOf(line, name) {
  const match = String(line).match(
    new RegExp(`\\b${name}=([A-Za-z0-9_.-]+)`, "i"),
  );
  return match?.[1] ?? undefined;
}

function eventFromLine(line, source) {
  const body = String(line).replace(/^.*?\][ ]*/, "");
  const explicit = valueOf(body, "event");
  if (explicit && EVENTS.has(explicit)) return explicit;
  const first = body.match(/^([a-z][a-z0-9_]+)/i)?.[1];
  if (first && EVENTS.has(first)) return first;
  if (source === "updater" && valueOf(body, "stage")) return "update_stage";
  return null;
}

function timestampOf(line, fallback) {
  const match = String(line).match(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\b/u,
  );
  return match?.[0] ?? fallback;
}

function chatContentPrecedes(text, markerIndex) {
  const chatIndex = String(text).search(
    /\bCHAT\s+(?:user|assistant|system)\s*:/iu,
  );
  return chatIndex >= 0 && chatIndex < markerIndex;
}

function realProductEvent(line, startedAt) {
  const text = String(line);
  const markerMatch = text.match(
    /\[(MODEL_CONFIGURATION|AGENTERA_RUNTIME_UPDATE|AGENTERA_RUNTIME_OWNER_TRANSITION)\]/iu,
  );
  if (!markerMatch) return null;
  if (chatContentPrecedes(text, markerMatch.index ?? 0)) return null;
  const marker = markerMatch[1];
  if (marker.toUpperCase() === "MODEL_CONFIGURATION") {
    const body = text.slice((markerMatch.index ?? 0) + markerMatch[0].length);
    const positional = body.match(
      /\bunavailable\s+([0-9a-f]{12})\s+([a-z][a-z0-9_]{1,127})\b/iu,
    );
    return normalizeDiagnosticEvent({
      at: timestampOf(line, startedAt),
      source: "main",
      event: "model_configuration_unavailable",
      diagnosticId: valueOf(line, "diagnosticId") || positional?.[1],
      code: valueOf(line, "code") || positional?.[2],
    });
  }
  if (marker.toUpperCase() === "AGENTERA_RUNTIME_UPDATE") {
    return normalizeDiagnosticEvent({
      at: timestampOf(line, startedAt),
      source: "updater",
      event: valueOf(line, "code") ? "update_failed" : "update_stage",
      code: valueOf(line, "code"),
      stage: valueOf(line, "stage"),
      diagnosticId: valueOf(line, "diagnosticId"),
    });
  }
  return normalizeDiagnosticEvent({
    at: timestampOf(line, startedAt),
    source: "owner",
    event: /\bfailed\b/iu.test(line)
      ? "transition_failed"
      : "transition_started",
    code: /\bfailed\b/iu.test(line) ? "owner_transition_failed" : undefined,
    transitionId: valueOf(line, "transitionId"),
  });
}

/** Parse only stable, redacted product event fields from arbitrary log lines. */
export function parseStableEvents(lines, window = {}) {
  const events = [];
  const families = new Set();
  const coverage = {
    mainRendererIpc: false,
    owner: false,
    updater: false,
  };
  const startedAt = Number.isFinite(Date.parse(window.startedAt))
    ? new Date(window.startedAt).toISOString()
    : new Date(0).toISOString();
  for (const raw of lines) {
    const line = String(raw);
    const real = realProductEvent(line, startedAt);
    if (real) {
      events.push(real);
      families.add(real.source);
      if (/\[MODEL_CONFIGURATION\]/iu.test(line))
        coverage.mainRendererIpc = true;
      else if (/\[AGENTERA_RUNTIME_OWNER_TRANSITION\]/iu.test(line))
        coverage.owner = true;
      else if (/\[AGENTERA_RUNTIME_UPDATE\]/iu.test(line))
        coverage.updater = true;
      continue;
    }
    const marker = line.match(
      /\[AGENTERA_(MAIN|PRELOAD|RENDERER|RUNTIME|OWNER|UPDATER)\]/i,
    );
    if (!marker || chatContentPrecedes(line, marker.index ?? 0)) continue;
    const source = marker[1].toLowerCase();
    const event = eventFromLine(line, source);
    if (!event) continue;
    const normalized = normalizeDiagnosticEvent({
      at: timestampOf(line, startedAt),
      source,
      pid: Number(valueOf(line, "pid")) || undefined,
      event,
      code: valueOf(line, "code"),
      diagnosticId: valueOf(line, "diagnosticId"),
      operationId: valueOf(line, "operationId"),
      transitionId: valueOf(line, "transitionId"),
      stage: valueOf(line, "stage"),
    });
    if (normalized) {
      events.push(normalized);
      families.add(source);
    }
  }
  const requiredFamilies = [
    "main",
    "preload",
    "renderer",
    "runtime",
    "owner",
    "updater",
  ];
  return {
    events,
    missingFamilies: requiredFamilies.filter((family) => !families.has(family)),
    coverage,
  };
}

export function mergeStableEventResults(...results) {
  const events = [];
  const seen = new Set();
  const coverage = {
    mainRendererIpc: false,
    owner: false,
    updater: false,
  };
  for (const result of results.filter(Boolean)) {
    for (const event of result.events || []) {
      const key = JSON.stringify(event);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
    coverage.mainRendererIpc ||= Boolean(result.coverage?.mainRendererIpc);
    coverage.owner ||= Boolean(result.coverage?.owner);
    coverage.updater ||= Boolean(result.coverage?.updater);
  }
  const families = new Set(events.map((event) => event.source));
  const requiredFamilies = [
    "main",
    "preload",
    "renderer",
    "runtime",
    "owner",
    "updater",
  ];
  return {
    events,
    missingFamilies: requiredFamilies.filter((family) => !families.has(family)),
    coverage,
  };
}

export function serializeDiagnosticEvents(events) {
  return (events || []).map((event) => JSON.stringify(event)).join("\n");
}

export function filterShareableDiagnosticText(input, window = {}) {
  const parsed = parseStableEvents(String(input || "").split(/\r?\n/u), window);
  return { ...parsed, text: serializeDiagnosticEvents(parsed.events) };
}

export function buildMacUnifiedLogRequest({
  startedAt,
  endedAt,
  pids,
  bundleId,
}) {
  const uniquePids = [
    ...new Set((pids || []).map(Number).filter(Number.isInteger)),
  ];
  const pidPredicate = uniquePids.length
    ? uniquePids.map((pid) => `processID == ${pid}`).join(" OR ")
    : "FALSEPREDICATE";
  const bundle = String(bundleId || "com.bignormal.agentera.studio")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return {
    command: "log",
    args: [
      "show",
      "--style",
      "compact",
      "--start",
      formatMacLogTimestamp(startedAt),
      "--end",
      formatMacLogTimestamp(endedAt),
      "--info",
      "--debug",
      "--predicate",
      `((${pidPredicate}) OR subsystem CONTAINS[c] "${bundle}" OR eventMessage CONTAINS[c] "${bundle}")`,
    ],
  };
}

function commandSummary(command) {
  return {
    code: command.code,
    timedOut: command.timedOut,
    stdoutBytes: command.stdoutBytes,
    stderrBytes: command.stderrBytes,
    stdoutTruncated: command.stdoutTruncated,
    stderrTruncated: command.stderrTruncated,
  };
}

export function collectMacUnifiedLogEvidence({
  startedAt,
  endedAt,
  pids = [],
  bundleId,
  appPath,
  runCommand = runBoundedCommand,
}) {
  const queries = buildMacLogQueries({
    startedAt,
    endedAt,
    pids,
    bundleId,
    appPath,
  });
  const requests = [];
  const text = [];
  const eventResults = [];
  for (const query of queries) {
    let command;
    try {
      command = runCommand(query.command, query.args, {
        timeoutMs: 10_000,
        maximumBytes: 1024 * 1024,
      });
    } catch {
      command = {
        code: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }
    const startIndex = query.args.indexOf("--start");
    const endIndex = query.args.indexOf("--end");
    requests.push({
      name: query.name,
      start: query.args[startIndex + 1] || null,
      end: query.args[endIndex + 1] || null,
      pidCount: new Set(pids.map(Number).filter(Number.isInteger)).size,
      command: commandSummary(command),
    });
    const filtered = filterShareableDiagnosticText(
      `${command.stdout || ""}\n${command.stderr || ""}`,
      { startedAt, endedAt },
    );
    eventResults.push(filtered);
    const queryStatus = {
      query: query.name,
      status: command.code === 0 ? "collected" : "failed",
      command: commandSummary(command),
    };
    text.push(
      `--- ${query.name} ---\n${JSON.stringify(queryStatus)}${
        filtered.text ? `\n${filtered.text}` : ""
      }`,
    );
  }
  const failed = requests.filter((request) => request.command.code !== 0);
  const eventResult = mergeStableEventResults(...eventResults);
  return {
    status: failed.length ? "failed" : "collected",
    reason: failed.length
      ? failed.some((request) => request.command.timedOut)
        ? "unified_log_timeout"
        : "unified_log_query_failed"
      : null,
    requests,
    text: redactText(text.join("\n"), 2 * 1024 * 1024),
    events: eventResult.events,
    missingFamilies: eventResult.missingFamilies,
    coverage: eventResult.coverage,
  };
}

export const stableDiagnosticCodes = [...CODES].sort();
