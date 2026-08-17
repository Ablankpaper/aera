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
]);
const UPDATE_STAGES = new Set([
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

/** Parse only stable, redacted product event fields from arbitrary log lines. */
export function parseStableEvents(lines, window = {}) {
  const events = [];
  const families = new Set();
  const startedAt = Number.isFinite(Date.parse(window.startedAt))
    ? new Date(window.startedAt).toISOString()
    : new Date(0).toISOString();
  for (const raw of lines) {
    const line = String(raw);
    const marker = line.match(
      /\[AGENTERA_(MAIN|PRELOAD|RENDERER|RUNTIME|OWNER|UPDATER)\]/i,
    );
    if (!marker) continue;
    const source = marker[1].toLowerCase();
    const event = eventFromLine(line, source);
    if (!event) continue;
    const atMatch = line.match(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\b/,
    );
    const normalized = normalizeDiagnosticEvent({
      at: atMatch?.[0] ?? startedAt,
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
  };
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
    text.push(
      `--- ${query.name} ---\n${command.stdout || command.stderr || ""}`,
    );
  }
  const failed = requests.filter((request) => request.command.code !== 0);
  return {
    status: failed.length ? "failed" : "collected",
    reason: failed.length
      ? failed.some((request) => request.command.timedOut)
        ? "unified_log_timeout"
        : "unified_log_query_failed"
      : null,
    requests,
    text: redactText(text.join("\n"), 2 * 1024 * 1024),
  };
}

export const stableDiagnosticCodes = [...CODES].sort();
