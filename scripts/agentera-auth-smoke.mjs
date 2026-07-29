import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloudRoot = resolve(
  process.env.AGENTERA_CLOUD_REPO ?? resolve(desktopRoot, "../aera-cloud"),
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const steps = [
  {
    name: "pinned cloud contract",
    command: npmCommand,
    args: ["run", "check:agentera-cloud-contract"],
    cwd: desktopRoot,
  },
  {
    name: "desktop loopback and client boundaries",
    command: npmCommand,
    args: [
      "test",
      "--",
      "tests/agentera-auth-loopback.test.ts",
      "tests/agentera-auth-client.test.ts",
      "tests/agentera-offline-entitlement.test.ts",
    ],
    cwd: desktopRoot,
  },
  {
    name: "cloud OAuth malicious cases",
    command: "go",
    args: [
      "test",
      "./internal/oauth",
      "-run",
      "^(TestBeginAuthorizationRequiresFixedClientS256AndExactLoopbackRedirect|TestExchangeRequiresPKCEAndDeviceProofAndConsumesCodeOnce)$",
      "-count=1",
    ],
    cwd: cloudRoot,
  },
];

if (process.argv.includes("--plan")) {
  process.stdout.write(`${JSON.stringify(steps, null, 2)}\n`);
  process.exit(0);
}

if (!existsSync(resolve(cloudRoot, "go.mod"))) {
  console.error(
    `Aera cloud repository not found at ${cloudRoot}. Set AGENTERA_CLOUD_REPO to its checkout path.`,
  );
  process.exit(2);
}

for (const step of steps) {
  console.log(`\n[Aera auth smoke] ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\nAera authentication smoke gate passed.");
