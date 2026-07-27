/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const implementationFiles = [
  "bootstrap-host.sh",
  "generate-secrets.sh",
  "install-ip-certificate.sh",
  "render-operator-record.mjs",
];

const policies = [
  {
    label: "literal IPv4 address",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/u,
  },
  {
    label: "embedded private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  },
  {
    label: "credential-shaped token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/u,
  },
  {
    label: "hard-coded secret assignment",
    pattern:
      /\b(?:PASSWORD|TOKEN|SECRET|API_KEY|HMAC_KEY|PRIVATE_KEY)\s*=\s*["']?(?![$%])[A-Za-z0-9+/_=-]{12,}["']?/iu,
  },
  {
    label: "disabled SSH host-key verification",
    pattern: /StrictHostKeyChecking\s*=\s*no/iu,
  },
  {
    label: "unsafe recursive delete",
    pattern:
      /\brm\s+(?:-[^\n ]*r[^\n ]*\s+|--recursive\s+)(?:\/(?:\s|$)|~(?:\/|\s|$)|["']?\$(?:HOME|[A-Z_]*ROOT|[A-Z_]*DIR)\b)/iu,
  },
  {
    label: "shell tracing",
    pattern: /\bset\s+-[a-z]*x[a-z]*\b/iu,
  },
  {
    label: "password helper or persisted password",
    pattern: /\b(?:sshpass|chpasswd)\b|(?:password|passwd).*(?:>>?|tee)\s/iu,
  },
  {
    label: "secret echo",
    pattern:
      /\becho\s+["']?\$\{?[^}\n]*(?:PASSWORD|TOKEN|SECRET|PRIVATE_KEY|HMAC_KEY)/iu,
  },
];

function assertPolicySafe(source, label) {
  for (const policy of policies) {
    assert.doesNotMatch(source, policy.pattern, `${label}: ${policy.label}`);
  }
}

test("policy catches every prohibited source shape", () => {
  const badSources = [
    `PUBLIC_ORIGIN=https://${[203, 0, 113, 9].join(".")}`,
    ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
    `TOKEN='${`ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`}'`,
    `PASSWORD='${"fixture-password-value"}'`,
    `ssh -o ${["StrictHostKeyChecking", "no"].join("=")} host`,
    `rm -rf ${"$"}HOME`,
    `set ${"-"}x`,
    `${["ssh", "pass"].join("")} -p value ssh host`,
    `echo "${"$"}SERVICE_TOKEN"`,
  ];

  for (let index = 0; index < badSources.length; index += 1) {
    assert.throws(
      () => assertPolicySafe(badSources[index], `fixture-${index}`),
      /fixture-/,
    );
  }
});

test("tracked internal-beta operator implementations contain no prohibited material", async () => {
  for (const file of implementationFiles) {
    const source = await readFile(path.join(directory, file), "utf8");
    assertPolicySafe(source, file);
  }
});

test("host preparation persists and validates the requested SSH port before firewall reload", async () => {
  const source = await readFile(
    path.join(directory, "bootstrap-host.sh"),
    "utf8",
  );
  assert.match(source, /configure_ssh_port\(\)/u);
  assert.match(source, /printf 'Port %s\\n' "\$ssh_port"/u);
  assert.match(source, /\/usr\/sbin\/sshd -T/u);

  const configure = source.indexOf('configure_ssh_port "$ssh_port"');
  const firewall = source.indexOf('configure_firewall "$ssh_port"');
  const reload = source.indexOf("reload_ssh_service", firewall);
  assert.ok(configure >= 0, "prepare must configure the requested SSH port");
  assert.ok(firewall > configure, "firewall must follow validated SSH config");
  assert.ok(reload > firewall, "SSH reload must follow the firewall update");
});

test("Docker repository downloads tolerate unreachable CDN edges", async () => {
  const source = await readFile(
    path.join(directory, "bootstrap-host.sh"),
    "utf8",
  );
  const repositoryInstaller = source.slice(
    source.indexOf("install_docker_repository()"),
    source.indexOf("install_certbot()"),
  );

  assert.match(repositoryInstaller, /curl[\s\S]*--ipv4/u);
  assert.match(repositoryInstaller, /curl[\s\S]*--retry 5/u);
  assert.match(repositoryInstaller, /curl[\s\S]*--retry-all-errors/u);
  assert.match(repositoryInstaller, /curl[\s\S]*--connect-timeout 10/u);
  assert.match(repositoryInstaller, /curl[\s\S]*--max-time 60/u);
});

test("host preparation installs the exact Cosign verifier used by candidate CI", async () => {
  const source = await readFile(
    path.join(directory, "bootstrap-host.sh"),
    "utf8",
  );
  const installer = source.slice(
    source.indexOf("install_cosign()"),
    source.indexOf("install_certbot()"),
  );

  assert.match(source, /cosign_version=3\.0\.6/u);
  assert.match(source, /cosign_install=\/usr\/local\/bin\/cosign/u);
  assert.match(
    installer,
    /c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74/u,
  );
  assert.match(
    installer,
    /bedac92e8c3729864e13d4a17048007cfafa79d5deca993a43a90ffe018ef2b8/u,
  );
  assert.match(
    installer,
    /github\.com\/sigstore\/cosign\/releases\/download\/v\$\{cosign_version\}\/cosign-linux-\$\{architecture\}/u,
  );
  assert.match(installer, /sha256sum --check --status/u);
  assert.match(installer, /GitVersion:/u);
  assert.ok(
    installer.indexOf("[[ -x $cosign_install ]]") <
      installer.indexOf('download="https://github.com/'),
    "an already verified exact Cosign binary must avoid a network download",
  );

  const preparation = source.slice(source.indexOf("prepare_host()"));
  const installCosign = preparation.indexOf("install_cosign");
  const installCertbot = preparation.indexOf("install_certbot");
  assert.ok(installCosign >= 0, "host preparation must install Cosign");
  assert.ok(
    installCertbot > installCosign,
    "Cosign must be verified before certificate and deployment preparation",
  );
});

test("host preparation can restart after a removed Caddy configuration", async () => {
  const source = await readFile(
    path.join(directory, "bootstrap-host.sh"),
    "utf8",
  );
  const preparation = source.slice(source.indexOf("prepare_host()"));
  const ensureConfig = preparation.indexOf("ensure_caddy_bootstrap_config");
  const startCaddy = preparation.indexOf("systemctl enable --now caddy");

  assert.match(source, /ensure_caddy_bootstrap_config\(\)/u);
  assert.match(source, /\[\[ -e \$caddy_config \|\| -L \$caddy_config \]\]/u);
  assert.match(source, /http:\/\/localhost/u);
  assert.match(source, /caddy validate --config "\$caddy_config"/u);
  assert.ok(ensureConfig >= 0, "host preparation must ensure a Caddy config");
  assert.ok(
    startCaddy > ensureConfig,
    "Caddy must start only after its bootstrap configuration exists",
  );
});

test("host preparation rejects a dangling Caddy configuration symlink", async () => {
  const source = await readFile(
    path.join(directory, "bootstrap-host.sh"),
    "utf8",
  );
  const functionStart = source.indexOf("ensure_caddy_bootstrap_config()");
  const functionEnd = source.indexOf(
    "\nconfigure_deploy_user()",
    functionStart,
  );
  assert.ok(functionStart >= 0 && functionEnd > functionStart);

  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "aera-caddy-bootstrap-"),
  );
  try {
    const target = path.join(temporary, "missing-target");
    const config = path.join(temporary, "Caddyfile");
    const harness = path.join(temporary, "harness.sh");
    await symlink(target, config);
    await writeFile(
      harness,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "caddy_config=$1",
        'fail() { printf "%s\\n" "$1" >&2; exit 1; }',
        source.slice(functionStart, functionEnd),
        "ensure_caddy_bootstrap_config",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = await new Promise((resolve, reject) => {
      const child = spawn(harness, [config], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, { code: 1, signal: null });
    await assert.rejects(access(target));
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("deployment account can traverse the root-owned application directory", async () => {
  const source = await readFile(
    path.join(directory, "bootstrap-host.sh"),
    "utf8",
  );
  const directoryConfiguration = source.slice(
    source.indexOf("configure_directories()"),
    source.indexOf("configure_unattended_updates()"),
  );

  assert.match(
    directoryConfiguration,
    /install -d -m 0755 -o root -g root \/opt\/aera/u,
  );
  assert.ok(
    directoryConfiguration.indexOf(
      "install -d -m 0755 -o root -g root /opt/aera",
    ) < directoryConfiguration.indexOf('"$install_root"'),
    "the traversable application parent must exist before the deploy-owned root",
  );
  assert.match(
    directoryConfiguration,
    /install -d -m 0755 -o root -g root \/etc\/aera/u,
  );
  assert.match(
    directoryConfiguration,
    /install -d -m 0755 -o root -g root \/var\/lib\/aera/u,
  );
  assert.ok(
    directoryConfiguration.indexOf(
      "install -d -m 0755 -o root -g root /etc/aera",
    ) < directoryConfiguration.indexOf('"$secret_root"'),
    "the traversable secret parent must exist before the restricted secret root",
  );
  assert.ok(
    directoryConfiguration.indexOf(
      "install -d -m 0755 -o root -g root /var/lib/aera",
    ) < directoryConfiguration.indexOf('"$state_root"'),
    "the traversable state parent must exist before the deploy-owned state root",
  );
});

test("Caddy configuration changes restart the service instead of reloading through the disabled admin API", async () => {
  const source = await readFile(
    path.join(directory, "install-ip-certificate.sh"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /systemctl reload caddy/u,
    "caddy reload requires the admin API, which the reviewed Caddyfile disables",
  );
  assert.match(source, /systemctl restart caddy/u);
  const validations = source.match(/caddy validate --config/gu) ?? [];
  const restarts = source.match(/systemctl restart caddy/gu) ?? [];
  assert.ok(
    validations.length >= restarts.length,
    "every caddy restart must be preceded by a configuration validation",
  );
});

test("ACME webroot path segments are all created world-traversable despite the restrictive umask", async () => {
  const source = await readFile(
    path.join(directory, "install-ip-certificate.sh"),
    "utf8",
  );

  assert.match(
    source,
    /install -d -m 0755 "\$webroot" "\$webroot\/\.well-known" \\\n\s*"\$webroot\/\.well-known\/acme-challenge"/u,
    "install -d applies the mode only to the final segment, so every parent must be listed explicitly",
  );
});

test("secret generation does not hide OpenSSL diagnostics", async () => {
  const source = await readFile(
    path.join(directory, "generate-secrets.sh"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /openssl (?:genpkey|pkey|req|x509)[\s\S]{0,240}2>\/dev\/null/u,
  );
});

test("secret generation prepares the live Admin-to-Cloud trust view", async () => {
  const source = await readFile(
    path.join(directory, "generate-secrets.sh"),
    "utf8",
  );

  assert.match(source, /write_admin_pki_view\(\)/u);
  for (const file of [
    "ca.pem",
    "client.pem",
    "client-key.pem",
    "service-key.pem",
  ]) {
    assert.match(
      source,
      new RegExp(`admin_pki_dir/${file.replace(".", "\\.")}`, "u"),
    );
  }
  assert.match(
    source,
    /AGENTERA_CLOUD_ADMIN_BASE_URL=https:\/\/aera-cloud-internal-admin:8443/u,
  );
  assert.match(source, /AGENTERA_CLOUD_ADMIN_JWT_ISSUER=aera-admin/u);
  assert.match(
    source,
    /AGENTERA_CLOUD_ADMIN_JWT_SUBJECT=aera-admin-internal-beta/u,
  );
  assert.match(source, /printf 'PAYLOAD_SECRET=%s\\n' "\$admin_payload"/u);
  assert.match(
    source,
    /"\$admin_operation_hmac" "\$admin_payload" "\$cloud_access_private"/u,
    "Payload secret must be independently generated and collision checked",
  );
  assert.match(source, /setfacl -m u:1001:--x "\$output_dir\/admin-pki"/u);
  assert.match(source, /setfacl -m u:1001:r--/u);
});
