import test from "node:test";
import assert from "node:assert/strict";

import {
  buildManagedGatewayConfig,
  buildManagedGatewayEnvironment,
  buildManagedGatewayPhases,
  buildGatewayStacktracePhase,
  canTerminateProcessIdentity,
  cleanupPhaseSandbox,
  cleanupPhaseProcesses,
  nextDiagnosticPhase,
  parseWindowsProcessEvidence,
  readProcessEvidenceWithRetry,
  runGatewayPhase,
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
  const sync = phases.find((phase) => phase.name === "sync-bundled-skills");
  assert.ok(sync);
  assert.match(sync.args.at(-1), /sys\.argv/u);
  assert.match(sync.args.at(-1), /--profile/u);
  assert.match(sync.args.at(-1), /research/u);
  assert.match(stacktrace.args.at(-1), /research/u);
  assert.match(stacktrace.args.at(-1), /sys\.argv/u);
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

// @lat: [[lat.md/agentera-runtime-distribution#AgentEra Runtime distribution#Desktop TUI backend lifecycle#Gateway readiness evidence#Managed Gateway diagnostic test specifications#Evidence and fail-closed cleanup]]
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

test("readiness retains pid-file transitions and listener identity evidence", async () => {
  const events = [];
  const pidEntries = [
    { state: "missing", pid: null },
    { state: "present", pid: 4321 },
  ];
  const listenerEvidence = {
    available: true,
    valid: true,
    pid: 4321,
    identity: "windows:200",
    imageName: "python.exe",
    executablePath: "c:\\seed\\python\\python.exe",
    queryOutcome: "valid",
    commandLine: "python.exe -m hermes_cli.main gateway",
  };
  let now = 0;
  const result = await waitForGatewayReadiness({
    phase: { name: "gateway-importtime" },
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\python\\python.exe",
    port: 18642,
    apiServerKey: "diagnostic-key-only",
    timeoutMs: 100,
    pollMs: 1,
    readPidEntry: () => pidEntries.shift() ?? { state: "present", pid: 4321 },
    isAlive: () => true,
    readEvidence: async () => listenerEvidence,
    probe: async () => ({
      statusCode: 200,
      authenticated: true,
      validDocument: true,
      requestToolPolicy: false,
      requestModelRoute: false,
    }),
    sleepFn: async () => {},
    nowFn: () => now++,
    emit: (event, fields) => events.push({ event, fields }),
  });

  assert.equal(result.ready, true);
  assert.equal(result.listenerPid, 4321);
  assert.equal(result.listenerEvidence.identity, "windows:200");
  assert.deepEqual(
    result.pidFileTransitions.map(({ state, pid }) => ({ state, pid })),
    [
      { state: "missing", pid: null },
      { state: "present", pid: 4321 },
    ],
  );
  assert.ok(
    events.some(
      ({ event, fields }) =>
        event === "gateway-pid-file" &&
        fields.state === "present" &&
        fields.pid === 4321,
    ),
  );
});

test("readiness rejects a stale pre-launch pid even when its API answers", async () => {
  let probeCalls = 0;
  let now = 0;
  const evidence = {
    available: true,
    valid: true,
    pid: 4321,
    identity: "windows:stale",
    imageName: "python.exe",
    executablePath: "c:\\seed\\python\\python.exe",
    queryOutcome: "valid",
    commandLine: "python.exe -m hermes_cli.main gateway",
  };
  const result = await waitForGatewayReadiness({
    phase: { name: "gateway-importtime" },
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\python\\python.exe",
    port: 18642,
    apiServerKey: "diagnostic-key-only",
    timeoutMs: 4,
    pollMs: 1,
    preLaunchPid: 4321,
    readPidEntry: () => ({ state: "present", pid: 4321 }),
    isAlive: () => true,
    readEvidence: async () => evidence,
    probe: async () => {
      probeCalls += 1;
      return {
        statusCode: 200,
        authenticated: true,
        validDocument: true,
      };
    },
    sleepFn: async () => {},
    nowFn: () => now++,
  });

  assert.equal(result.ready, false);
  assert.equal(result.outcome, "readiness-timeout");
  assert.equal(probeCalls, 0);
  assert.ok(result.pidFileTransitions.at(-1)?.preLaunch === true);
  assert.equal(result.listenerPid, null);
  assert.equal(result.listenerEvidence, null);
  assert.equal(result.observedPidFilePid, 4321);
  assert.equal(result.observedPidFileEvidence.identity, "windows:stale");
});

test("readiness preserves an observed listener identity mismatch in timeout evidence", async () => {
  let now = 0;
  const mismatch = {
    available: true,
    valid: false,
    pid: 4321,
    identity: "windows:reused",
    imageName: "other.exe",
    executablePath: "c:\\other\\python.exe",
    queryOutcome: "identity-mismatch",
    commandLine: "other.exe",
  };
  const result = await waitForGatewayReadiness({
    phase: { name: "gateway-importtime" },
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\python\\python.exe",
    port: 18642,
    apiServerKey: "diagnostic-key-only",
    timeoutMs: 3,
    pollMs: 1,
    readPidEntry: () => ({ state: "present", pid: 4321 }),
    isAlive: () => true,
    readEvidence: async () => mismatch,
    probe: async () => ({
      statusCode: 200,
      authenticated: true,
      validDocument: true,
    }),
    sleepFn: async () => {},
    nowFn: () => now++,
  });

  assert.equal(result.ready, false);
  assert.equal(result.listenerEvidence.queryOutcome, "identity-mismatch");
  assert.equal(result.listenerImageValid, false);
});

test("readiness rejects listener evidence without an exact PID match", async () => {
  let now = 0;
  const result = await waitForGatewayReadiness({
    phase: { name: "gateway-importtime" },
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\python\\python.exe",
    port: 18642,
    apiServerKey: "diagnostic-key-only",
    timeoutMs: 3,
    pollMs: 1,
    readPidEntry: () => ({ state: "present", pid: 4321 }),
    isAlive: () => true,
    readEvidence: async () => ({
      available: true,
      valid: true,
      pid: null,
      identity: "windows:missing-pid",
      imageName: "python.exe",
      executablePath: "c:\\seed\\python\\python.exe",
      queryOutcome: "valid",
      commandLine: "python.exe -m hermes_cli.main gateway",
    }),
    probe: async () => ({
      statusCode: 200,
      authenticated: true,
      validDocument: true,
    }),
    sleepFn: async () => {},
    nowFn: () => now++,
  });

  assert.equal(result.ready, false);
  assert.equal(result.listenerImageValid, false);
  assert.equal(result.listenerEvidence.pid, null);
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

test("process identity reads retry only transient query failures", async () => {
  const valid = (pid) => ({
    available: true,
    valid: true,
    pid,
    identity: `windows:${pid}`,
    imageName: "python.exe",
    executablePath: "c:\\seed\\python\\python.exe",
    queryOutcome: "valid",
    commandLine: "python.exe -m hermes_cli.main gateway",
  });

  // A first-miss transient (no row yet) recovers on the bounded retry.
  const calls1 = [];
  const recovered = await readProcessEvidenceWithRetry({
    readEvidence: async () => {
      calls1.push(1);
      return calls1.length === 1 ? null : valid(4321);
    },
    sleepFn: async () => {},
  });
  assert.equal(recovered?.valid, true);
  assert.equal(calls1.length, 2);

  // PowerShell/CIM represents a just-spawned process with an empty object
  // before the provider can materialize its row. That miss is transient too.
  const callsEmpty = [];
  const recoveredAfterEmpty = await readProcessEvidenceWithRetry({
    readEvidence: async () => {
      callsEmpty.push(1);
      return callsEmpty.length === 1
        ? {
            available: false,
            valid: false,
            pid: null,
            identity: null,
            imageName: null,
            executablePath: null,
            queryOutcome: "empty",
            commandLine: null,
          }
        : valid(4321);
    },
    sleepFn: async () => {},
  });
  assert.equal(recoveredAfterEmpty?.valid, true);
  assert.equal(callsEmpty.length, 2);

  // A CIM timeout row is transient and retried the same way.
  const calls2 = [];
  const recoveredAfterTimeout = await readProcessEvidenceWithRetry({
    readEvidence: async () => {
      calls2.push(1);
      return calls2.length === 1
        ? {
            available: false,
            valid: false,
            pid: null,
            identity: null,
            imageName: null,
            executablePath: null,
            queryOutcome: "timeout",
            commandLine: null,
          }
        : valid(4321);
    },
    sleepFn: async () => {},
  });
  assert.equal(recoveredAfterTimeout?.valid, true);
  assert.equal(calls2.length, 2);

  // A conclusive identity mismatch is NOT transient: retrying a reused PID
  // would only re-read the same wrong process, so it stops immediately.
  const calls3 = [];
  const mismatch = await readProcessEvidenceWithRetry({
    readEvidence: async () => {
      calls3.push(1);
      return {
        available: true,
        valid: false,
        pid: 4321,
        identity: "windows:999",
        imageName: "other.exe",
        executablePath: "c:\\other\\other.exe",
        queryOutcome: "identity-mismatch",
        commandLine: "other",
      };
    },
    sleepFn: async () => {},
  });
  assert.equal(mismatch?.valid, false);
  assert.equal(calls3.length, 1);

  // Persistent transient failure returns the last evidence after exactly
  // maxAttempts reads, never an unbounded loop.
  const calls4 = [];
  const sleeps4 = [];
  const exhausted = await readProcessEvidenceWithRetry({
    readEvidence: async () => {
      calls4.push(1);
      return null;
    },
    sleepFn: async (ms) => {
      sleeps4.push(ms);
    },
    retryDelayMs: 100,
    maxAttempts: 3,
  });
  assert.equal(exhausted, null);
  assert.equal(calls4.length, 3);
  assert.deepEqual(sleeps4, [100, 100]);

  const callsUndefined = [];
  const recoveredAfterUndefined = await readProcessEvidenceWithRetry({
    readEvidence: async () => {
      callsUndefined.push(1);
      return callsUndefined.length === 1 ? undefined : valid(4321);
    },
    sleepFn: async () => {},
  });
  assert.equal(recoveredAfterUndefined?.valid, true);
  assert.equal(callsUndefined.length, 2);
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

test("cleanup captures a late pid-file listener and keeps its identity evidence", async () => {
  const events = [];
  const terminated = [];
  const wrapperEvidence = {
    available: true,
    valid: true,
    pid: 4321,
    identity: "windows:wrapper",
    imageName: "python.exe",
    executablePath: "c:\\seed\\python\\python.exe",
    queryOutcome: "valid",
    commandLine: "python.exe -m hermes_cli.main gateway",
  };
  const listenerEvidence = {
    ...wrapperEvidence,
    pid: 9876,
    identity: "windows:listener",
  };
  const result = await cleanupPhaseProcesses({
    phase: { name: "gateway-importtime" },
    child: { pid: 4321 },
    wrapperEvidence,
    listenerPid: null,
    listenerEvidence: null,
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\python\\python.exe",
    readPidEntry: () => ({ state: "present", pid: 9876 }),
    readEvidence: async (pid) =>
      pid === 9876 ? listenerEvidence : wrapperEvidence,
    isAlive: (pid) => pid === 9876,
    terminate: async (pid) => {
      terminated.push(pid);
      return { attempted: true, error: null };
    },
    sleepFn: async () => {},
    cleanupWaitMs: 0,
    emit: (event, fields) => events.push({ event, fields }),
  });

  assert.deepEqual(terminated, [9876]);
  assert.equal(result.latePidEntry.pid, 9876);
  assert.equal(result.lateListenerEvidence.identity, "windows:listener");
  assert.equal(result.attempts[0].kind, "listener");
  assert.equal(
    result.attempts[0].observedEvidence.identity,
    "windows:listener",
  );
  assert.ok(
    events.some(
      ({ event, fields }) =>
        event === "gateway-late-listener" && fields.pid === 9876,
    ),
  );
});

test("cleanup records a changed pid file as residue while the wrapper is still live", async () => {
  const terminated = [];
  const wrapperEvidence = {
    available: true,
    valid: true,
    pid: 4321,
    identity: "windows:wrapper",
    imageName: "python.exe",
    executablePath: "c:\\seed\\python\\python.exe",
    queryOutcome: "valid",
    commandLine: "python.exe -m hermes_cli.main gateway",
  };
  const changedListenerEvidence = {
    ...wrapperEvidence,
    pid: 9876,
    identity: "windows:changed-listener",
  };
  const result = await cleanupPhaseProcesses({
    phase: { name: "gateway-importtime" },
    child: { pid: 4321 },
    wrapperEvidence,
    listenerPid: null,
    listenerEvidence: null,
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\python\\python.exe",
    readPidEntry: () => ({ state: "present", pid: 9876 }),
    readEvidence: async (pid) =>
      pid === 9876 ? changedListenerEvidence : wrapperEvidence,
    isAlive: () => true,
    terminate: async (pid) => {
      terminated.push(pid);
      return { attempted: true, error: null };
    },
    sleepFn: async () => {},
    cleanupWaitMs: 0,
    emit: () => {},
  });

  assert.deepEqual(terminated, [4321]);
  assert.ok(
    result.residue.some(
      ({ kind, pid, reason }) =>
        kind === "listener" &&
        pid === 9876 &&
        reason === "wrapper-live-late-pid",
    ),
  );
  assert.ok(result.remainingPids.includes(9876));
});

test("cleanup never adopts a stale pre-launch pid from a late pid file", async () => {
  const terminated = [];
  const staleEvidence = {
    available: true,
    valid: true,
    pid: 2468,
    identity: "windows:pre-launch",
    imageName: "python.exe",
    executablePath: "c:\\seed\\python\\python.exe",
    queryOutcome: "valid",
    commandLine: "python.exe -m hermes_cli.main gateway",
  };
  const result = await cleanupPhaseProcesses({
    phase: { name: "gateway-importtime" },
    child: { pid: 4321 },
    wrapperEvidence: null,
    listenerPid: null,
    listenerEvidence: null,
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\python\\python.exe",
    preLaunchPid: 2468,
    readPidEntry: () => ({ state: "present", pid: 2468 }),
    readEvidence: async () => staleEvidence,
    isAlive: (pid) => pid === 2468,
    terminate: async (pid) => {
      terminated.push(pid);
      return { attempted: true, error: null };
    },
    sleepFn: async () => {},
    cleanupWaitMs: 0,
    emit: () => {},
  });

  assert.deepEqual(terminated, []);
  assert.deepEqual(result.remainingPids, []);
  assert.ok(
    result.residue.some(
      ({ pid, reason, alive }) =>
        pid === 2468 && reason === "pre-launch-pid" && alive === true,
    ),
  );
});

test("cleanup retains the latest wrapper evidence when ownership cannot be verified", async () => {
  const observedWrapper = {
    available: true,
    valid: false,
    pid: 4321,
    identity: "windows:reused-wrapper",
    imageName: "other.exe",
    executablePath: "c:\\other\\python.exe",
    queryOutcome: "identity-mismatch",
    commandLine: "other.exe",
  };
  const result = await cleanupPhaseProcesses({
    phase: { name: "import-gateway-run" },
    child: { pid: 4321 },
    wrapperEvidence: null,
    listenerPid: null,
    listenerEvidence: null,
    pidPath: "C:\\run\\gateway.pid",
    python: "C:\\seed\\python\\python.exe",
    readPidEntry: () => ({ state: "missing", pid: null }),
    readEvidence: async () => observedWrapper,
    isAlive: () => true,
    terminate: async () => ({ attempted: false, error: null }),
    sleepFn: async () => {},
    cleanupWaitMs: 0,
    emit: () => {},
  });

  assert.equal(result.residue[0].reason, "wrapper-identity-unverified");
  assert.equal(
    result.residue[0].observedEvidence.queryOutcome,
    "identity-mismatch",
  );
  assert.deepEqual(result.remainingPids, [4321]);
});

test("ordinary phase results retain wrapper and pid-file cleanup evidence", async () => {
  const evidence = {
    available: true,
    valid: true,
    pid: 0,
    identity: "posix:test",
    imageName: "node",
    executablePath: process.execPath,
    queryOutcome: "test",
    commandLine: "node phase",
  };
  const result = await runChildToExit({
    phase: {
      name: "import-hermes-cli-main",
      file: process.execPath,
      cwd: process.cwd(),
      args: ["-e", "process.stdout.write('phase-output')"],
    },
    env: process.env,
    timeoutMs: 2_000,
    emit: () => {},
    pidPath: "C:\\run\\gateway.pid",
    readPidEntry: () => ({ state: "missing", pid: null }),
    readEvidence: async (pid) => ({ ...evidence, pid }),
    isAlive: () => false,
    terminate: async () => ({ attempted: false, error: null }),
    sleepFn: async () => {},
  });

  assert.equal(result.wrapperEvidence.valid, true);
  assert.equal(result.pidFileBefore.state, "missing");
  assert.equal(result.pidFileAfter.state, "missing");
  assert.ok(Array.isArray(result.cleanup.attempts));
  assert.ok(Array.isArray(result.cleanup.residue));
  assert.match(result.stdoutTail, /phase-output/u);
});

test("sandbox cleanup failure is retained on the phase result", () => {
  const result = {
    phase: "gateway-stacktrace",
    cleanup: { remainingPids: [] },
  };
  const events = [];
  const updated = cleanupPhaseSandbox({
    phase: { name: "gateway-stacktrace" },
    phaseRoot: "C:\\runner\\phase-root",
    result,
    remove: () => {
      const error = new Error("EBUSY");
      error.code = "EBUSY";
      throw error;
    },
    emit: (event, fields) => events.push({ event, fields }),
  });

  assert.equal(updated.sandboxCleanup.cleaned, false);
  assert.equal(updated.sandboxCleanup.errorCode, "EBUSY");
  assert.deepEqual(updated.cleanup.remainingPids, []);
  assert.ok(
    events.some(({ event }) => event === "phase-sandbox-cleanup-failed"),
  );
});

test("sandbox stays retained when cleanup reports live process residue", () => {
  const result = {
    phase: "gateway-importtime",
    cleanup: { remainingPids: [9] },
  };
  let removeCalls = 0;
  const updated = cleanupPhaseSandbox({
    phase: { name: "gateway-importtime" },
    phaseRoot: "C:\\runner\\phase-root",
    result,
    remove: () => {
      removeCalls += 1;
    },
    emit: () => {},
  });

  assert.equal(removeCalls, 0);
  assert.equal(updated.sandboxCleanup.retainedForResidue, true);
  assert.equal(updated.sandboxCleanup.cleaned, false);
});

test("Gateway phase result retains wrapper/listener, pid-file, output, and cleanup evidence", async () => {
  let childPid = null;
  const terminated = [];
  const events = [];
  const evidenceFor = (pid) => ({
    available: true,
    valid: true,
    pid,
    identity: `posix:${pid}`,
    imageName: "node",
    executablePath: process.execPath,
    queryOutcome: "test",
    commandLine: "node gateway diagnostic",
  });
  const result = await runGatewayPhase({
    phase: {
      name: "gateway-importtime",
      file: process.execPath,
      cwd: process.cwd(),
      args: ["-e", "setTimeout(() => {}, 5000)"],
    },
    env: process.env,
    timeoutMs: 1_000,
    emit: (event, fields) => {
      events.push({ event, fields });
      if (event === "probe-spawned") childPid = fields.pid;
    },
    pidPath: "C:\\run\\gateway.pid",
    port: 18642,
    apiServerKey: "diagnostic-key-only",
    python: process.execPath,
    pollMs: 1,
    readPidEntry: () =>
      childPid === null
        ? { state: "missing", pid: null }
        : { state: "present", pid: childPid },
    readEvidence: async (pid) => evidenceFor(pid),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    probe: async () => ({
      statusCode: 200,
      authenticated: true,
      validDocument: true,
      requestToolPolicy: false,
      requestModelRoute: false,
    }),
    terminate: async (pid) => {
      terminated.push(pid);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The child may have exited between the identity read and signal.
      }
      return { attempted: true, error: null };
    },
    sleepFn: async () => {},
    cleanupWaitMs: 100,
  });

  assert.equal(result.ready, true);
  assert.equal(result.wrapperEvidence.valid, true);
  assert.equal(result.listenerEvidence.valid, true);
  assert.equal(result.listenerPid, childPid);
  assert.equal(result.pidFileBefore.state, "missing");
  assert.equal(result.pidFileAfter.state, "present");
  assert.ok(Array.isArray(result.pidFileTransitions));
  assert.equal(result.stdoutTail, "");
  assert.equal(result.stderrTail, "");
  assert.equal(result.cleanup.attempts.length, 1);
  assert.deepEqual(terminated, [childPid]);
  assert.ok(events.some(({ event }) => event === "gateway-wrapper-evidence"));
});

test("phase summaries retain the bounded importtime, faulthandler, and residue fields", () => {
  const summary = summarizeDiagnosticPhase({
    phase: "gateway-stacktrace",
    outcome: "readiness-timeout-residue",
    command: "C:\\seed\\python.exe",
    args: ["-X", "importtime", "gateway"],
    cwd: "C:\\seed\\site-packages",
    wrapperEvidence: { identity: "windows:1" },
    listenerEvidence: { identity: "windows:2" },
    wrapperImageValid: true,
    listenerImageValid: false,
    listenerAlive: true,
    pidFileBefore: { state: "missing", pid: null },
    pidFileAfter: { state: "present", pid: 7 },
    pidFileTransitions: [{ state: "present", pid: 7 }],
    importtimeTail: "import time",
    faulthandlerTail: "Traceback",
    cleanup: { attempts: [], residue: [{ pid: 7 }], remainingPids: [7] },
    sandboxCleanup: { cleaned: false, retainedForResidue: true },
  });

  assert.equal(summary.wrapperEvidence.identity, "windows:1");
  assert.equal(summary.listenerEvidence.identity, "windows:2");
  assert.equal(summary.wrapperImageValid, true);
  assert.equal(summary.listenerAlive, true);
  assert.equal(summary.importtimeTail, "import time");
  assert.equal(summary.faulthandlerTail, "Traceback");
  assert.deepEqual(summary.cleanup.remainingPids, [7]);
  assert.equal(summary.sandboxCleanup.retainedForResidue, true);
});
