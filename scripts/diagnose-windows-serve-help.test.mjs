import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildManagedGatewayConfig,
  buildManagedGatewayEnvironment,
  buildManagedGatewayPhases,
  buildGatewayInstrumentationScript,
  buildGatewayStacktracePhase,
  canTerminateProcessIdentity,
  cleanupPhaseSandbox,
  cleanupPhaseProcesses,
  nextDiagnosticPhase,
  parseWindowsProcessEvidence,
  readProcessEvidenceWithRetry,
  runChildToExit,
  summarizeDiagnosticPhase,
  waitForGatewayReadiness,
  redactDiagnosticText,
} from "./diagnose-windows-serve-help.mjs";

/* eslint-disable @typescript-eslint/explicit-function-return-type */

// @lat: [[lat.md/agentera-runtime-distribution#AgentEra Runtime distribution#Desktop TUI backend lifecycle#Gateway readiness evidence#Managed Gateway diagnostic test specifications#Invocation and phase boundaries]]
test("managed Gateway diagnostics reproduce the Windows invocation environment without secrets", () => {
  const env = buildManagedGatewayEnvironment({
    platform: "windows",
    runtimeRoot: "C:\\seed\\agentera-runtime",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    hermesHome: "C:\\run\\hermes-home",
    fakeHome: "C:\\run\\home",
    apiServerKey: "diagnostic-key-only",
    apiServerPort: 18642,
    baseEnv: {
      PATH: "C:\\Windows\\System32",
      PYTHONHOME: "C:\\old-python",
      PYTHONPATH: "C:\\old-python\\Lib",
      HERMES_HOME: "C:\\old-home",
      API_SERVER_KEY: "old-key",
      CI: "true",
      OPENAI_API_KEY: "must-not-be-copied",
    },
  });

  assert.equal(env.HERMES_HOME, "C:\\run\\hermes-home");
  assert.equal(env.API_SERVER_KEY, "diagnostic-key-only");
  assert.equal(env.API_SERVER_ENABLED, "true");
  assert.equal(env.API_SERVER_PORT, "18642");
  assert.equal(env.PYTHONNOUSERSITE, "1");
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  // The managed Desktop spawn does not pass these; the independent health
  // probe owns them. Their presence would change the dispatch boundary.
  assert.equal(env.PIP_NO_INDEX, undefined);
  assert.equal(env.UV_OFFLINE, undefined);
  assert.equal(env.NO_PROXY, undefined);
  assert.equal(env.no_proxy, undefined);
  assert.equal(env.TZ, undefined);
  assert.equal(env.LANG, undefined);
  assert.equal(env.LC_ALL, undefined);
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.match(env.PATH, /^C:\\seed\\agentera-runtime\\python;/u);
  assert.equal(
    env.PATH,
    "C:\\seed\\agentera-runtime\\python;C:\\Windows\\System32",
  );
  assert.equal(env.USERPROFILE, "C:\\run\\home");
  assert.equal(env.APPDATA, "C:\\run\\home\\AppData\\Roaming");
  assert.equal(env.LOCALAPPDATA, "C:\\run\\home\\AppData\\Local");
  assert.equal(env.CI, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  // Desktop writes the bind host into config.yaml, not the spawn env.
  assert.equal(env.API_SERVER_HOST, undefined);
  assert.equal(env.HERMES_BUNDLED_SKILLS, undefined);
  assert.equal(env.HERMES_OPTIONAL_SKILLS, undefined);
  assert.equal(env.HERMES_OPTIONAL_MCPS, undefined);
  assert.equal(env.PYTHONUNBUFFERED, undefined);
});

test("managed Gateway diagnostic phases stop at the single traced launch", () => {
  const phases = buildManagedGatewayPhases({
    module: "hermes_cli.main",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    cwd: "C:\\seed\\agentera-runtime\\python\\Lib\\site-packages",
  });

  assert.deepEqual(
    phases.map(({ name }) => name),
    [
      "managed-version",
      "import-hermes-cli-main",
      "sync-bundled-skills",
      "import-hermes-cli-gateway",
      "import-gateway-run",
      "gateway-importtime",
    ],
  );

  for (const phase of phases) {
    assert.equal(phase.file, "C:\\seed\\agentera-runtime\\python\\python.exe");
    assert.equal(
      phase.cwd,
      "C:\\seed\\agentera-runtime\\python\\Lib\\site-packages",
    );
  }

  const traced = phases.find((phase) => phase.name === "gateway-importtime");
  assert.deepEqual(traced.args, [
    "-X",
    "importtime",
    "-m",
    "hermes_cli.main",
    "gateway",
  ]);
  assert.equal(traced.waitForGateway, true);

  const sync = phases.find((phase) => phase.name === "sync-bundled-skills");
  assert.ok(sync);
  assert.equal(sync.waitForGateway, false);
  assert.deepEqual(sync.args.slice(0, 3), ["-X", "importtime", "-c"]);
  assert.match(sync.args.at(-1), /_sync_bundled_skills_quietly/u);
  assert.match(sync.args.at(-1), /faulthandler\.dump_traceback_later/u);
});

test("direct normal Gateway phase preserves the packaged command without import tracing", () => {
  const phases = buildManagedGatewayPhases({
    module: "hermes_cli.main",
    launchMode: "direct",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    cwd: "C:\\seed\\agentera-runtime\\python\\Lib\\site-packages",
  });

  assert.deepEqual(
    phases.map(({ name }) => name),
    ["gateway-direct"],
  );
  assert.deepEqual(phases[0].args, ["-m", "hermes_cli.main", "gateway"]);
  assert.equal(phases[0].waitForGateway, true);
  assert.equal(phases[0].instrumented, false);
  assert.equal(phases[0].diagnosticOnly, false);
  assert.doesNotMatch(phases[0].args.join(" "), /importtime/u);
});

test("instrumented Gateway phase enables startup markers before exact dispatch", () => {
  const phases = buildManagedGatewayPhases({
    module: "hermes_cli.main",
    launchMode: "instrumented",
    profile: "research",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    cwd: "C:\\seed\\agentera-runtime\\python\\Lib\\site-packages",
  });

  assert.deepEqual(
    phases.map(({ name }) => name),
    ["gateway-instrumented"],
  );
  assert.equal(phases[0].waitForGateway, true);
  assert.equal(phases[0].instrumented, true);
  assert.equal(phases[0].diagnosticOnly, true);
  const script = phases[0].args.at(-1);
  assert.match(script, /faulthandler\.enable/u);
  assert.match(script, /dump_traceback_later/u);
  assert.match(script, /AERA_GATEWAY_DIAGNOSTIC_MARKER/u);
  assert.match(script, /sys\.setprofile/u);
  assert.match(script, /runpy\.run_module\("hermes_cli\.main"/u);
  assert.match(script, /--profile.*research.*gateway/u);
});

test("instrumented wrapper keeps profiling on the launch thread", () => {
  const script = buildGatewayInstrumentationScript({
    module: "hermes_cli.main",
    profile: "research",
  });

  assert.match(script, /sys\.setprofile\(_profile\)/u);
  assert.doesNotMatch(script, /threading\.setprofile\(_profile\)/u);
  assert.doesNotMatch(script, /threading\.current_thread\(\)/u);
  assert.match(
    script,
    /if short not in _targets and name not in _targets: return _profile/u,
  );
});

test("candidate home mode preserves inherited Windows home variables", () => {
  const env = buildManagedGatewayEnvironment({
    platform: "windows",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    hermesHome: "C:\\run\\hermes-home",
    fakeHome: "C:\\run\\disposable-home",
    homeMode: "candidate",
    apiServerKey: "diagnostic-key-only",
    apiServerPort: 18642,
    baseEnv: {
      PATH: "C:\\Windows\\System32",
      HOME: "C:\\Users\\runner",
      USERPROFILE: "C:\\Users\\runner",
      APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
      CI: "true",
    },
    envMode: "desktop",
  });

  assert.equal(env.HOME, "C:\\Users\\runner");
  assert.equal(env.USERPROFILE, "C:\\Users\\runner");
  assert.equal(env.APPDATA, "C:\\Users\\runner\\AppData\\Roaming");
  assert.equal(env.LOCALAPPDATA, "C:\\Users\\runner\\AppData\\Local");
  assert.equal(env.HERMES_HOME, "C:\\run\\hermes-home");
  assert.notEqual(env.HOME, "C:\\run\\disposable-home");
});

test("instrumentation script helper uses environment-owned evidence paths", () => {
  const script = buildGatewayInstrumentationScript({
    module: "hermes_cli.main",
    profile: "research",
  });
  assert.match(script, /AERA_GATEWAY_DIAGNOSTIC_MARKER/u);
  assert.match(script, /AERA_GATEWAY_DIAGNOSTIC_STACK/u);
  assert.match(script, /function-/u);
  assert.match(script, /GatewayRunner/u);
  assert.match(script, /write_pid_file/u);
});

test("named Profile Gateway phases put --profile before the gateway command", () => {
  const phases = buildManagedGatewayPhases({
    module: "hermes_cli.main",
    profile: "research",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    cwd: "C:\\seed\\agentera-runtime\\python\\Lib\\site-packages",
  });
  const traced = phases.find((phase) => phase.name === "gateway-importtime");
  assert.deepEqual(traced.args, [
    "-X",
    "importtime",
    "-m",
    "hermes_cli.main",
    "--profile",
    "research",
    "gateway",
  ]);
  const version = phases.find((phase) => phase.name === "managed-version");
  assert.deepEqual(version.args, [
    "-m",
    "hermes_cli.main",
    "--profile",
    "research",
    "--version",
  ]);

  const stacktrace = buildGatewayStacktracePhase({
    module: "hermes_cli.main",
    profile: "research",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    cwd: "C:\\seed\\agentera-runtime\\python\\Lib\\site-packages",
  });
  assert.equal(stacktrace.name, "gateway-stacktrace");
  assert.equal(stacktrace.waitForGateway, true);
  assert.match(stacktrace.args.at(-1), /sys\.argv/u);
  assert.match(stacktrace.args.at(-1), /--profile/u);
  assert.match(stacktrace.args.at(-1), /faulthandler\.dump_traceback_later/u);

  const sync = phases.find((phase) => phase.name === "sync-bundled-skills");
  assert.ok(sync);
  assert.match(sync.args.at(-1), /--profile/u);
});

test("diagnostic control flow stops at the first failure and only traces a readiness timeout", () => {
  assert.deepEqual(
    nextDiagnosticPhase({
      phase: "managed-version",
      outcome: "exited",
      exitCode: 1,
    }),
    { action: "stop", reason: "phase-failed" },
  );
  assert.deepEqual(
    nextDiagnosticPhase({
      phase: "gateway-importtime",
      outcome: "ready-cleaned",
      ready: true,
    }),
    { action: "stop", reason: "gateway-ready" },
  );
  assert.deepEqual(
    nextDiagnosticPhase({
      phase: "gateway-importtime",
      outcome: "exited",
      exitCode: 1,
    }),
    { action: "stop", reason: "gateway-exited" },
  );
  assert.deepEqual(
    nextDiagnosticPhase({
      phase: "gateway-importtime",
      outcome: "readiness-timeout-cleaned",
      ready: false,
    }),
    { action: "append", phase: "gateway-stacktrace" },
  );
  assert.deepEqual(
    nextDiagnosticPhase({
      phase: "gateway-stacktrace",
      outcome: "timeout-killed",
    }),
    { action: "stop", reason: "stacktrace-complete" },
  );
  assert.deepEqual(
    nextDiagnosticPhase({
      phase: "gateway-direct",
      outcome: "readiness-timeout-cleaned",
      ready: false,
    }),
    { action: "append", phase: "gateway-stacktrace" },
  );
  assert.deepEqual(
    nextDiagnosticPhase({
      phase: "gateway-instrumented",
      outcome: "readiness-timeout-cleaned",
      ready: false,
    }),
    { action: "stop", reason: "instrumented-complete" },
  );
});

test("diagnostic config materializes the same minimal API-server files as Desktop", () => {
  const config = buildManagedGatewayConfig({
    apiServerKey: "diagnostic-key-only",
    apiServerPort: 18642,
  });
  assert.equal(config.envFile, "API_SERVER_KEY=diagnostic-key-only\n");
  assert.match(config.configYaml, /platforms:\n/u);
  assert.match(config.configYaml, /api_server:\n/u);
  assert.match(config.configYaml, /enabled: true\n/u);
  assert.match(config.configYaml, /port: 18642\n/u);
  assert.match(config.configYaml, /host: ["']?127\.0\.0\.1/u);
  assert.doesNotMatch(config.configYaml, /provider|OPENAI|ANTHROPIC/u);
});

test("Windows listener evidence requires PID, creation identity, image, path, and command line", () => {
  const raw = JSON.stringify({
    ProcessId: 4321,
    CreationFileTimeUtc: "133700000000000000",
    Name: "python.exe",
    ExecutablePath: "C:\\seed\\agentera-runtime\\python\\python.exe",
    CommandLine: "python.exe -m hermes_cli.main gateway",
  });
  const evidence = parseWindowsProcessEvidence(
    raw,
    "C:\\seed\\agentera-runtime\\python\\python.exe",
    4321,
  );
  assert.deepEqual(evidence, {
    available: true,
    valid: true,
    pid: 4321,
    identity: "windows:133700000000000000",
    imageName: "python.exe",
    executablePath: "c:\\seed\\agentera-runtime\\python\\python.exe",
    queryOutcome: "valid",
    commandLine: "python.exe -m hermes_cli.main gateway",
  });

  const wrongImage = parseWindowsProcessEvidence(
    JSON.stringify({
      ProcessId: 4321,
      CreationFileTimeUtc: "133700000000000001",
      Name: "python.exe",
      ExecutablePath: "C:\\other\\python.exe",
      CommandLine: "python.exe -m hermes_cli.main gateway",
    }),
    "C:\\seed\\agentera-runtime\\python\\python.exe",
    4321,
  );
  assert.equal(wrongImage?.available, true);
  assert.equal(wrongImage?.valid, false);

  const arrayRow = parseWindowsProcessEvidence(
    JSON.stringify([
      {
        ProcessId: 7,
        CreationFileTimeUtc: "1",
        Name: "other.exe",
        ExecutablePath: "C:\\other.exe",
        CommandLine: "other",
      },
      {
        ProcessId: 4321,
        CreationFileTimeUtc: "2",
        Name: "python.exe",
        ExecutablePath: "C:\\seed\\agentera-runtime\\python\\python.exe",
        CommandLine: "python.exe -m hermes_cli.main gateway",
      },
    ]),
    "C:\\seed\\agentera-runtime\\python\\python.exe",
    4321,
  );
  assert.equal(arrayRow.pid, 4321);
  assert.equal(arrayRow.valid, true);

  for (const [rawValue, outcome] of [
    ["", "empty"],
    ["{}", "empty"],
    ["[]", "empty"],
    ["not-json", "invalid-json"],
  ]) {
    const parsed = parseWindowsProcessEvidence(
      rawValue,
      "C:\\seed\\agentera-runtime\\python\\python.exe",
      4321,
    );
    assert.equal(parsed.queryOutcome, outcome);
    assert.equal(parsed.valid, false);
  }
});

test("cleanup refuses a reused PID or changed executable identity", () => {
  const captured = {
    available: true,
    valid: true,
    pid: 4321,
    identity: "windows:100",
    imageName: "python.exe",
    executablePath: "c:\\seed\\agentera-runtime\\python\\python.exe",
    commandLine: "python.exe -m hermes_cli.main gateway",
    queryOutcome: "valid",
  };
  assert.equal(canTerminateProcessIdentity(captured, { ...captured }), true);
  assert.equal(
    canTerminateProcessIdentity(captured, {
      ...captured,
      identity: "windows:101",
    }),
    false,
  );
  assert.equal(
    canTerminateProcessIdentity(captured, {
      ...captured,
      executablePath: "c:\\other\\python.exe",
    }),
    false,
  );
  assert.equal(
    canTerminateProcessIdentity(captured, { ...captured, valid: false }),
    false,
  );
  assert.equal(canTerminateProcessIdentity(captured, null), false);
});

test("process identity reads retry transient query failures until valid evidence", async () => {
  const outcomes = [
    { available: true, valid: false, queryOutcome: "empty" },
    { available: true, valid: false, queryOutcome: "timeout" },
    { available: true, valid: true, queryOutcome: "valid", pid: 4321 },
  ];
  let calls = 0;
  const sleeps = [];
  const result = await readProcessEvidenceWithRetry({
    readEvidence: async () => outcomes[calls++ % outcomes.length],
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
    retryDelayMs: 250,
    maxAttempts: 5,
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 250]);
  assert.equal(result?.valid, true);
});

test("process identity reads treat thrown CIM reads as retryable and bound attempts", async () => {
  let calls = 0;
  const result = await readProcessEvidenceWithRetry({
    readEvidence: async () => {
      calls += 1;
      if (calls === 1) throw new Error("cim provider down");
      return { available: true, valid: false, queryOutcome: "invalid-json" };
    },
    sleepFn: async () => {},
    maxAttempts: 3,
  });
  assert.equal(calls, 3);
  assert.equal(result?.valid, false);
});

test("valid process identity is returned without any retry", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await readProcessEvidenceWithRetry({
    readEvidence: async () => {
      calls += 1;
      return { available: true, valid: true, queryOutcome: "valid" };
    },
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
    maxAttempts: 4,
  });
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(result?.valid, true);
});

test("readiness returns as soon as the child exits instead of waiting for the full timeout", async () => {
  const events = [];
  const result = await waitForGatewayReadiness({
    phase: { name: "gateway-importtime" },
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    port: 18642,
    apiServerKey: "diagnostic-key-only",
    timeoutMs: 60_000,
    pollMs: 10_000,
    emit: (event, fields) => events.push({ event, fields }),
    childExitPromise: Promise.resolve({ exitCode: 17, signal: null }),
    readPidEntry: () => ({ state: "missing", pid: null }),
    isAlive: () => false,
    readEvidence: async () => null,
    probe: async () => ({ statusCode: null }),
    sleepFn: async () => {},
  });
  assert.equal(result.ready, false);
  assert.equal(result.outcome, "child-exited");
  assert.equal(result.exitCode, 17);
  assert.ok(events.some(({ event }) => event === "gateway-child-exited"));
});

test("readiness child-exit notification interrupts an unresolved poll sleep", async () => {
  const pendingSleeps = [];
  const sleepFn = () =>
    new Promise((resolve) => {
      pendingSleeps.push(resolve);
    });
  let resolveChild;
  const childExitPromise = new Promise((resolve) => {
    resolveChild = resolve;
  });
  const resultPromise = waitForGatewayReadiness({
    phase: { name: "gateway-importtime" },
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    port: 18642,
    apiServerKey: "diagnostic-key-only",
    timeoutMs: 60_000,
    pollMs: 60_000,
    childExitPromise,
    readPidEntry: () => ({ state: "missing", pid: null }),
    isAlive: () => false,
    readEvidence: async () => null,
    probe: async () => ({ statusCode: null }),
    sleepFn,
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  resolveChild({ exitCode: 23, signal: null });
  const completedBeforeSleepRelease = await Promise.race([
    resultPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(completedBeforeSleepRelease, true);
  for (const resolve of pendingSleeps) resolve();
  await assert.doesNotReject(resultPromise);
});

test("diagnostic evidence redacts credentials and local paths while retaining the failure tail", () => {
  const value =
    "Authorization: Bearer diagnostic-secret C:\\Users\\runner\\hermes\\gateway.log sk-live-12345678901234567890";
  const redacted = redactDiagnosticText(value, ["diagnostic-secret"]);

  assert.doesNotMatch(redacted, /diagnostic-secret/u);
  assert.doesNotMatch(redacted, /C:\\Users\\runner/u);
  assert.doesNotMatch(redacted, /sk-live-12345678901234567890/u);
  assert.match(redacted, /<redacted>/u);
  assert.match(redacted, /<path>/u);
});

test("diagnostic evidence redacts an unquoted Windows path containing spaces", () => {
  const redacted = redactDiagnosticText(
    "open failed at C:\\Users\\runner workspace\\hermes\\gateway.log",
  );
  assert.doesNotMatch(redacted, /C:\\Users\\runner workspace/u);
  assert.doesNotMatch(redacted, /workspace\\hermes\\gateway\.log/u);
  assert.match(redacted, /<path>/u);
});

test("a timed-out non-Gateway probe never kills an unverified PID", async () => {
  let terminateCalls = 0;
  const events = [];
  const result = await runChildToExit({
    phase: {
      name: "import-hermes-cli-main",
      file: process.execPath,
      cwd: process.cwd(),
      args: ["-e", "setInterval(() => {}, 1000)"],
    },
    env: process.env,
    timeoutMs: 10,
    emit: (event, fields) => events.push({ event, fields }),
    pidPath: "C:\\run\\gateway.pid",
    readEvidence: async () => null,
    isAlive: () => true,
    terminate: async () => {
      terminateCalls += 1;
    },
    cleanupWaitMs: 0,
    sleepFn: async () => {},
  });

  try {
    assert.equal(terminateCalls, 0);
    assert.equal(result.outcome, "timeout-unverified");
    assert.deepEqual(result.cleanup.remainingPids, [result.pid]);
    assert.ok(
      events.some(
        ({ event, fields }) =>
          event === "probe-cleanup-skip" &&
          fields.reason === "identity-unverified",
      ),
    );
  } finally {
    if (result.pid) process.kill(result.pid, "SIGKILL");
  }
});

test("cleanup terminates only identity-verified wrapper and listener processes", async () => {
  const evidenceFor = (pid) => ({
    available: true,
    valid: true,
    pid,
    identity: `windows:${pid}`,
    imageName: "python.exe",
    executablePath: "c:\\seed\\agentera-runtime\\python\\python.exe",
    commandLine: "python.exe -m hermes_cli.main gateway",
    queryOutcome: "valid",
  });
  const terminated = [];
  const alivePids = new Set([100, 200]);
  const events = [];

  const result = await cleanupPhaseProcesses({
    phase: { name: "gateway-importtime" },
    child: { pid: 100 },
    wrapperEvidence: evidenceFor(100),
    listenerPid: 200,
    listenerEvidence: evidenceFor(200),
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    emit: (event, fields) => events.push({ event, fields }),
    reason: "readiness-timeout",
    readPidEntry: () => ({ state: "present", pid: 200 }),
    readEvidence: async (pid) => evidenceFor(pid),
    isAlive: async (pid) => alivePids.has(pid),
    terminate: async (pid) => {
      terminated.push(pid);
      alivePids.delete(pid);
      return { attempted: true, error: null };
    },
    sleepFn: async () => {},
    cleanupWaitMs: 0,
  });

  assert.deepEqual(
    [...terminated].sort((a, b) => a - b),
    [100, 200],
  );
  assert.deepEqual(result.remainingPids, []);
  assert.equal(result.forced, true);
  assert.ok(events.some(({ event }) => event === "gateway-cleanup-complete"));
});

test("cleanup never signals a stale pre-launch PID even while it is alive", async () => {
  const evidenceFor = (pid) => ({
    available: true,
    valid: true,
    pid,
    identity: `windows:${pid}`,
    imageName: "python.exe",
    executablePath: "c:\\seed\\agentera-runtime\\python\\python.exe",
    commandLine: "python.exe -m hermes_cli.main gateway",
    queryOutcome: "valid",
  });
  const terminated = [];

  const result = await cleanupPhaseProcesses({
    phase: { name: "gateway-importtime" },
    child: { pid: 5555 },
    wrapperEvidence: evidenceFor(5555),
    listenerPid: null,
    listenerEvidence: null,
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    emit: () => {},
    reason: "readiness-timeout",
    readPidEntry: () => ({ state: "present", pid: 5555 }),
    readEvidence: async (pid) => evidenceFor(pid),
    isAlive: async () => true,
    terminate: async (pid) => {
      terminated.push(pid);
      return { attempted: true, error: null };
    },
    sleepFn: async () => {},
    cleanupWaitMs: 0,
    preLaunchPid: 5555,
  });

  assert.deepEqual(terminated, []);
  assert.deepEqual(result.remainingPids, []);
  assert.ok(
    result.residue.some(
      (entry) => entry.pid === 5555 && entry.reason === "pre-launch-pid",
    ),
  );
});

test("desktop env mode spreads the parent environment like the managed Desktop spawn", () => {
  const env = buildManagedGatewayEnvironment({
    platform: "windows",
    python: "C:\\seed\\agentera-runtime\\python\\python.exe",
    hermesHome: "C:\\run\\hermes-home",
    fakeHome: "C:\\run\\home",
    apiServerKey: "diagnostic-key-only",
    apiServerPort: 18642,
    baseEnv: {
      PATH: "C:\\Windows\\System32",
      CI: "true",
      GITHUB_ACTIONS: "true",
      OPENAI_API_KEY: "parent-marker",
    },
    envMode: "desktop",
  });

  // The managed Desktop spawn spreads process.env: runner markers and parent
  // variables DO reach the child, unlike the minimal diagnostic environment.
  assert.equal(env.CI, "true");
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.OPENAI_API_KEY, "parent-marker");
  assert.equal(env.HERMES_HOME, "C:\\run\\hermes-home");
  assert.equal(env.API_SERVER_KEY, "diagnostic-key-only");
  assert.equal(env.API_SERVER_ENABLED, "true");
  assert.match(env.PATH, /^C:\\seed\\agentera-runtime\\python;/u);
  // Desktop does not synthesize the fake-home AppData redirects.
  assert.equal(env.USERPROFILE, undefined);
  assert.equal(env.APPDATA, undefined);
  assert.equal(env.LOCALAPPDATA, undefined);
});

test("file stdio mode captures the child stderr tail from the inherited log", async () => {
  const phaseRoot = mkdtempSync(join(tmpdir(), "stderr-mode-"));
  const logPath = join(phaseRoot, "gateway-stderr.log");
  const result = await runChildToExit({
    phase: {
      name: "stderr-file-mode",
      file: process.execPath,
      cwd: process.cwd(),
      args: ["-e", "console.error('stderr-file-mode-marker')"],
    },
    env: process.env,
    timeoutMs: 5_000,
    emit: () => {},
    pidPath: join(phaseRoot, "gateway.pid"),
    readEvidence: async () => null,
    isAlive: () => false,
    terminate: async () => ({ attempted: false, error: null }),
    cleanupWaitMs: 0,
    sleepFn: async () => {},
    stdioMode: "file",
    stderrLogPath: logPath,
  });

  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 0);
  assert.match(result.stderrTail, /stderr-file-mode-marker/u);
  assert.ok(result.stderrBytes > 0);
});

test("phase summary retains wrapper, listener, pid-file, importtime, faulthandler, and cleanup evidence", () => {
  const summary = summarizeDiagnosticPhase({
    phase: { name: "gateway-importtime" },
    outcome: "readiness-timeout-cleaned",
    elapsedMs: 90_000,
    pid: 8452,
    command: "C:\\seed\\agentera-runtime\\python\\python.exe",
    args: ["-X", "importtime", "-m", "hermes_cli.main", "gateway"],
    cwd: "C:\\seed\\agentera-runtime\\python\\Lib\\site-packages",
    exitCode: null,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 512,
    stdoutTail: "",
    stderrTail: "traceback tail",
    wrapperEvidence: { identity: "windows:100" },
    wrapperIdentity: "windows:100",
    wrapperImageValid: true,
    listenerPid: null,
    listenerEvidence: null,
    listenerIdentity: null,
    listenerImageValid: false,
    listenerAlive: false,
    observedPidFilePid: null,
    observedPidFileEvidence: null,
    observedPidFilePreLaunch: false,
    ready: false,
    capabilities: null,
    pidFileBefore: { state: "missing", pid: null },
    pidFileAfter: { state: "missing", pid: null },
    pidFileTransitions: [],
    importtimeTail: "import time: 88099 | 784005 | hermes_cli.main",
    faulthandlerTail: "Thread 0x00000001 (most recent call first)",
    cleanup: { remainingPids: [] },
    sandboxCleanup: { attempted: true, cleaned: true },
    stageMarkerBytes: 42,
    stageMarkerTail: '{"event":"function-enter"}',
    stacktraceBytes: 84,
    stacktraceTail: "Thread 0x00000001",
  });

  assert.equal(summary.phase.name, "gateway-importtime");
  assert.equal(summary.outcome, "readiness-timeout-cleaned");
  assert.equal(summary.pid, 8452);
  assert.equal(summary.wrapperIdentity, "windows:100");
  assert.equal(summary.wrapperImageValid, true);
  assert.equal(summary.listenerPid, null);
  assert.equal(summary.ready, false);
  assert.match(summary.importtimeTail, /hermes_cli\.main/u);
  assert.match(summary.faulthandlerTail, /most recent call first/u);
  assert.equal(summary.stageMarkerBytes, 42);
  assert.match(summary.stageMarkerTail, /function-enter/u);
  assert.equal(summary.stacktraceBytes, 84);
  assert.match(summary.stacktraceTail, /Thread/u);
  assert.deepEqual(summary.cleanup.remainingPids, []);
  assert.equal(summary.sandboxCleanup.cleaned, true);

  const empty = summarizeDiagnosticPhase(null);
  assert.equal(empty.phase, null);
  assert.equal(empty.ready, false);
  assert.deepEqual(empty.args, []);
  assert.deepEqual(empty.pidFileTransitions, []);
});

test("phase sandbox is retained for process residue, cleaned otherwise, and reports cleanup errors", () => {
  let removed = 0;
  const withResidue = cleanupPhaseSandbox({
    phase: { name: "gateway-importtime" },
    phaseRoot: "C:\\run\\phase",
    result: { cleanup: { remainingPids: [4321] } },
    remove: () => {
      removed += 1;
    },
  });
  assert.equal(removed, 0);
  assert.equal(withResidue.sandboxCleanup.retainedForResidue, true);
  assert.equal(withResidue.sandboxCleanup.cleaned, false);

  const clean = cleanupPhaseSandbox({
    phase: { name: "gateway-importtime" },
    phaseRoot: "C:\\run\\phase",
    result: { cleanup: { remainingPids: [] } },
    remove: () => {
      removed += 1;
    },
  });
  assert.equal(removed, 1);
  assert.equal(clean.sandboxCleanup.cleaned, true);
  assert.equal(clean.sandboxCleanup.retainedForResidue, false);

  const failed = cleanupPhaseSandbox({
    phase: { name: "gateway-importtime" },
    phaseRoot: "C:\\run\\phase",
    result: { cleanup: { remainingPids: [] } },
    remove: () => {
      const error = new Error("busy");
      error.code = "EBUSY";
      throw error;
    },
  });
  assert.equal(failed.sandboxCleanup.cleaned, false);
  assert.equal(failed.sandboxCleanup.errorCode, "EBUSY");
});
